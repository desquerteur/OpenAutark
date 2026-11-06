# Workforce computer-use helper for Linux (protocol 4, the Windows helper's JSON-line protocol):
# reads one JSON request per line on stdin, answers one JSON line per request on stdout; the first
# line it writes is {"ready":true,"protocol":4,"pid":...,"dpiAware":true,"session":"x11"|"wayland"|...}.
# Semantics through AT-SPI 2 (gi.repository.Atspi): windows of the desktop's applications, their
# accessible trees, element actions (Action, EditableText, Value, Selection, Component). Pointer and
# keyboard input through Atspi.generate_mouse_event / generate_keyboard_event, which only reach
# applications on X11 (and XWayland): on a Wayland session those ops answer 'unavailable' instead
# of pretending. Screenshots come from the desktop app's own capture (op 'screenshot' answers
# 'unavailable'). 'presence' reports the person's idle time from X11 (XScreenSaver, linux_x11.py)
# or idleUnknown, with the time since this helper's own last input (injectedAgoMs).
# The Workforce app (B-044, linux_guard.py): an element action in its windows, a press or release
# inside the rectangles of its visible windows (also under another window) and keys while it has
# the keyboard answer 'app_window' with what they would hit (error.app) until the request carries
# `app` - the runtime asked the window whether the target is a guarded control. Presses are
# refused while its windows cannot be located, keys while no window is known to have the keyboard.
# Moves and wheel steps press nothing and need no clearance.
# B-055: 'path' replays a planned pointer path and ends in a click, a drag or wheel steps
# (linux_path.py; it replaces 'drag'); an element click may carry `path`; 'cursor' reads the
# pointer (X11) with the idle times.
# Element ids: rid = the index path inside its window ("0.3.1"); an act re-resolves it and checks the
# observed name and role first (expectName/expectRole) – a moved element is a 'conflict', nothing runs.
# Window ids: small numbers per (pid, window index), stable while this process runs.
# Never: sends a press or key event the guards did not pass, types through the clipboard,
# retries an input action, or writes anything but protocol lines to stdout.


import json
import os
import sys
import time

from linux_atspi import (APP, MAX_DEPTH, SESSION, Atspi, Fail, center, do_action, foreground, gi, has, node, resolve,
                         role_of, states, tree, walk, window_by_id, windows_list)
from linux_guard import guard_element, guard_keyboard, guard_point, idle_ms, pointer_now, pointer_zone
import linux_path

PROTOCOL = 4
LAST_INPUT = [None]
KEYSYMS = {8: 0xff08, 9: 0xff09, 13: 0xff0d, 27: 0xff1b, 32: 0x20, 33: 0xff55, 34: 0xff56, 35: 0xff57, 36: 0xff50, 37: 0xff51, 38: 0xff52,
           39: 0xff53, 40: 0xff54, 45: 0xff63, 46: 0xffff, 16: 0xffe1, 17: 0xffe3, 18: 0xffe9, 91: 0xffeb, 92: 0xffec, 93: 0xff67}
MODIFIERS = {16, 17, 18, 91, 92}


def needs_input():
    if SESSION == 'wayland':
        raise Fail('unavailable', 'Pointer and keyboard control is not possible on this Wayland session; element actions (computer.act) still work.')


def cleared(a):
    """The runtime cleared this request for the Workforce window (`app`)."""
    return bool(a.get('app'))


def send_mouse(x, y, event):
    needs_input()
    Atspi.generate_mouse_event(int(x), int(y), event)
    LAST_INPUT[0] = time.monotonic()


def press(x, y, event, ok, zone=None):
    """A press or release at (x, y) after the Workforce check (ok: cleared); zone: pointer_zone() of the op."""
    needs_input()
    if not ok:
        guard_point(int(x), int(y), pointer_zone() if zone is None else zone)
    send_mouse(x, y, event)


