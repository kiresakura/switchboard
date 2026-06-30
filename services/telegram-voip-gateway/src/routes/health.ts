import type { ServerResponse } from "node:http";
import { sendJson } from "../auth";
import type { CallController } from "../controller";
import type { SessionStore } from "../sessions";

export async function handleHealth(
  res: ServerResponse,
  controller: CallController,
  sessions: SessionStore,
) {
  const readiness = await controller.getReadiness();
  sendJson(res, 200, {
    status: "ok",
    mode: "real-gateway-media",
    ...readiness,
    activeSessions: sessions.count(),
  });
}
