import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {CustomEventType} from 'resource:///org/gnome/shell/ui/swipeTracker.js';
import {TouchpadConstants} from '../constants.js';
import {getWindowUnderPointer} from './utils/windowUnderPointer.js';
import {getVirtualKeyboard} from './utils/keyboard.js';

// how far (px) the drag has to keep pushing past a screen edge to snap the window
const EDGE_SNAP_THRESHOLD = 80;

type EdgeSnap = 'top' | 'left' | 'right';

enum State {
    NONE = 0,
    PENDING = 1,
    HANDLING = 2,
    IGNORED = 3,
}

/**
 * Drags the focused window with a swipe. The swipe has to start horizontally;
 * once detected the window follows the fingers in both directions until they
 * are lifted, so this does not use SwipeTracker (which is single-axis).
 */
export class WindowDragGestureExtension implements ISubExtension {
    private _nfingers: number[];
    private _captureId = 0;
    private _state = State.NONE;
    private _window?: Meta.Window;
    private _pendingX = 0;
    private _pendingY = 0;
    private _startX = 0;
    private _startY = 0;
    private _dragX = 0;
    private _dragY = 0;
    private _scale = 1;
    private _overshootX = 0;
    private _overshootY = 0;
    private _snap?: EdgeSnap;
    private _snapPreview?: St.Widget;
    private _pointer?: Clutter.VirtualInputDevice;
    private _pointerOffsetX = 0;
    private _pointerOffsetY = 0;
    private _restoring = false;
    private _sizeChangedId = 0;
    private _restoreTimeoutId = 0;

    constructor(nfingers: number[]) {
        this._nfingers = nfingers;
    }

    apply() {
        this._captureId = global.stage.connect(
            'captured-event::touchpad',
            this._handleEvent.bind(this)
        );
    }

    destroy() {
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
        this._cancelRestore();
        this._window = undefined;
        this._pointer = undefined;
        this._snapPreview?.destroy();
        this._snapPreview = undefined;
    }

    private _handleEvent(
        _actor: Clutter.Actor | undefined,
        event: CustomEventType
    ): boolean {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._state = State.NONE;
            this._cancelRestore();
            this._window = undefined;
        }

        if (this._state === State.IGNORED) return Clutter.EVENT_PROPAGATE;

        if (
            !this._nfingers.includes(
                event.get_touchpad_gesture_finger_count()
            ) ||
            (Main.actionMode & Shell.ActionMode.NORMAL) === 0
        ) {
            this._state = State.IGNORED;
            return Clutter.EVENT_PROPAGATE;
        }

        const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
        const multiplier = TouchpadConstants.SWIPE_MULTIPLIER;

        if (this._state === State.NONE) {
            if (dx === 0 && dy === 0) return Clutter.EVENT_PROPAGATE;
            this._pendingX = 0;
            this._pendingY = 0;
            this._state = State.PENDING;
        }

        if (this._state === State.PENDING) {
            this._pendingX += dx * multiplier;
            this._pendingY += dy * multiplier;
            if (
                Math.hypot(this._pendingX, this._pendingY) <
                TouchpadConstants.DRAG_THRESHOLD_DISTANCE
            )
                return Clutter.EVENT_PROPAGATE;

            // only a horizontal start begins the drag; vertical swipes belong to other gestures
            if (
                Math.abs(this._pendingX) <= Math.abs(this._pendingY) ||
                !this._beginDrag()
            ) {
                this._state = State.IGNORED;
                return Clutter.EVENT_PROPAGATE;
            }
            this._state = State.HANDLING;
        }

