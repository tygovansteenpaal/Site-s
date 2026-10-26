# PyInstaller spec: one-file ZONEFALL server with the game bundled inside.
#   pip install pyinstaller -r requirements.txt && pyinstaller zonefall_server.spec
# Output: dist/ZONEFALL-Server (macOS / Linux) or dist/ZONEFALL-Server.exe (Windows). Build on each OS for that OS.
import os
root = os.path.abspath(os.path.join(SPECPATH, '..'))
game = os.path.join(root, 'zonefall')
skip = ('tools', 'dev', 'progress')
datas = []
for dirpath, dirnames, filenames in os.walk(game):
    rel = os.path.relpath(dirpath, root)
    if rel.split(os.sep)[1:2] and rel.split(os.sep)[1] in skip:
        continue
    for f in filenames:
        if not f.startswith('.'):
            datas.append((os.path.join(dirpath, f), os.path.join('site', rel)))

a = Analysis(['zonefall_server.py'], pathex=[SPECPATH], datas=datas, hiddenimports=['simple_websocket', 'wsproto'])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, name='ZONEFALL-Server', console=True, upx=False)
