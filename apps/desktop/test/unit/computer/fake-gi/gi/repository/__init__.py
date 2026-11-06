# Test fixture (test/unit/computer/linux-driver.test.ts): a scripted AT-SPI desktop with the parts
# of gi.repository.Atspi the Linux helper uses – two applications (an editor and the
# Workforce app), a few controls with actions, editable text, check and expand states – and a log
# of every action, text change and synthesized pointer/key event (FAKE_ATSPI_LOG, JSON lines).
# FAKE_ATSPI_ACTIVE=workforce puts the Workforce window in front; FAKE_ATSPI_HIDE=workforce leaves
# the Workforce app off the accessibility bus (as Chromium without assistive technology).
# No Gdk here: key combinations report 'unavailable' as on a desktop without it. Owns: fixtures only.

import json
import os


def log(entry):
    path = os.environ.get('FAKE_ATSPI_LOG')
    if path:
        with open(path, 'a') as handle:
            handle.write(json.dumps(entry) + '\n')


class _Enum(object):
    def __init__(self, names):
        for i, name in enumerate(names):
            setattr(self, name, i)


class _Box(object):
    def __init__(self, x, y, w, h):
        self.x, self.y, self.width, self.height = x, y, w, h


class _States(object):
    def __init__(self, owner):
        self.owner = owner

    def contains(self, state):
        return state in self.owner.states


class _Component(object):
    def __init__(self, owner):
        self.owner = owner

    def get_extents(self, coord):
        return _Box(*self.owner.rect)

    def grab_focus(self):
        log({'focus': self.owner.name})
        self.owner.states.add(Atspi.StateType.FOCUSED)
        return True

    def scroll_to(self, kind):
        log({'scroll_to': self.owner.name})
        return True


class _Action(object):
    def __init__(self, owner):
        self.owner = owner

    def get_n_actions(self):
        return len(self.owner.actions)

    def get_action_name(self, i):
        return self.owner.actions[i]

    def do_action(self, i):
        name = self.owner.actions[i]
        log({'action': [self.owner.name, name]})
        if name == 'toggle':
            self.owner.flip(Atspi.StateType.CHECKED)
        if name == 'expand or contract':
            self.owner.flip(Atspi.StateType.EXPANDED)
        return True


class _Text(object):
    def __init__(self, owner):
        self.owner = owner

    def set_text_contents(self, text):
        log({'set_text': [self.owner.name, text]})
        self.owner.text = text
        return True

    def get_text(self, start, end):
        return self.owner.text


class Accessible(object):
    def __init__(self, role, name, pid=0, rect=(0, 0, 0, 0), states=(), actions=(), text=None, kids=()):
        S = Atspi.StateType
        self.role, self.name, self.pid, self.rect = role, name, pid, rect
        self.states = set(states) | {S.SHOWING, S.SENSITIVE, S.ENABLED}
        self.actions, self.text, self.kids = list(actions), text, list(kids)

    def flip(self, state):
        if state in self.states:
            self.states.discard(state)
        else:
            self.states.add(state)

    def get_role_name(self): return self.role
    def get_name(self): return self.name
    def get_accessible_id(self): return ''
    def get_process_id(self): return self.pid
    def get_state_set(self): return _States(self)
    def get_child_count(self): return len(self.kids)
    def get_child_at_index(self, i): return self.kids[i]
    def get_component_iface(self): return _Component(self) if self.rect[2] else None
    def get_action_iface(self): return _Action(self) if self.actions else None
    def get_editable_text_iface(self): return _Text(self) if self.text is not None else None
    def get_text_iface(self): return _Text(self) if self.text is not None else None
    def get_value_iface(self): return None


class Atspi(object):
    StateType = _Enum(['ACTIVE', 'SHOWING', 'SENSITIVE', 'ENABLED', 'FOCUSED', 'CHECKABLE', 'CHECKED', 'EXPANDABLE', 'EXPANDED', 'SELECTED', 'ICONIFIED'])
    CoordType = _Enum(['SCREEN', 'WINDOW'])
    ScrollType = _Enum(['TOP_LEFT', 'BOTTOM_RIGHT', 'ANYWHERE'])
    KeySynthType = _Enum(['PRESS', 'RELEASE', 'PRESSRELEASE', 'SYM', 'STRING'])
    _desktop = None

    @staticmethod
    def get_desktop(index):
        if Atspi._desktop is None:
            S = Atspi.StateType
            front = os.environ.get('FAKE_ATSPI_ACTIVE') == 'workforce'
            editor = Accessible('frame', 'Notes - gedit', rect=(100, 100, 800, 600), states=[] if front else [S.ACTIVE], kids=[
                Accessible('push button', 'Save', rect=(110, 120, 80, 30), actions=['click']),
                Accessible('text', 'Body', rect=(110, 160, 600, 300), text='hello'),
                Accessible('check box', 'Wrap', rect=(110, 470, 60, 20), states=[S.CHECKABLE], actions=['toggle']),
                Accessible('tree item', 'Folder', rect=(110, 500, 120, 20), states=[S.EXPANDABLE], actions=['expand or contract']),
                Accessible('label', 'Status', rect=(110, 680, 200, 16)),
            ])
            workforce = Accessible('frame', 'Workforce', rect=(1000, 0, 600, 400), states=[S.ACTIVE] if front else [],
                                   kids=[Accessible('push button', 'Stop', rect=(1010, 10, 60, 24), actions=['click'])])
            apps = [Accessible('application', 'gedit', pid=4242, kids=[editor])]
            if os.environ.get('FAKE_ATSPI_HIDE') != 'workforce':
                apps.append(Accessible('application', 'workforce', pid=999, kids=[workforce]))
            Atspi._desktop = Accessible('desktop frame', 'main', kids=apps)
            for app in Atspi._desktop.kids:
                for window in app.kids:
                    window.pid = app.pid
        return Atspi._desktop

    @staticmethod
    def generate_mouse_event(x, y, name):
        log({'mouse': [x, y, name]})
        return True

    @staticmethod
    def generate_keyboard_event(keyval, string, kind):
        log({'key': [keyval, string, kind]})
        return True
