# What of the Linux helper's input reaches the Workforce app, and the person's presence (review
# fix 23.10.2026; B-044: the app is operable, its guarded controls are checked by its own window –
# runtime/computer/app-guard.ts). linux-helper.py calls these before every press and key.
# Pointer rule: a press or release (a click, a drag's ends, an element's centre) inside the
# rectangle of any visible window of the app – even with another window above it: AT-SPI knows
# no stacking order, and the X11 one is not used – is refused with 'app_window' and the point,
# until the request carries `app` (the runtime cleared it). Where those windows are comes from
# AT-SPI (SHOWING and not ICONIFIED windows of the app's pids) and from X11 (viewable top-level
# windows whose _NET_WM_PID is the app's, linux_x11.py). When neither source can say where they
# are – AT-SPI does not list the app (Chromium joins the accessibility bus only when assistive
# technology is on) and X11 is not there or reads no process ids at all – every press is refused
# (it could land on a guarded control unchecked). Moves and wheel steps press nothing: no rule.
# Keyboard rule: typing and keys need a window with the keyboard that is known; the app's window
# needs the clearance, an unknown one is refused.
# Element rule: an element action in a window of the app needs the clearance (with its rectangle).
# Presence: the person's idle time from X11 (XScreenSaver) when there, else unknown.
# Without the app's pids (a headless worker has no Workforce window) nothing is refused here.
# Owns: these rules. Never: sends input, changes windows, or lets a failed X11 read open a hole
# (a read that fails counts as "cannot say", never as "no Workforce window there").

from linux_atspi import APP, Atspi, Fail, extents, foreground, has, states, windows_raw  # noqa: I001 - same directory
import linux_x11

_X11 = []  # the display, opened on first use (tests put a fake here)


def x11():
    if not _X11:
        _X11.append(linux_x11.open_display())
    return _X11[0]


def _atspi_rects():
    """(rects, located): visible app windows' rectangles; located = AT-SPI lists the app's windows and knows where each visible one is."""
    rects, listed, unknown = [], False, False
    for _hwnd, win, _app, pid in windows_raw():
        if pid not in APP:
            continue
        listed = True
        st = states(win)
        if st is not None and (has(st, Atspi.StateType.ICONIFIED) or not has(st, Atspi.StateType.SHOWING)):
            continue
        rect = extents(win)
        if rect is None:
            unknown = True  # visible, but where? Only X11 can say then
        else:
            rects.append(rect)
    return rects, listed and not unknown


def _x11_rects(display):
    """(rects, located) from X11; located only when it read at least one process id (its reads work)."""
    rects, pids = [], 0
    for window in display.top_windows():
        rect = display.rect(window)
        if rect is None:
            continue
        pid = display.pid(window)
        if pid:
            pids += 1
        if pid in APP:
            rects.append(rect)
    return rects, pids > 0


def pointer_zone():
    """The rectangles of the app's windows (see the header); raises when they cannot be known."""
    if not APP:
        return []
    rects, located = _atspi_rects()
    display = x11()
    if display is not None:
        try:
            more, seen = _x11_rects(display)
            rects, located = rects + more, located or seen
        except Exception:  # noqa: BLE001 - a failed read says nothing
            pass
    if not located:
        raise Fail('forbidden', "The Autark app's windows cannot be located on this desktop, so no click or drag is sent (it could land on a control that needs the person). Use element actions (computer.act), or turn on the desktop's accessibility support.")
    return rects


def guard_point(x, y, zone, cleared=False):
    """A press or release at (x, y): on (or under) a Workforce window it needs the clearance."""
    if cleared:
        return
    for left, top, width, height in zone:
        if left <= x < left + width and top <= y < top + height:
            raise Fail('app_window', 'This point lies on (or under) an Autark window: its guarded controls are checked first.', {'point': {'x': x, 'y': y}})


def pointer_now():
    """Where the pointer is (X11), or None."""
    display = x11()
    if display is None:
        return None
    try:
        return display.pointer()
    except Exception:  # noqa: BLE001
        return None


def guard_keyboard(cleared=False):
    if not APP:
        return
    pids = []
    display = x11()
    if display is not None:
        try:
            active = display.active()
            if active:
                pids.append(display.pid(active))
        except Exception:  # noqa: BLE001 - a failed read says nothing
            pass
    front = foreground()
    if front is not None:
        pids.append(front[3])
    if not any(pids):
        raise Fail('forbidden', 'No window is known to have the keyboard, so nothing is typed (it could reach a control of the Autark app that needs the person). Focus the target window first (computer.focus_window).')
    if any(pid in APP for pid in pids) and not cleared:
        raise Fail('app_window', 'The Autark window has the keyboard: its focused control is checked first.', {'keyboard': True})


def guard_element(pid, acc, cleared=False):
    """An element action in a window of the app needs the clearance; the element's rectangle goes with the refusal."""
    if pid not in APP or cleared:
        return
    rect = extents(acc)
    raise Fail('app_window', 'That element is in the Autark window: its guarded controls are checked first.', {'rect': rect} if rect and rect[2] > 0 and rect[3] > 0 else {})


def idle_ms():
    """Milliseconds since the person's last input (X11 XScreenSaver), or None when unknown."""
    display = x11()
    if display is None:
        return None
    try:
        return display.idle_ms()
    except Exception:  # noqa: BLE001
        return None