class PathIo:
    """What linux_path.py needs from this helper: moves, presses, the pointer, wheel steps, the guards."""

    def __init__(self, a):
        self.ok = cleared(a)

    def move(self, x, y):
        send_mouse(x, y, 'abs')

    def press(self, x, y, button, kind):
        send_mouse(x, y, 'b%d%s' % (button, kind))

    def pointer(self):
        return pointer_now()

    def wheel(self, x, y, dx, dy):
        for button, count in ((4 if dy < 0 else 5, abs(dy)), (6 if dx < 0 else 7, abs(dx))):
            for _ in range(count):
                Atspi.generate_mouse_event(x, y, 'b%dc' % button)
        LAST_INPUT[0] = time.monotonic()

    def guard(self, points):
        """Presses only where the Workforce check passed (all points before anything is sent)."""
        if self.ok:
            return
        zone = pointer_zone()
        for x, y in points:
            guard_point(int(x), int(y), zone)


def presence():
    ago = None if LAST_INPUT[0] is None else int((time.monotonic() - LAST_INPUT[0]) * 1000)
    idle = idle_ms()
    return {'idleUnknown': True, 'injectedAgoMs': ago} if idle is None else {'idleMs': idle, 'injectedAgoMs': ago}


def scroll(a):
    """Wheel steps at (x, y), or where the pointer is (-1, -1 leaves it in place); a wheel presses nothing."""
    dx, dy = int(a.get('dx') or 0), int(a.get('dy') or 0)
    needs_input()
    given = 'x' in a and 'y' in a
    at = (int(a['x']), int(a['y'])) if given else pointer_now()
    if at is None:
        raise Fail('bad_request', 'Where the pointer is cannot be read here: give x and y to scroll.')
    x, y = at if given else (-1, -1)
    for button, count in ((4 if dy < 0 else 5, min(50, abs(dy))), (6 if dx < 0 else 7, min(50, abs(dx)))):
        for _ in range(count):
            Atspi.generate_mouse_event(x, y, 'b%dc' % button)
    LAST_INPUT[0] = time.monotonic()


