# -*- coding: utf-8 -*-
"""
扫雷叠加器 —— 把模拟器的推断结果半透明地叠在游戏窗口上，实时刷新。

  按 F11 开始框选：按住左键拖出一个矩形，把游戏棋盘圈进去；松开即生效。
  按 F12 取消框选、收起叠加层。
  按 F10 存证：把当前这一帧（原样像素）+ 一份识别诊断 JSON 存到「存证」目录。
              识别偶尔不对时按一下，比事后口述强得多（没有现场就只能靠猜）。

参数（宝藏数 / 炸弹数 / 刷新间隔 / 不透明度）在控制面板里改，
默认 18×18、宝藏 38、炸弹 26、不透明度 25%。

运行：
  C:\\Users\\JIIM\\.workbuddy-ai\\binaries\\python\\envs\\overlay\\Scripts\\python.exe 叠加器\\overlay.py

实现要点（都是踩过的坑）：
  · 必须开 DPI 感知。否则 tkinter 用的是逻辑像素、截屏用的是物理像素，
    在 125%/150% 缩放下一叠加就整体错位。
  · 叠加层用 SetLayeredWindowAttributes 同时开 LWA_COLORKEY + LWA_ALPHA：
    色键把纯黑抠成完全透明（连点击一起穿透），alpha 控制整体不透明度。
    只用 Tk 的 -alpha 会把整块矩形蒙上一层灰。
  · 叠加层要 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)，
    否则截屏会把自己的半透明色块拍进去 —— 越算越偏，自己污染自己。
  · 热键用 GetAsyncKeyState 轮询，不用 RegisterHotKey：
    RegisterHotKey 会**抢走** F11/F12，而且线程消息会被 Tk 的事件循环吃掉。
    轮询既不抢键，也不依赖消息循环。
"""
import ctypes
from ctypes import wintypes
import json
import os
import queue
import random
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk

from PIL import Image, ImageDraw, ImageFont, ImageGrab, ImageTk

HERE = None


def _res_dir():
    """运行时资源目录 —— bridge.js / engine_core.js / templates.json / node.exe 都在这儿。

    PyInstaller 打包之后，脚本本身在压缩包里，资源被解到 sys._MEIPASS。
    不认这个路径的话，打包出来的 exe 会报「找不到 engine_core.js」。
    """
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
    return os.path.dirname(os.path.abspath(__file__))


HERE = _res_dir()


def _data_dir():
    """可写的**持久**目录（存证用）。

    打包后 HERE 指向 sys._MEIPASS —— 那是临时解包目录，进程退出就删了，
    所以存证绝不能写那里（会"存了但找不到"）。冻结时用 exe 所在目录；
    那儿不可写（比如装在 Program Files）就退到 %LOCALAPPDATA%。
    """
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(os.path.abspath(sys.executable))
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(base, '存证')
    try:
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, '.w')
        open(probe, 'w').close()
        os.remove(probe)
        return d
    except Exception:
        d = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')),
                         '扫雷叠加器', '存证')
        os.makedirs(d, exist_ok=True)
        return d


DUMP_DIR = _data_dir()


def _slim_res(res):
    """把一帧结果削成"能存进 JSON 又够查问题"的样子。

    逐格的 probs/certain 是长度 N*3 的数组，存进去 JSON 会膨胀到几百 KB 而且人看不了；
    真正要的是"识别成了什么"（每格 state/num）+ 求解的结论摘要。
    """
    if not res:
        return None
    out = {k: v for k, v in res.items() if k not in ('cells', 'sol', 'dbg')}
    s = res.get('sol') or {}
    out['cells'] = [[c.get('gx'), c.get('gy'), c.get('state'), c.get('num'),
                     c.get('note', ''), bool(c.get('icon'))]
                    for c in (res.get('cells') or [])]
    out['sol'] = {k: v for k, v in s.items()
                  if k not in ('probs', 'certain', 'estimated', 'pCascade', 'pCache')}
    return out


# ---------------------------------------------------------------- 常量
UNKNOWN, BLANK, BLUE, YELLOW, RED, KT, KB = 0, 1, 2, 3, 4, 5, 6
STN = {0: '未知', 1: '空白', 2: '蓝', 3: '黄', 4: '红', 5: '已知宝', 6: '已知弹'}

# 配色跟 扫雷模拟器.html 保持一致
CERT_T = (21, 128, 61)        # 确定宝藏
CERT_B = (185, 28, 28)        # 确定炸弹
HINT_COL = {BLUE: (59, 130, 246), YELLOW: (217, 119, 6), RED: (220, 38, 38)}
BLANK_EDGE = (120, 133, 148)

# 概率格分两级：**看有没有炸弹可能**，不看概率大小。
#   安全格（P弹 == 0，只可能是宝藏或空地）-> 绿色，显示宝藏概率
#   危险格（P弹  > 0）                   -> 红色，显示炸弹概率
# 为什么不按概率大小分三档：扫雷里几乎每个未挖开格都带一点炸弹概率，分档会退化成
# "一片全红"，反而看不出东西。而 P弹 恰好为 0 是求解器**证明**出来的硬边界，不是拍的阈值。
#
# 配色为什么要靠**明度差**，不靠色相差：
# 叠加层默认只有 25% 不透明度，压在未挖开格的橙棕底 (173,113,43) 上，合成后
#   合成色 = 0.25*叠加色 + 0.75*橙棕底
# 橙棕底把 0.75*173 ≈ 130 的红**强行加进每一格**，于是：
#   · 填充色如果还带红（比如淡绿 (205,250,215)），合成后 R=181 > G=147，
#     格子照样是"红主导的棕"，压根没变绿。所以**绿底的红通道必须接近 0**。
#   · 红底永远红不过底色，只能靠"更暗"来表达危险。
# 实测合成后：安全底(130,145,67) vs 危险底(165,90,39) → Δ(-35,55,29)，一眼能分。
# 危险格越危险越暗（P弹 0 -> 深红，P弹 0.5+ -> 近黑红）。
SAFE_FILL = (0, 240, 145)       # 安全格底色（红通道压到 0，合成后才真的偏绿）
SAFE_DEEP = (0, 205, 110)       # 安全度拉满（更饱和的绿）
SAFE_TEXT = (0, 45, 25)         # 安全格数字（极深绿）
DANGER_FILL = (140, 20, 20)     # 危险格底色（深红）
DANGER_DEEP = (60, 0, 0)        # 危险度拉满（近黑红）
DANGER_TEXT = (255, 245, 245)   # 危险格数字（近白 —— 压在深红底上，浅红会糊）
PROB_SHOW_MIN = 0.03            # 数字低于 3% 不写，底色表达就够；写了反而糊成一片

# 推荐下一步的标记环：近黑外圈 + 白内圈。
# 为什么不用彩色环 —— 25% 不透明度下任何彩色都会被橙棕底色压平（见 prob_style 的注释），
# 而黑白环靠**明度**对比：外圈合成后 ≈ 0.75×底色（明显更暗），
# 内圈 ≈ 0.25×255 + 0.75×底色（明显更亮），在任何底色上都读得出来，也不跟绿/红填充抢色相。
# 外圈**不能是纯黑**：叠加层用色键把纯黑抠成全透明，画纯黑等于什么都没画（踩过）。
NEXT_OUTER = (20, 20, 20)
NEXT_INNER = (255, 255, 255)

