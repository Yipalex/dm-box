#!/bin/bash
# 微博私信备份 · 本地服务一键启动（macOS 双击运行）
cd "$(dirname "$0")"
set -e

if ! ./.venv/bin/python -c 'import sys' >/dev/null 2>&1; then
  echo "创建或修复 Python 运行环境并安装依赖…"
  PYTHON=""
  for candidate in python3 /opt/homebrew/bin/python3 /opt/homebrew/bin/python3.{14,13,12,11,10} /usr/local/bin/python3; do
    if "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
      PYTHON="$candidate"
      break
    fi
  done
  if [ -z "$PYTHON" ]; then
    echo "需要 Python 3.10 或更新版本，请先安装后重新运行。"
    exit 1
  fi
  if [ -e .venv ]; then
    mv .venv ".venv.backup.$(date +%Y%m%d%H%M%S)"
  fi
  "$PYTHON" -m venv .venv
fi
if ! ./.venv/bin/python -c 'import fastapi, uvicorn, jinja2, requests' >/dev/null 2>&1; then
  ./.venv/bin/python -m pip install -q -r server/requirements.txt
fi

echo ""
echo "  ✅ 本地服务启动中： http://127.0.0.1:8765"
echo "  数据保存在: $(pwd)/data/"
echo "  服务运行期间系统不会自动休眠（屏幕仍可关闭）"
echo "  按 Ctrl+C 停止服务"
echo ""
( sleep 2 && open "http://127.0.0.1:8765" ) &
# caffeinate -i：服务运行期间阻止系统空闲休眠（媒体下载不中断）
exec caffeinate -i ./.venv/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port 8765
