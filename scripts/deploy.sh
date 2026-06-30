#!/bin/bash
set -euo pipefail
# ── Switchboard 部署腳本 ──────────────────────────────────
# 用法：
#   首次部署：  ./scripts/deploy.sh init
#   更新部署：  ./scripts/deploy.sh update
#   查看狀態：  ./scripts/deploy.sh status
#   查看日誌：  ./scripts/deploy.sh logs

ENV_FILE=".env.production"
COMPOSE_FILE="docker-compose.prod.yml"

# 檢查環境變數檔案
check_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "❌ 找不到 $ENV_FILE"
    echo "   請複製 .env.production.example 並填入設定值："
    echo "   cp .env.production.example .env.production"
    exit 1
  fi
}

case "${1:-}" in
  init)
    echo "🚀 首次部署..."
    check_env

    # 建置映像
    echo "📦 建置 Docker 映像..."
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build

    # 執行資料庫 migration
    echo "🗃️  執行資料庫 migration..."
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE --profile migrate run --rm migrate

    # 執行 seed
    echo "🌱 建立預設管理員..."
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE run --rm app npx tsx prisma/seed.ts

    # 啟動服務
    echo "▶️  啟動服務..."
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d app bridge

    echo ""
    echo "✅ 部署完成！"
    echo "   應用程式：http://localhost:${APP_PORT:-3000}"
    echo "   預設帳號：admin@switchboard.local / admin1234"
    echo "   ⚠️  請立即修改密碼！"
    ;;

  update)
    echo "🔄 更新部署..."
    check_env

    echo "📦 重建映像..."
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build

    echo "🗃️  執行資料庫 migration..."
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE --profile migrate run --rm migrate

    echo "▶️  重啟服務..."
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d app bridge

    echo "✅ 更新完成！"
    ;;

  status)
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE ps
    ;;

  logs)
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f --tail=100 ${2:-app bridge}
    ;;

  down)
    echo "⏹️  停止服務..."
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down
    echo "✅ 已停止"
    ;;

  *)
    echo "Switchboard 部署工具"
    echo ""
    echo "用法："
    echo "  ./scripts/deploy.sh init     首次部署（建置 + migration + seed + 啟動）"
    echo "  ./scripts/deploy.sh update   更新部署（重建 + migration + 重啟）"
    echo "  ./scripts/deploy.sh status   查看服務狀態"
    echo "  ./scripts/deploy.sh logs     查看即時日誌"
    echo "  ./scripts/deploy.sh down     停止所有服務"
    ;;
esac
