#!/bin/bash
# ── Switchboard 啟動 ──────────────────────────────────────
# 雙擊此檔案即可啟動系統

cd "$(dirname "$0")/.."

echo "🚀 啟動 Switchboard 客戶互動平台..."
echo ""

# 啟動 PostgreSQL
echo "📦 啟動資料庫..."
docker compose up -d
sleep 2

# 啟動 Bridge Worker（背景執行）
echo "🔗 啟動 Telegram Bridge..."
npm run bridge &
BRIDGE_PID=$!
echo "   Bridge PID: $BRIDGE_PID"

# 啟動 Next.js
echo "🌐 啟動網頁伺服器..."
echo ""
echo "═══════════════════════════════════════"
echo "  Switchboard 已啟動！"
echo "  開啟瀏覽器：http://localhost:1688"
echo "  按 Ctrl+C 可停止伺服器"
echo "═══════════════════════════════════════"
echo ""

npm run dev

# Next.js 停止後，也停掉 Bridge
kill $BRIDGE_PID 2>/dev/null
