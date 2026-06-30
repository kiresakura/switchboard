# ── 階段一：安裝依賴 ──────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/
COPY prisma.config.ts tsconfig.json ./

# 產生 Prisma Client 時需要一個假的 DATABASE_URL 讓 prisma.config.ts 不報錯
ARG DATABASE_URL=postgresql://fake:fake@localhost:5432/fake
ENV DATABASE_URL=${DATABASE_URL}

RUN npm ci --ignore-scripts
# @prisma/dev 7.x 透過 require() 載入 zeptomatch (ESM);Node 20 需此 flag
ENV NODE_OPTIONS="--experimental-require-module"
RUN npx prisma generate

# ── 階段二：建置 Next.js ─────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# 建置時提供假的 secrets 讓 module-level 驗證不拋錯
# 這些值只在 build 階段使用，runtime 由部署平台的環境變數覆蓋
ENV DATABASE_URL="postgresql://fake:fake@localhost:5432/fake"
ENV SESSION_SECRET="build-time-placeholder-replaced-at-runtime"
ENV TELEGRAM_SESSION_KEY="build-time-placeholder-replaced-at-runtime"
ENV INTERNAL_SECRET="build-time-placeholder-replaced-at-runtime"

RUN npm run build

# ── 階段三：Migration 專用鏡像（保留完整 node_modules 以跑 prisma CLI）────
FROM node:22-alpine AS migrate
WORKDIR /app

ENV NODE_OPTIONS="--experimental-require-module"

# deps 階段已經 npm ci 裝了包含 prisma CLI 的完整 node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma/
COPY prisma.config.ts tsconfig.json ./

CMD ["node", "./node_modules/prisma/build/index.js", "migrate", "deploy"]

# ── 階段四：生產環境 ─────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# 安裝 wget（用於 healthcheck）
RUN apk add --no-cache wget

# 建立非 root 使用者
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# 複製必要檔案
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# 確保 /app/uploads 可讀（avatar API 從這讀 — bridge 寫，app 讀）
RUN mkdir -p /app/uploads && chown -R nextjs:nodejs /app/uploads

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
