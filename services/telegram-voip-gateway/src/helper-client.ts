import type { GatewayConfig } from "./config";

export type HelperHealth = {
  reachable: boolean;
  telegramSessionReady: boolean;
  mediaBridgeReady: boolean;
  fullDuplexAudioReady: boolean;
  videoReady: boolean;
  activeCalls?: number;
  reason?: string | null;
};

export type HelperCallResult =
  | { ok: true; offer: { type: string; sdp: string } | null; state?: string }
  | { ok: false; status: number; error: string; reason?: string };

const HEALTH_CACHE_MS = 3_000;

function readBoolean(value: unknown): boolean {
  return value === true;
}

export class HelperClient {
  private healthCache: { at: number; value: HelperHealth } | null = null;

  constructor(private readonly config: GatewayConfig) {}

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.helperSecret}`,
    };
  }

  private url(path: string) {
    return `${this.config.helperUrl}${path}`;
  }

  async health(force = false): Promise<HelperHealth> {
    const now = Date.now();
    if (!force && this.healthCache && now - this.healthCache.at < HEALTH_CACHE_MS) {
      return this.healthCache.value;
    }
    let value: HelperHealth;
    try {
      const res = await fetch(this.url("/health"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(2_500),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      value = {
        reachable: res.ok,
        telegramSessionReady: readBoolean(data.telegramSessionReady),
        mediaBridgeReady: readBoolean(data.mediaBridgeReady),
        fullDuplexAudioReady: readBoolean(data.fullDuplexAudioReady),
        videoReady: readBoolean(data.videoReady),
        activeCalls: typeof data.activeCalls === "number" ? data.activeCalls : undefined,
        reason: typeof data.reason === "string" ? data.reason : null,
      };
    } catch {
      value = {
        reachable: false,
        telegramSessionReady: false,
        mediaBridgeReady: false,
        fullDuplexAudioReady: false,
        videoReady: false,
        reason: "HELPER_UNREACHABLE",
      };
    }
    this.healthCache = { at: now, value };
    return value;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<HelperCallResult> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { ok: false, status: 502, error: "VOIP_HELPER_UNREACHABLE" };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: typeof data.error === "string" ? data.error : "VOIP_HELPER_ERROR",
        reason: typeof data.reason === "string" ? data.reason : undefined,
      };
    }
    const offer = data.offer;
    return {
      ok: true,
      offer:
        offer && typeof offer === "object" && typeof (offer as { sdp?: unknown }).sdp === "string"
          ? (offer as { type: string; sdp: string })
          : null,
      state: typeof data.state === "string" ? data.state : undefined,
    };
  }

  createCall(input: { sessionId: string; platformUserId: string; mode: string }) {
    return this.post("/calls", {
      ...input,
      iceServers: this.config.iceServers,
    });
  }

  answerCall(sessionId: string) {
    return this.post(`/calls/${encodeURIComponent(sessionId)}/answer`, {
      iceServers: this.config.iceServers,
    });
  }

  signal(sessionId: string, signal: Record<string, unknown>): Promise<HelperCallResult> {
    return this.post(`/calls/${encodeURIComponent(sessionId)}/signals`, { signal });
  }

  async deleteCall(sessionId: string): Promise<void> {
    await fetch(this.url(`/calls/${encodeURIComponent(sessionId)}`), {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
  }
}
