/**
 * Bridge singleton lock — Postgres advisory lock that enforces "at most one
 * bridge worker holding active GramJS sessions at any moment".
 *
 * Background (incident 2026-05-05):
 *   Railway 的 rolling deploy 會讓舊 bridge 跟新 bridge 同時活著 ~3 秒。
 *   兩邊各自用同一筆 TelegramSession 重連 Telegram → Telegram 偵測到
 *   AUTH_KEY_DUPLICATED → 把 auth_key 廢掉,既有帳號掉線。要修這條 race
 *   只能保證任意時刻「全宇宙只有一個 bridge 在跟 Telegram 說話」。
 *
 * Design:
 *   - 用 Postgres `pg_advisory_lock` (session-scoped)。誰先 connect 並
 *     lock 成功誰就是「現任」bridge。
 *   - 鎖綁在獨立的 pg.Client 連線上,連線斷掉(crash / SIGKILL / OOM /
 *     network)時 Postgres 自動釋放鎖,下一個 waiter 立刻拿到。
 *   - 等待時非阻塞:先 `pg_try_advisory_lock` 看立刻拿不拿得到;拿不到
 *     才 `pg_advisory_lock`(會 hang)。等待中每 5 秒 log 一次狀態,
 *     不會看起來像當機。
 *   - 用兩個 int32 的鎖鍵(classid, objid)是為了在 `pg_locks` 視圖裡
 *     好認:`SELECT * FROM pg_locks WHERE locktype='advisory'` 可以直接
 *     看到 0x43534D53(='CSMS')+ 0x42524447(='BRDG')。
 *
 * Lifecycle:
 *   - 開機:bridge.main() 在連 Telegram 前 await acquireBridgeLock()。
 *   - 關機:SIGTERM handler 必須先斷 GramJS、等 1-2 秒讓 Telegram 端
 *     收到 disconnect、再 release() 釋放鎖。順序顛倒會讓新 bridge 又
 *     撞 AUTH_KEY_DUPLICATED。
 */
import { Client } from "pg";
import { logger } from "../logger";

const log = logger("BridgeLock");

// 鎖鍵:two-int32 form。值挑成可閱讀的 ASCII 助記:
//   classid = 0x43534D53 = 'CSMS' (Customer Service Management System)
//   objid   = 0x42524447 = 'BRDG' (Bridge)
const LOCK_CLASSID = 0x43534d53; // 'CSMS'
const LOCK_OBJID = 0x42524447; // 'BRDG'

const PROGRESS_LOG_INTERVAL_MS = 5_000;

export interface SingletonLock {
  /**
   * Release the advisory lock and close the dedicated pg connection.
   * Must be called AFTER GramJS clients have fully disconnected — releasing
   * the lock first allows the next bridge to start connecting Telegram while
   * this bridge's auth_keys are still in use server-side, which would re-
   * trigger AUTH_KEY_DUPLICATED.
   */
  release: () => Promise<void>;
}

/**
 * Acquire the cluster-wide bridge singleton lock. Blocks (with progress
 * logging) until the lock is available. Throws on connection / query
 * failure — caller should treat that as fatal and exit non-zero.
 */
export async function acquireBridgeLock(
  connectionString: string,
): Promise<SingletonLock> {
  const client = new Client({ connectionString });
  client.on("error", (err) => {
    // 不直接 process.exit — 讓 caller 的 unhandledRejection / shutdown
    // 路徑接走。打 log 讓我們知道鎖連線斷了。
    log.error("Bridge lock pg connection error", { error: String(err) });
  });

  await client.connect();

  log.info("Acquiring bridge singleton lock…", {
    classid: `0x${LOCK_CLASSID.toString(16)}`,
    objid: `0x${LOCK_OBJID.toString(16)}`,
  });

  // 1) Non-blocking 試一次,讓 log 區分「立刻拿到」vs「要排隊」兩種情境。
  const tryRes = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    [LOCK_CLASSID, LOCK_OBJID],
  );

  if (tryRes.rows[0]?.acquired) {
    log.info("Bridge singleton lock acquired immediately");
    return makeLockHandle(client);
  }

  log.warn(
    "Another bridge holds the singleton lock — waiting for it to release…",
  );

  // 2) Blocking acquire,中間 5s 一次 progress log。
  const startTime = Date.now();
  const progressTimer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    log.warn("Still waiting for bridge singleton lock", { elapsedSec });
  }, PROGRESS_LOG_INTERVAL_MS);

  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      LOCK_CLASSID,
      LOCK_OBJID,
    ]);
  } finally {
    clearInterval(progressTimer);
  }

  const waitedSec = Math.round((Date.now() - startTime) / 1000);
  log.info("Bridge singleton lock acquired after wait", { waitedSec });
  return makeLockHandle(client);
}

function makeLockHandle(client: Client): SingletonLock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        // pg_advisory_unlock 回 boolean(true=有解鎖、false=本來就沒鎖)。
        // 我們不檢查回傳值 — 連線斷掉同樣會釋放,結果一樣。
        await client.query("SELECT pg_advisory_unlock($1, $2)", [
          LOCK_CLASSID,
          LOCK_OBJID,
        ]);
        log.info("Bridge singleton lock released");
      } catch (err) {
        log.error("Failed to unlock bridge singleton (continuing)", {
          error: String(err),
        });
      } finally {
        try {
          await client.end();
        } catch {
          // ignore — 程式即將離開,連線狀態無所謂
        }
      }
    },
  };
}
