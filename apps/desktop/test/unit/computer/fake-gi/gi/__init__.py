# Test fixture (test/unit/computer/linux-driver.test.ts): a stand-in for PyGObject's `gi` package
# so the Linux AT-SPI helper runs against a scripted desktop. Owns: fixtures only.

def require_version(namespace, version):
    if namespace not in ('Atspi', 'Gdk'):
        raise ValueError('unknown namespace %s' % namespace)
