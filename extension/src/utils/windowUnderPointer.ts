import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

/**
 * Topmost window under the pointer, or null (desktop, dock, nothing).
 * Touchpad gestures don't move the pointer, so this is the window the user is
 * pointing at, which is not necessarily the focused one.
 */
export function getWindowUnderPointer(): Meta.Window | null {
    const [x, y] = global.get_pointer();
    let actor: Clutter.Actor | null = global.stage.get_actor_at_pos(
        Clutter.PickMode.REACTIVE,
        x,
        y
    );
    while (actor && !(actor as Meta.WindowActor).meta_window)
        actor = actor.get_parent();

    const window = (actor as Meta.WindowActor | null)?.meta_window;
    if (!window) return null;
    const type = window.get_window_type();
    if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
        return null;
    return window;
}
