#!/bin/bash
# 打包插件为 zip（用于上架 Chrome Web Store 或分发）
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
OUT="weibo-dm-backup-extension-v${VERSION}.zip"
rm -f "$OUT"
cd extension
zip -r "../$OUT" . -x "icons/icon512.png" -x ".*"
cd ..
echo "已打包: $OUT"
