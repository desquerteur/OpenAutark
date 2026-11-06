# X11 side of the Linux computer-use helper (linux-helper.py, review fix 23.10.2026): read-only
# facts about the X11 session through libX11 with ctypes (no extra package): the top-level windows
# with their map state, rectangle and process id (_NET_WM_PID, on the window or the client window
# inside a window manager's frame), the window that has the keyboard (_NET_ACTIVE_WINDOW), where
# the pointer is, and the idle time of the person's input (XScreenSaver, when libXss is there).
# open_display() answers None without a display or libX11 (Wayland, headless, other systems); the
# protection rules that use these facts live in linux_guard.py.
# Owns: the ctypes bindings and the X11 reads. Never: sends input, changes a window or a property,
# or lets an X error end the helper (a no-op error handler is installed; a failed read is None).

import ctypes
import ctypes.util
import os

IS_VIEWABLE = 2
ANY_TYPE = 0
XA_WINDOW = 33
MAX_DEPTH = 2
MAX_CHILDREN = 4000


class _Attributes(ctypes.Structure):
    _fields_ = [('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_int), ('height', ctypes.c_int), ('border_width', ctypes.c_int),
                ('depth', ctypes.c_int), ('visual', ctypes.c_void_p), ('root', ctypes.c_ulong), ('c_class', ctypes.c_int),
                ('bit_gravity', ctypes.c_int), ('win_gravity', ctypes.c_int), ('backing_store', ctypes.c_int), ('backing_planes', ctypes.c_ulong),
                ('backing_pixel', ctypes.c_ulong), ('save_under', ctypes.c_int), ('colormap', ctypes.c_ulong), ('map_installed', ctypes.c_int),
                ('map_state', ctypes.c_int), ('all_event_masks', ctypes.c_long), ('your_event_mask', ctypes.c_long),
                ('do_not_propagate_mask', ctypes.c_long), ('override_redirect', ctypes.c_int), ('screen', ctypes.c_void_p)]


class _SaverInfo(ctypes.Structure):
    _fields_ = [('window', ctypes.c_ulong), ('state', ctypes.c_int), ('kind', ctypes.c_int), ('til_or_since', ctypes.c_ulong),
                ('idle', ctypes.c_ulong), ('event_mask', ctypes.c_ulong)]


_ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
_IGNORE = _ERROR_HANDLER(lambda display, event: 0)  # kept alive for the process: Xlib calls it on every X error


class X11(object):
    """The reads linux_guard.py needs (tests pass an object with the same methods)."""

    def __init__(self, lib, display, saver=None):
        self.lib, self.display, self.saver = lib, display, saver
        self.root = lib.XDefaultRootWindow(display)
        self.pid_atom = lib.XInternAtom(display, b'_NET_WM_PID', 1)
        self.active_atom = lib.XInternAtom(display, b'_NET_ACTIVE_WINDOW', 1)
        self.info = saver.XScreenSaverAllocInfo() if saver is not None else None

    def _card(self, window, atom, kind):
        if not atom or not window:
            return None
        actual, fmt, count, after = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong()
        data = ctypes.POINTER(ctypes.c_ubyte)()
        status = self.lib.XGetWindowProperty(self.display, window, atom, 0, 1, 0, kind, ctypes.byref(actual), ctypes.byref(fmt),
                                             ctypes.byref(count), ctypes.byref(after), ctypes.byref(data))
        try:
            if status != 0 or fmt.value != 32 or count.value < 1 or not data:
                return None
            return int(ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0])  # format 32 comes as C longs
        finally:
            if data:
                self.lib.XFree(data)

    def children(self, window):
        root, parent = ctypes.c_ulong(), ctypes.c_ulong()
        kids, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
        if not self.lib.XQueryTree(self.display, window, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(kids), ctypes.byref(count)):
            return []
        try:
            return [int(kids[i]) for i in range(min(count.value, MAX_CHILDREN))]
        finally:
            if kids:
                self.lib.XFree(kids)

    def top_windows(self):
        return self.children(self.root)

    def pid(self, window, depth=0):
        found = self._card(window, self.pid_atom, ANY_TYPE)
        if found or depth >= MAX_DEPTH:
            return found or None
        for child in self.children(window)[:50]:
            found = self.pid(child, depth + 1)
            if found:
                return found
        return None

    def rect(self, window):
        """[x, y, width, height] on the screen of a viewable window, else None."""
        attrs = _Attributes()
        if not self.lib.XGetWindowAttributes(self.display, window, ctypes.byref(attrs)) or attrs.map_state != IS_VIEWABLE:
            return None
        x, y, child = ctypes.c_int(), ctypes.c_int(), ctypes.c_ulong()
        if not self.lib.XTranslateCoordinates(self.display, window, self.root, 0, 0, ctypes.byref(x), ctypes.byref(y), ctypes.byref(child)):
            return None
        border = attrs.border_width
        return [x.value - border, y.value - border, attrs.width + 2 * border, attrs.height + 2 * border]

    def active(self):
        return self._card(self.root, self.active_atom, XA_WINDOW)

    def pointer(self):
        root, child = ctypes.c_ulong(), ctypes.c_ulong()
        x, y, wx, wy, mask = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint()
        if not self.lib.XQueryPointer(self.display, self.root, ctypes.byref(root), ctypes.byref(child), ctypes.byref(x), ctypes.byref(y),
                                      ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask)):
            return None
        return x.value, y.value

    def idle_ms(self):
        if self.info is None or not self.saver.XScreenSaverQueryInfo(self.display, self.root, self.info):
            return None
        return int(self.info.contents.idle)


