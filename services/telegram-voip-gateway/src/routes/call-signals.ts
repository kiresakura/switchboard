import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../auth";
import type { CallController } from "../controller";
import { asRecord, readJson } from "../http";
import type { SessionStore } from "../sessions";

export async function handleCallSignal(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionStore,
  controller: CallController,
  sessionId: string,
) {
  const body = asRecord(await readJson(req).catch(() => ({})));
  const session = sessions.get(sessionId);
  if (!session) {
    sendJson(res, 404, { error: "CALL_SESSION_NOT_FOUND" });
    return;
  }

  const signal = asRecord(body.signal);
  if (Object.keys(signal).length === 0) {
    sendJson(res, 400, { error: "MISSING_SIGNAL" });
    return;
  }

  const result = await controller.signal(sessionId, signal);
  if (!result.ok) {
    sendJson(res, result.status, { error: result.error, reason: result.reason });
    return;
  }
  sendJson(res, 200, {
    success: true,
    recordedSignals: sessions.get(sessionId)?.signalCount ?? 0,
  });
}
