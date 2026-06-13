#!/bin/bash
# 安装 macOS 开机自启（launchd）：登录后自动在后台运行本地服务，崩溃自动拉起。
# 卸载: ./scripts/uninstall_autostart.sh
set -e
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
LABEL="com.weibo-dm-backup.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -d .venv ]; then
  echo "请先双击 start.command 完成首次安装"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/data"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PROJECT_DIR/.venv/bin/uvicorn</string>
    <string>server.app:app</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>8765</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/data/server.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 已安装开机自启。服务现在在后台运行: http://127.0.0.1:8765"
echo "   日志: $PROJECT_DIR/data/server.log"
echo "   以后不需要再双击 start.command 了"