VK = {'F8': 0x77, 'F9': 0x78, 'F10': 0x79, 'F11': 0x7A, 'F12': 0x7B}
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
# 合成点击走 SendInput：SetCursorPos 是"瞬移"，很多游戏（尤其按 WM_MOUSEMOVE
# 或原始输入跟踪光标的）收不到移动事件，按下弹起就落不到格子上。
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000
INPUT_MOUSE = 0

AUTODIG_MIN_GAP = 0.8           # 自动挖掘两次点击的最小间隔（秒）
AUTODIG_RETRY_AFTER = 2.5       # 点击后棋盘没变，隔多久重试一次
AUTODIG_MAX_RETRY = 3           # 连续重试这么多次仍无变化，自动关掉 F9
AUTODIG_MOVE_SETTLE_MS = 420    # 移到格子上后等这么久（人手落格后会停一下）再按下
AUTODIG_PRESS_MS = 160          # 按下保持时长（人手单击按压通常 80~180ms）
AUTODIG_RELEASE_SETTLE_MS = 350 # 弹起后等游戏处理完这次点击，再把鼠标挪走
AUTODIG_JITTER_PX = 3           # 点击落点的随机抖动（像素）——机器不会有人类的落点误差
GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080
LWA_COLORKEY = 0x00000001
LWA_ALPHA = 0x00000002
WDA_EXCLUDEFROMCAPTURE = 0x00000011
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

_user32 = ctypes.windll.user32

_UNSET = object()          # 哨兵：区分"这个参数没传"和"传了 None"


