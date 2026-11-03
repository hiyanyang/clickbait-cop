#!/usr/bin/env bash
# 打包成 Chrome 应用商店可上传的 zip（manifest.json 位于压缩包根目录）
set -e
cd "$(dirname "$0")/.."

VER=$(node -p "require('./manifest.json').version")
OUT="dist/cover-lightning-rod-${VER}.zip"
mkdir -p dist
rm -f "$OUT"

python - "$OUT" <<'PY'
import sys, os, zipfile

out = sys.argv[1]
DIRS = ['content', 'icons']
FILES = ['manifest.json', 'background.js', 'popup.html', 'popup.css',
         'popup.js', 'content.css', 'LICENSE']

paths = [f for f in FILES if os.path.exists(f)]
for d in DIRS:
    for root, _, names in os.walk(d):
        for n in sorted(names):
            paths.append(os.path.join(root, n).replace('\\', '/'))

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for p in paths:
        z.write(p, p)

print('已打包 %d 个文件 -> %s' % (len(paths), out))
PY

echo "校验：manifest.json 是否在根目录"
python - "$OUT" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
assert 'manifest.json' in names, '失败：manifest.json 不在根目录'
assert not any(n.startswith('docs/') for n in names), '失败：混进了 docs/'
print('OK  %d 个条目，根目录含 manifest.json' % len(names))
for n in sorted(names):
    print('   ', n)
PY
