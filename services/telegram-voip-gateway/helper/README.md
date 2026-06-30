# Switchboard Telegram VoIP Media Helper

Python daemon that makes **real Telegram 1:1 voice calls** (via
[py-tgcalls](https://github.com/pytgcalls/pytgcalls) + ntgcalls) and bridges
audio to the operator's **browser via WebRTC** (aiortc). It is the media plane
behind `services/telegram-voip-gateway` (the Node control plane). The browser
never talks to this process's HTTP API directly — only the gateway does; the
browser exchanges WebRTC media with it after SDP negotiation through Switchboard.

```
Browser (mic/speaker, RTCPeerConnection)
   │ SDP/ICE via Switchboard app → gateway → helper (HTTP)
   │ Audio: WebRTC (Opus 48k stereo)
   ▼
helper (this daemon, port 3003)
   aiortc ⇄ PCM16 48k stereo ⇄ py-tgcalls/ntgcalls
   ▼
Real Telegram 1:1 encrypted call (P2P or TG reflector)
```

## Run

```bash
cd services/telegram-voip-gateway/helper
uv sync
set -a; source ~/.switchboard/voip-helper.env; set +a   # from tools/voip-helper-provision-session.ts
uv run python -m switchboard_voip_helper
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `VOIP_HELPER_HOST` / `VOIP_HELPER_PORT` | `127.0.0.1` / `3003` | Bind address (keep localhost) |
| `VOIP_HELPER_SECRET` | falls back to `TELEGRAM_VOIP_GATEWAY_SECRET` | Bearer for inbound API |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | — | Telegram app creds (same as the account's row) |
| `VOIP_HELPER_SESSION_STRING` | falls back to `TELEGRAM_SESSION_STRING` | Telethon **or** GramJS string session (auto-converted) |
| `VOIP_HELPER_GATEWAY_URL` | `http://127.0.0.1:3002` | Gateway base URL for event callbacks |
| `VOIP_HELPER_GATEWAY_SECRET` | gateway secret | Bearer for callbacks |
| `VOIP_HELPER_CALL_TIMEOUT_S` | `75` | Outgoing ring timeout |

⚠️ The session string is a credential. Generate a **dedicated** session for this
daemon with `npx tsx tools/voip-helper-provision-session.ts` (QR-login handoff
from the bridge-held session — no SMS code needed). Do **not** reuse the exact
session string the bridge is actively using: two MTProto clients on one auth
key fight over update delivery and calls/messages get silently missed.

## HTTP API (gateway-only, bearer auth)

- `GET /health` → readiness flags (`telegramSessionReady`, `mediaBridgeReady`, …)
- `POST /calls` `{sessionId, platformUserId, mode:"voice", iceServers?}` → `{ok, offer}` — places the TG call, returns browser SDP offer
- `POST /calls/:id/answer` `{iceServers?}` → `{ok, offer}` — accepts a ringing incoming call
- `POST /calls/:id/signals` `{signal}` — browser answer SDP / ICE candidate / hangup
- `GET /calls/:id` → state; `DELETE /calls/:id` → hangup + cleanup

Events back to gateway (`POST {gateway}/internal/helper-events`):
`{event:"incoming"|"state", sessionId?, platformUserId, mode, state, detail?}` —
for `incoming` the gateway responds `{sessionId}` to bind the session id.

## States

`dialing → ringing → accepted → connected` then terminal:
`ended | declined | busy | timeout | missed | failed`.

## Security

- No audio is recorded or written to disk; FIFO buffers are memory-only.
- Session strings / SDP / media are never logged (third-party loggers forced to WARNING).
- Binds to localhost; all non-health routes require the bearer secret.

## Tests

```bash
uv run pytest -q   # session conversion + PCM bridging units
```
