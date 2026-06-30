#!/bin/bash
# ── Switchboard 關閉 ──────────────────────────────────────
# 雙擊此檔案即可關閉系統

cd "$(dirname "$0")/.."

echo "⏹️  關閉 Switchboard 客戶互動平台..."

# 停止 Next.js dev server
echo "🌐 停止網頁伺服器..."
pkill -f "node.*next.*dev.*1688" 2>/dev/null || pkill -f "next dev" 2>/dev/null

# 停止 Bridge Worker
echo "🔗 停止 Telegram Bridge..."
pkill -f "tsx.*telegram-bridge" 2>/dev/null || pkill -f "node.*telegram-bridge" 2>/dev/null

# 停止 PostgreSQL
echo "📦 停止資料庫..."
docker compose down

echo ""
echo "✅ Switchboard 已完全關閉"