def enable_dpi_awareness():
    """必须最先调用。不开的话 125%/150% 缩放下的坐标会整体错位。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)      # per-monitor v2
        return 'per-monitor v2'
    except Exception:
        try:
            _user32.SetProcessDPIAware()
            return 'system'
        except Exception:
            return '失败'


def virtual_screen():
    return (_user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
            _user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
            _user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
            _user32.GetSystemMetrics(SM_CYVIRTUALSCREEN))


def hwnd_of(win):
    """拿 Tk 窗口真正的顶层 HWND（winfo_id 有时给的是子窗口）。"""
    h = int(win.winfo_id())
    parent = _user32.GetParent(h)
    return parent if parent else h


def key_down(vk):
    """这个键现在是不是按下状态。

    为什么用轮询而不是 RegisterHotKey：
      ① RegisterHotKey 会把 F11/F12 从别的程序手里抢走（用户可能还要用）；
      ② 它的 WM_HOTKEY 要挂在消息循环上，而 Tk 的事件循环会把消息吃掉。
    单独抽成函数是为了自检能替换掉它 —— 自检里不能真按键，
    真按 F11 会把前台窗口（浏览器之类）搞成全屏。
    """
    return bool(_user32.GetAsyncKeyState(vk) & 0x8000)


class POINT(ctypes.Structure):
    _fields_ = [('x', wintypes.LONG), ('y', wintypes.LONG)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG),
                ('mouseData', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.POINTER(wintypes.ULONG))]


class _INPUTU(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ('u',)
    _fields_ = [('type', wintypes.DWORD), ('u', _INPUTU)]


_user32.WindowFromPoint.argtypes = [POINT]
_user32.WindowFromPoint.restype = wintypes.HWND


def cursor_pos():
    """当前鼠标的物理像素坐标（进程已开 DPI 感知，和截屏坐标同系）；拿不到就 None。"""
    pt = POINT()
    if _user32.GetCursorPos(ctypes.byref(pt)):
        return pt.x, pt.y
    return None


def send_mouse(flags, dx=0, dy=0):
    """注入一个鼠标输入事件。dx/dy 只在 MOVE|ABSOLUTE 时用（虚拟屏幕归一化坐标）。"""
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(dx, dy, 0, flags, 0, None)
    return bool(_user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT)))


def abs_coords(x, y):
    """物理像素 → SendInput 绝对坐标（0~65535，虚拟屏幕坐标系）。"""
    vx, vy, vw, vh = virtual_screen()
    nx = round((x - vx) * 65535 / max(1, vw - 1))
    ny = round((y - vy) * 65535 / max(1, vh - 1))
    return max(0, min(65535, nx)), max(0, min(65535, ny))


def window_at(x, y):
    """这个点位下的顶层窗口（叠加层是 WS_EX_TRANSPARENT，不会被算进来）。"""
    return int(_user32.WindowFromPoint(POINT(int(x), int(y))) or 0)


def set_capture_excluded(hwnd, on=True):
    """让这个窗口在截屏里消失 / 恢复。
    必须开：否则叠加层自己的半透明色块会被拍进去，越算越偏（自己污染自己）。"""
    try:
        return bool(_user32.SetWindowDisplayAffinity(
            hwnd, WDA_EXCLUDEFROMCAPTURE if on else 0))
    except Exception:
        return False


def make_overlay_window(hwnd, alpha=0.25):
    """置顶 + 纯黑抠透 + 整体半透明 + 点击穿透 + 不被截屏。"""
    ex = _user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    _user32.SetWindowLongW(hwnd, GWL_EXSTYLE,
                           ex | WS_EX_LAYERED | WS_EX_TRANSPARENT
                           | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
    a = max(8, min(255, int(alpha * 255)))
    # 色键 = 纯黑：canvas 底色是 #000000，被抠成完全透明（顺带穿透点击）
    ok = _user32.SetLayeredWindowAttributes(hwnd, 0x000000, a, LWA_COLORKEY | LWA_ALPHA)
    # 不让自己的半透明色块进入截屏，否则会自己污染自己
    # （自检脚本要拍叠加效果，所以留了个关掉它的开关）
    if not os.environ.get('OVERLAY_SHOW_IN_CAPTURE'):
        set_capture_excluded(hwnd, True)
    return bool(ok)


def set_overlay_alpha(hwnd, alpha):
    a = max(8, min(255, int(alpha * 255)))
    _user32.SetLayeredWindowAttributes(hwnd, 0x000000, a, LWA_COLORKEY | LWA_ALPHA)


def find_node():
    """找一个能用的 node.exe。

    顺序要紧：**先看随包自带的那个**。
    打包成 exe 就是要让用户机器上不装 Node 也能跑，
    所以不能用 shutil.which 打头 —— 万一用户装了个又老又怪的 node，
    反而会被优先选中。
    """
    for p in (os.path.join(HERE, 'node.exe'),
              os.path.join(HERE, 'runtime', 'node.exe')):
        if os.path.exists(p):
            return p
    n = shutil.which('node')
    if n:
        return n
    for p in (r'C:\Users\JIIM\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe',
              r'C:\Program Files\nodejs\node.exe'):
        if os.path.exists(p):
            return p
    return 'node'


# ---------------------------------------------------------------- 引擎桥
class Bridge:
    """常驻 Node 进程。识别 + 求解全在那边，这边只负责喂像素、收结果。"""

    def __init__(self):
        self.p = None
        self.lock = threading.Lock()
        self.start()

    def start(self):
        self.close()
        self.p = subprocess.Popen(
            [find_node(), os.path.join(HERE, 'bridge.js')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        hello = json.loads(self.p.stdout.readline().decode('utf-8'))
        if not hello.get('ready'):
            raise RuntimeError('引擎桥没起来：%r' % (hello,))

    def call(self, hdr, payload=b''):
        with self.lock:
            if self.p is None or self.p.poll() is not None:
                self.start()
            self.p.stdin.write((json.dumps(hdr) + '\n').encode('utf-8'))
            if payload:
                self.p.stdin.write(payload)
            self.p.stdin.flush()
            line = self.p.stdout.readline()
            if not line:
                err = b''
                try:
                    err = self.p.stderr.read(600)
                except Exception:
                    pass
                raise RuntimeError('引擎桥没回话：' + err.decode('utf-8', 'replace'))
            return json.loads(line.decode('utf-8'))

    def close(self):
        if self.p is None:
            return
        try:
            self.p.stdin.write(b'{"cmd":"quit"}\n')
            self.p.stdin.flush()
            self.p.wait(timeout=2)
        except Exception:
            try:
                self.p.kill()
            except Exception:
                pass
        self.p = None


# ---------------------------------------------------------------- 采集线程
class Worker(threading.Thread):
    """不停截屏 -> 喂桥 -> 把结果丢进队列。UI 线程只管取队列重画。"""

    def __init__(self, bridge, out_q):
        super().__init__(daemon=True)
        self.bridge = bridge
        self.out_q = out_q
        self.stop_evt = threading.Event()
        self.lock = threading.Lock()
        self.region = None
        self.params = {'T': 38, 'B': 26}
        self.want = 18
        self.interval = 0.35
        self.paused = False
        self.last_capture = None
        self.cap_log = []           # 每帧截到的原始像素指纹，排查"同一画面识别结果却不同"
        self.gen = 0                # 框选换代号：区域一变就 +1，让桥把悬停读数缓存作废

    def configure(self, region=_UNSET, params=None, want=None, interval=None, paused=None):
        """改采集参数。没传的项保持原样 —— 所以"清空区域"要显式传 region=None。

        这里踩过一次：原来写的是 `if region is not None:`，
        结果 `configure(region=None)`（想清空）成了空操作，
        按 F12 之后采集线程还在傻乎乎地一直截屏 + 识别，白烧 CPU。
        用哨兵值把"没传"和"传了 None"区分开。
        """
        with self.lock:
            if region is not _UNSET:
                if region != self.region:
                    self.gen += 1   # 区域变了，旧画面上的悬停读数全部作废
                self.region = region
            if params is not None:
                self.params = dict(params)
            if want is not None:
                self.want = want
            if interval is not None:
                self.interval = interval
            if paused is not None:
                self.paused = paused

    def run(self):
        while not self.stop_evt.is_set():
            with self.lock:
                region, params, want = self.region, dict(self.params), self.want
                interval, paused = self.interval, self.paused
                gen = self.gen
            if region is None or paused:
                time.sleep(0.1)
                continue
            t0 = time.time()
            try:
                # 鼠标位置必须在**截屏的同一瞬间**采样：悬停高亮是截屏那一刻
                # 压在像素里的，晚一步就把"现在悬停哪格"对到"上一帧画面"上。
                mx = my = -1
                pos = cursor_pos()
                if pos:
                    mx, my = pos[0] - region[0], pos[1] - region[1]
                    if not (0 <= mx < region[2] - region[0]
                            and 0 <= my < region[3] - region[1]):
                        mx = my = -1          # 鼠标不在棋盘上
                im = ImageGrab.grab(bbox=region, all_screens=True).convert('RGBA')
                with self.lock:
                    self.last_capture = im.copy()      # 自检用：看它到底截到了什么
                raw = im.tobytes()
                with self.lock:
                    self.cap_log.append((round(t0, 3), len(raw), hash(raw)))
                    if len(self.cap_log) > 40:
                        del self.cap_log[:-40]
                res = self.bridge.call({'cmd': 'frame', 'w': im.width, 'h': im.height,
                                        'want': want, 'bytes': len(raw), 'params': params,
                                        'gen': gen, 'mx': mx, 'my': my}, raw)
                res['__wall'] = (time.time() - t0) * 1000
                res['__region'] = region
            except Exception as e:
                res = {'ok': False, 'error': '采集/识别异常：%s' % e}
            # 队列里只留最新一帧，旧的丢掉（叠加器要的是"现在"）
            while not self.out_q.empty():
                try:
                    self.out_q.get_nowait()
                except queue.Empty:
                    break
            self.out_q.put(res)
            time.sleep(max(0.05, interval - (time.time() - t0)))


# ---------------------------------------------------------------- 叠加层
class Overlay:
    def __init__(self, root, region, alpha, on_destroy=None):
        self.root = root
        self.region = region
        self.on_destroy = on_destroy
        x0, y0, x1, y1 = region
        self.w = max(1, x1 - x0)
        self.h = max(1, y1 - y0)
        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.geometry('%dx%d+%d+%d' % (self.w, self.h, x0, y0))
        self.win.attributes('-topmost', True)
        self.win.configure(bg='#000000')
        self.cv = tk.Canvas(self.win, width=self.w, height=self.h,
                            bg='#000000', highlightthickness=0, bd=0)
        self.cv.pack(fill='both', expand=True)
        self.win.update_idletasks()
        self.hwnd = hwnd_of(self.win)
        make_overlay_window(self.hwnd, alpha)
        self.photo = None
        self.last_img = None
        self.last_drawn = None      # 画这张图用的那一帧结果（自检要拿它跟图对账）
        self.draw_log = []          # 每次重画记一条，排查"图和数据对不上"用
        self.item = self.cv.create_image(0, 0, anchor='nw')
        self.font_cache = {}
        self.win.bind('<Destroy>', lambda e: None)

    def set_alpha(self, alpha):
        set_overlay_alpha(self.hwnd, alpha)

    def font(self, size):
        size = max(6, int(size))
        f = self.font_cache.get(size)
        if f is None:
            f = load_font(size)
            self.font_cache[size] = f
        return f

    def destroy(self):
        try:
            self.win.destroy()
        except Exception:
            pass
        if self.on_destroy:
            self.on_destroy()

    def draw(self, res):
        """把一帧结果画成图。底色必须是纯黑（色键要抠它）。"""
        sol = res.get('sol') or {}
        self.draw_log.append((len(res.get('cells') or []), bool(res.get('ok')),
                              bool(sol.get('ok')), bool(sol.get('probs')),
                              res.get('error') or sol.get('error') or ''))
        img = render_layer(res, self.w, self.h, self.font)
        self.last_img = img
        self.last_drawn = res
        self.photo = ImageTk.PhotoImage(img)
        self.cv.itemconfigure(self.item, image=self.photo)


def render_layer(res, w, h, font=None):
    """把一帧识别结果画成叠加层，返回 PIL 图。**不碰 Tk**。

    抽成纯函数是因为配色这类东西"像素检查通过 ≠ 看着对"：
    25% 不透明度下深绿/深红到底读不读得出来，只能在真截图上叠出来肉眼看。
    没有窗口的环境也要能渲染，所以不能依赖 Overlay 实例。

    底色必须是纯黑 —— 叠加层用色键把纯黑抠成全透明。
    """
    if font is None:
        font = _font_cache
    img = Image.new('RGB', (w, h), (0, 0, 0))
    d = ImageDraw.Draw(img)
    if not res.get('ok'):
        _banner(d, w, font, '识别失败：%s' % (res.get('error') or '未知原因'))
        return img

    probs = (res.get('sol') or {}).get('probs')
    certain = (res.get('sol') or {}).get('certain')
    # 注意：sx/sy/ex/ey 是**相对截图**的坐标（截的就是框选那块），
    # 而画布本身也是那块、尺寸一样 —— 所以直接用，不要再减框选原点。
    # （减过一次，整盘画到画布外面去了，一片全黑。）
    for c in res['cells']:
        x0 = int(round(c['sx'])); y0 = int(round(c['sy']))
        x1 = int(round(c['ex'])); y1 = int(round(c['ey']))
        if x1 <= x0 or y1 <= y0:
            continue
        st = c['state']
        i = c['i']
        fs = font(max(7, (y1 - y0) * 0.42))

        if st == KT:
            d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], fill=CERT_T)
            d.text(((x0 + x1) // 2, (y0 + y1) // 2), '宝', font=fs, fill=(255, 255, 255), anchor='mm')
        elif st == KB:
            d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], fill=CERT_B)
            d.text(((x0 + x1) // 2, (y0 + y1) // 2), '弹', font=fs, fill=(255, 255, 255), anchor='mm')
        elif st in (BLUE, YELLOW, RED):
            # 已挖开的数字格：只描个边 + 写上读到的数字，方便核对有没有对齐/读错
            d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], outline=HINT_COL[st], width=1)
            d.text(((x0 + x1) // 2, (y0 + y1) // 2), str(c['num']), font=fs,
                   fill=HINT_COL[st], anchor='mm')
        elif st == BLANK:
            d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], outline=BLANK_EDGE, width=1)
        else:
            # 未挖开格：这才是叠加器要回答的问题
            if not probs or i * 3 + 2 >= len(probs):
                continue
            pt, pb = probs[i * 3], probs[i * 3 + 1]
            ct = certain[i] if certain else 0
            if ct == 1:
                d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], fill=CERT_T)
                d.text(((x0 + x1) // 2, (y0 + y1) // 2), '宝', font=fs, fill=(255, 255, 255), anchor='mm')
            elif ct == 2:
                d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], fill=CERT_B)
                d.text(((x0 + x1) // 2, (y0 + y1) // 2), '弹', font=fs, fill=(255, 255, 255), anchor='mm')
            elif ct == 3:
                d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], fill=(46, 52, 64))
            else:
                # 概率格：安全格（P弹=0）绿、危险格（P弹>0）红，数字就是对应的概率。
                # 安全格显示**宝藏概率**（决定值不值得挖），危险格显示**炸弹概率**（危险多大）。
                fill, tcol, val = prob_style(pt, pb)
                d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], fill=fill)
                if val >= PROB_SHOW_MIN and (x1 - x0) >= 16:
                    d.text(((x0 + x1) // 2, (y0 + y1) // 2),
                           '%d' % round(val * 100), font=fs, fill=tcol, anchor='mm')

    # 外框：一眼看出识别出来的棋盘边界对不对
    bd = res.get('bd')
    if bd:
        d.rectangle([int(bd['x0']), int(bd['y0']),
                     int(bd['x1']), int(bd['y1'])], outline=(120, 220, 255), width=2)

    # 推荐下一步：黑白双环，压在棋盘之上。
    # 这一条必须画在格循环**外面**（循环里画会被后画的邻格盖掉半边）。
    nx = (res.get('sol') or {}).get('next')
    if nx:
        for c in res['cells']:
            if c['i'] != nx.get('i'):
                continue
            x0 = int(round(c['sx'])); y0 = int(round(c['sy']))
            x1 = int(round(c['ex'])); y1 = int(round(c['ey']))
            if x1 - x0 >= 12 and y1 - y0 >= 12:
                # 外圈往外扩 2px、两圈各 3px 宽 —— 细环（1~2px）在满屏格子里扫不到，
                # 加粗后即便在 25% 不透明度下也能一眼认出"标的是这一格"。
                d.rectangle([x0 - 2, y0 - 2, x1 + 1, y1 + 1], outline=NEXT_OUTER, width=3)
                d.rectangle([x0 + 2, y0 + 2, x1 - 3, y1 - 3], outline=NEXT_INNER, width=3)
            break

    # 求解没跑通时必须说话。否则未挖开格一个都不画，
    # 界面上看起来就是"标注凭空消失了"，用户根本不知道是标注错了还是程序挂了。
    # 注意：这一条要画在最后，压在棋盘上，保证看得见。
    if not (res.get('sol') or {}).get('ok'):
        _banner(d, w, font, '求解未通过：%s' % ((res.get('sol') or {}).get('error') or '未知原因'))
    return img


_font_map = {}


def _font_cache(size):
    """size -> ImageFont，带缓存。给 render_layer 当默认取字体函数。"""
    size = max(6, int(size))
    f = _font_map.get(size)
    if f is None:
        f = load_font(size)
        _font_map[size] = f
    return f


def _banner(d, w, font, text):
    """在图顶部压一条警示带。底色不是纯黑，所以色键不会把它抠掉。"""
    pad = 6
    f = font(15)
    try:
        tw = d.textlength(text, font=f)
    except Exception:
        tw = len(text) * 8
    bh = 26
    bw = min(w - 2 * pad, int(tw) + 2 * pad)
    d.rectangle([pad, pad, pad + bw, pad + bh], fill=(127, 29, 29), outline=(248, 113, 113))
    d.text((pad + bw // 2, pad + bh // 2), text, font=f, fill=(255, 235, 235), anchor='mm')


def _mix(a, b, w):
    """两个颜色按 w 线性混合。"""
    w = 0.0 if w < 0 else (1.0 if w > 1 else w)
    return tuple(int(a[k] + (b[k] - a[k]) * w) for k in range(3))


def prob_style(pt, pb):
    """概率格的配色。返回 (底色, 数字色, 要写的数字)。

    分界线是 `pb == 0` 这个**硬边界**，不是"概率大不大"：
    P弹 为 0 意味着求解器已经证明这格不可能是炸弹（只可能是宝藏或空地），
    这是确定的安全结论；只要 P弹 > 0 就还有踩雷的可能，必须提醒。

    底色深浅跟着对应概率走（安全格跟 P宝、危险格跟 P弹），
    这样一眼扫过去能看出"安全格有多值钱 / 危险格有多危险"，而不是只有红绿两色。
    """
    if pb <= 1e-9:
        return _mix(SAFE_FILL, SAFE_DEEP, pt / 0.5), SAFE_TEXT, pt
    return _mix(DANGER_FILL, DANGER_DEEP, pb / 0.5), DANGER_TEXT, pb


_font_path = None


def load_font(size):
    global _font_path
    if _font_path is None:
        for p in ('C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/segoeuib.ttf',
                  'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/simhei.ttf'):
            if os.path.exists(p):
                _font_path = p
                break
        else:
            _font_path = ''
    if _font_path:
        try:
            return ImageFont.truetype(_font_path, size)
        except Exception:
            pass
    return ImageFont.load_default()


# ---------------------------------------------------------------- 框选层
class Selector:
    """全屏半透明层，拖一个矩形出来。"""

    def __init__(self, root, on_done, on_cancel):
        self.on_done, self.on_cancel = on_done, on_cancel
        vx, vy, vw, vh = virtual_screen()
        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.geometry('%dx%d+%d+%d' % (vw, vh, vx, vy))
        self.win.attributes('-topmost', True)
        self.win.attributes('-alpha', 0.28)
        self.cv = tk.Canvas(self.win, bg='#101820', highlightthickness=0,
                            cursor='crosshair')
        self.cv.pack(fill='both', expand=True)
        self.cv.create_text(vw // 2, 40, text='按住左键拖出棋盘范围 · Esc 取消',
                            fill='#7dd3fc', font=('Microsoft YaHei UI', 20, 'bold'))
        self.vx, self.vy = vx, vy
        self.x0 = self.y0 = None
        self.rect = None
        self.cv.bind('<Button-1>', self._down)
        self.cv.bind('<B1-Motion>', self._move)
        self.cv.bind('<ButtonRelease-1>', self._up)
        self.win.bind('<Escape>', lambda e: self.cancel())
        self.win.focus_force()

    def _down(self, e):
        self.x0, self.y0 = e.x, e.y
        if self.rect:
            self.cv.delete(self.rect)
        self.rect = self.cv.create_rectangle(e.x, e.y, e.x, e.y,
                                             outline='#22d3ee', width=2, fill='#0e7490')

    def _move(self, e):
        if self.rect and self.x0 is not None:
            self.cv.coords(self.rect, self.x0, self.y0, e.x, e.y)

    def _up(self, e):
        if self.x0 is None:
            return
        x0, x1 = sorted((self.x0, e.x))
        y0, y1 = sorted((self.y0, e.y))
        self.destroy()
        if x1 - x0 < 40 or y1 - y0 < 40:
            self.on_cancel('框选太小了，重来一次。')
            return
        self.on_done((self.vx + x0, self.vy + y0, self.vx + x1, self.vy + y1))

    def cancel(self):
        self.destroy()
        self.on_cancel('已取消框选。')

    def destroy(self):
        try:
            self.win.destroy()
        except Exception:
            pass


# ---------------------------------------------------------------- 主程序
class App:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title('扫雷叠加器')
        self.root.attributes('-topmost', True)
        self.bridge = Bridge()
        self.out_q = queue.Queue()
        self.worker = Worker(self.bridge, self.out_q)
        self.worker.start()

        self.overlay = None
        self.selector = None
        self.last_hash = None
        self.last_res = None
        self.prev_keys = {}
        self.frame_seq = 0
        # 当前生效的参数，指纹要用（见 _tick_results 里那段注释）
        self.cur_params = {'T': 38, 'B': 26}
        self.cur_want = 18
        self.last_dump = 0.0           # 自动存证的限流用
        self.dump_count = 0
        # F9 自动挖掘的状态（开关本身是 self.v_autodig，在 _build_ui 里建）
        self.last_click_fp = None      # 上次点击时的棋盘指纹：没变说明那一下没生效
        self.last_click_t = 0.0        # 上次点击时刻：限流
        self.click_busy = False        # 一次点击（移动→按下→弹起→挪鼠标）正在半路上
        self.click_retry = 0           # 连续多少次点击后棋盘没变化
        self.dig_hwnd = None           # 自动挖掘认定的游戏窗口（换框选时重置）
        self.finish_fired = False      # "宝藏找齐自动收工"只触发一次（重框选时复位）

        self._build_ui()
        self.root.protocol('WM_DELETE_WINDOW', self.quit)
        self.root.after(30, self._tick_keys)
        self.root.after(40, self._tick_results)
        self._set_status('就绪 —— 按 F11 框选棋盘范围。')

    # ---------- 控制面板 ----------
    def _build_ui(self):
        pad = dict(padx=8, pady=3)
        f = ttk.LabelFrame(self.root, text='参数')
        f.grid(row=0, column=0, sticky='ew', padx=8, pady=(8, 4))

        self.v_want = tk.IntVar(value=18)
        self.v_T = tk.IntVar(value=38)
        self.v_B = tk.IntVar(value=26)
        self.v_alpha = tk.IntVar(value=25)
        self.v_interval = tk.IntVar(value=350)

        rows = [('棋盘边长（识别用）', self.v_want, 3, 25),
                ('宝藏总数', self.v_T, 0, 999),
                ('炸弹总数', self.v_B, 0, 999),
                ('不透明度 %', self.v_alpha, 8, 100),
                ('刷新间隔 ms', self.v_interval, 100, 3000)]
        for r, (lab, var, lo, hi) in enumerate(rows):
            ttk.Label(f, text=lab).grid(row=r, column=0, sticky='w', **pad)
            sp = ttk.Spinbox(f, from_=lo, to=hi, textvariable=var, width=8,
                             command=self._on_param)
            sp.grid(row=r, column=1, sticky='e', **pad)
            sp.bind('<Return>', lambda e: self._on_param())
            sp.bind('<FocusOut>', lambda e: self._on_param())
        f.columnconfigure(1, weight=1)

        g = ttk.LabelFrame(self.root, text='操作')
        g.grid(row=1, column=0, sticky='ew', padx=8, pady=4)
        ttk.Button(g, text='框选棋盘  (F11)', command=self.start_select).grid(
            row=0, column=0, sticky='ew', **pad)
        ttk.Button(g, text='取消框选  (F12)', command=self.cancel_select).grid(
            row=1, column=0, sticky='ew', **pad)
        self.v_pause = tk.BooleanVar(value=False)
        ttk.Checkbutton(g, text='暂停刷新', variable=self.v_pause,
                        command=self._on_pause).grid(row=2, column=0, sticky='w', **pad)
        self.v_autodig = tk.BooleanVar(value=False)
        ttk.Checkbutton(g, text='自动挖开推荐格  (F9)', variable=self.v_autodig,
                        command=self._on_autodig).grid(row=3, column=0, sticky='w', **pad)
        ttk.Button(g, text='存下这一帧  (F10)', command=self.dump_frame).grid(
            row=4, column=0, sticky='ew', **pad)
        g.columnconfigure(0, weight=1)

        s = ttk.LabelFrame(self.root, text='状态')
        s.grid(row=2, column=0, sticky='nsew', padx=8, pady=(4, 8))
        self.lb_status = ttk.Label(s, text='', wraplength=260, justify='left')
        self.lb_status.grid(row=0, column=0, sticky='w', **pad)
        self.lb_info = ttk.Label(s, text='', wraplength=260, justify='left',
                                 foreground='#0f766e')
        self.lb_info.grid(row=1, column=0, sticky='w', **pad)
        ttk.Label(s, text='F11 框选 · F12 取消 · F10 存证 · F9 自动挖掘\n'
                          '叠加层 25%% 透明且点击穿透，可正常操作游戏窗口。\n'
                          '识别不对时按 F10：帧图 + 诊断存到「存证」目录。',
                  foreground='#64748b', justify='left').grid(row=2, column=0, sticky='w', **pad)
        s.columnconfigure(0, weight=1)
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(2, weight=1)

    def _on_param(self):
        try:
            params = {'T': max(0, self.v_T.get()), 'B': max(0, self.v_B.get())}
            want = max(3, min(25, self.v_want.get()))
            alpha = max(0.08, min(1.0, self.v_alpha.get() / 100.0))
            interval = max(0.1, self.v_interval.get() / 1000.0)
        except Exception:
            return
        self.worker.configure(params=params, want=want, interval=interval)
        self.cur_params, self.cur_want = params, want
        if self.overlay:
            self.overlay.set_alpha(alpha)
        self.last_hash = None          # 参数变了，强制重画

    def _on_pause(self):
        self.worker.configure(paused=self.v_pause.get())
        self._set_status('已暂停刷新。' if self.v_pause.get() else '继续刷新。')

    def _set_status(self, txt):
        self.lb_status.configure(text=txt)

    # ---------- 热键轮询 ----------
    def _tick_keys(self):
        for name, vk in VK.items():
            down = key_down(vk)
            if down and not self.prev_keys.get(name):
                if name == 'F11':
                    self.start_select()
                elif name == 'F12':
                    self.cancel_select()
                elif name == 'F10':
                    self.dump_frame('手动')
                elif name == 'F9':
                    self.v_autodig.set(not self.v_autodig.get())
                    self._on_autodig()
            self.prev_keys[name] = down
        self.root.after(30, self._tick_keys)

    def _on_autodig(self):
        if self.v_autodig.get():
            # 新开的开关允许立刻点第一下
            self.last_click_fp = None
            self.last_click_t = 0.0
            self.click_retry = 0
            self.dig_hwnd = None
            self._set_status('F9 自动挖掘已开启 —— 程序会移动鼠标去点推荐格（白框），'
                             '点完把鼠标挪到棋盘外。再按 F9 停止。')
        else:
            self._set_status('F9 自动挖掘已停止。')

    # ---------- 存证 ----------
    def dump_frame(self, tag='手动', auto=False):
        """把"叠加器看到的那一帧"连同识别/求解诊断一起落盘。

        为什么需要它：识别偶发不稳（"挖开十几二十格之后就不对了，重新框选才好"）
        这类问题没有现场就查不动 —— 用户手里没有案例，改代码的人也没有。
        所以按 F10 就能把当前这一帧**原样**存下来：叠加层是 SetWindowDisplayAffinity
        排除在截屏之外的，所以存下来的就是识别真正看到的像素；
        再附一份带 debug 的诊断 JSON（格线、颜色档、每格亮度/字形、求解结论）。

        自动存证（识别失败时）做了限流，免得一直坏就一直写盘。
        """
        with self.worker.lock:
            im = None if self.worker.last_capture is None else self.worker.last_capture.copy()
            region = self.worker.region
        if im is None:
            if not auto:
                self._set_status('还没开始采集，没有帧可存。')
            return
        now = time.time()
        if auto and (now - self.last_dump < 20 or self.dump_count >= 8):
            return
        self.last_dump, self.dump_count = now, self.dump_count + 1
        try:
            stamp = time.strftime('%Y%m%d_%H%M%S')
            png = os.path.join(DUMP_DIR, '异常_%s_%s.png' % (stamp, tag))
            js = os.path.join(DUMP_DIR, '异常_%s_%s.json' % (stamp, tag))
            im.convert('RGB').save(png)
            dbg = None
            try:
                dbg = self.bridge.call(
                    {'cmd': 'frame', 'w': im.width, 'h': im.height, 'want': self.cur_want,
                     'bytes': im.width * im.height * 4, 'params': self.cur_params,
                     'debug': True},
                    im.convert('RGBA').tobytes())
            except Exception as e:
                dbg = {'ok': False, 'error': '重跑诊断失败：%s' % e}
            info = {
                'time': time.strftime('%Y-%m-%d %H:%M:%S'),
                'tag': tag, 'region': region,
                'params': self.cur_params, 'want': self.cur_want,
                'frame': {'w': im.width, 'h': im.height},
                '重跑诊断': dbg,
                '当时那一帧的结果': _slim_res(self.last_res),
                '说明': '帧图就是叠加器当时看到的像素（叠加层已被排除在截屏外）。'
                        '「重跑诊断」是用同一张图重跑一次识别的 debug 输出。',
            }
            with open(js, 'w', encoding='utf-8') as f:
                json.dump(info, f, ensure_ascii=False, indent=1)
            self._set_status('已存证：%s（+ 同名 .json 诊断）' % os.path.basename(png))
        except Exception as e:
            self._set_status('存证失败：%s' % e)

    # ---------- 框选 ----------
    def start_select(self):
        if self.selector:
            return
        if self.overlay:
            self.overlay.destroy()
            self.overlay = None
        self.worker.configure(region=None)
        self.selector = Selector(self.root, self._on_selected, self._on_select_cancel)
        self._set_status('框选中：拖出棋盘范围，Esc 取消。')

    def cancel_select(self):
        """F12：不管是"框选层还开着"还是"叠加层已经建好"，都收干净。"""
        if self.selector:
            # cancel() 会回调 _on_select_cancel，把 self.selector 置空
            self.selector.cancel()
        if self.overlay:
            self.overlay.destroy()
            self.overlay = None
        # 必须真的清空：否则采集线程会继续截屏 + 识别（configure 现在用哨兵值区分了）
        self.worker.configure(region=None)
        self.last_hash = None
        self.dig_hwnd = None
        self.lb_info.configure(text='')
        self._set_status('已取消框选。按 F11 重新框选。')

    def _on_select_cancel(self, msg):
        self.selector = None
        self._set_status(msg)

    def _on_selected(self, region):
        self.selector = None
        self.worker.configure(region=region)
        alpha = max(0.08, min(1.0, self.v_alpha.get() / 100.0))
        self.overlay = Overlay(self.root, region, alpha)
        self.last_hash = None
        self.dig_hwnd = None        # 新棋盘，重新认定游戏窗口
        self.finish_fired = False   # 新的一局，找齐判定重新武装
        self._set_status('已框选 %d×%d，正在识别…' % (region[2] - region[0], region[3] - region[1]))

    # ---------- 取结果重画 ----------
    def size_mismatch(self, res):
        """识别到的棋盘尺寸和设定边长不符吗？

        这是"识别不稳"最典型、也**最隐蔽**的表现：bridge 不会报错（ok 仍是 true），
        叠加层照样画，只是画在错位的格子上。用户看到的是"一片错位的绿红"，
        分不清是识别错了还是自己框歪了；而且以前既没有提示、也不会存证，
        于是只能说"就是不太对，但没有具体案例"。

        所以判定条件特意包含 `res['ok']` —— 失败的情况由另一条分支处理，
        两条别重复报。`want` 取 `cur_want`（用户界面上那个"棋盘边长"），
        而不是 bridge 回来的 `res['auto']`：用户设了 18 却认成 17，就是要报。
        """
        return bool(res.get('ok')) and (
            res.get('nW') != self.cur_want or res.get('nH') != self.cur_want)

    def _tick_results(self):
        try:
            res = self.out_q.get_nowait()
        except queue.Empty:
            self.root.after(40, self._tick_results)
            return

        self.last_res = res
        size_bad = self.size_mismatch(res)
        if not res.get('ok'):
            # 识别失败就自动存一次现场（限流见 dump_frame）——
            # 这类"偶发认不出来"的问题，没有现场图就只能靠猜。
            self.dump_frame('识别失败', auto=True)
        elif size_bad:
            self.dump_frame('棋盘尺寸不符', auto=True)
        if self.overlay:
            if res.get('ok'):
                # 只有结果变了才重画，省 CPU。
                # 推荐格也要进指纹 —— 否则"格子没变但推荐变了"时叠加层不会重画，
                # 表现是黑框停在上一次的推荐格上，看起来像推荐算错了。
                #
                # 【2026-09-25 修】指纹必须覆盖**所有参与绘制的东西**，
                # 因为 render_layer() 读的是 probs / certain / cells / next / sol.ok|error：
                #   · params（T/B）与 want 以前**根本没进指纹**。改"宝藏总数"之后
                #     probs 整片都变、certain 也可能变，但 cells 与 next.i 可能一个都没变
                #     → 指纹相同 → 不重画 → 叠加层停在旧配色上，看起来像识别/求解错了。
                #     用户只能"重新框选"（那会把 last_hash 清空）才恢复。
                #   · certain 以前写成 `1 if v else 0`，把 1(宝)/2(弹)/3(空) 全压成 1，
                #     "宝 ↔ 弹 ↔ 空"之间互变就检测不到。存完整取值。
                #   · 求解失败时 sol 里只有 error，也要进指纹（否则横幅会停在旧文字上）。
                # probs 故意**不进**指纹：抽样近似路径下它每帧都会抖，
                # 进了会让叠加层每帧重画（CPU 白烧），而抖动量在视觉上不可辨。
                nx = (res.get('sol') or {}).get('next') or {}
                s = res.get('sol') or {}
                h = (res['nW'], res['nH'], res['opened'],
                     self.cur_params.get('T'), self.cur_params.get('B'), self.cur_want,
                     tuple((c['state'], c['num']) for c in res['cells']),
                     tuple(s.get('certain') or ()),
                     nx.get('i'), s.get('error') or '')
                if h != self.last_hash:
                    self.last_hash = h
                    self.overlay.draw(res)
                self.frame_seq += 1
                s = res.get('sol') or {}
                # 尺寸不符时在信息栏最前面挂一条警示 —— 否则用户看到的就是
                # "一片错位的绿红"，根本不知道是识别错了还是自己框错了。
                warn = ''
                if size_bad:
                    warn = ('⚠ 识别到的棋盘是 %d×%d，与设定边长 %d 不符：\n'
                            '   格线没对准（框选范围偏了 / 格线太淡）。'
                            '已自动存证到「存证」目录。\n'
                            % (res['nW'], res['nH'], self.cur_want))
                if s.get('ok'):
                    certain = s.get('certain') or []
                    nt = sum(1 for v in certain if v == 1)
                    nb = sum(1 for v in certain if v == 2)
                    extra = ('  降级 %d 格' % s['degraded']) if s.get('degraded') else ''
                    nx = s.get('next')
                    nxline = ''
                    if nx:
                        nxline = ('\n推荐下一步：第 %d 行 · 第 %d 列（白框）\n%s'
                                  % (nx['gy'] + 1, nx['gx'] + 1, nx['reason']))
                    self.lb_info.configure(
                        text=warn + '%d×%d · 已挖开 %d 格 · 确定宝藏 %d / 炸弹 %d%s\n识别 %dms · 求解 %dms · 刷新 %dms%s'
                             % (res['nW'], res['nH'], res['opened'], nt, nb, extra,
                                res['ms']['rec'], res['ms']['solve'], res.get('__wall', 0), nxline))
                    self._set_status('叠加中 —— F12 取消。')
                    if self.v_autodig.get():
                        self._maybe_autodig(res)
                    # 找齐判定：识别到的**已挖开宝藏**（兔子图标）达到设定总数。
                    # 只数已挖开的 —— 求解器的"确定宝藏"（certain==1）还没真挖到手，
                    # 不算"找到"。触发一次后直到下次框选才复位。
                    known_t = sum(1 for c in res['cells'] if c['state'] == KT)
                    if (not self.finish_fired and self.cur_params.get('T', 0) > 0
                            and known_t >= self.cur_params['T']):
                        self.finish_fired = True
                        if self.v_autodig.get():
                            self.v_autodig.set(False)   # 先停手，别在收工提示后还补一刀
                        self.cancel_select()
                        self._set_status('%d 个宝藏已全部找到 —— 已停止自动挖掘、清除框选。'
                                         '按 F11 可重新框选开新局。' % known_t)
                else:
                    self.lb_info.configure(text=warn + '求解失败：%s' % s.get('error', '?'))
            else:
                self.lb_info.configure(text='识别失败：%s' % res.get('error', '?'))
        self.root.after(40, self._tick_results)

    # ---------- F9 自动挖掘 ----------
    def _maybe_autodig(self, res):
        """点掉当前推荐格（白框那格）。

        限流与重试：
          · 距上次点击 ≥ AUTODIG_MIN_GAP 秒 —— 给游戏留出动画/重算的时间；
          · 棋盘指纹和上次点击时**相同** = 那一下没生效（没点中/游戏不认合成点击）
            → 隔 AUTODIG_RETRY_AFTER 秒重试；连试 AUTODIG_MAX_RETRY 次仍无变化
            就自动关掉 F9 —— 绝不隔着旧局面无限乱点。
        点完必须把鼠标挪出棋盘（_park_cursor）：悬停保持会把刚点开的格子
        冻在旧读数上（见 bridge.js），鼠标不挪走指纹就不会变，挖掘原地卡死。
        """
        if self.click_busy or self.selector:
            return
        now = time.time()
        if now - self.last_click_t < AUTODIG_MIN_GAP:
            return
        sol = res.get('sol') or {}
        nx = sol.get('next')
        if not nx:
            return
        fp = (res['nW'], res['nH'],
              tuple((c['state'], c['num']) for c in res['cells']))
        if fp == self.last_click_fp:
            if now - self.last_click_t < AUTODIG_RETRY_AFTER:
                return
            self.click_retry += 1
            if self.click_retry >= AUTODIG_MAX_RETRY:
                self.v_autodig.set(False)
                self._set_status('连续 %d 次点击棋盘都没变化，F9 已自动关闭。'
                                 '检查游戏窗口有没有被挡住/最小化，或按 F10 存证。'
                                 % self.click_retry)
                return
        else:
            self.click_retry = 0
        region = res.get('__region')
        cell = next((c for c in res['cells'] if c['i'] == nx.get('i')), None)
        if not region or cell is None:
            return
        x = int(region[0] + (cell['sx'] + cell['ex']) / 2)
        y = int(region[1] + (cell['sy'] + cell['ey']) / 2)
        # 落点底下必须始终是同一个窗口：不是游戏窗口（比如用户把别的窗口
        # 挪到了棋盘上）时点下去就是乱点，宁可停。
        hwnd = window_at(x, y)
        if not hwnd:
            return
        if self.dig_hwnd is None:
            self.dig_hwnd = hwnd
        elif hwnd != self.dig_hwnd:
            self._set_status('自动挖掘暂停：推荐格位置下的窗口变了，不是游戏窗口。'
                             '把游戏挪回原位后重开 F9。')
            return
        self.last_click_fp = fp
        self.last_click_t = now
        self.click_busy = True
        self._set_status('自动挖掘：第 %d 行 · 第 %d 列（第 %d 次尝试）…'
                         % (nx['gy'] + 1, nx['gx'] + 1, self.click_retry + 1))
        self._do_click(x, y)

    def _do_click(self, x, y):
        """在格子上完成一次"移动 → 按下 → 保持 → 弹起 → 挪出棋盘"。

        节奏按人手来（上次被游戏拒收的教训：事件发得太"机器"了）：
          · 落点带 ±3px 随机抖动 —— 人没有像素级精度；
          · 移动分两段：先落到格子附近，再"减速滑进"最终落点 ——
            人手到任何位置都带微动，一步瞬移到位很多游戏不认；
          · 落定后停 ~0.4s 才按下（人瞄准需要时间），按下保持 ~0.16s 再弹起
            （人手单击按压通常 80~180ms，太快会被输入队列合并），
            弹起后再等 ~0.35s 让游戏处理完，才把鼠标挪走；
          · 每段间隔都带 ±15~20% 随机浮动，不产生机器般的等间隔节拍。
        全程用 SendInput 注入（绝对坐标移动）：SetCursorPos 的瞬移很多游戏
        收不到配套的 WM_MOUSEMOVE。若 SendInput 被拒（比如游戏以管理员
        运行而本程序没有）则退回 SetCursorPos。
        """
        jit = lambda lim: random.randint(-lim, lim)
        tx, ty = x + jit(AUTODIG_JITTER_PX), y + jit(AUTODIG_JITTER_PX)
        var = lambda ms: int(ms * random.uniform(0.85, 1.2))

        def _abs(px, py):
            nx, ny = abs_coords(px, py)
            if not send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
                              | MOUSEEVENTF_VIRTUALDESK, nx, ny):
                _user32.SetCursorPos(px, py)

        t0 = var(70)                                    # 先落到格子附近
        t1 = t0 + var(80)                               # 减速滑进最终落点
        t2 = t1 + var(AUTODIG_MOVE_SETTLE_MS)           # 瞄准停顿后按下
        t3 = t2 + var(AUTODIG_PRESS_MS)                 # 保持按压后弹起
        t4 = t3 + var(AUTODIG_RELEASE_SETTLE_MS)        # 游戏消化完再挪鼠标

        self.root.after(t0, lambda: _abs(tx + 5, ty - 3))
        self.root.after(t1, lambda: _abs(tx, ty))
        self.root.after(t2, lambda: send_mouse(MOUSEEVENTF_LEFTDOWN))
        self.root.after(t3, lambda: send_mouse(MOUSEEVENTF_LEFTUP))
        self.root.after(t4, self._after_click)

    def _after_click(self):
        if self.overlay:
            self._park_cursor(self.overlay.region)
        self.click_busy = False

    def _park_cursor(self, region):
        """把鼠标挪到棋盘外最近的一侧。"""
        x0, y0, x1, y1 = region
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        cur = cursor_pos() or (cx, cy)
        vx, vy, vw, vh = virtual_screen()
        cands = sorted([(x0 - 24, cy), (x1 + 24, cy), (cx, y0 - 24), (cx, y1 + 24)],
                       key=lambda p: (p[0] - cur[0]) ** 2 + (p[1] - cur[1]) ** 2)
        for p in cands:
            if vx <= p[0] < vx + vw and vy <= p[1] < vy + vh:
                nx, ny = abs_coords(p[0], p[1])
                if not send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
                                  | MOUSEEVENTF_VIRTUALDESK, nx, ny):
                    _user32.SetCursorPos(int(p[0]), int(p[1]))
                return
        _user32.SetCursorPos(vx + 8, vy + 8)

    # ---------- 退出 ----------
    def quit(self):
        # 顺序要紧：先让采集线程停下，再关桥。
        # 反过来的话线程可能正握着已经关掉的管道写，会抛 OSError（间歇性，难查）。
        try:
            self.worker.stop_evt.set()
            self.worker.join(timeout=2.0)
        except Exception:
            pass
        try:
            self.bridge.close()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass

    def run(self):
        self.root.mainloop()


def _selftest(argv):
    """不开窗口，拿一张 PNG 走一遍完整链路（除了截屏那一步之外的所有环节）。

      扫雷叠加器.exe --selftest 图片.png [--want 18] [--T 38] [--B 26]

    为什么要有这个：打包成 exe 之后最怕的就是「少了某个数据文件」，
    而窗口程序没控制台、崩了也看不见。这个模式能把
    node / bridge.js / engine_core.js / templates.json / 识别 / 求解
    全部串起来验一遍，是打包产物的真·冒烟测试。
    """
    import time as _t
    path = None
    want, T, B = 18, 38, 26
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--want' and i + 1 < len(argv):
            want = int(argv[i + 1]); i += 2; continue
        if a == '--T' and i + 1 < len(argv):
            T = int(argv[i + 1]); i += 2; continue
        if a == '--B' and i + 1 < len(argv):
            B = int(argv[i + 1]); i += 2; continue
        if path is None:
            path = a
        i += 1

    if not path or not os.path.exists(path):
        print('[selftest] 用法：--selftest <图片.png> [--want 18] [--T 38] [--B 26]')
        return 2

    print('[selftest] 资源目录 %s' % HERE)
    for f in ('bridge.js', 'engine_core.js', 'templates.json'):
        p = os.path.join(HERE, f)
        print('[selftest]   %-16s %s' % (f, ('%d 字节' % os.path.getsize(p)) if os.path.exists(p) else '**缺失**'))
    nd = find_node()
    print('[selftest] node: %s  %s' % (nd, '存在' if os.path.exists(nd) else '**不存在**'))

    im = Image.open(path).convert('RGBA')
    raw = im.tobytes()
    print('[selftest] 图片 %dx%d  %d 字节 RGBA' % (im.width, im.height, len(raw)))

    br = Bridge()
    try:
        t0 = _t.time()
        r = br.call({'cmd': 'frame', 'w': im.width, 'h': im.height, 'want': want,
                     'bytes': len(raw), 'params': {'T': T, 'B': B}}, raw)
        dt = (_t.time() - t0) * 1000
        print('[selftest] 桥握手 ping -> %s' % br.call({'cmd': 'ping'}).get('pong'))
        if not r.get('ok'):
            print('[selftest] 识别失败：%s' % r.get('error'))
            return 1
        print('[selftest] 识别+求解 ok，耗时 %.0fms（识别 %d / 求解 %d）'
              % (dt, r['ms']['rec'], r['ms']['solve']))
        print('[selftest] 棋盘 %dx%d  已挖开 %d 格' % (r['nW'], r['nH'], r['opened']))
        stn = {1: '空白', 2: '蓝·宝', 3: '黄·混', 4: '红·弹', 5: '已知宝', 6: '已知弹'}
        cnt = {}
        for c in r['cells']:
            if c['state']:
                cnt[stn.get(c['state'], c['state'])] = cnt.get(stn.get(c['state'], c['state']), 0) + 1
        print('[selftest] 分布 ' + '  '.join('%s %d' % kv for kv in sorted(cnt.items())))
        s = r.get('sol') or {}
        if not s.get('ok'):
            print('[selftest] 求解未通过：%s' % s.get('error'))
            return 1
        cert = s.get('certain') or []
        print('[selftest] 求解 ok · 确定宝藏 %d / 确定炸弹 %d / 确定空地 %d · 降级 %d'
              % (sum(1 for v in cert if v == 1), sum(1 for v in cert if v == 2),
                 sum(1 for v in cert if v == 3), s.get('degraded', 0)))
        N = r['nW'] * r['nH']
        ok_len = len(s['probs']) == N * 3
        print('[selftest] 概率数组 %d（应为 %d）%s' % (len(s['probs']), N * 3,
                                                   'ok' if ok_len else '**长度不对**'))
        nx = s.get('next')
        if nx:
            print('[selftest] 推荐下一步 (%d,%d) [%s] 宝%.0f%% 弹%.0f%% 空%.0f%% 连锁%.0f%% · %s'
                  % (nx['gy'] + 1, nx['gx'] + 1, nx['kind'],
                     nx['pt'] * 100, nx['pb'] * 100, nx['pe'] * 100,
                     nx.get('pc', 0) * 100, nx['reason']))
        else:
            print('[selftest] 推荐下一步：无（没有未挖开格？）')
        return 0 if (ok_len and nx) else 1
    finally:
        br.close()


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == '--selftest':
        mode = enable_dpi_awareness()
        print('[selftest] DPI 感知：%s' % mode)
        return _selftest(argv[1:])
    mode = enable_dpi_awareness()
    print('DPI 感知：%s' % mode)
    if not os.path.exists(os.path.join(HERE, 'engine_core.js')):
        print('缺少 engine_core.js —— 先跑：node 叠加器/建引擎.js')
        return 1
    app = App()
    print('就绪。F11 框选 / F12 取消。')
    app.run()
    return 0


if __name__ == '__main__':
    sys.exit(main())
