#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Switchboard 生產環境金鑰產生器
# ═══════════════════════════════════════════════════════════
# 產生所有需要的隨機金鑰，輸出到 stdout
#
# 使用方式：
#   bash scripts/deploy/generate-secrets.sh
#
# 或直接附加到 .env.production：
#   bash scripts/deploy/generate-secrets.sh >> .env.production.generated
#
# 輸出範例：
#   DB_PASSWORD=<32 字隨機>
#   SESSION_SECRET=<64 字 hex>
#   TELEGRAM_SESSION_KEY=<64 字 hex>
#   INTERNAL_SECRET=<64 字 hex>
#   SEED_ADMIN_PASSWORD=<16 字隨機>
#   SEED_CS_PASSWORD=<16 字隨機>

set -euo pipefail

if ! command -v openssl &> /dev/null; then
  echo "錯誤：需要 openssl 指令" >&2
  exit 1
fi

# 產生 URL-safe 密碼（非 hex，適合 DB password 等）
random_pw() {
  local len=${1:-32}
  openssl rand -base64 48 | tr -d '+/=' | head -c "$len"
}

# 產生 hex 金鑰（適合加密金鑰）
random_hex() {
  openssl rand -hex "${1:-32}"
}

cat <<EOF
# ═══════════════════════════════════════════════════════════
# 自動產生於 $(date -u "+%Y-%m-%d %H:%M:%S UTC")
# ═══════════════════════════════════════════════════════════

DB_PASSWORD=$(random_pw 32)
SESSION_SECRET=$(random_hex 32)
TELEGRAM_SESSION_KEY=$(random_hex 32)
INTERNAL_SECRET=$(random_hex 32)

# 首次部署密碼（登入後請立即修改）
SEED_ADMIN_PASSWORD=$(random_pw 16)
SEED_CS_PASSWORD=$(random_pw 16)

EOF

echo "提示:Telegram API ID / Hash 不在此處設定。" >&2
echo "每個 TG 帳號於「帳號池 → 驗證」UI 個別填入" >&2
echo "(申請網址:https://my.telegram.org/apps,每個帳號各自用自己的手機號申請)" >&2
