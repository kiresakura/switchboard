/**
 * Background job queue — pg-boss skeleton (2026-05-21).
 *
 * 為什麼:現有 cron 全是 bridge 的 setInterval(),撐單 instance OK,但:
 *   - 沒有 retry 機制(失敗就跳過該次,要等下一輪)
 *   - 沒有去重(兩個 instance 同時跑就會重複處理)
 *   - 沒有 dead-letter queue 看哪些 job 一直失敗
 *   - 不能 schedule 一次性 future job(e.g. 用戶設了「明天 9 點寄這封信」)
 * pg-boss 用 Postgres 的 SELECT ... FOR UPDATE SKIP LOCKED 解決前三個,本身就是
 * 一個輕量級任務佇列,跑在 Switchboard 既有的 Postgres 之上 — 零新服務。
 *
 * 本檔當前範圍(Round 3 概念驗證):
 *   - 初始化 pg-boss 並暴露給 bridge 使用
 *   - 註冊一個示範 job:cleanup expired PendingAuthSession(每小時跑)
 *   - 其他 setInterval cron 暫不遷移(每個獨立 round 再來)
 *
 * 依賴 / 環境:
 *   - pg-boss(optionalDependencies)— 沒裝就靜默 skip
 *   - DATABASE_URL — 同主資料庫
 *   - PGBOSS_DISABLED=true — 顯式關閉(testing / 暫時繞道用)
 */

import { logger } from "@/lib/logger";

const log = logger("Jobs");

// Minimal interface — pg-boss 自己的 TS types 我們不硬綁定。
interface PgBossInstance {
  start(): Promise<void>;
  stop(opts?: { graceful?: boolean; timeout?: number }): Promise<void>;
  schedule(name: string, cron: string, data?: unknown, opts?: unknown): Promise<void>;
  work<T>(
    name: string,
    handler: (job: { id: string; data: T } | Array<{ id: string; data: T }>) => unknown | Promise<unknown>,
  ): Promise<string>;
  send<T>(name: string, data: T, opts?: unknown): Promise<string | null>;
  /** pg-boss 12+:work/schedule 前必須 createQueue。冪等(重複呼叫不會錯)。 */
  createQueue(name: string, options?: Record<string, unknown>): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

type PgBossCtor = new (config: string | Record<string, unknown>) => PgBossInstance;

let boss: PgBossInstance | null = null;
let initPromise: Promise<PgBossInstance | null> | null = null;

/**
 * 載入 pg-boss + 啟動。idempotent — 多 caller 共享同一個 promise。
 * 失敗(套件沒裝 / 連線失敗 / disable)→ resolves null,caller 自己決定要不要 fallback。
 */
export async function initJobs(): Promise<PgBossInstance | null> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (process.env.PGBOSS_DISABLED === "true") {
      log.info("PGBOSS_DISABLED=true — skipping pg-boss init");
      return null;
    }
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      log.warn("DATABASE_URL not set — pg-boss disabled");
      return null;
    }
    try {
      const mod = await import("pg-boss");
      // pg-boss 12.x exports `PgBoss` as named class + a few helpers,沒有 default export。
      const Ctor = (mod as unknown as { PgBoss: PgBossCtor }).PgBoss;
      if (!Ctor) {
        log.warn("pg-boss import failed (PgBoss class not found)");
        return null;
      }
      const instance = new Ctor(dbUrl);
      instance.on("error", (err: unknown) => {
        log.warn("pg-boss internal error", { err: String(err).slice(0, 200) });
      });
      await instance.start();
      boss = instance;
      log.info("pg-boss started");
      // 註冊預設 jobs
      await registerDefaultJobs(instance);
      return instance;
    } catch (err) {
      log.error("pg-boss init failed", { err: String(err).slice(0, 200) });
      // 連線 / 啟動失敗 → 清掉快取的 promise,容許後續 caller 重試
      // (PGBOSS_DISABLED / 沒 DATABASE_URL 是刻意停用,走上方 return,不重試)。
      initPromise = null;
      return null;
    }
  })();
  return initPromise;
}

export async function shutdownJobs(): Promise<void> {
  if (!boss) return;
  try {
    await boss.stop({ graceful: true, timeout: 10_000 });
  } catch (err) {
    log.warn("pg-boss shutdown error", { err: String(err).slice(0, 200) });
  }
  boss = null;
}

/** Send 一次性 job(立刻或排程到 future time)。 */
export async function sendJob<T>(name: string, data: T, opts?: unknown): Promise<string | null> {
  const instance = await initJobs();
  if (!instance) return null;
  return instance.send(name, data, opts);
}

/**
 * 預設 jobs — 跟著 init 一起註冊。
 *
 * Round 4 範圍(2026-05-21):
 *   - cleanup-pending-auth-sessions(hourly):清過期 auth session
 *   - cleanup-expired-delegations(daily):軟刪除過期 30 天的 AccountDelegation
 *   - cleanup-stale-translations(weekly):清 90 天沒被讀過的翻譯快取
 *
 * 為什麼從 setInterval 抽出來:
 *   - 多 instance 不會重複跑(pg-boss 自動 dedupe)
 *   - 失敗有 retry 不會默默吞掉
 *   - 可以從 audit log 查「上次跑成功是何時」
 *
 * Round 4 沒遷移的 setInterval(bridge 自己仍跑):
 *   - lockCleanup(60s)、discovery(5min)、retention(1h)、avatar(60s)、reconcile(5min)
 *   - 這些跟 GramJS client 強耦合,搬到 pg-boss 要先抽出 client manager 的訪問,
 *     等下回合再做。
 */
async function registerDefaultJobs(instance: PgBossInstance): Promise<void> {
  const { prisma } = await import("@/lib/db");

  // Helper:在 pg-boss 12+,work/schedule 前要先 createQueue(冪等)。
  const registerJob = async (
    name: string,
    cron: string,
    handler: () => Promise<void>,
  ) => {
    await instance.createQueue(name);
    await instance.work(name, async () => {
      await handler();
    });
    await instance.schedule(name, cron);
  };

  // Job 1: cleanup-pending-auth-sessions(hourly @ :05)
  await registerJob("cleanup-pending-auth-sessions", "5 * * * *", async () => {
    const result = await prisma.pendingAuthSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    log.info("cleanup-pending-auth-sessions completed", {
      deleted: result.count,
    });
  });

  // Job 2: cleanup-expired-delegations(daily @ 03:15)
  // 過期已經被 account-visibility 過濾,但久了 row 太多 — 刪 30 天前的、
  // revokedAt 或 expiresAt 之一 < now-30d 即可。保留稽核期(audit log 仍有完整紀錄)。
  await registerJob("cleanup-expired-delegations", "15 3 * * *", async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await prisma.accountDelegation.deleteMany({
      where: {
        OR: [
          { revokedAt: { lt: cutoff } },
          { expiresAt: { lt: cutoff }, revokedAt: null },
        ],
      },
    });
    log.info("cleanup-expired-delegations completed", {
      deleted: result.count,
    });
  });

  // Job 3: cleanup-stale-translations(weekly Sunday @ 04:30)
  // 翻譯快取 90 天沒人讀過 → 刪除。保留近期常用詞庫。
  // 簡化:沒記 lastReadAt,直接刪「createdAt < now-90d」的 row。
  await registerJob("cleanup-stale-translations", "30 4 * * 0", async () => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const result = await prisma.conversationMessageTranslation.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    log.info("cleanup-stale-translations completed", {
      deleted: result.count,
    });
  });

  log.info(
    "Registered jobs: cleanup-pending-auth-sessions, cleanup-expired-delegations, cleanup-stale-translations",
  );
}
