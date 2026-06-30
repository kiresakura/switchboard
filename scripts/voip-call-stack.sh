#!/bin/bash
# Start/stop the local real-Telegram-call stack: media helper (3003) + gateway (3002).
#
# Prereqs:
#   - .env with TELEGRAM_VOIP_GATEWAY_SECRET (and TELEGRAM_VOIP_GATEWAY_URL for the app)
#   - ~/.switchboard/voip-helper.env from: npx tsx tools/voip-helper-provision-session.ts
#   - helper deps: cd services/telegram-voip-gateway/helper && uv sync
#
# Usage: bash scripts/voip-call-stack.sh start|stop|status [--allow-any-peer]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER_ENV="${VOIP_HELPER_ENV_FILE:-$HOME/.switchboard/voip-helper.env}"
LOG_DIR="${VOIP_STACK_LOG_DIR:-$REPO_ROOT/logs}"
ALLOW_ANY_PEER="${TELEGRAM_VOIP_ALLOW_ANY_PRIVATE_PEER:-1}"

cmd="${1:-status}"
if [[ "${2:-}" == "--allow-any-peer" ]]; then ALLOW_ANY_PEER=1; fi

start() {
  if [[ ! -f "$HELPER_ENV" ]]; then
    echo "[voip-stack] 缺少 $HELPER_ENV — 先執行: npx tsx --env-file-if-exists=.env tools/voip-helper-provision-session.ts" >&2
    exit 1
  fi
  mkdir -p "$LOG_DIR"

  if ! pgrep -f "switchboard_voip_helper" >/dev/null; then
    (
      set -a
      . "$REPO_ROOT/.env"
      . "$HELPER_ENV"
      VOIP_HELPER_PORT="${VOIP_HELPER_PORT:-3003}"
      VOIP_HELPER_GATEWAY_URL="${VOIP_HELPER_GATEWAY_URL:-http://127.0.0.1:3002}"
      set +a
      cd "$REPO_ROOT/services/telegram-voip-gateway/helper"
      nohup uv run python -m switchboard_voip_helper >>"$LOG_DIR/voip-helper.log" 2>&1 &
      echo "[voip-stack] helper 啟動 (pid $!) → $LOG_DIR/voip-helper.log"
    )
  else
    echo "[voip-stack] helper 已在執行"
  fi

  if ! pgrep -f "telegram-voip-gateway/src/server.ts" >/dev/null; then
    (
      set -a
      . "$REPO_ROOT/.env"
      . "$HELPER_ENV" # TELEGRAM_VOIP_ACCOUNT_ID lives here
      TELEGRAM_VOIP_GATEWAY_PORT="${TELEGRAM_VOIP_GATEWAY_PORT:-3002}"
      TELEGRAM_VOIP_HELPER_URL="${TELEGRAM_VOIP_HELPER_URL:-http://127.0.0.1:3003}"
      TELEGRAM_VOIP_ENABLE_REAL_CALLS=1
      TELEGRAM_VOIP_ALLOW_ANY_PRIVATE_PEER="$ALLOW_ANY_PEER"
      SWITCHBOARD_BASE_URL="${SWITCHBOARD_BASE_URL:-http://127.0.0.1:1688}"
      set +a
      cd "$REPO_ROOT"
      nohup npx tsx services/telegram-voip-gateway/src/server.ts >>"$LOG_DIR/voip-gateway.log" 2>&1 &
      echo "[voip-stack] gateway 啟動 (pid $!) → $LOG_DIR/voip-gateway.log"
    )
  else
    echo "[voip-stack] gateway 已在執行"
  fi

  sleep 4
  status
}

stop() {
  pkill -f "switchboard_voip_helper" 2>/dev/null && echo "[voip-stack] helper 已停止" || echo "[voip-stack] helper 未在執行"
  pkill -f "telegram-voip-gateway/src/server.ts" 2>/dev/null && echo "[voip-stack] gateway 已停止" || echo "[voip-stack] gateway 未在執行"
}

status() {
  echo "[voip-stack] gateway /health:"
  curl -s --max-time 4 http://127.0.0.1:3002/health || echo "(gateway 無回應)"
  echo
}

case "$cmd" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status [--allow-any-peer]" >&2; exit 1 ;;
esac
