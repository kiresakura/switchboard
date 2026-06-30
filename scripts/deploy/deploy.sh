#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Switchboard 部署 / 升級腳本
# ═══════════════════════════════════════════════════════════
# 使用方式（在 VPS 上）：
#   首次部署: bash scripts/deploy/deploy.sh --init
#   升級:     bash scripts/deploy/deploy.sh
#   僅備份:   bash scripts/deploy/deploy.sh --backup-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.production"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
BACKUP_DIR="$PROJECT_ROOT/backups"

cd "$PROJECT_ROOT"

# ── 顏色 ────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[info]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $*"; }
error() { echo -e "${RED}[err ]${NC} $*" >&2; }
dc()    { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# ── 前置檢查 ────────────────────────────────────────
check_prereq() {
  [ -f "$ENV_FILE" ] || { error ".env.production 不存在，請先複製 .env.production.example 並設定"; exit 1; }
  [ "$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %A "$ENV_FILE")" = "600" ] || \
    warn ".env.production 權限不是 600，建議執行：chmod 600 $ENV_FILE"
  command -v docker >/dev/null || { error "需要安裝 docker"; exit 1; }
  docker compose version >/dev/null 2>&1 || { error "需要 docker compose v2"; exit 1; }
}

# ── 備份 ────────────────────────────────────────────
backup_db() {
  info "備份資料庫..."
  mkdir -p "$BACKUP_DIR"
  local ts=$(date -u +"%Y%m%d_%H%M%SZ")
  local file="$BACKUP_DIR/switchboard_${ts}.sql.gz"
  dc exec -T db pg_dump -U switchboard switchboard | gzip > "$file"
  info "已備份至 $file ($(du -h "$file" | cut -f1))"

  # 只保留最近 30 份
  ls -t "$BACKUP_DIR"/switchboard_*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm
}

# ── 初始化 ──────────────────────────────────────────
init() {
  info "=== 首次部署 ==="
  check_prereq

  info "建置 Docker images..."
  dc build

  info "啟動資料庫..."
  dc up -d db

  info "等待資料庫就緒..."
  local tries=0
  until dc exec -T db pg_isready -U switchboard -d switchboard > /dev/null 2>&1; do
    tries=$((tries+1))
    [ $tries -gt 30 ] && { error "資料庫啟動超時"; exit 1; }
    sleep 1
  done

  info "初始化資料庫 schema..."
  dc --profile migrate run --rm migrate

  info "啟動全部服務..."
  dc up -d

  info "等待 app 就緒..."
  sleep 8

  info "執行 seed（建立 admin + cs_user）..."
  dc exec -T app npx tsx prisma/seed.ts || warn "Seed 可能已執行過（帳號已存在）"

  info "=== 初始化完成 ==="
  info "狀態："
  dc ps
}

# ── 升級 ────────────────────────────────────────────
upgrade() {
  info "=== 升級部署 ==="
  check_prereq

  info "拉取最新程式碼..."
  git pull

  info "備份資料庫..."
  backup_db

  info "建置新 images..."
  dc build

  info "套用資料庫 schema 變更..."
  dc --profile migrate run --rm migrate

  info "重啟服務（rolling update）..."
  dc up -d

  info "清理舊 images..."
  docker image prune -f

  info "=== 升級完成 ==="
  dc ps
}

# ── 主 ─────────────────────────────────────────────
main() {
  case "${1:-upgrade}" in
    --init|init)
      init
      ;;
    --backup-only|backup)
      check_prereq
      backup_db
      ;;
    --upgrade|upgrade|"")
      upgrade
      ;;
    -h|--help|help)
      cat <<EOF
Switchboard 部署腳本

用法：
  $0 --init         首次部署（建立 schema + seed）
  $0 --upgrade      升級（git pull + migrate + rebuild）
  $0 --backup-only  僅備份資料庫
  $0 --help         顯示此說明
EOF
      ;;
    *)
      error "未知參數: $1。使用 --help 查看用法。"
      exit 1
      ;;
  esac
}

main "$@"
