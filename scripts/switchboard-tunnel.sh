#!/bin/bash
# Run cloudflared quick tunnel + extract public URL.
# Designed to be supervised by launchd (no backgrounding).
export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin

LOG="$HOME/Library/Logs/switchboard/tunnel.log"
URL_FILE="$HOME/.switchboard-public-url"
: > "$LOG"

# Background tail to scrape URL once it appears
(
  while sleep 1; do
    URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null | tail -1)
    if [ -n "$URL" ] && [ "$URL" != "$(cat "$URL_FILE" 2>/dev/null)" ]; then
      echo "$URL" > "$URL_FILE"
      osascript -e "display notification \"$URL\" with title \"Switchboard tunnel ready\"" 2>/dev/null || true
    fi
  done
) &
SCRAPER=$!
trap "kill $SCRAPER 2>/dev/null" EXIT

# Cloudflared runs in foreground so launchd can supervise
exec cloudflared tunnel --url http://localhost:1688 --protocol http2 --no-autoupdate \
     >> "$LOG" 2>&1
