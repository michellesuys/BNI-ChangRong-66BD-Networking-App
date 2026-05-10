#!/bin/bash
# start-display.sh — 用 autoplay 允許參數開啟 Chrome，跳到 display 頁面
#
# 用法：
#   ./start-display.sh                     # 預設開 localhost:3000/display
#   ./start-display.sh kiosk               # 全螢幕 kiosk 模式（隱藏網址列）
#   ./start-display.sh https://your.url/   # 指定其他網址（如 zeabur 線上版）

URL="${1:-http://localhost:3000/display}"
KIOSK_FLAG=""

if [ "$URL" = "kiosk" ]; then
  URL="http://localhost:3000/display"
  KIOSK_FLAG="--kiosk"
fi

# 用獨立的 user-data-dir，避免影響你平常的 Chrome profile（cookies、書籤等）
PROFILE_DIR="/tmp/chrome-bni-display"

echo "🎬 啟動 BNI Display 模式…"
echo "   URL: $URL"
[ -n "$KIOSK_FLAG" ] && echo "   全螢幕 kiosk 模式"
echo ""

open -na "Google Chrome" --args \
  --autoplay-policy=no-user-gesture-required \
  --user-data-dir="$PROFILE_DIR" \
  $KIOSK_FLAG \
  "$URL"

echo "✅ 已開啟。音效會自動播放，不用點擊。"
echo ""
echo "💡 提示："
echo "   - 全螢幕 kiosk：./start-display.sh kiosk"
echo "   - 退出 kiosk：Cmd+Q 或 Cmd+W"
