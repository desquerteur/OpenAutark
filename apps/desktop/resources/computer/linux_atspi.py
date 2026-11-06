# AT-SPI side of the Linux computer-use helper (linux-helper.py): the windows of the desktop's
# applications, their accessible trees as the protocol's nodes (roles named like the Windows
# helper's control types), element lookup by index path, and the element actions' building blocks.
# Owns: reading AT-SPI and the window/element ids. Never: generates pointer or keyboard input
# (linux-helper.py does, X11 only), writes to stdout, or decides what reaches the Workforce app (linux_guard.py).

import os
import sys

try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception as error:  # noqa: BLE001 - any import problem means no AT-SPI here
    sys.stderr.write('AT-SPI is not available (install python3-gi and gir1.2-atspi-2.0): %s\n' % error)
    sys.exit(3)

MAX_DEPTH = 40
MAX_NODES = 2000


class Fail(Exception):
    def __init__(self, code, message, app=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.app = app  # with code 'app_window': what the input would hit (linux_guard.py)


SESSION = (os.environ.get('XDG_SESSION_TYPE') or ('wayland' if os.environ.get('WAYLAND_DISPLAY') else 'x11')).lower()
APP = set()  # the Workforce app's process ids (config appPids)
WINDOW_IDS = {}
WINDOW_KEYS = {}

ROLES = {
    'push button': 'button', 'toggle button': 'button', 'button': 'button', 'check box': 'checkbox', 'radio button': 'radiobutton',
    'text': 'edit', 'entry': 'edit', 'password text': 'edit', 'editbar': 'edit', 'label': 'text', 'static': 'text', 'heading': 'text',
    'paragraph': 'text', 'combo box': 'combobox', 'list': 'list', 'list box': 'list', 'list item': 'listitem', 'menu': 'menu',
    'menu item': 'menuitem', 'check menu item': 'menuitem', 'radio menu item': 'menuitem', 'menu bar': 'menubar', 'tree': 'tree',
    'tree table': 'tree', 'tree item': 'treeitem', 'table': 'table', 'table cell': 'dataitem', 'page tab': 'tabitem',
    'page tab list': 'tab', 'frame': 'window', 'window': 'window', 'dialog': 'window', 'alert': 'window', 'panel': 'pane',
    'filler': 'pane', 'scroll pane': 'pane', 'viewport': 'pane', 'split pane': 'pane', 'section': 'group', 'document frame': 'document',
    'document web': 'document', 'link': 'hyperlink', 'image': 'image', 'icon': 'image', 'scroll bar': 'scrollbar', 'slider': 'slider',
    'spin button': 'spinner', 'status bar': 'statusbar', 'tool bar': 'toolbar', 'tool tip': 'tooltip', 'separator': 'separator',
    'progress bar': 'progressbar',
}
WINDOW_ROLES = {'frame', 'window', 'dialog', 'alert', 'file chooser'}


def role_of(acc):
    name = (acc.get_role_name() or '').lower()
    return ROLES.get(name, name.replace(' ', '') or 'unknown')


def states(acc):
    try:
        return acc.get_state_set()
    except Exception:  # noqa: BLE001
        return None


def has(state_set, state):
    return bool(state_set) and state_set.contains(state)


def extents(acc):
    try:
        comp = acc.get_component_iface()
        if comp is None:
            return None
        box = comp.get_extents(Atspi.CoordType.SCREEN)
        return [int(box.x), int(box.y), int(box.width), int(box.height)]
    except Exception:  # noqa: BLE001
        return None


def children(acc):
    try:
        count = acc.get_child_count()
    except Exception:  # noqa: BLE001
        return []
    out = []
    for i in range(min(count, 5000)):
        try:
            child = acc.get_child_at_index(i)
        except Exception:  # noqa: BLE001
            child = None
        if child is not None:
            out.append(child)
    return out


def pid_of(acc):
    try:
        return int(acc.get_process_id())
    except Exception:  # noqa: BLE001
        return 0


def windows_raw():
    desktop = Atspi.get_desktop(0)
    found = []
    for app in children(desktop):
        pid = pid_of(app)
        index = 0
        for win in children(app):
            if (win.get_role_name() or '').lower() not in WINDOW_ROLES:
                continue
            key = '%s:%s' % (pid, index)
            index += 1
            if key not in WINDOW_IDS:
                WINDOW_IDS[key] = len(WINDOW_IDS) + 1
            hwnd = WINDOW_IDS[key]
            WINDOW_KEYS[hwnd] = key
            found.append((hwnd, win, app, pid))
    return found


def window_by_id(hwnd):
    for item in windows_raw():
        if item[0] == hwnd:
            return item
    raise Fail('not_found', 'The window is gone. List the windows again.')


def foreground():
    for hwnd, win, app, pid in windows_raw():
        if has(states(win), Atspi.StateType.ACTIVE):
            return hwnd, win, app, pid
    return None


def node(acc, depth, parent, rid):
    st = states(acc)
    out = {'d': depth, 'p': parent, 'rid': rid, 'role': role_of(acc)}
    name = acc.get_name() or ''
    if name:
        out['name'] = name[:200]
    try:
        aid = acc.get_accessible_id() or ''
    except Exception:  # noqa: BLE001
        aid = ''
    if aid:
        out['aid'] = aid[:200]
    rect = extents(acc)
    if rect:
        out['rect'] = rect
    if st is not None:
        if not has(st, Atspi.StateType.SENSITIVE) and not has(st, Atspi.StateType.ENABLED):
            out['disabled'] = True
        if not has(st, Atspi.StateType.SHOWING):
            out['offscreen'] = True
        if has(st, Atspi.StateType.FOCUSED):
            out['focused'] = True
        if has(st, Atspi.StateType.CHECKABLE) or out['role'] in ('checkbox', 'radiobutton'):
            out['toggle'] = 'on' if has(st, Atspi.StateType.CHECKED) else 'off'
        if has(st, Atspi.StateType.EXPANDABLE):
            out['expand'] = 'expanded' if has(st, Atspi.StateType.EXPANDED) else 'collapsed'
        if has(st, Atspi.StateType.SELECTED):
            out['selected'] = True
    patterns = []
    action = acc.get_action_iface()
    if action is not None and action.get_n_actions() > 0:
        patterns.append('invoke')
    text = acc.get_editable_text_iface()
    value = acc.get_value_iface()
    if text is not None or value is not None:
        patterns.append('value')
    if 'toggle' in out:
        patterns.append('toggle')
    if 'expand' in out:
        patterns.append('expand')
    if patterns:
        out['patterns'] = patterns
    if value is not None:
        try:
            out['value'] = value.get_current_value()
        except Exception:  # noqa: BLE001
            pass
    elif text is not None and 'password' not in (acc.get_role_name() or ''):
        try:
            content = acc.get_text_iface().get_text(0, -1)
            if content:
                out['value'] = content[:400]
        except Exception:  # noqa: BLE001
            pass
    return out


def walk(win, max_depth, max_nodes, match=None):
    nodes = []
    truncated = [False]

    def visit(acc, depth, parent, path):
        if len(nodes) >= max_nodes:
            truncated[0] = True
            return
        index = parent
        if match is None or match(acc):
            nodes.append(node(acc, depth, parent, path))
            index = len(nodes) - 1
        if depth >= max_depth:
            return
        for i, child in enumerate(children(acc)):
            visit(child, depth + 1, index, '%s.%d' % (path, i) if path else str(i))
    visit(win, 0, -1, '')
    return nodes, truncated[0]


def resolve(win, rid):
    acc = win
    for part in (rid.split('.') if rid else []):
        kids = children(acc)
        index = int(part)
        if index >= len(kids):
            raise Fail('not_found', 'The element is gone (the UI changed). Observe again with computer.ui_tree.')  # before acting: recipes/replay.ts MOVED
        acc = kids[index]
    return acc


def do_action(acc, names):
    action = acc.get_action_iface()
    if action is None:
        return False
    count = action.get_n_actions()
    wanted = [n.lower() for n in names]
    for i in range(count):
        if (action.get_action_name(i) or '').lower() in wanted:
            return bool(action.do_action(i))
    if count and not names[0].startswith('expand'):
        return bool(action.do_action(0))
    return False


def center(acc):
    rect = extents(acc)
    if not rect or rect[2] <= 0 or rect[3] <= 0:
        raise Fail('unavailable', 'This element has no position on the screen. Scroll it into view first.')
    return rect[0] + rect[2] // 2, rect[1] + rect[3] // 2


def windows_list():
    out = []
    for hwnd, win, app, pid in windows_raw():
        st = states(win)
        item = {'hwnd': hwnd, 'title': win.get_name() or '', 'process': app.get_name() or '', 'pid': pid,
                'minimized': has(st, Atspi.StateType.ICONIFIED), 'foreground': has(st, Atspi.StateType.ACTIVE), 'app': pid in APP}
        rect = extents(win)
        if rect:
            item['rect'] = rect
        out.append(item)
    return out


def tree(a, search=False):
    hwnd = a.get('hwnd')
    item = window_by_id(int(hwnd)) if hwnd else foreground()
    if item is None:
        raise Fail('not_found', 'No window is in front. Name one (window).')
    hwnd, win, app, pid = item
    if search:
        name, aid, role = (a.get('name') or '').lower(), a.get('aid'), a.get('role')
        nodes, truncated = walk(win, MAX_DEPTH, 4000, lambda e: (not name or name in (e.get_name() or '').lower()) and (not role or role_of(e) == role)
                                and (not aid or (getattr(e, 'get_accessible_id', lambda: '')() or '') == aid))
        limit = max(1, min(100, int(a.get('max') or 20)))
        return {'hwnd': hwnd, 'nodes': nodes[:limit], 'truncated': truncated or len(nodes) > limit}
    nodes, truncated = walk(win, max(1, min(MAX_DEPTH, int(a.get('depth') or 12))), max(20, min(MAX_NODES, int(a.get('maxNodes') or 400))))
    return {'hwnd': hwnd, 'title': win.get_name() or '', 'nodes': nodes, 'truncated': truncated}
