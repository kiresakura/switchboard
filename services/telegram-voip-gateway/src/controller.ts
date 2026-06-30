import type { GatewayConfig } from "./config";
import { HelperClient } from "./helper-client";
import {
  isTerminalCallState,
  type CreateGatewaySessionInput,
  type GatewaySession,
  type GatewaySessionState,
  type SessionStore,
} from "./sessions";

export type CallReadiness = {
  realTelegramCalls: boolean;
  telegramSessionReady: boolean;
  mediaBridgeReady: boolean;
  outgoingRingingSpikeReady: boolean;
  incomingDetectionReady: boolean;
  fullDuplexAudioReady: boolean;
  videoReady: boolean;
  helperReachable: boolean;
  activeHelperCalls?: number;
  reason: string | null;
};

export type CallAttemptResult =
  | {
      ok: true;
      session: GatewaySession;
      offer: { type: string; sdp: string } | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      reason?: string;
      session?: GatewaySession;
    };

type HelperEvent = {
  event: "incoming" | "state";
  sessionId?: string;
  platformUserId?: string;
  mode?: string;
  state?: string;
  detail?: string;
};

function sanitize(value: string | undefined | null, max = 240) {
  if (!value) return undefined;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "<redacted>")
    .slice(0, max);
}

/**
 * Control plane for real embedded Telegram calls.
 *
 * All Telegram signaling + media lives in the Python helper; this class owns
 * authorization gates, the session registry, and Switchboard callbacks.
 */
export class CallController {
  readonly helper: HelperClient;

  constructor(
    private readonly config: GatewayConfig,
    private readonly sessions: SessionStore,
  ) {
    this.helper = new HelperClient(config);
  }

  // -------------------------------------------------------------- readiness

  async getReadiness(force = false): Promise<CallReadiness> {
    const health = await this.helper.health(force);
    const hasTargetPolicy =
      this.config.allowAnyPrivatePeer ||
      Boolean(this.config.approvedCalleePlatformUserId || this.config.approvedCalleeGroupId);
    const callsEnabled = this.config.enableRealCalls && hasTargetPolicy;
    const real = callsEnabled && health.telegramSessionReady;

    let reason: string | null = null;
    if (!health.reachable) reason = health.reason || "HELPER_UNREACHABLE";
    else if (!health.telegramSessionReady) reason = health.reason || "TELEGRAM_SESSION_NOT_READY";
    else if (!this.config.enableRealCalls) reason = "REAL_CALLS_DISABLED";
    else if (!hasTargetPolicy) reason = "NO_APPROVED_TARGET_POLICY";

    return {
      realTelegramCalls: real,
      telegramSessionReady: health.telegramSessionReady,
      mediaBridgeReady: health.mediaBridgeReady,
      outgoingRingingSpikeReady: real,
      incomingDetectionReady: health.telegramSessionReady,
      fullDuplexAudioReady: health.fullDuplexAudioReady,
      videoReady: false,
      helperReachable: health.reachable,
      activeHelperCalls: health.activeCalls,
      reason,
    };
  }

  // ------------------------------------------------------------------ guards

  private guard(input: CreateGatewaySessionInput): CallAttemptResult | null {
    if (!this.config.enableRealCalls) {
      return {
        ok: false,
        status: 403,
        error: "REAL_CALL_DISABLED",
        message:
          "Real Telegram calls are disabled. Set TELEGRAM_VOIP_ENABLE_REAL_CALLS=1 (or QA_ENABLE_REAL_TELEGRAM_CALL=1).",
      };
    }
    if (input.mode !== "voice") {
      return {
        ok: false,
        status: 400,
        error: "REAL_CALL_MODE_NOT_SUPPORTED",
        message: "Embedded Telegram calls currently support voice only.",
      };
    }
    if (this.config.voipAccountId && input.accountId !== this.config.voipAccountId) {
      return {
        ok: false,
        status: 403,
        error: "VOIP_ACCOUNT_MISMATCH",
        message:
          "This gateway's helper holds a session for a different CommunicationAccount; embedded calls from this account are not possible.",
      };
    }
    return null;
  }

