#!/bin/bash
# 卸载开机自启
LABEL="com.weibo-dm-backup.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "已卸载开机自启（本地服务已停止，数据不受影响）"