def act(a):
    hwnd, win, app, pid = window_by_id(int(a.get('hwnd') or 0))
    if a.get('rid') is not None:
        acc = resolve(win, str(a['rid']))
    else:
        want_name, want_aid, want_role = a.get('name'), a.get('aid'), a.get('role')
        hits, _ = walk(win, MAX_DEPTH, 400, lambda e: (not want_name or (e.get_name() or '') == want_name) and (not want_role or role_of(e) == want_role)
                       and (not want_aid or (getattr(e, 'get_accessible_id', lambda: '')() or '') == want_aid))
        if len(hits) != 1:
            raise Fail('not_found' if not hits else 'conflict', 'No element matches.' if not hits else '%d elements match. Use a ref.' % len(hits))
        acc = resolve(win, hits[0]['rid'])
    expect_name, expect_role = a.get('expectName'), a.get('expectRole')
    if expect_name is not None and (acc.get_name() or '')[:200] != expect_name:
        raise Fail('conflict', 'The element changed: expected "%s" but found "%s". Observe again before acting.' % (expect_name[:80], (acc.get_name() or '')[:80]))
    if expect_role is not None and role_of(acc) != expect_role:
        raise Fail('conflict', 'The element changed: expected a %s but found a %s. Observe again before acting.' % (expect_role, role_of(acc)))
    action, value = a.get('action'), a.get('value')
    clicked = None
    if action not in ('scroll', 'scroll_into_view'):
        guard_element(pid, acc, cleared(a))
    st = states(acc)
    if action in ('invoke', 'select'):
        if not do_action(acc, ['click', 'press', 'activate', 'jump', 'select']):
            raise Fail('unavailable', 'This element offers no action. Try click.')
    elif action == 'toggle':
        on = has(st, Atspi.StateType.CHECKED)
        if value not in ('on', 'off') or (value == 'on') != on:
            if not do_action(acc, ['toggle', 'click', 'press', 'activate']):
                raise Fail('unavailable', 'This element cannot be toggled.')
    elif action in ('expand', 'collapse'):
        if has(st, Atspi.StateType.EXPANDED) != (action == 'expand') and not do_action(acc, ['expand or contract', action, 'toggle', 'click']):
            raise Fail('unavailable', 'This element cannot be %sed.' % action)
    elif action == 'set_value':
        text, number = acc.get_editable_text_iface(), acc.get_value_iface()
        if text is not None:
            text.set_text_contents(str(value or ''))
        elif number is not None:
            number.set_current_value(float(value))
        else:
            raise Fail('unavailable', 'This element has no editable value.')
    elif action == 'focus':
        comp = acc.get_component_iface()
        if comp is None or not comp.grab_focus():
            raise Fail('unavailable', 'This element cannot take the focus.')
    elif action == 'scroll_into_view':
        comp = acc.get_component_iface()
        if comp is None or not comp.scroll_to(Atspi.ScrollType.ANYWHERE):
            raise Fail('unavailable', 'This element cannot be scrolled into view.')
    elif action == 'scroll':
        x, y = center(acc)
        button = {'up': 4, 'page_up': 4, 'down': 5, 'page_down': 5, 'left': 6, 'right': 7}.get(value or 'down', 5)
        for _ in range(3 if (value or '').startswith('page') else 1):
            send_mouse(x, y, 'b%dc' % button)
    elif action in ('click', 'double_click', 'right_click'):
        x, y = center(acc)
        if isinstance(a.get('path'), dict):
            needs_input()
            io = PathIo(a)
            io.guard([(x, y)])
            linux_path.element_click(a['path'], x, y, io, 3 if action == 'right_click' else 1, 2 if action == 'double_click' else 1)
        else:
            press(x, y, {'click': 'b1c', 'double_click': 'b1d', 'right_click': 'b3c'}[action], cleared(a))
        clicked = [int(x), int(y)]
    else:
        raise Fail('unavailable' if action and action.startswith('window_') else 'bad_request', 'Not available on Linux: %s.' % action)
    time.sleep(min(3000, max(0, int(a.get('settleMs') or 250))) / 1000.0)
    try:
        after = node(acc, 0, -1, str(a.get('rid') or ''))
        exists = True
    except Exception:  # noqa: BLE001
        after, exists = None, False
    active = foreground()
    out = {'exists': exists}
    if after is not None:
        out['element'] = after
    if active is not None:
        out['foreground'] = {'title': active[1].get_name() or ''}
    if clicked is not None:
        out['at'] = clicked
    return out


def keysym(vk):
    if 65 <= vk <= 90 or 48 <= vk <= 57:
        return vk + (32 if 65 <= vk <= 90 else 0)
    if 112 <= vk <= 135:
        return 0xffbe + (vk - 112)
    if vk in KEYSYMS:
        return KEYSYMS[vk]
    raise Fail('bad_request', 'This key is not available on Linux.')


def keycode(sym):
    # AT-SPI presses and holds keys only by hardware key code; GDK's keymap translates a keysym.
    try:
        gi.require_version('Gdk', '3.0')
        from gi.repository import Gdk
        ok, entries = Gdk.Keymap.get_default().get_entries_for_keyval(sym)
        if ok and entries:
            return int(entries[0].keycode)
    except Exception:  # noqa: BLE001
        pass
    raise Fail('unavailable', 'Key combinations need GDK on this PC; single keys work.')


