# Test fixture (test/unit/computer/linux-path.test.ts): runs the Linux helper's pointer paths
# (resources/computer/linux_path.py, B-055) against a scripted pointer instead of X11 and prints one
# JSON line per case: what moved and pressed when (ms since the case started), or what was refused.
# Usage: python linux-path-check.py <resources/computer>. Owns: fixtures only.

import json
import sys
import time

sys.path.insert(0, sys.argv[1])

import linux_atspi  # noqa: E402
import linux_path  # noqa: E402


class FakeIo(object):
    """A pointer that follows our moves; `person_after`: after that many moves (once the helper read where its
    own move left the pointer) the person pushes it 50 px away."""

    def __init__(self, start=(0, 0), person_after=None, pointer=True):
        self.at, self.person_after, self.has_pointer = start, person_after, pointer
        self.moves, self.person, self.push_in, self.events, self.guarded = 0, None, 0, [], []
        self.t0 = time.monotonic()

    def now(self):
        return int(round((time.monotonic() - self.t0) * 1000))

    def move(self, x, y):
        self.moves += 1
        self.at = (x, y)
        self.events.append(['move', x, y, self.now()])
        if self.person_after is not None and self.moves == self.person_after:
            self.push_in = 2

    def press(self, x, y, button, kind):
        self.events.append([kind, x, y, button, self.now()])

    def pointer(self):
        if not self.has_pointer:
            return None
        if self.push_in:
            self.push_in -= 1
            if not self.push_in:
                self.person = (self.at[0] + 50, self.at[1] + 50)
        return self.person or self.at

    def wheel(self, x, y, dx, dy):
        self.events.append(['wheel', x, y, dx, dy, self.now()])

    def guard(self, points):
        self.guarded.append([list(p) for p in points])


def case(name, run, io):
    try:
        value = run(io)
        print(json.dumps({'case': name, 'ok': True, 'value': value, 'events': io.events, 'guarded': io.guarded}))
    except linux_atspi.Fail as failure:
        print(json.dumps({'case': name, 'ok': False, 'code': failure.code, 'message': failure.message, 'events': io.events, 'guarded': io.guarded}))


line = [0, 0, 0, 10, 0, 30, 20, 0, 60]
case('move on time', lambda io: linux_path.run({'steps': line, 'end': 'none', 'from': [0, 0]}, io), FakeIo())
case('double click holds', lambda io: linux_path.run({'steps': line, 'end': 'click', 'count': 2, 'pressMs': 50, 'gapMs': 30, 'dwellMs': 0}, io), FakeIo())
case('person moves mid-path', lambda io: linux_path.run({'steps': line, 'end': 'click'}, io), FakeIo(person_after=1))
case('person moved before', lambda io: linux_path.run({'steps': line, 'end': 'click', 'from': [100, 100]}, io), FakeIo())
case('drag cut by the person', lambda io: linux_path.run({'steps': [0, 0, 0], 'end': 'drag', 'drag': [10, 0, 10, 20, 0, 20, 30, 0, 30], 'dwellMs': 0, 'downMs': 0, 'settleMs': 0}, io), FakeIo(person_after=2))
case('drag', lambda io: linux_path.run({'steps': [0, 0, 0], 'end': 'drag', 'button': 'right', 'drag': [10, 0, 10, 30, 0, 20], 'dwellMs': 0, 'downMs': 0, 'settleMs': 0}, io), FakeIo())
case('wheel at the end', lambda io: linux_path.run({'steps': line, 'end': 'wheel', 'dy': 3, 'dwellMs': 0}, io), FakeIo())
case('no pointer reads', lambda io: linux_path.run({'steps': line, 'end': 'none', 'from': [500, 500]}, io), FakeIo(pointer=False))
case('t falls', lambda io: linux_path.run({'steps': [0, 0, 10, 5, 5, 5], 'end': 'none'}, io), FakeIo())
case('not numbers', lambda io: linux_path.run({'steps': [0, 'x', 0], 'end': 'none'}, io), FakeIo())
case('bad end', lambda io: linux_path.run({'steps': [0, 0, 0], 'end': 'fly'}, io), FakeIo())
case('element click bent', lambda io: linux_path.element_click({'steps': [0, 0, 0, 50, 50, 20, 100, 100, 40], 'dwellMs': 0}, 110, 90, io, 1, 1), FakeIo())
