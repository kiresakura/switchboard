import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventBus, type SSEEvent } from "@/lib/realtime/event-bus";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function publish(workspaceId: string, n: number) {
  eventBus.publish({ type: "chat:message", workspaceId, data: { n } });
}

function ns(events: SSEEvent[]) {
  return events.map((e) => e.data.n);
}

beforeEach(() => {
  // 不設 REDIS_URL → 單一 instance、純記憶體模式
  vi.stubEnv("REDIS_URL", "");
  vi.stubEnv("UPSTASH_REDIS_URL", "");
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// 每個測試使用獨立的 workspaceId，因為 eventBus 是 process 內的單例
describe("eventBus replay buffer", () => {
  it("replays only the requested workspace's events", () => {
    publish("ws-a", 1);
    publish("ws-b", 2);
    publish("ws-a", 3);

    expect(ns(eventBus.getReplayEvents("ws-a"))).toEqual([1, 3]);
  });

  it("assigns unique ids that embed the publish timestamp", () => {
    publish("ws-ids", 1);
    publish("ws-ids", 2);

    const [first, second] = eventBus.getReplayEvents("ws-ids");
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(new RegExp(`^[0-9a-f]{8}-${T0}-\\d+$`));
    expect(first.timestamp).toBe(T0);
  });

  it("resumes after the last event the client saw", () => {
    publish("ws-resume", 1);
    publish("ws-resume", 2);
    publish("ws-resume", 3);

    const [first] = eventBus.getReplayEvents("ws-resume");
    expect(ns(eventBus.getReplayEvents("ws-resume", first.id))).toEqual([2, 3]);
  });

  it("falls back to the timestamp inside an id issued by another instance", () => {
    publish("ws-foreign", 1);
    vi.setSystemTime(T0 + 1_000);
    publish("ws-foreign", 2);
    vi.setSystemTime(T0 + 2_000);
    publish("ws-foreign", 3);

    const foreignId = `0badc0de-${T0 + 1_000}-7`;
    expect(ns(eventBus.getReplayEvents("ws-foreign", foreignId))).toEqual([3]);
  });

  it("replays everything when the last event id cannot be parsed", () => {
    publish("ws-garbage", 1);
    publish("ws-garbage", 2);

    expect(ns(eventBus.getReplayEvents("ws-garbage", "garbage"))).toEqual([1, 2]);
  });

  it("forgets events once they leave the 5-minute replay window", () => {
    publish("ws-ttl", 1);

    vi.setSystemTime(T0 + REPLAY_WINDOW_MS - 1);
    expect(ns(eventBus.getReplayEvents("ws-ttl"))).toEqual([1]);

    vi.setSystemTime(T0 + REPLAY_WINDOW_MS);
    expect(eventBus.getReplayEvents("ws-ttl")).toEqual([]);
  });

  it("keeps at most 500 events, dropping the oldest first", () => {
    for (let n = 0; n <= 500; n++) publish("ws-ring", n);

    const replay = eventBus.getReplayEvents("ws-ring");
    expect(replay).toHaveLength(500);
    expect(replay[0].data.n).toBe(1);
    expect(replay[499].data.n).toBe(500);
  });

  it("buffers and delivers events relayed from another instance", () => {
    const received: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => received.push(e));
    const remote = {
      id: `0badc0de-${T0}-1`,
      type: "chat:message" as const,
      workspaceId: "ws-remote",
      data: { n: 1 },
      timestamp: T0,
    };

    eventBus._injectRemote(remote);
    unsubscribe();

    expect(received).toEqual([remote]);
    expect(eventBus.getReplayEvents("ws-remote")).toEqual([remote]);
  });
});

describe("eventBus subscriptions", () => {
  it("delivers to every subscriber and isolates a throwing one", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = eventBus.getListenerCount();
    const received: string[] = [];

    const unsubscribeBad = eventBus.subscribe(() => {
      throw new Error("listener bug");
    });
    const unsubscribe = eventBus.subscribe((e) => received.push(e.workspaceId));
    expect(eventBus.getListenerCount()).toBe(before + 2);

    publish("ws-sub", 1);
    unsubscribe();
    unsubscribeBad();
    publish("ws-sub", 2);

    expect(received).toEqual(["ws-sub"]);
    expect(eventBus.getListenerCount()).toBe(before);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