def key(vks, repeat, ok):
    needs_input()
    guard_keyboard(ok)
    syms = [keysym(int(vk)) for vk in vks]
    mods = [s for vk, s in zip(vks, syms) if int(vk) in MODIFIERS]
    keys = [s for vk, s in zip(vks, syms) if int(vk) not in MODIFIERS]
    held = [keycode(s) for s in mods]
    codes = [keycode(s) for s in keys] if held else []
    for _ in range(repeat):
        if not held:
            for s in keys:
                Atspi.generate_keyboard_event(s, None, Atspi.KeySynthType.SYM)
            continue
        for code in held:
            Atspi.generate_keyboard_event(code, None, Atspi.KeySynthType.PRESS)
        for code in codes:
            Atspi.generate_keyboard_event(code, None, Atspi.KeySynthType.PRESSRELEASE)
        for code in reversed(held):
            Atspi.generate_keyboard_event(code, None, Atspi.KeySynthType.RELEASE)
    LAST_INPUT[0] = time.monotonic()


def handle(op, a):
    if op == 'ping':
        return {}
    if op == 'config':
        APP.clear()
        APP.update(int(pid) for pid in (a.get('appPids') or []))
        return {}
    if op == 'presence':
        return presence()
    if op == 'cursor':
        at = pointer_now()
        if at is None:
            raise Fail('unavailable', 'Where the pointer is cannot be read here (no X11).')
        out = presence()
        out.update({'x': int(at[0]), 'y': int(at[1])})
        return out
    if op == 'windows':
        return windows_list()
    if op == 'focus_window':
        hwnd, win, app, pid = window_by_id(int(a.get('hwnd') or 0))
        comp = win.get_component_iface()
        if comp is not None:
            comp.grab_focus()
        return {'focused': has(states(win), Atspi.StateType.ACTIVE)}
    if op in ('tree', 'find'):
        return tree(a, op == 'find')
    if op == 'act':
        return act(a)
    if op == 'click':
        count = max(1, min(3, int(a.get('count') or 1)))
        button = {'left': 1, 'middle': 2, 'right': 3}.get(a.get('button') or 'left', 1)
        press(a['x'], a['y'], 'b%dd' % button if count == 2 else 'b%dc' % button, cleared(a))
        return {}
    if op == 'move':
        send_mouse(a['x'], a['y'], 'abs')
        return {}
    if op == 'path':
        needs_input()
        return linux_path.run(a, PathIo(a))
    if op == 'scroll':
        scroll(a)
        return {}
    if op == 'type':
        text = a.get('text') or ''
        if not 0 < len(text) <= 5000:
            raise Fail('bad_request', 'text must have 1 to 5000 characters.')
        needs_input()
        guard_keyboard(cleared(a))
        Atspi.generate_keyboard_event(0, text, Atspi.KeySynthType.STRING)
        LAST_INPUT[0] = time.monotonic()
        return {}
    if op == 'key':
        key(a.get('vks') or [], max(1, min(50, int(a.get('repeat') or 1))), cleared(a))
        return {}
    if op == 'release':
        return {'released': []}
    if op in ('screenshot', 'screens', 'ocr'):
        raise Fail('unavailable', 'Not available from the Linux helper; the desktop app captures the screen.')
    raise Fail('bad_request', 'Unknown op %s.' % op)


def main():
    out = sys.stdout
    out.write(json.dumps({'ready': True, 'protocol': PROTOCOL, 'pid': os.getpid(), 'dpiAware': True, 'session': SESSION}, ensure_ascii=True) + '\n')
    out.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            rid, op, args = request.get('id'), request.get('op'), request.get('args') or {}
        except Exception:  # noqa: BLE001
            continue
        try:
            answer = {'id': rid, 'ok': True, 'result': handle(op, args)}
        except Fail as failure:
            error = {'code': failure.code, 'message': failure.message}
            if failure.app is not None:
                error['app'] = failure.app
            answer = {'id': rid, 'ok': False, 'error': error}
        except Exception as error:  # noqa: BLE001
            answer = {'id': rid, 'ok': False, 'error': {'code': 'internal', 'message': 'AT-SPI failed: %s' % str(error)[:200]}}
        out.write(json.dumps(answer, ensure_ascii=True) + '\n')
        out.flush()


if __name__ == '__main__':
    main()
