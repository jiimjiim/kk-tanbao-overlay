# -*- coding: utf-8 -*-
"""扫雷叠加器 —— exe 入口。

打包成的是**窗口程序**（没有控制台），所以任何异常都不能就这么消失：
用户双击之后只会看到「什么也没发生」，根本没法排查。
所以这里统一做两件事：
  1. 把 stdout / stderr 接到日志文件（窗口程序里 print 默认无处可去）
  2. 崩了弹一个 MessageBox，把 traceback 尾部直接摆到用户面前

日志位置：%LOCALAPPDATA%\\扫雷叠加器\\overlay.log
"""
import datetime
import os
import sys
import traceback


def log_path():
    base = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'),
                        '扫雷叠加器')
    try:
        os.makedirs(base, exist_ok=True)
    except Exception:
        base = os.path.dirname(os.path.abspath(sys.executable))
    return os.path.join(base, 'overlay.log')


class Tee:
    """同时写到日志文件。没有控制台时 print 不该丢。"""

    def __init__(self, fp):
        self.fp = fp

    def write(self, s):
        try:
            self.fp.write(s)
            self.fp.flush()
        except Exception:
            pass
        return len(s)

    def flush(self):
        try:
            self.fp.flush()
        except Exception:
            pass

    def isatty(self):
        return False

    def fileno(self):
        raise OSError('Tee 没有真实文件描述符')


def msgbox(title, text):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, str(text), str(title), 0x10)   # MB_ICONERROR
    except Exception:
        pass


def main():
    lp = log_path()
    try:
        fp = open(lp, 'a', encoding='utf-8', buffering=1)
    except Exception:
        fp = None
    if fp is not None:
        fp.write('\n===== %s =====\n' % datetime.datetime.now().isoformat(timespec='seconds'))
        sys.stdout = Tee(fp)
        sys.stderr = Tee(fp)

    try:
        import overlay
        return overlay.main()
    except SystemExit:
        raise
    except BaseException:
        tb = traceback.format_exc()
        try:
            sys.stderr.write(tb)
        except Exception:
            pass
        msgbox('扫雷叠加器启动失败',
               '%s\n\n完整日志：\n%s' % (tb.strip()[-1500:], lp))
        return 1


if __name__ == '__main__':
    sys.exit(main())
