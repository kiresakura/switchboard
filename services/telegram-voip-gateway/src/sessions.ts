import { randomUUID } from "node:crypto";

export const TERMINAL_CALL_STATES = [
  "ended",
  "declined",
  "busy",
  "timeout",
  "missed",
  "failed",
  "discarded",
] as const;

export type GatewaySessionState =
  | "dialing"
  | "ringing"
  | "incoming-ringing"
  | "accepted"
  | "connected"
  | (typeof TERMINAL_CALL_STATES)[number];

export function isTerminalCallState(state: string): boolean {
  return (TERMINAL_CALL_STATES as readonly string[]).includes(state);
}

export type GatewaySession = {
  id: string;
  /** Empty for incoming calls until Switchboard resolves the private chat. */
  workspaceId: string;
  groupId: string;
  accountId: string;
  platformUserId: string;
  mode: "voice" | "video";
  direction: "outgoing" | "incoming";
  operatorUserId: string;
  state: GatewaySessionState;
  stateDetail?: string;
  createdAt: string;
  expiresAt: string;
  signalCount: number;
};

export type CreateGatewaySessionInput = Pick<
  GatewaySession,
  | "workspaceId"
  | "groupId"
  | "accountId"
  | "platformUserId"
  | "mode"
  | "direction"
  | "operatorUserId"
> & { state?: GatewaySessionState };

export class SessionStore {
  private readonly sessions = new Map<string, GatewaySession>();

  constructor(private readonly ttlMs: number) {}

  create(input: CreateGatewaySessionInput): GatewaySession {
    this.pruneExpired();
    const now = new Date();
    const { state, ...rest } = input;
    const session: GatewaySession = {
      ...rest,
      id: randomUUID(),
      state: state || "dialing",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      signalCount: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): GatewaySession | null {
    this.pruneExpired();
    return this.sessions.get(id) || null;
  }

  delete(id: string) {
    return this.sessions.delete(id);
  }

  recordSignal(id: string) {
    const session = this.get(id);
    if (!session) return null;
    session.signalCount += 1;
    return session;
  }

  updateState(id: string, state: GatewaySessionState, detail?: string) {
    const session = this.get(id);
    if (!session) return null;
    session.state = state;
    if (detail !== undefined) session.stateDetail = detail;
    return session;
  }

  findActiveByPeer(platformUserId: string) {
    this.pruneExpired();
    for (const session of this.sessions.values()) {
      if (session.platformUserId === platformUserId && !isTerminalCallState(session.state)) {
        return session;
      }
    }
    return null;
  }

  count() {
    this.pruneExpired();
    return this.sessions.size;
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) {
        this.sessions.delete(id);
      }
    }
  }
}
