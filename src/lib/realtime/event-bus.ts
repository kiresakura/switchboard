import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { logger } from "@/lib/logger";

const log = logger("EventBus");

export type SSEEventType =
  | "review:new"
  | "review:locked"
  | "review:unlocked"
  | "review:resolved"
  | "message:forwarded"
  | "message:edited"
  | "message:deleted"
  | "message:new_direct"
  | "message:read"
  | "message:pinned"
  | "chat:message"
  | "chat:reaction-changed"
  // A user in one of our tracked groups is typing on Telegram. Fired by
  // bridge for every UpdateUserTyping / UpdateChat*UserTyping update; the
  // UI expects to hide the indicator ~6s after the latest event.
  | "chat:typing"
  | "account:status"
  | "presence:update"
  | "group:discovered"
  | "group:migrated"
  | "group:renamed"
  | "conversation:tags-updated"
  | "call:incoming"
  | "call:updated"
  | "announcement:created"
  | "announcement:updated"
  | "handover:created";

export type SSEEvent = {
  id?: string;
  type: SSEEventType;
  workspaceId: string;
  data: Record<string, unknown>;
  timestamp?: number;
};

// In-memory ring buffer for event replay on reconnect
const EVENT_BUFFER_SIZE = 500;
const EVENT_BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes

type BufferedEvent = SSEEvent & { id: string; timestamp: number };

// ─── Redis pub/sub adapter (2026-05-21) ────────────────────────────
//
// 為什麼需要:in-process EventEmitter 在多實例部署(Railway 橫向擴展、Vercel
// edge fan-out)下完全壞掉 — Instance A 收到 SSE event 後只通知 A 自己的客戶端,
// 連到 B 的客戶端永遠看不到。Redis pub/sub 是 Switchboard 規模下最簡單的 fanout:
// - publish 到頻道 → 所有 instance 收到 → 各自分發給自己的 SSE listeners
// - 每個 event 帶 `_origin` instance UUID,instance 自己 echo 的訊息會 dedup
// - REDIS_URL 沒設 → 完全跳過 Redis,回到 single-instance in-memory(dev 友善)
// - ioredis 沒安裝 → catch + 印 warning 不掛掉(讓部署可漸進開啟)
//
// 為什麼不用 @upstash/redis(REST):他們 REST API 不支援 SUBSCRIBE。pub/sub
// 必須走持久連線。Switchboard 的 next.js 跟 bridge 都是長期 process,ioredis 完全 fit。
//
// 不做的事:event ordering 跨 instance(Redis pub/sub 是 at-most-once + 不保序),
// persistence(restart 丟掉所有 5min buffer 也接受 — UI 已經有 SSE reconnect)。

const INSTANCE_ID = randomUUID();
const REDIS_CHANNEL = "bbcs:sse:v1";

interface IORedisClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
  disconnect(): void;
}
type IORedisCtor = new (url: string, opts?: Record<string, unknown>) => IORedisClient;

let redisPub: IORedisClient | null = null;
let redisSub: IORedisClient | null = null;
let redisInitPromise: Promise<void> | null = null;
// init 失敗的時間戳;失敗後冷卻期內不重試(避免每個 publish 都重連造成 storm)。
let redisInitFailedAt = 0;
const REDIS_INIT_RETRY_COOLDOWN_MS = 60_000;

async function ensureRedisInit(): Promise<void> {
  if (redisInitPromise) return redisInitPromise;
  // 上次 init 失敗後的冷卻期內直接跳過 — 不讓每個事件都重試重連。
  if (
    redisInitFailedAt &&
    Date.now() - redisInitFailedAt < REDIS_INIT_RETRY_COOLDOWN_MS
  ) {
    return;
  }
  redisInitPromise = (async () => {
    const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;
    if (!url) {
      log.info(
        "REDIS_URL not set — event-bus running single-instance (in-memory only)",
        { instance: INSTANCE_ID.slice(0, 8) },
      );
      return;
    }
    try {
      // ioredis 已加進 dependencies(以前是 optionalDependencies + 動態 import,
      // 後來確認部署要 multi-instance 一律需要)。直接 import 比 dynamic 簡潔且 tsc 順手。
      const mod = await import("ioredis");
      const Ctor = (mod.default ?? (mod as unknown as { Redis: IORedisCtor }).Redis) as IORedisCtor;
      if (!Ctor) {
        log.warn("ioredis import failed");
        return;
      }
      // 連線參數:讓 ioredis 自己 retry(預設 maxRetriesPerRequest=20,exponential)。
      // lazyConnect=false → 立刻連,讓我們在 startup 就知道是否能通。
      redisPub = new Ctor(url, { lazyConnect: false });
      redisSub = new Ctor(url, { lazyConnect: false });
      redisPub.on("error", (err) => {
        log.warn("Redis pub error", { err: String(err).slice(0, 200) });
      });
      redisSub.on("error", (err) => {
        log.warn("Redis sub error", { err: String(err).slice(0, 200) });
      });
      await redisSub.subscribe(REDIS_CHANNEL);
      redisSub.on("message", (channel: string, message: string) => {
        if (channel !== REDIS_CHANNEL) return;
        try {
          const parsed = JSON.parse(message) as BufferedEvent & {
            _origin?: string;
          };
          // 過濾自己 publish 出去的回音 — 否則本 instance 的 listener 會被 emit 兩次。
          if (parsed._origin === INSTANCE_ID) return;
          eventBus._injectRemote(parsed);
        } catch (err) {
          log.warn("invalid Redis SSE payload", {
            err: String(err).slice(0, 200),
          });
        }
      });
      log.info("Redis pub/sub initialized", {
        channel: REDIS_CHANNEL,
        instance: INSTANCE_ID.slice(0, 8),
      });
    } catch (err) {
      log.error("Redis init failed — fallback to single-instance", {
        err: String(err).slice(0, 200),
      });
      redisPub = null;
      redisSub = null;
      // 清掉 promise + 記失敗時間 → 冷卻期過後可重試(不會每個事件狂重連)。
      redisInitPromise = null;
      redisInitFailedAt = Date.now();
    }
  })();
  return redisInitPromise;
}

