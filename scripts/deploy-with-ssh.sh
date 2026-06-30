#!/bin/bash
# ── Switchboard SSH 轉發部署腳本 ────────────────────────
# 用法：
#   服務器端部署：./scripts/deploy-with-ssh.sh server-deploy
#   客戶端連接：  ./scripts/deploy-with-ssh.sh client-connect <server-ip> [local-port]
#   停止轉發：    ./scripts/deploy-with-ssh.sh stop-forward

set -e

case "${1}" in
  server-deploy)
    echo "🚀 在服務器端部署 Switchboard..."
    
    # 檢查 Docker 和 Docker Compose
    if ! command -v docker &> /dev/null; then
        echo "❌ 請先安裝 Docker"
        exit 1
    fi
    
    # 設定環境變數檔案
    if [ ! -f ".env.production" ]; then
        echo "📝 創建環境變數檔案..."
        cp .env.production.example .env.production
        
        # 自動生成密鑰
        DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)
        SESSION_SECRET=$(openssl rand -hex 32)
        TELEGRAM_SESSION_KEY=$(openssl rand -hex 32)
        INTERNAL_SECRET=$(openssl rand -hex 32)
        
        # Use printf to avoid sed injection issues with special characters
        awk -v val="$DB_PASSWORD" '/^DB_PASSWORD=/{print "DB_PASSWORD=" val; next}1' .env.production > .env.production.tmp && mv .env.production.tmp .env.production
        awk -v val="$SESSION_SECRET" '/^SESSION_SECRET=/{print "SESSION_SECRET=" val; next}1' .env.production > .env.production.tmp && mv .env.production.tmp .env.production
        awk -v val="$TELEGRAM_SESSION_KEY" '/^TELEGRAM_SESSION_KEY=/{print "TELEGRAM_SESSION_KEY=" val; next}1' .env.production > .env.production.tmp && mv .env.production.tmp .env.production
        awk -v val="$INTERNAL_SECRET" '/^INTERNAL_SECRET=/{print "INTERNAL_SECRET=" val; next}1' .env.production > .env.production.tmp && mv .env.production.tmp .env.production
        
        echo "✓ .env.production 已完成;無需額外 TELEGRAM_API_ID / HASH 設定"
        echo "  (每個 Telegram 帳號於 UI 綁定時個別填入 my.telegram.org 憑證)"
        exit 0
    fi
    
    # 執行部署
    ./scripts/deploy.sh init
    
    echo ""
    echo "✅ 服務器端部署完成！"
    echo "🔗 服務運行在：http://localhost:3000"
    echo ""
    echo "📡 客戶端連接指令："
    echo "   ssh -L 8080:localhost:3000 $(whoami)@$(hostname -I | awk '{print $1}')"
    echo ""
    echo "🌐 客戶端存取：http://localhost:8080"
    ;;

  client-connect)
    if [ -z "$2" ]; then
        echo "❌ 請提供服務器 IP 地址"
        echo "用法：$0 client-connect <server-ip> [local-port]"
        exit 1
    fi
    
    SERVER_IP="$2"
    LOCAL_PORT="${3:-8080}"
    
    echo "🔗 建立 SSH 隧道..."
    echo "   本地端 Port: $LOCAL_PORT"
    echo "   遠端服務: $SERVER_IP:3000"
    echo ""
    echo "✅ 連線建立後，請開啟瀏覽器前往："
    echo "   http://localhost:$LOCAL_PORT"
    echo ""
    echo "⏹️  停止轉發請按 Ctrl+C"
    
    # 建立 SSH 隧道
    ssh -L ${LOCAL_PORT}:localhost:3000 -N ${SERVER_IP}
    ;;

  stop-forward)
    echo "⏹️  停止所有 SSH 轉發..."
    pkill -f "ssh -L.*localhost:3000" || echo "沒有找到運行中的轉發"
    echo "✅ 已停止"
    ;;

  status)
    echo "📊 Switchboard 服務狀態："
    ./scripts/deploy.sh status
    echo ""
    echo "🔗 SSH 隧道狀態："
    ps aux | grep "ssh -L.*localhost:3000" | grep -v grep || echo "沒有運行中的 SSH 隧道"
    ;;

  *)
    echo "Switchboard SSH 轉發部署工具"
    echo ""
    echo "服務器端操作："
    echo "  $0 server-deploy           部署 Switchboard 到本機"
    echo "  $0 status                  查看服務狀態"
    echo ""
    echo "客戶端操作："
    echo "  $0 client-connect <ip>     連接到遠端服務器（預設 local port 8080）"
    echo "  $0 client-connect <ip> <port>  連接到遠端服務器（指定 local port）"
    echo "  $0 stop-forward            停止 SSH 轉發"
    echo ""
    echo "範例："
    echo "  # 服務器端"
    echo "  $0 server-deploy"
    echo ""
    echo "  # 客戶端"
    echo "  $0 client-connect 192.168.1.100"
    echo "  $0 client-connect 192.168.1.100 9090"
    ;;
esac