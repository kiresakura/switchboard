export type GatewayConfig = {
  host: string;
  port: number;
  secret: string;
  sessionTtlMs: number;
  /** Media helper daemon (Python, services/telegram-voip-gateway/helper). */
  helperUrl: string;
  helperSecret: string;
  /** Switchboard CommunicationAccount id whose Telegram session the helper holds. */
  voipAccountId: string;
  /** Master switch for placing/answering real Telegram calls. */
  enableRealCalls: boolean;
  /** Lab allowlist (exact match). Empty + !allowAnyPrivatePeer ⇒ calls blocked. */
  approvedCalleePlatformUserId: string;
  approvedCalleeGroupId: string;
  /** Production switch: allow any private-chat peer (Switchboard already authorizes). */
  allowAnyPrivatePeer: boolean;
  /** Browser-safe ICE servers, JSON array (TURN/STUN). */
  iceServers: Array<Record<string, unknown>>;
  switchboardBaseUrl: string;
};

function readNumber(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readIceServers(raw: string | undefined): Array<Record<string, unknown>> {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && "urls" in entry,
    );
  } catch {
    return [];
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    host: env.TELEGRAM_VOIP_GATEWAY_HOST || env.HOST || "127.0.0.1",
    port: readNumber(env.TELEGRAM_VOIP_GATEWAY_PORT || env.PORT, 3002),
    secret: (
      env.TELEGRAM_VOIP_GATEWAY_SECRET ||
      env.VOIP_GATEWAY_SECRET ||
      ""
    ).trim(),
    sessionTtlMs: readNumber(env.TELEGRAM_VOIP_SESSION_TTL_MS, 15 * 60_000),
    helperUrl: (env.TELEGRAM_VOIP_HELPER_URL || "http://127.0.0.1:3003")
      .trim()
      .replace(/\/$/, ""),
    helperSecret: (
      env.TELEGRAM_VOIP_HELPER_SECRET ||
      env.TELEGRAM_VOIP_GATEWAY_SECRET ||
      env.VOIP_GATEWAY_SECRET ||
      ""
    ).trim(),
    voipAccountId: (env.TELEGRAM_VOIP_ACCOUNT_ID || "").trim(),
    enableRealCalls:
      env.TELEGRAM_VOIP_ENABLE_REAL_CALLS === "1" ||
      env.QA_ENABLE_REAL_TELEGRAM_CALL === "1",
    approvedCalleePlatformUserId: (env.QA_APPROVED_CALLEE_PLATFORM_USER_ID || "").trim(),
    approvedCalleeGroupId: (env.QA_APPROVED_CALLEE_GROUP_ID || "").trim(),
    allowAnyPrivatePeer: env.TELEGRAM_VOIP_ALLOW_ANY_PRIVATE_PEER === "1",
    iceServers: readIceServers(env.TELEGRAM_VOIP_ICE_SERVERS),
    switchboardBaseUrl: (env.SWITCHBOARD_BASE_URL || env.QA_BASE_URL || "").trim().replace(/\/$/, ""),
  };
}