class EventBus {
  private emitter = new EventEmitter();
  private listenerCount = 0;
  private buffer: BufferedEvent[] = [];
  private eventCounter = 0;

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  publish(event: SSEEvent) {
    const now = Date.now();
    // instance-prefix 確保跨 instance id 不撞 — replay by lastEventId 需要 globally unique。
    const id = `${INSTANCE_ID.slice(0, 8)}-${now}-${++this.eventCounter}`;
    const buffered: BufferedEvent = {
      ...event,
      id,
      timestamp: now,
    };

    // Drop events past TTL — done on publish so an idle workspace can't
    // accumulate stale events that linger until the next read.
    const cutoff = now - EVENT_BUFFER_TTL_MS;
    if (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
      this.buffer = this.buffer.filter((e) => e.timestamp >= cutoff);
    }

    // Add to ring buffer
    this.buffer.push(buffered);
    if (this.buffer.length > EVENT_BUFFER_SIZE) {
      this.buffer.shift();
    }

    // Local fanout — 本 instance 的 SSE listeners 立刻拿到。
    const listeners = this.emitter.listeners("sse") as Array<
      (event: BufferedEvent) => void
    >;
    for (const listener of listeners) {
      try {
        listener(buffered);
      } catch (error) {
        log.error("subscriber error", { error: String(error) });
      }
    }

    // Cross-instance fanout — best-effort,Redis 沒連或失敗都不影響本 instance 行為。
    void this._publishRemote(buffered);
  }

  private async _publishRemote(buffered: BufferedEvent) {
    await ensureRedisInit();
    if (!redisPub) return;
    try {
      const enveloped = { ...buffered, _origin: INSTANCE_ID };
      await redisPub.publish(REDIS_CHANNEL, JSON.stringify(enveloped));
    } catch (err) {
      log.warn("Redis publish failed", { err: String(err).slice(0, 200) });
    }
  }

  /**
   * Internal — Redis subscriber 收到別的 instance publish 的事件時呼叫。
   * 跟 publish() 不同:不再 republish 到 Redis(會迴圈),但 buffer + 本機 emit 都要做,
   * 不然連到本 instance 的 SSE 客戶端不會收到事件 / replay 也找不到。
   */
  _injectRemote(event: BufferedEvent) {
    const now = Date.now();
    const cutoff = now - EVENT_BUFFER_TTL_MS;
    if (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
      this.buffer = this.buffer.filter((e) => e.timestamp >= cutoff);
    }
    this.buffer.push(event);
    if (this.buffer.length > EVENT_BUFFER_SIZE) {
      this.buffer.shift();
    }
    const listeners = this.emitter.listeners("sse") as Array<
      (event: BufferedEvent) => void
    >;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log.error("subscriber error (remote)", { error: String(error) });
      }
    }
  }

  /**
   * Replay events missed during SSE disconnect.
   * Returns events after `lastEventId` for the given workspace.
   */
  getReplayEvents(workspaceId: string, lastEventId?: string): BufferedEvent[] {
    const cutoff = Date.now() - EVENT_BUFFER_TTL_MS;
    const workspaceEvents = this.buffer.filter(
      (e) => e.workspaceId === workspaceId && e.timestamp > cutoff,
    );

    if (!lastEventId) return workspaceEvents;

    const idx = workspaceEvents.findIndex((e) => e.id === lastEventId);
    if (idx !== -1) return workspaceEvents.slice(idx + 1);
    // lastEventId 不在 buffer(常見於 reconnect 連到「不同 instance」)→ 不要
    // 整個 buffer 重播(會造成客戶端重複事件風暴)。改用 id 內嵌的 timestamp
    // (格式 `<8hex>-<ms>-<counter>`)只回該時間點之後的事件。
    const tsFromId = parseInt(lastEventId.split("-")[1] ?? "", 10);
    if (Number.isFinite(tsFromId)) {
      return workspaceEvents.filter((e) => e.timestamp > tsFromId);
    }
    return workspaceEvents; // id 無法解析 timestamp → 只能全回(極罕見)
  }

  subscribe(listener: (event: BufferedEvent) => void) {
    // First subscribe — kick off Redis init (idempotent + async, doesn't block).
    void ensureRedisInit();
    this.listenerCount++;
    if (this.listenerCount > 900) {
      log.warn("High listener count", { count: this.listenerCount });
    }
    this.emitter.on("sse", listener);
    return () => {
      this.emitter.off("sse", listener);
      this.listenerCount--;
    };
  }

  getListenerCount() {
    return this.listenerCount;
  }
}

// Singleton for the process
const globalForBus = globalThis as unknown as {
  eventBus: EventBus | undefined;
};

export const eventBus = globalForBus.eventBus ?? new EventBus();

if (process.env.NODE_ENV !== "production") {
  globalForBus.eventBus = eventBus;
}
