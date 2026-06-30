<div align="center">

# Switchboard

**Self-hosted, multi-tenant omnichannel customer-engagement platform.**

Unify customer conversations from across many messaging accounts into one
real-time team console — with role-based collaboration, full audit trails,
**embedded real voice calls**, and AI assist.

`Next.js 16` · `React 19` · `TypeScript` · `PostgreSQL` · `Prisma` · `WebRTC`

</div>

---

Switchboard turns scattered messaging accounts into a single collaborative inbox
for a support team. Agents see every customer conversation in one place, claim
and route them, reply in real time, place voice calls without leaving the
browser, and leave a complete audit trail behind every action. Each **Workspace**
is an isolated tenant with its own accounts, members, roles, and settings.

**Telegram is the first fully-implemented channel.** The data model
(`Account → Channel → Conversation → Message`) and the bridge worker are
channel-agnostic by design, so additional providers slot in behind the same
pipeline and UI.

## Why it's worth a look (engineering highlights)

- 🎙️ **Embedded real voice calls** — a **WebRTC ⇄ Telegram MTProto bridge**
  lets agents place and answer *real* Telegram voice calls from the browser.
  A Node gateway handles signalling; a Python media helper bridges
  `py-tgcalls`/`ntgcalls` (the real, encrypted TG call) to `aiortc` with
  full-duplex PCM. No audio is persisted.
- ⚡ **Real-time by default** — server-sent events over an in-memory event bus
  with automatic reconnect and `lastEventId` replay (5-minute ring buffer), so
  flaky mobile/corporate networks recover transparently.
- 🏢 **Multi-tenant from the ground up** — strict per-workspace isolation and a
  Discord-style RBAC layer (custom roles, granular permission keys, permissions
  unioned across roles).
- 🔐 **Security-first** — AES-256-GCM encryption of stored provider sessions,
  bcrypt auth with timing-attack mitigation, per-account login throttling, a
  runtime *secret-guard* that refuses to boot on placeholder secrets, strict
  security headers + HSTS, and access-controlled media.
- 🤖 **AI assist** — pluggable LLM provider for intent/sentiment/urgency analysis
  of inbound messages.
- 📱 **Mobile-first PWA** — installable, offline-aware, safe-area-padded,
  ≥44px tap targets; built for agents on phones.

## Features

| Area | What it does |
|---|---|
| **Unified inbox** | Multi-account send/receive, pinning, edit history, emoji reactions, history backfill |
| **Conversation routing** | Claim/assign conversations, ownership, snooze/close lifecycle |
| **Voice calls** | Place/answer real Telegram 1:1 voice calls in-browser |
| **AI analysis** | Intent, sentiment, and urgency hints on inbound messages |
| **Quick replies** | `/shortcut`-triggered reply templates |
| **Roles & permissions** | Custom roles with granular, unioned permission keys |
| **Scheduling** | Time-based rules for routing/automation |
| **Audit log** | Every key operation recorded, retained, and queryable |
| **Multi-tenant** | One deployment, many isolated teams |

## Architecture

```
 Messaging accounts ┐
   (Telegram first) │   ┌─────────────────────────┐  HTTP    ┌──────────────────────┐
   many accounts ───┼──▶│  Bridge worker  :3001    │─────────▶│  Next.js app  :1688  │
                    │   │  GramJS client pool      │          │  API · SSE · UI       │
                    │   │  message pipeline        │◀─────────│  realtime push        │
                    ┘   └─────────────────────────┘  notify  └──────────┬───────────┘
                                                                         │
            ┌──────────────────────────────┐                 ┌──────────▼─────────┐
            │ Voice gateway :3002 + media   │                 │   PostgreSQL 16    │
            │ helper :3003 (WebRTC ⇄ MTProto)│                 └────────────────────┘
            └──────────────────────────────┘
```

Two long-running processes are required: the **app** (`npm run dev`, port 1688)
and the **bridge worker** (`npm run bridge`, port 3001). Voice calls add the
gateway + Python media helper.

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5.9 (strict) |
| UI | React 19 · Tailwind CSS 4 · Lucide |
| Database | PostgreSQL 16 |
| ORM | Prisma 6.19 |
| Auth | Custom session (bcryptjs + HTTP-only cookie) |
| Messaging | GramJS (Telegram MTProto) |
| Voice | py-tgcalls / ntgcalls ⇄ aiortc |
| Encryption | AES-256-GCM (Node crypto) |

## Quick start

```bash
cp .env.example .env          # fill in values (see below)
docker compose up -d          # PostgreSQL
npm install
npm run db:migrate            # apply schema
npm run db:generate           # Prisma client
SEED_ADMIN_PASSWORD=... SEED_CS_PASSWORD=... npm run db:seed
npm run dev                   # app  → http://localhost:1688
npm run bridge                # bridge worker (separate terminal)
```

### Required environment (generate secrets with `openssl rand -hex 32`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | session integrity (required in production) |
| `TELEGRAM_SESSION_KEY` | AES-256-GCM key for stored provider sessions |
| `INTERNAL_SECRET` | shared secret for app ↔ bridge |
| `SEED_ADMIN_PASSWORD` / `SEED_CS_PASSWORD` | required when seeding production |
| `TRUSTED_PROXY_HOPS` | trusted reverse-proxy depth (rate-limit/audit IP) |

Per-account Telegram `apiId`/`apiHash` are entered through the in-app account UI
(from <https://my.telegram.org>), never via environment variables.

See [`SECURITY.md`](./SECURITY.md) before deploying.

## Notes

- This project automates Telegram **user** accounts (GramJS) and bridges real
  calls; review Telegram's Terms of Service and your local data-protection law
  before deploying it against real accounts.
- The voice dependencies (`py-tgcalls`, `ntgcalls`, `telethon`, `aiortc`) carry
  their own licenses — review them before redistribution.

## License

[MIT](./LICENSE)
