# -*- coding: utf-8 -*-
"""构建「扫雷叠加器.exe」—— 单文件版，产物直接落在 simulator\\ 根目录。

  python 叠加器exe\\构建.py

产物：simulator\\扫雷叠加器.exe（onefile）+ 旁边一份 使用说明.txt。
构建脚本、node.exe、图标这些留在 叠加器exe\\。

**为什么改成 onefile**：交付形态就是"根目录一个 exe"，拷走、发人都省事。
代价要清楚（这也是历史上选 onedir 的原因）：
  · node.exe 87MB + Python 运行时全部打进 exe，**每次启动**都要自解压到
    %TEMP%\\_MEIxxxx，冷启动比 onedir 慢好几秒 —— 双击后别急着关，等它。
  · 除此之外运行行为与 onedir 完全一致：overlay.py 的 _res_dir() 认
    sys._MEIPASS，bridge.js / engine_core.js / templates.json / runtime\\node.exe
    都从解包目录读。
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.dirname(HERE)
SRC = os.path.join(SIM, '叠加器')
NAME = '扫雷叠加器'
WORK = os.path.join(HERE, 'build')
DIST = SIM                       # onefile 的产物就是一个 exe，直接放 simulator\

DATA = [
    ('bridge.js', '.'),          # Node 常驻桥
    ('engine_core.js', '.'),     # 从 扫雷模拟器.html 抽出来的引擎
    ('templates.json', '.'),     # 浏览器渲染的字形模板
]
NODE = os.path.join(HERE, 'node', 'node.exe')


def clean(work):
    """清掉上一次的构建工作目录。onefile 的旧 exe 由 PyInstaller 直接覆盖。"""
    if os.path.exists(work):
        try:
            shutil.rmtree(work)
            print('已清理构建目录 %s' % work)
        except Exception as e:
            print('[x] 清理失败：%s\n    %s\n    请手动删掉这个目录再重跑。' % (work, e))
            return False
    return True


def main():
    for f, _ in DATA:
        p = os.path.join(SRC, f)
        if not os.path.exists(p):
            print('[x] 缺少 %s（识别引擎跑不了）' % p)
            return 1
    for f in ('overlay.py',):
        if not os.path.exists(os.path.join(SRC, f)):
            print('[x] 缺少 叠加器\\%s' % f)
            return 1
    if not os.path.exists(NODE):
        print('[x] 缺少 %s' % NODE)
        return 1

    ico = os.path.join(HERE, '图标.ico')
    if not os.path.exists(ico):
        print('图标不存在，先生成…')
        subprocess.run([sys.executable, os.path.join(HERE, '生成图标.py')], check=True)

    # 版本资源：**必须带**。不带的话 exe 属性页里"公司/产品/版本"全空，
    # Windows Defender 的 ML 启发式会报 Trojan:Win32/Bearfoos.A!ml（见 版本信息.txt）。
    ver = os.path.join(HERE, '版本信息.txt')
    if not os.path.exists(ver):
        print('[x] 缺少版本资源文件 %s' % ver)
        return 1
    # 版本资源文件是给 eval() 读的，**必须是单个表达式**：注释可以，docstring 不行。
    try:
        with open(ver, 'rb') as fh:
            compile(fh.read().decode('utf-8'), ver, 'eval')
    except Exception as e:
        print('[x] 版本资源文件不是合法表达式（不能有 docstring）：\n    %s\n    %s' % (ver, e))
        return 1

    if not clean(WORK):
        return 1

    args = [
        sys.executable, '-m', 'PyInstaller',
        '--noconfirm', '--clean',
        '--onefile',                      # 单文件交付（启动时自解压，见文件头说明）
        '--windowed',                     # 不要控制台；崩了由入口弹 MessageBox
        '--name', NAME,
        '--icon', ico,
        '--version-file', ver,            # 防 Defender 误报的关键
        '--noupx',                        # 显式关掉 UPX（加壳会显著抬高 ML 评分）
        '--paths', SRC,
        '--hidden-import', 'overlay',
        # 用不到的大件，别拖进来
        '--exclude-module', 'numpy',
        '--exclude-module', 'matplotlib',
        '--exclude-module', 'scipy',
        '--exclude-module', 'pandas',
        '--distpath', DIST,
        '--workpath', WORK,
        '--specpath', WORK,
    ]
    for f, dest in DATA:
        args += ['--add-data', '%s%s%s' % (os.path.join(SRC, f), os.pathsep, dest)]
    args += ['--add-data', '%s%s%s' % (NODE, os.pathsep, 'runtime')]
    args += [os.path.join(HERE, '启动入口.py')]

    print('开始构建（onefile，node.exe 要压进去，会花一两分钟）…')
    r = subprocess.run(args)
    if r.returncode != 0:
        print('[x] PyInstaller 返回 %d' % r.returncode)
        return r.returncode

    exe = os.path.join(DIST, NAME + '.exe')
    if not os.path.exists(exe):
        print('[x] 没找到产物 %s' % exe)
        return 1

    # 版本资源真的嵌进去了吗？直接看 exe 里有没有 VS_VERSION_INFO 这个 UTF-16 标记。
    with open(exe, 'rb') as fh:
        blob = fh.read()
    if 'VS_VERSION_INFO'.encode('utf-16-le') not in blob:
        print('[x] exe 里没有版本资源（找不到 VS_VERSION_INFO）—— 检查 --version-file')
        return 1
    print('     版本资源：已嵌入')

    # 说明放在 exe 旁边，双击就能看到。
    doc = os.path.join(HERE, '使用说明.txt')
    if os.path.exists(doc):
        shutil.copyfile(doc, os.path.join(DIST, '使用说明.txt'))
        print('     说明文档：使用说明.txt')

    print('\n[ok] %s  (%.1f MB)' % (exe, os.path.getsize(exe) / 1048576.0))
    print('     提示：onefile 启动要先自解压（87MB 的 node 在里面），冷启动等几秒是正常的。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
