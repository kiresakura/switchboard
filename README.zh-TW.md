<div align="center">

# Switchboard

**可自架、多租戶的全通路客服協作平台。**

[![CI](https://github.com/kiresakura/switchboard/actions/workflows/ci.yml/badge.svg)](https://github.com/kiresakura/switchboard/actions/workflows/ci.yml)

把分散在多個通訊帳號的客戶對話，整合進同一個即時團隊主控台——
具備角色權限協作、完整稽核紀錄、**內嵌真實語音通話**與 AI 輔助。

`Next.js 16` · `React 19` · `TypeScript` · `PostgreSQL` · `Prisma` · `WebRTC`

[English](./README.md) · 繁體中文

</div>

---

Switchboard 把零散的通訊帳號變成客服團隊共用的單一收件匣。客服人員在同一處看到
所有客戶對話，可以認領與分派、即時回覆、不離開瀏覽器就撥打語音通話，每個動作都
留下完整的稽核紀錄。每個**工作區（Workspace）**都是獨立的租戶，擁有自己的帳號、
成員、角色與設定。

**Telegram 是第一個完整實作的通路。** 資料模型
（`Account → Channel → Conversation → Message`）與 bridge worker 在設計上與通路
無關，之後的通路可以接在同一條管線與介面後面。

## 工程亮點

- 🎙️ **內嵌真實語音通話**——**WebRTC ⇄ Telegram MTProto 橋接**讓客服人員在瀏覽器
  中撥打與接聽*真正的* Telegram 語音通話。Node gateway 負責信令；Python media
  helper 把 `py-tgcalls`/`ntgcalls`（真實、加密的 TG 通話）橋接到 `aiortc`，
  全雙工 PCM。不保存任何音訊。
- ⚡ **預設即時**——以記憶體內 event bus 推送 server-sent events，支援自動重連與
  `lastEventId` 重播（5 分鐘環狀緩衝），行動網路或企業網路不穩時也能無感恢復。
- 🏢 **從底層就是多租戶**——嚴格的工作區隔離，加上類似 Discord 的 RBAC
  （自訂角色、細粒度權限鍵、多個角色的權限取聯集）。
- 🔐 **安全優先**——以 AES-256-GCM 加密儲存的通路 session、bcrypt 驗證並防範
  timing attack、依帳號限制登入嘗試、偵測到預留位置（placeholder）密鑰就拒絕
  啟動的 runtime *secret-guard*、嚴格的安全標頭 + HSTS，以及受存取控制的媒體檔。
- 🤖 **AI 輔助**——Claude 副駕（透過 Vercel AI SDK 使用 `claude-haiku-4-5`）把回覆
  草稿填進客服的輸入框，並依意圖、情緒與急迫程度標記進線對話。
- 📱 **行動優先的 PWA**——可安裝、具離線感知、處理安全區域邊距、點擊目標 ≥44px；
  為用手機值班的客服設計。

## 功能

| 範疇 | 內容 |
|---|---|
| **統一收件匣** | 多帳號收發、釘選、編輯紀錄、表情回應、歷史訊息回補 |
| **對話分派** | 認領／指派對話、負責人、延後／結案的生命週期 |
| **語音通話** | 在瀏覽器中撥打／接聽真實的 Telegram 一對一語音通話 |
| **AI 分析** | 對進線訊息提示意圖、情緒與急迫程度 |
| **快速回覆** | 以 `/shortcut` 觸發的回覆範本 |
| **角色與權限** | 自訂角色，細粒度且可取聯集的權限鍵 |
| **排程** | 依時間觸發的分派／自動化規則 |
| **稽核紀錄** | 每個關鍵操作都會記錄、保存並可查詢 |
| **多租戶** | 一套部署，多個彼此隔離的團隊 |

## 架構

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

即時收發訊息需要兩個常駐程序：**app**（`npm run dev`，port 1688）與
**bridge worker**（`npm run bridge`，port 3001）。語音通話另外需要 gateway 與
Python media helper。

## 技術棧

| 層級 | 技術 |
|---|---|
| 框架 | Next.js 16（App Router、Turbopack） |
| 語言 | TypeScript 5.9（strict） |
| 介面 | React 19 · Tailwind CSS 4 · Lucide |
| 資料庫 | PostgreSQL 16 |
| ORM | Prisma 6.19 |
| 驗證 | 自製 session（bcryptjs + HTTP-only cookie） |
| 通訊 | GramJS（Telegram MTProto） |
| 語音 | py-tgcalls / ntgcalls ⇄ aiortc |
| 加密 | AES-256-GCM（Node crypto） |

## 快速開始

需求：Node.js 22 以上、含 Compose 的 Docker。只是想看看介面的話，不需要
Telegram 帳號或任何 API 金鑰。

```bash
cp .env.example .env          # 開發用預設值在本機可直接使用
docker compose up -d          # PostgreSQL 16 + pgvector 在 :5435（以及 Redis 在 :6380）
npm ci
npx prisma migrate deploy     # 建立資料表
npx prisma generate           # 產生 Prisma client
npm run db:seed               # 示範工作區、角色與使用者
npm run dev                   # app → http://localhost:1688
```

到 <http://localhost:1688/login> 以 `admin` / `admin1234`（系統管理員）或
`cs_user` / `cs1234`（客服）登入。只有在沒設定 `SEED_ADMIN_PASSWORD` /
`SEED_CS_PASSWORD` 時，seed 才會使用這組開發用密碼；`NODE_ENV=production` 時會直接
拒絕。

### 不連 Telegram 也能看的部分

- seed 會建立一個工作區、三個角色、一個團隊、一個佔位用的 Telegram 帳號
  （`PENDING_AUTH`，沒有 session）與兩個對話資料夾。在接上真實帳號之前，
  對話列表會是空的。
- 角色、成員、帳號、快速回覆、排程、稽核紀錄與系統管理頁面，在不連 Telegram、
  不啟動 bridge 的情況下都能正常載入。
- 新增 Telegram 帳號時若沒有填該帳號自己的 API ID / API Hash，登入流程會切換成
  模擬模式（介面上會標示）：輸入驗證碼 `12345` 即可通過，不會連線到 Telegram。
- 只有在接上真實 Telegram 帳號後，才需要另開終端機執行 bridge worker
  （`npm run bridge`）。語音通話另外需要
  [`services/telegram-voip-gateway`](./services/telegram-voip-gateway) 裡的 gateway
  與 media helper。

### 必要的環境變數（以 `openssl rand -hex 32` 產生密鑰）

| 變數 | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 連線字串 |
| `SESSION_SECRET` | session 完整性（正式環境必填） |
| `TELEGRAM_SESSION_KEY` | 加密儲存通路 session 的 AES-256-GCM 金鑰 |
| `INTERNAL_SECRET` | app ↔ bridge 之間的共用密鑰 |
| `SEED_ADMIN_PASSWORD` / `SEED_CS_PASSWORD` | 對正式環境資料庫執行 seed 時必填 |
| `TRUSTED_PROXY_HOPS` | 可信任的反向代理層數（用於限流與稽核的來源 IP） |

每個 Telegram 帳號的 `apiId`/`apiHash` 都在應用程式的帳號介面中輸入
（取自 <https://my.telegram.org>），不使用環境變數。

`.env.example` 裡的預留位置密鑰可以直接用於本機開發：secret guard 在非正式環境
只會發出警告，`NODE_ENV=production` 時則會丟出錯誤。

部署前請先閱讀 [`SECURITY.md`](./SECURITY.md)。

## 測試

```bash
npm test                      # vitest——不需要資料庫、網路或任何憑證
npm run check                 # tsc --noEmit + eslint
```

單元測試涵蓋：每支工作區 API 背後的角色權限聯集（以 mock 取代 Prisma 與
session）、SSE 重播緩衝、排程與 SLA 規則、標籤／電話／標題的正規化、
AES-256-GCM session 加密、secret guard、限流器，以及 Prisma 的 `.env` 載入。
CI 會在每次 push 與對 `main` 的 pull request 時執行型別檢查、lint 與測試。

## 負責任的使用

- Switchboard 透過 MTProto（GramJS）登入 Telegram 的**個人帳號**，而不是使用
  Bot API。以自動化方式操作個人帳號可能違反 Telegram 服務條款，帳號可能因此被
  限制或封鎖。部署者須自行確認最新的條款與當地法規（包括個人資料保護），並在
  連接任何帳號之前取得該帳號持有人的同意。
- 這個 repository 是工程展示，不是代管或託管服務；不提供任何擔保（見
  [授權條款](./LICENSE)），也不承諾技術支援。
- 語音相關的依賴套件（`py-tgcalls`、`ntgcalls`、`telethon`、`aiortc`）各有授權
  條款，再散布前請先確認。

## 來源說明

由 [@kiresakura](https://github.com/kiresakura) 獨立開發。

## 授權

[MIT](./LICENSE)