def _bind(lib):
    ulong, uint, cint, ptr = ctypes.c_ulong, ctypes.c_uint, ctypes.c_int, ctypes.POINTER
    lib.XOpenDisplay.restype, lib.XOpenDisplay.argtypes = ctypes.c_void_p, [ctypes.c_char_p]
    lib.XSetErrorHandler.restype, lib.XSetErrorHandler.argtypes = ctypes.c_void_p, [_ERROR_HANDLER]
    lib.XDefaultRootWindow.restype, lib.XDefaultRootWindow.argtypes = ulong, [ctypes.c_void_p]
    lib.XInternAtom.restype, lib.XInternAtom.argtypes = ulong, [ctypes.c_void_p, ctypes.c_char_p, cint]
    lib.XFree.restype, lib.XFree.argtypes = cint, [ctypes.c_void_p]
    lib.XQueryTree.restype, lib.XQueryTree.argtypes = cint, [ctypes.c_void_p, ulong, ptr(ulong), ptr(ulong), ptr(ptr(ulong)), ptr(uint)]
    lib.XGetWindowAttributes.restype, lib.XGetWindowAttributes.argtypes = cint, [ctypes.c_void_p, ulong, ptr(_Attributes)]
    lib.XTranslateCoordinates.restype = cint
    lib.XTranslateCoordinates.argtypes = [ctypes.c_void_p, ulong, ulong, cint, cint, ptr(cint), ptr(cint), ptr(ulong)]
    lib.XGetWindowProperty.restype = cint
    lib.XGetWindowProperty.argtypes = [ctypes.c_void_p, ulong, ulong, ctypes.c_long, ctypes.c_long, cint, ulong, ptr(ulong), ptr(cint), ptr(ulong),
                                       ptr(ulong), ptr(ptr(ctypes.c_ubyte))]
    lib.XQueryPointer.restype = cint
    lib.XQueryPointer.argtypes = [ctypes.c_void_p, ulong, ptr(ulong), ptr(ulong), ptr(cint), ptr(cint), ptr(cint), ptr(cint), ptr(uint)]


def open_display():
    """The session's X11 display, or None (no DISPLAY, no libX11, the server refuses)."""
    if not os.environ.get('DISPLAY'):
        return None
    try:
        name = ctypes.util.find_library('X11')
        if not name:
            return None
        lib = ctypes.CDLL(name)
        _bind(lib)
        lib.XSetErrorHandler(_IGNORE)
        display = lib.XOpenDisplay(None)
        if not display:
            return None
        saver = None
        saver_name = ctypes.util.find_library('Xss')
        if saver_name:
            try:
                saver = ctypes.CDLL(saver_name)
                saver.XScreenSaverAllocInfo.restype, saver.XScreenSaverAllocInfo.argtypes = ctypes.POINTER(_SaverInfo), []
                saver.XScreenSaverQueryInfo.restype = ctypes.c_int
                saver.XScreenSaverQueryInfo.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(_SaverInfo)]
            except Exception:  # noqa: BLE001 - no idle time then, the rest still works
                saver = None
        return X11(lib, display, saver)
    except Exception:  # noqa: BLE001 - any binding problem means no X11 facts
        return None
