# Switchboard Telegram VoIP Gateway

Control plane for **real embedded Telegram 1:1 voice calls** in Switchboard. The
actual Telegram call (MTProto signaling, DH, encrypted media) and the browser
WebRTC leg live in the Python **media helper** (`./helper`, port 3003); this
Node daemon (port 3002) owns:

- authorization gates (master switch, approved-target policy, account match)
- the call-session registry (TTL'd, sanitized)
- proxying create/answer/signals/delete to the helper
- forwarding helper events to Switchboard (`/api/internal/telegram-call-event` → SSE)

```
Browser ⇄ (WebRTC media) ⇄ helper(3003) ⇄ real Telegram call
   │                          ▲
   │ HTTPS (Switchboard app routes) │ localhost HTTP
   ▼                          │
Switchboard app (1688) ⇄ gateway(3002)
```

Contract: `docs/telegram-voip-gateway-contract.md`. R&D log:
`docs/telegram-real-voip-gateway-rd.md`.

## Run (local)

```bash
# 1. one-time: provision a dedicated helper session (QR handoff, no SMS code)
npx tsx --env-file-if-exists=.env tools/voip-helper-provision-session.ts

# 2. both daemons
bash scripts/voip-call-stack.sh start
bash scripts/voip-call-stack.sh status
bash scripts/voip-call-stack.sh stop
```

Or manually:

```bash
TELEGRAM_VOIP_GATEWAY_SECRET=... \
TELEGRAM_VOIP_HELPER_URL=http://127.0.0.1:3003 \
TELEGRAM_VOIP_ACCOUNT_ID=<communication-account-id> \
TELEGRAM_VOIP_ENABLE_REAL_CALLS=1 \
TELEGRAM_VOIP_ALLOW_ANY_PRIVATE_PEER=1 \
Switchboard_BASE_URL=http://127.0.0.1:1688 \
npm --prefix services/telegram-voip-gateway run dev
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `TELEGRAM_VOIP_GATEWAY_HOST` / `PORT` | `127.0.0.1` / `3002` | bind |
| `TELEGRAM_VOIP_GATEWAY_SECRET` | — | bearer for Switchboard ⇄ gateway ⇄ helper events |
| `TELEGRAM_VOIP_HELPER_URL` / `SECRET` | `http://127.0.0.1:3003` / gateway secret | media helper |
| `TELEGRAM_VOIP_ACCOUNT_ID` | — | CommunicationAccount whose session the helper holds; mismatched `accountId` → `403 VOIP_ACCOUNT_MISMATCH` |
| `TELEGRAM_VOIP_ENABLE_REAL_CALLS` | off | master switch (legacy: `QA_ENABLE_REAL_TELEGRAM_CALL`) |
| `TELEGRAM_VOIP_ALLOW_ANY_PRIVATE_PEER` | off | allow any private-chat peer (Switchboard authorizes per conversation) |
| `QA_APPROVED_CALLEE_PLATFORM_USER_ID` / `GROUP_ID` | — | lab allowlist (exact match) when not allowing any peer |
| `TELEGRAM_VOIP_ICE_SERVERS` | `[]` | JSON array; add TURN for production |
| `TELEGRAM_VOIP_SESSION_TTL_MS` | 15 min | session registry TTL |
| `Switchboard_BASE_URL` | — | where call events are POSTed |

Safety defaults: with the switch off **or** no target policy, every call
attempt is rejected before any Telegram RPC.

## API

See the contract doc. Summary:

- `GET /health` — merged gateway+helper readiness (`realTelegramCalls`,
  `mediaBridgeReady`, `fullDuplexAudioReady`, `helperReachable`, …)
- `POST /telegram/calls/sessions` — start outgoing call; returns WebRTC `offer`
- `POST /telegram/calls/sessions/:id/answer` — answer helper-detected incoming
- `POST /telegram/calls/sessions/:id/signals` — browser answer SDP / ICE / hangup
- `GET|DELETE /telegram/calls/sessions/:id` — inspect / end
- `POST /internal/helper-events` — helper → gateway (incoming ring, state)

## Tests & QA

```bash
npm --prefix services/telegram-voip-gateway run typecheck
npm --prefix services/telegram-voip-gateway test           # 21 unit tests (mock helper + mock Switchboard)
cd services/telegram-voip-gateway/helper && uv run pytest  # helper unit tests

# browser ⇄ helper full-duplex media proof (no Telegram traffic):
#   helper:  VOIP_HELPER_ENABLE_QA_LOOPBACK=1
#   gateway: QA_APPROVED_CALLEE_PLATFORM_USER_ID=qa:loopback
npx tsx tools/qa-real-call-media-loopback.ts
```

The legacy `qa:c1`–`qa:c4` scripts predate the media helper and are kept for
reference; the loopback QA plus a human-confirmed real callee supersede them.
Real-callee ringing/answer QA stays human-gated — see
`docs/telegram-real-call-qa-fixtures.md`.

## Security

- Non-health endpoints always require bearer auth (constant-time compare).
- Auth failures return JSON `401`, never raw text.
- Never log Telegram session strings, phone numbers, auth keys, secrets,
  bearer headers, SDP, or media.
- The helper must bind to localhost; only the gateway talks to it.
- Calls are voice-only today; `mode:"video"` is rejected with
  `400 REAL_CALL_MODE_NOT_SUPPORTED`.
