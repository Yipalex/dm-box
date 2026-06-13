#!/bin/bash
# 微博私信备份 · 本地服务一键启动（macOS 双击运行）
cd "$(dirname "$0")"
set -e

if [ ! -d .venv ]; then
  echo "首次运行：创建 Python 虚拟环境并安装依赖…"
  python3 -m venv .venv
  ./.venv/bin/pip install -q -r server/requirements.txt
fi

echo ""
echo "  ✅ 本地服务启动中： http://127.0.0.1:8765"
echo "  数据保存在: $(pwd)/data/"
echo "  服务运行期间系统不会自动休眠（屏幕仍可关闭）"
echo "  按 Ctrl+C 停止服务"
echo ""
( sleep 2 && open "http://127.0.0.1:8765" ) &
# caffeinate -i：服务运行期间阻止系统空闲休眠（媒体下载不中断）
exec caffeinate -i ./.venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8765
