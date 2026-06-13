@echo off
chcp 65001 >nul
rem 微博私信备份 · 本地服务一键启动（Windows 双击运行）
cd /d %~dp0
if not exist .venv (
  echo 首次运行：创建 Python 虚拟环境并安装依赖…
  python -m venv .venv
  .venv\Scripts\python -m pip install -q -r server\requirements.txt
)
echo.
echo   本地服务启动中： http://127.0.0.1:8765
echo   数据保存在: %cd%\data\
echo   提示：语音转码需要 ffmpeg（见 README），不装也能用只是语音存为 .amr
echo   按 Ctrl+C 停止服务
echo.
start "" "http://127.0.0.1:8765"
.venv\Scripts\uvicorn server.app:app --host 127.0.0.1 --port 8765
