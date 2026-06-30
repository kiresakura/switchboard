import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../auth";
import type { GatewayConfig } from "../config";
import type { CallController } from "../controller";
import { asRecord, readJson } from "../http";
import type { SessionStore } from "../sessions";

type CallMode = "voice" | "video";
type CallDirection = "outgoing" | "incoming";

function isCallMode(value: unknown): value is CallMode {
  return value === "voice" || value === "video";
}

function isDirection(value: unknown): value is CallDirection {
  return value === "outgoing" || value === "incoming";
}

function readRequiredString(body: Record<string, unknown>, field: string) {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function readCallBody(req: IncomingMessage) {
  const body = asRecord(await readJson(req));
  const mode = body.mode;
  const direction = body.direction;
  const input = {
    workspaceId: readRequiredString(body, "workspaceId"),
    groupId: readRequiredString(body, "groupId"),
    accountId: readRequiredString(body, "accountId"),
    platformUserId: readRequiredString(body, "platformUserId"),
    mode,
    direction,
    operatorUserId: readRequiredString(body, "operatorUserId"),
  };

  if (
    !input.workspaceId ||
    !input.groupId ||
    !input.accountId ||
    !input.platformUserId ||
    !input.operatorUserId ||
    !isCallMode(mode) ||
    !isDirection(direction)
  ) {
    return null;
  }

  return {
    ...input,
    mode,
    direction,
  };
}

export async function handleCreateCallSession(
  req: IncomingMessage,
  res: ServerResponse,
  controller: CallController,
  config: GatewayConfig,
) {
  const input = await readCallBody(req).catch(() => null);
  if (!input || input.direction !== "outgoing") {
    sendJson(res, 400, { error: "INVALID_CALL_SESSION_REQUEST" });
    return;
  }

  const result = await controller.requestOutgoingCall(input);
  const readiness = await controller.getReadiness();
  const { reason: readinessReason, ...readinessFlags } = readiness;

  if (!result.ok) {
    sendJson(res, result.status, {
      error: result.error,
      message: result.message,
      reason: result.reason || readinessReason,
      sessionId: result.session?.id,
      ...readinessFlags,
    });
    return;
  }

  sendJson(res, 200, {
    success: true,
    sessionId: result.session.id,
    state: result.session.state,
    offer: result.offer,
    iceServers: config.iceServers,
    signalingUrl: null,
    browserSignalingUrl: null,
    expiresAt: result.session.expiresAt,
    message: "真實 Telegram 通話已建立,等待對方接聽。",
    ...readinessFlags,
  });
}

export async function handleAnswerCallSession(
  req: IncomingMessage,
  res: ServerResponse,
  controller: CallController,
  config: GatewayConfig,
  sessionId: string,
) {
  const input = await readCallBody(req).catch(() => null);
  if (!input || input.direction !== "incoming") {
    sendJson(res, 400, { error: "INVALID_CALL_ANSWER_REQUEST" });
    return;
  }

  const result = await controller.answerIncomingCall(sessionId, input);
  const readiness = await controller.getReadiness();
  const { reason: readinessReason, ...readinessFlags } = readiness;

  if (!result.ok) {
    sendJson(res, result.status, {
      error: result.error,
      message: result.message,
      reason: result.reason || readinessReason,
      sessionId: result.session?.id,
      ...readinessFlags,
    });
    return;
  }

  sendJson(res, 200, {
    success: true,
    sessionId: result.session.id,
    state: result.session.state,
    offer: result.offer,
    iceServers: config.iceServers,
    signalingUrl: null,
    browserSignalingUrl: null,
    expiresAt: result.session.expiresAt,
    message: "已接聽 Telegram 來電。",
    ...readinessFlags,
  });
}

export async function handleDeleteCallSession(
  req: IncomingMessage,
  res: ServerResponse,
  controller: CallController,
  sessions: SessionStore,
  sessionId: string,
) {
  await readJson(req).catch(() => ({}));
  await controller.endCall(sessionId);
  sessions.delete(sessionId);
  sendJson(res, 200, { success: true });
}

export function handleGetCallSession(
  res: ServerResponse,
  sessions: SessionStore,
  sessionId: string,
) {
  const session = sessions.get(sessionId);
  if (!session) {
    sendJson(res, 404, { error: "CALL_SESSION_NOT_FOUND" });
    return;
  }
  sendJson(res, 200, {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    groupId: session.groupId,
    accountId: session.accountId,
    platformUserId: session.platformUserId,
    mode: session.mode,
    direction: session.direction,
    state: session.state,
    stateDetail: session.stateDetail,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    signalCount: session.signalCount,
  });
}
