# Test fixture (test/unit/computer/linux-driver.test.ts): runs the Linux helper's Workforce-window rules
# (resources/computer/linux_guard.py) against the scripted AT-SPI desktop (fake-gi, here with the
# Workforce app off the accessibility bus) and a scripted X11 display in place of linux_x11.py's
# ctypes reads, and prints one JSON line per case: what was refused, why and what it would hit. Usage:
# python linux-guard-check.py <resources/computer>. Owns: fixtures only.

import json
import sys

sys.path.insert(0, sys.argv[1])

import linux_atspi  # noqa: E402
import linux_guard  # noqa: E402


class FakeX11(object):
    def __init__(self, windows, active=None, pointer=None, idle=None):
        self.windows, self.active_window, self.at, self.idle = windows, active, pointer, idle

    def top_windows(self):
        return list(self.windows)

    def rect(self, window):
        return self.windows[window].get('rect')

    def pid(self, window):
        return self.windows[window].get('pid')

    def active(self):
        return self.active_window

    def pointer(self):
        return self.at

    def idle_ms(self):
        return self.idle


def case(name, run):
    try:
        value = run()
        print(json.dumps({'case': name, 'ok': True, 'value': value}))
    except linux_atspi.Fail as failure:
        print(json.dumps({'case': name, 'ok': False, 'code': failure.code, 'message': failure.message, 'app': failure.app}))


WORKFORCE = {'rect': [1000, 0, 600, 400], 'pid': 999}
EDITOR = {'rect': [100, 100, 800, 600], 'pid': 4242}
linux_atspi.APP.update([999])

linux_guard._X11[:] = [None]
case('no source locates Workforce', lambda: linux_guard.pointer_zone())

linux_guard._X11[:] = [FakeX11({7: WORKFORCE, 8: EDITOR, 9: {'rect': None, 'pid': 999}}, active=8, pointer=(150, 135), idle=1234)]
zone = []
case('X11 zone', lambda: zone.extend(linux_guard.pointer_zone()) or zone)
case('point on Workforce', lambda: linux_guard.guard_point(1100, 100, zone))
case('point on Workforce, cleared', lambda: linux_guard.guard_point(1100, 100, zone, True))
case('point on the editor', lambda: linux_guard.guard_point(150, 135, zone))
case('keyboard with the editor in front', lambda: linux_guard.guard_keyboard())
case('pointer and idle', lambda: [linux_guard.pointer_now(), linux_guard.idle_ms()])

linux_guard._X11[:] = [FakeX11({7: WORKFORCE, 8: EDITOR}, active=7)]
case('keyboard with Workforce in front (X11)', lambda: linux_guard.guard_keyboard())
case('keyboard with Workforce in front, cleared', lambda: linux_guard.guard_keyboard(True))

linux_guard._X11[:] = [FakeX11({7: {'rect': [1000, 0, 600, 400], 'pid': None}, 8: {'rect': [100, 100, 800, 600], 'pid': None}})]
case('X11 reads no process ids', lambda: linux_guard.pointer_zone())

linux_atspi.APP.clear()
case('no Workforce app here', lambda: linux_guard.pointer_zone())
