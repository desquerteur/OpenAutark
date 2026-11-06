# Pointer paths for the Linux helper (B-055, protocol 4 - the Windows helper's 'path' op; the
# runtime plans the path, runtime/computer/motion.ts): steps x, y, t (whole px, ms since the
# start) replayed on the monotonic clock, then a click (button held pressMs), a drag along a second
# path or wheel steps; an element click bends the planned path onto the element's centre. With X11
# the pointer is read after each step: the person moving it (more than a few pixels away from where
# our last step left it) stops the path with 'human_active' before anything was pressed; a drag
# already held is let go at once ('conflict'). Without X11 (no pointer reads) the path just runs.
# Owns: step validation, timing, the interruption check and the order of press and release.
# Never: presses before the guards passed (the caller's io.guard), leaves a button held, or plans
# motion itself.

import math
import time

from linux_atspi import Fail

TOLERANCE = 4
MAX_STEPS = 1000


def steps_of(a, key):
    raw = a.get(key)
    if not isinstance(raw, list) or not raw or len(raw) % 3 or len(raw) > MAX_STEPS * 3:
        raise Fail('bad_request', '%s must be 1 to %d steps of x, y, t.' % (key, MAX_STEPS))
    out, last = [], 0
    for i in range(0, len(raw), 3):
        x, y, t = raw[i:i + 3]
        for v in (x, y, t):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > 1e6:
                raise Fail('bad_request', '%s must be finite numbers.' % key)
        t = int(round(t))
        if t < last or t > 60000:
            raise Fail('bad_request', '%s: t must never fall and stay within 60 s.' % key)
        last = t
        out.append((int(round(x)), int(round(y)), t))
    return out


def _check(io, last, held):
    now = io.pointer() if last is not None else None
    if now is None or (abs(now[0] - last[0]) <= TOLERANCE and abs(now[1] - last[1]) <= TOLERANCE):
        return
    if held:
        raise Fail('conflict', 'The person moved the mouse during the drag, so it was let go early at %d,%d. Look at the screen before you go on.' % (now[0], now[1]))
    raise Fail('human_active', 'The person moved the mouse, so the pointer stopped on its way and nothing was pressed.')


def _start(a, io):
    now = io.pointer()
    want = a.get('from')
    if want is None or now is None:
        return now
    if not isinstance(want, list) or len(want) != 2 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in want):
        raise Fail('bad_request', 'from must be [x, y].')
    if abs(now[0] - int(round(want[0]))) > TOLERANCE or abs(now[1] - int(round(want[1]))) > TOLERANCE:
        raise Fail('human_active', 'The person moved the mouse since this step was planned; nothing was pressed.')
    return now


def _replay(steps, io, last, held=False):
    """Moves along the steps on time; a step that is already late is skipped (the last one never)."""
    begin = time.monotonic()
    for i, (x, y, t) in enumerate(steps):
        elapsed = (time.monotonic() - begin) * 1000.0
        if i < len(steps) - 1 and elapsed >= steps[i + 1][2]:
            continue
        if t > elapsed:
            time.sleep((t - elapsed) / 1000.0)
        _check(io, last, held)
        io.move(x, y)
        last = io.pointer()  # where the pointer really is now; None without X11
    return last


def _ms(a, key, default, top):
    return min(top, max(0, int(a.get(key) if a.get(key) is not None else default))) / 1000.0


def _click(a, steps, io, button, count):
    x, y = steps[-1][0], steps[-1][1]
    last = _replay(steps, io, _start(a, io))
    time.sleep(_ms(a, 'dwellMs', 20, 1000))
    _check(io, last, False)
    hold, gap = _ms(a, 'pressMs', 0, 500), max(0.02, _ms(a, 'gapMs', 60, 400))
    for n in range(count):
        io.press(x, y, button, 'p')
        try:
            time.sleep(hold)
        finally:
            io.press(x, y, button, 'r')
        if n + 1 < count:
            time.sleep(gap)


def button_of(a):
    button = {'left': 1, 'middle': 2, 'right': 3}.get(a.get('button') or 'left')
    if button is None:
        raise Fail('bad_request', 'button must be left, right or middle.')
    return button


def run(a, io):
    """op 'path': end none (a hover), click, drag (a['drag']: the held path) or wheel (dx, dy)."""
    steps = steps_of(a, 'steps')
    end = a.get('end') or 'none'
    fx, fy = steps[-1][0], steps[-1][1]
    if end == 'click':
        button = button_of(a)
        io.guard([(fx, fy)])
        _click(a, steps, io, button, max(1, min(3, int(a.get('count') or 1))))
        return {'done': True, 'at': [fx, fy]}
    if end == 'drag':
        button = button_of(a)
        held = steps_of(a, 'drag')
        tx, ty = held[-1][0], held[-1][1]
        io.guard([(fx, fy), (tx, ty)])  # both ends before the button goes down: never half a drag
        last = _replay(steps, io, _start(a, io))
        time.sleep(_ms(a, 'dwellMs', 40, 1000))
        _check(io, last, False)
        io.press(fx, fy, button, 'p')
        released = False
        try:
            time.sleep(_ms(a, 'downMs', 60, 1000))
            _replay(held, io, io.pointer(), True)
            time.sleep(_ms(a, 'settleMs', 60, 1000))
            io.press(tx, ty, button, 'r')
            released = True
        finally:
            if not released:
                io.press(-1, -1, button, 'r')  # never leave the button held (where the pointer is)
        return {'done': True, 'at': [tx, ty]}
    if end not in ('none', 'wheel'):
        raise Fail('bad_request', 'end must be none, click, drag or wheel.')
    last = _replay(steps, io, _start(a, io))
    if end == 'wheel':
        time.sleep(_ms(a, 'dwellMs', 20, 1000))
        _check(io, last, False)
        io.wheel(fx, fy, max(-50, min(50, int(a.get('dx') or 0))), max(-50, min(50, int(a.get('dy') or 0))))
    return {'done': True, 'at': [fx, fy]}


def element_click(a, x, y, io, button, count):
    """An element click with a planned path (op 'act'): bent onto the element's centre, then clicked."""
    steps = steps_of(a, 'steps')
    dx, dy = x - steps[-1][0], y - steps[-1][1]
    total = max(1, steps[-1][2])
    bent = [(sx + int(round(dx * t / total)), sy + int(round(dy * t / total)), t) for sx, sy, t in steps]
    bent[-1] = (x, y, bent[-1][2])
    _click(a, bent, io, button, count)