        switch (phase) {
            case Clutter.TouchpadGesturePhase.BEGIN:
            case Clutter.TouchpadGesturePhase.UPDATE: {
                const speed =
                    multiplier *
                    this._scale *
                    TouchpadConstants.WINDOW_DRAG_MULTIPLIER;
                const moveX = dx * speed;
                const moveY = dy * speed;
                this._dragX += moveX;
                this._dragY += moveY;
                // while a maximized window is being restored, just collect the movement
                if (!this._restoring) this._moveWindow(moveX, moveY);
                break;
            }
            case Clutter.TouchpadGesturePhase.END:
            case Clutter.TouchpadGesturePhase.CANCEL: {
                const window = this._window;
                const snap = this._snap;
                this._state = State.NONE;
                this._cancelRestore();
                this._window = undefined;
                this._snapPreview?.hide();
                this._snap = undefined;
                this._overshootX = 0;
                this._overshootY = 0;
                if (
                    window &&
                    snap &&
                    phase === Clutter.TouchpadGesturePhase.END
                )
                    this._applySnap(window, snap);
                break;
            }
        }
        return Clutter.EVENT_STOP;
    }

    private _beginDrag(): boolean {
        const window = getWindowUnderPointer();

        // fullscreen windows report allows_move() == false until they are restored
        if (!window || (!window.is_fullscreen() && !window.allows_move()))
            return false;

        this._window = window;
        this._dragX = 0;
        this._dragY = 0;
        this._overshootX = 0;
        this._overshootY = 0;
        this._snap = undefined;
        if (this._needsRestore(window)) {
            // restore first; the drag starts from wherever the restored window lands
            this._restoring = true;
            this._sizeChangedId = window.connect('size-changed', () =>
                this._finishRestore()
            );
            this._restoreTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                250,
                () => {
                    this._restoreTimeoutId = 0;
                    this._finishRestore();
                    return GLib.SOURCE_REMOVE;
                }
            );
            this._restoreStep(window);
        } else {
            this._setStartPosition(window);
        }
        // same speed on both axes: a full touchpad width moves the window one monitor width
        this._scale =
            global.display.get_monitor_geometry(window.get_monitor()).width /
            TouchpadConstants.TOUCHPAD_BASE_WIDTH;
        return true;
    }

    private _setStartPosition(window: Meta.Window) {
        const rect = window.get_frame_rect();
        this._startX = rect.x;
        this._startY = rect.y;

        // the pointer keeps its place relative to the window (pulled inside it
        // if the restored window no longer covers the pointer)
        const [px, py] = global.get_pointer();
        this._pointerOffsetX = Math.min(
            Math.max(px - rect.x, 0),
            rect.width - 1
        );
        this._pointerOffsetY = Math.min(
            Math.max(py - rect.y, 0),
            rect.height - 1
        );
    }

    // leave fullscreen, then maximized; a fullscreen window that was maximized
    // before goes back to maximized, so this runs again after each size change
    private _restoreStep(window: Meta.Window) {
        if (window.is_fullscreen()) window.unmake_fullscreen();
        else if (window.is_maximized()) window.unmaximize();
        else if (this._needsRestore(window))
            window.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
    }

    // fullscreen, maximized or tiled; a half-screen tile is a one-axis maximize flag
    // so is_maximized() alone misses it
    private _needsRestore(window: Meta.Window): boolean {
        return (
            window.is_fullscreen() ||
            window.is_maximized() ||
            window.get_maximize_flags() !== Meta.MaximizeFlags.NONE
        );
    }

    private _finishRestore() {
        const window = this._window;
        if (
            window &&
            this._needsRestore(window) &&
            this._restoreTimeoutId
        ) {
            this._restoreStep(window);
            return;
        }
        this._cancelRestore();
        if (!window) return;
        this._setStartPosition(window);
        this._moveWindow(0, 0);
    }

    private _cancelRestore() {
        if (this._sizeChangedId) {
            this._window?.disconnect(this._sizeChangedId);
            this._sizeChangedId = 0;
        }
        if (this._restoreTimeoutId) {
            GLib.source_remove(this._restoreTimeoutId);
            this._restoreTimeoutId = 0;
        }
        this._restoring = false;
    }

    private _moveWindow(moveX: number, moveY: number) {
        const window = this._window;
        if (!window) return;

        const rect = window.get_frame_rect();
        const area = Main.layoutManager.getWorkAreaForMonitor(
            window.get_monitor()
        );

        // keep the window inside the work area (if it is larger, pin it to the top-left)
        const maxX = Math.max(area.x, area.x + area.width - rect.width);
        const maxY = Math.max(area.y, area.y + area.height - rect.height);
        const x = Math.min(Math.max(this._startX + this._dragX, area.x), maxX);
        const y = Math.min(Math.max(this._startY + this._dragY, area.y), maxY);

        // what the clamp swallowed is the push against the edge; it builds up while
        // the drag keeps going that way and resets as soon as it moves back
        this._overshootX = this._updateOvershoot(
            this._overshootX,
            moveX,
            this._startX + this._dragX - x
        );
        this._overshootY = this._updateOvershoot(
            this._overshootY,
            moveY,
            this._startY + this._dragY - y
        );
        this._updateSnap(area);

        // store the clamped offset so reversing direction responds immediately
        this._dragX = x - this._startX;
        this._dragY = y - this._startY;
        window.move_frame(true, Math.round(x), Math.round(y));

        // the cursor travels with the window
        this._pointer ??= global.stage.context
            .get_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._pointer.notify_absolute_motion(
            GLib.get_monotonic_time(),
            Math.round(x) + this._pointerOffsetX,
            Math.round(y) + this._pointerOffsetY
        );
    }

    private _updateOvershoot(current: number, move: number, excess: number) {
        if (move === 0) return current;
        if (excess === 0) return 0;
        return Math.sign(current) === Math.sign(excess)
            ? current + excess
            : excess;
    }

    // top edge maximizes, left/right edge snaps to that half (like dragging by the titlebar)
    private _updateSnap(area: Mtk.Rectangle) {
        let snap: EdgeSnap | undefined;
        if (this._overshootY <= -EDGE_SNAP_THRESHOLD) snap = 'top';
        else if (this._overshootX <= -EDGE_SNAP_THRESHOLD) snap = 'left';
        else if (this._overshootX >= EDGE_SNAP_THRESHOLD) snap = 'right';

        if (snap === this._snap) return;
        this._snap = snap;
        if (!snap) {
            this._snapPreview?.hide();
            return;
        }

        const half = area.width / 2;
        const box = {
            top: [area.x, area.y, area.width, area.height],
            left: [area.x, area.y, half, area.height],
            right: [area.x + half, area.y, half, area.height],
        }[snap];
        if (!this._snapPreview) {
            this._snapPreview = new St.Widget({
                reactive: false,
                style_class: 'tile-preview gie-tile-window-preview',
                visible: false,
            });
            Main.layoutManager.uiGroup.add_child(this._snapPreview);
        }
        this._snapPreview.set_position(box[0], box[1]);
        this._snapPreview.set_size(box[2], box[3]);
        this._snapPreview.show();
    }

    private _applySnap(window: Meta.Window, snap: EdgeSnap) {
        if (snap === 'top') {
            window.maximize();
            return;
        }
        // Super+Left/Right acts on the focused window, so focus the dragged one first
        if (window !== global.display.get_focus_window())
            Main.activateWindow(window);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            getVirtualKeyboard().sendKeys([
                Clutter.KEY_Super_L,
                snap === 'left' ? Clutter.KEY_Left : Clutter.KEY_Right,
            ]);
            return GLib.SOURCE_REMOVE;
        });
    }
}