  private isApprovedOutgoingTarget(input: CreateGatewaySessionInput) {
    if (this.config.allowAnyPrivatePeer) return true;
    if (
      this.config.approvedCalleePlatformUserId &&
      input.platformUserId === this.config.approvedCalleePlatformUserId
    ) {
      return true;
    }
    if (this.config.approvedCalleeGroupId && input.groupId === this.config.approvedCalleeGroupId) {
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- actions

  async requestOutgoingCall(input: CreateGatewaySessionInput): Promise<CallAttemptResult> {
    const guarded = this.guard(input);
    if (guarded) return guarded;

    if (!this.isApprovedOutgoingTarget(input)) {
      return {
        ok: false,
        status: 403,
        error: "REAL_CALL_TARGET_NOT_APPROVED",
        message:
          "Outgoing target is not approved. Set TELEGRAM_VOIP_ALLOW_ANY_PRIVATE_PEER=1 or the QA_APPROVED_CALLEE_* allowlist.",
      };
    }

    const active = this.sessions.findActiveByPeer(input.platformUserId);
    if (active) {
      return {
        ok: false,
        status: 409,
        error: "CALL_ALREADY_ACTIVE_FOR_PEER",
        message: "A call session with this contact is already in progress.",
        session: active,
      };
    }

    const session = this.sessions.create({ ...input, state: "dialing" });
    const result = await this.helper.createCall({
      sessionId: session.id,
      platformUserId: input.platformUserId,
      mode: input.mode,
    });
    if (!result.ok) {
      this.sessions.updateState(session.id, "failed", result.reason);
      return {
        ok: false,
        status: result.status,
        error: result.error,
        message: "Telegram VoIP helper could not start the call.",
        reason: sanitize(result.reason),
        session,
      };
    }
    if (result.state === "dialing" || result.state === "ringing") {
      this.sessions.updateState(session.id, result.state);
    }
    return { ok: true, session: this.sessions.get(session.id) || session, offer: result.offer };
  }

  async answerIncomingCall(
    sessionId: string,
    input: CreateGatewaySessionInput,
  ): Promise<CallAttemptResult> {
    const guarded = this.guard(input);
    if (guarded) return guarded;

    const session = this.sessions.get(sessionId);
    if (!session || session.direction !== "incoming") {
      return {
        ok: false,
        status: 404,
        error: "CALL_SESSION_NOT_FOUND",
        message: "Incoming call session does not exist or already expired.",
      };
    }
    if (isTerminalCallState(session.state)) {
      return {
        ok: false,
        status: 410,
        error: "CALL_ALREADY_ENDED",
        message: "The caller hung up before the call was answered.",
        session,
      };
    }
    if (session.platformUserId !== input.platformUserId) {
      return {
        ok: false,
        status: 409,
        error: "CALL_SESSION_PEER_MISMATCH",
        message: "Session does not belong to this conversation.",
        session,
      };
    }

    // Adopt Switchboard context (workspace/group/operator) onto the helper-born session.
    session.workspaceId = input.workspaceId;
    session.groupId = input.groupId;
    session.accountId = input.accountId;
    session.operatorUserId = input.operatorUserId;

    const result = await this.helper.answerCall(sessionId);
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: result.error,
        message: "Telegram VoIP helper could not answer the call.",
        reason: sanitize(result.reason),
        session,
      };
    }
    return { ok: true, session, offer: result.offer };
  }

  async signal(sessionId: string, signal: Record<string, unknown>) {
    this.sessions.recordSignal(sessionId);
    return this.helper.signal(sessionId, signal);
  }

  async endCall(sessionId: string) {
    await this.helper.deleteCall(sessionId);
    const session = this.sessions.get(sessionId);
    if (session && !isTerminalCallState(session.state)) {
      this.sessions.updateState(sessionId, "ended");
    }
  }

  // ------------------------------------------------------------ helper events

  async handleHelperEvent(payload: HelperEvent): Promise<Record<string, unknown>> {
    if (payload.event === "incoming") {
      const platformUserId = (payload.platformUserId || "").trim();
      if (!platformUserId) return { error: "MISSING_PLATFORM_USER_ID" };
      const existing = this.sessions.findActiveByPeer(platformUserId);
      if (existing && existing.direction === "incoming") {
        return { sessionId: existing.id };
      }
      const session = this.sessions.create({
        workspaceId: "",
        groupId: "",
        accountId: this.config.voipAccountId,
        platformUserId,
        mode: payload.mode === "video" ? "video" : "voice",
        direction: "incoming",
        operatorUserId: "",
        state: "incoming-ringing",
      });
      await this.notifySwitchboard(session, "incoming", "ringing");
      return { sessionId: session.id };
    }

    if (payload.event === "state") {
      const sessionId = (payload.sessionId || "").trim();
      const state = (payload.state || "").trim();
      if (!sessionId || !state) return { error: "MISSING_SESSION_OR_STATE" };
      const session = this.sessions.get(sessionId);
      if (!session) return { error: "CALL_SESSION_NOT_FOUND" };
      const wasTerminal = isTerminalCallState(session.state);
      this.sessions.updateState(sessionId, state as GatewaySessionState, payload.detail);
      if (!wasTerminal) {
        if (isTerminalCallState(state)) {
          await this.notifySwitchboard(session, "ended", "ended", state);
        } else {
          await this.notifySwitchboard(session, "updated", state, payload.detail);
        }
      }
      return { ok: true };
    }

    return { error: "UNKNOWN_EVENT" };
  }

  private async notifySwitchboard(
    session: GatewaySession,
    event: "incoming" | "updated" | "ended",
    state: string,
    detail?: string,
  ) {
    if (!this.config.switchboardBaseUrl || !this.config.secret) return;
    await fetch(`${this.config.switchboardBaseUrl}/api/internal/telegram-call-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.secret}`,
      },
      body: JSON.stringify({
        event: event === "ended" ? "updated" : event,
        workspaceId: session.workspaceId || undefined,
        groupId: session.groupId || undefined,
        accountId: session.accountId || this.config.voipAccountId || undefined,
        sessionId: session.id,
        mode: session.mode,
        state,
        detail: detail || session.stateDetail,
        platformUserId: session.platformUserId,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}
