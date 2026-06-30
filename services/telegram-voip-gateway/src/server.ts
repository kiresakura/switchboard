import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorized, sendJson, sendUnauthorized } from "./auth";
import { loadConfig, type GatewayConfig } from "./config";
import { CallController } from "./controller";
import { asRecord, readJson } from "./http";
import {
  handleCreateCallSession,
  handleAnswerCallSession,
  handleDeleteCallSession,
  handleGetCallSession,
} from "./routes/call-sessions";
import { handleCallSignal } from "./routes/call-signals";
import { handleHealth } from "./routes/health";
import { SessionStore } from "./sessions";

export type GatewayRuntime = {
  config: GatewayConfig;
  sessions: SessionStore;
  controller: CallController;
};

export function createGatewayRuntime(config: GatewayConfig = loadConfig()): GatewayRuntime {
  const sessions = new SessionStore(config.sessionTtlMs);
  return {
    config,
    sessions,
    controller: new CallController(config, sessions),
  };
}

function parseUrl(req: IncomingMessage, config: GatewayConfig) {
  return new URL(req.url || "/", `http://${req.headers.host || `${config.host}:${config.port}`}`);
}

async function handleHelperEvent(
  req: IncomingMessage,
  res: ServerResponse,
  controller: CallController,
) {
  const body = asRecord(await readJson(req).catch(() => ({})));
  const event = body.event;
  if (event !== "incoming" && event !== "state") {
    sendJson(res, 400, { error: "UNKNOWN_EVENT" });
    return;
  }
  const result = await controller.handleHelperEvent({
    event,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    platformUserId: typeof body.platformUserId === "string" ? body.platformUserId : undefined,
    mode: typeof body.mode === "string" ? body.mode : undefined,
    state: typeof body.state === "string" ? body.state : undefined,
    detail: typeof body.detail === "string" ? body.detail : undefined,
  });
  sendJson(res, "error" in result ? 400 : 200, result);
}

export function createGatewayServer(
  runtime: GatewayRuntime = createGatewayRuntime(),
) {
  const { config, sessions, controller } = runtime;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method || "GET";
    const url = parseUrl(req, config);

    try {
      if (method === "GET" && url.pathname === "/health") {
        await handleHealth(res, controller, sessions);
        return;
      }

      if (!isAuthorized(req, config.secret)) {
        sendUnauthorized(res);
        return;
      }

      if (method === "POST" && url.pathname === "/internal/helper-events") {
        await handleHelperEvent(req, res, controller);
        return;
      }

      if (method === "POST" && url.pathname === "/telegram/calls/sessions") {
        await handleCreateCallSession(req, res, controller, config);
        return;
      }

      const answerMatch = /^\/telegram\/calls\/sessions\/([^/]+)\/answer$/.exec(url.pathname);
      if (method === "POST" && answerMatch) {
        await handleAnswerCallSession(
          req,
          res,
          controller,
          config,
          decodeURIComponent(answerMatch[1]),
        );
        return;
      }

      const signalsMatch = /^\/telegram\/calls\/sessions\/([^/]+)\/signals$/.exec(url.pathname);
      if (method === "POST" && signalsMatch) {
        await handleCallSignal(req, res, sessions, controller, decodeURIComponent(signalsMatch[1]));
        return;
      }

      const sessionMatch = /^\/telegram\/calls\/sessions\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && sessionMatch) {
        handleGetCallSession(res, sessions, decodeURIComponent(sessionMatch[1]));
        return;
      }

      if (method === "DELETE" && sessionMatch) {
        await handleDeleteCallSession(
          req,
          res,
          controller,
          sessions,
          decodeURIComponent(sessionMatch[1]),
        );
        return;
      }

      sendJson(res, 404, { error: "NOT_FOUND" });
    } catch {
      sendJson(res, 500, { error: "INTERNAL_SERVER_ERROR" });
    }
  });
}

if (require.main === module) {
  const config = loadConfig();
  const server = createGatewayServer(createGatewayRuntime(config));

  server.listen(config.port, config.host, () => {
    console.log(`Telegram VoIP gateway listening on http://${config.host}:${config.port}`);
    console.log(
      `Media helper expected at ${config.helperUrl} (real calls ${config.enableRealCalls ? "ENABLED" : "disabled"}).`,
    );
  });
}
