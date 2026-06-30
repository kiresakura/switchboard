import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createGatewayServer, createGatewayRuntime } from "./server";
import { type GatewayConfig } from "./config";

type TestResult = {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
};

const results: TestResult[] = [];
const testSecret = "gateway-media-test-secret";

function assert(name: string, condition: boolean, detail?: string) {
  results.push({ name, status: condition ? "PASS" : "FAIL", detail });
}

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no tcp address");
  return address.port;
}

type CapturedRequest = { method: string; path: string; body: Record<string, unknown> };

function makeMockHelper(state: { telegramReady: boolean }) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const path = req.url || "/";
    requests.push({ method: req.method || "GET", path, body });

    res.setHeader("Content-Type", "application/json");
    if (path === "/health") {
      res.end(
        JSON.stringify({
          status: "ok",
          telegramSessionReady: state.telegramReady,
          mediaBridgeReady: state.telegramReady,
          fullDuplexAudioReady: state.telegramReady,
          videoReady: false,
          activeCalls: 0,
          reason: state.telegramReady ? null : "TELEGRAM_SESSION_NOT_READY",
        }),
      );
      return;
    }
    if (path === "/calls" && req.method === "POST") {
      res.end(
        JSON.stringify({
          ok: true,
          state: "dialing",
          offer: { type: "offer", sdp: "v=0 mock-offer" },
        }),
      );
      return;
    }
    if (/^\/calls\/[^/]+\/answer$/.test(path)) {
      res.end(
        JSON.stringify({ ok: true, state: "connected", offer: { type: "offer", sdp: "v=0 mock-answer-offer" } }),
      );
      return;
    }
    if (/^\/calls\/[^/]+\/signals$/.test(path)) {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "DELETE") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
  return { server, requests };
}

function makeMockSwitchboard() {
  const events: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    events.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true }));
  });
  return { server, events };
}

function baseConfig(overrides: Partial<GatewayConfig>): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    secret: testSecret,
    sessionTtlMs: 15 * 60_000,
    helperUrl: "http://127.0.0.1:1",
    helperSecret: testSecret,
    voipAccountId: "",
    enableRealCalls: false,
    approvedCalleePlatformUserId: "",
    approvedCalleeGroupId: "",
    allowAnyPrivatePeer: false,
    iceServers: [],
    switchboardBaseUrl: "",
    ...overrides,
  };
}

const validBody = {
  workspaceId: "workspace-test",
  groupId: "group-test",
  accountId: "account-test",
  platformUserId: "777000123",
  mode: "voice" as const,
  direction: "outgoing" as const,
  operatorUserId: "operator-test",
};

async function main() {
  const helperState = { telegramReady: true };
  const helper = makeMockHelper(helperState);
  const helperPort = await listen(helper.server);
  const switchboard = makeMockSwitchboard();
  const switchboardPort = await listen(switchboard.server);

  // --- Scenario A: helper unreachable, calls disabled -----------------------
  const downRuntime = createGatewayRuntime(baseConfig({}));
  const downServer = createGatewayServer(downRuntime);
  const downPort = await listen(downServer);
  const downBase = `http://127.0.0.1:${downPort}`;

  // --- Scenario B: helper reachable, real calls enabled, allowlist ----------
  const config = baseConfig({
    helperUrl: `http://127.0.0.1:${helperPort}`,
    enableRealCalls: true,
    approvedCalleePlatformUserId: validBody.platformUserId,
    switchboardBaseUrl: `http://127.0.0.1:${switchboardPort}`,
    iceServers: [{ urls: "stun:stun.example.com:3478" }],
  });
  const runtime = createGatewayRuntime(config);
  const server = createGatewayServer(runtime);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${testSecret}`,
  };

  try {
    // Health: helper down
    const downHealth = await readJson(await fetch(`${downBase}/health`));
    assert(
      "helper unreachable -> health degraded",
      downHealth.status === "ok" &&
        downHealth.telegramSessionReady === false &&
        downHealth.mediaBridgeReady === false &&
        downHealth.helperReachable === false &&
        downHealth.reason === "HELPER_UNREACHABLE",
    );

    // Health: helper up + enabled
    const health = await readJson(await fetch(`${base}/health`));
    assert(
      "helper ready -> embedded readiness true",
      health.realTelegramCalls === true &&
        health.telegramSessionReady === true &&
        health.mediaBridgeReady === true &&
        health.fullDuplexAudioReady === true &&
        health.videoReady === false &&
        health.reason === null,
    );

    // Auth guards
    const noAuth = await fetch(`${base}/telegram/calls/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    assert("missing auth -> 401", noAuth.status === 401);
    const wrongAuth = await fetch(`${base}/telegram/calls/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: JSON.stringify(validBody),
    });
    assert("wrong auth -> 401", wrongAuth.status === 401);

    // Disabled gateway rejects with explicit error
    const disabledRes = await fetch(`${downBase}/telegram/calls/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(validBody),
    });
    const disabled = await readJson(disabledRes);
    assert(
      "real call disabled -> 403 REAL_CALL_DISABLED",
      disabledRes.status === 403 && disabled.error === "REAL_CALL_DISABLED",
    );

    // Unapproved target
    const unapprovedRes = await fetch(`${base}/telegram/calls/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...validBody, platformUserId: "999" }),
    });
    const unapproved = await readJson(unapprovedRes);
    assert(
      "unapproved target -> 403 REAL_CALL_TARGET_NOT_APPROVED",
      unapprovedRes.status === 403 && unapproved.error === "REAL_CALL_TARGET_NOT_APPROVED",
    );

    // Video unsupported
    const videoRes = await fetch(`${base}/telegram/calls/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...validBody, mode: "video" }),
    });
    const video = await readJson(videoRes);
    assert(
      "video mode -> 400 REAL_CALL_MODE_NOT_SUPPORTED",
      videoRes.status === 400 && video.error === "REAL_CALL_MODE_NOT_SUPPORTED",
    );

    // Successful outgoing call: offer + ice servers + helper got the request
    const createRes = await fetch(`${base}/telegram/calls/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(validBody),
    });
    const created = await readJson(createRes);
    const offer = created.offer as { sdp?: string } | null;
    assert(
      "outgoing call -> 200 with offer + session",
      createRes.status === 200 &&
        created.success === true &&
        typeof created.sessionId === "string" &&
        Boolean(offer && offer.sdp === "v=0 mock-offer") &&
        Array.isArray(created.iceServers) &&
        created.state === "dialing",
    );
    const helperCreate = helper.requests.find((r) => r.path === "/calls");
    assert(
      "helper received sessionId + peer + ice servers",
      Boolean(
        helperCreate &&
          helperCreate.body.sessionId === created.sessionId &&
          helperCreate.body.platformUserId === validBody.platformUserId &&
          Array.isArray(helperCreate.body.iceServers),
      ),
    );
    const sessionId = String(created.sessionId);

    // Concurrent same-peer call blocked
    const dupRes = await fetch(`${base}/telegram/calls/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(validBody),
    });
    const dup = await readJson(dupRes);
    assert(
      "second call to same peer -> 409",
      dupRes.status === 409 && dup.error === "CALL_ALREADY_ACTIVE_FOR_PEER",
    );

    // Signal forwarding
    const signalRes = await fetch(`${base}/telegram/calls/sessions/${sessionId}/signals`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ signal: { type: "answer", answer: { type: "answer", sdp: "v=0" } } }),
    });
    const signal = await readJson(signalRes);
    const helperSignal = helper.requests.find((r) => r.path.endsWith("/signals"));
    assert(
      "signal forwarded to helper",
      signalRes.status === 200 &&
        signal.success === true &&
        Boolean(helperSignal && (helperSignal.body.signal as { type?: string })?.type === "answer"),
    );
    const missingSignalRes = await fetch(`${base}/telegram/calls/sessions/missing/signals`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ signal: { type: "candidate" } }),
    });
    assert("signal for missing session -> 404", missingSignalRes.status === 404);

    // Helper state events propagate to Switchboard
    const stateRes = await fetch(`${base}/internal/helper-events`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ event: "state", sessionId, state: "ringing" }),
    });
    assert("helper state event accepted", stateRes.status === 200);
    const ringingEvent = switchboard.events.find((e) => e.state === "ringing");
    assert(
      "ringing state forwarded to Switchboard",
      Boolean(ringingEvent && ringingEvent.event === "updated" && ringingEvent.sessionId === sessionId),
    );

    await fetch(`${base}/internal/helper-events`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ event: "state", sessionId, state: "declined" }),
    });
    const endedEvent = switchboard.events.find((e) => e.state === "ended" && e.detail === "declined");
    assert("terminal state maps to ended for Switchboard", Boolean(endedEvent));

    // Incoming call event creates a session and notifies Switchboard
    const incomingRes = await fetch(`${base}/internal/helper-events`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ event: "incoming", platformUserId: "555000111", mode: "voice" }),
    });
    const incoming = await readJson(incomingRes);
    assert(
      "incoming event -> session id assigned",
      incomingRes.status === 200 && typeof incoming.sessionId === "string",
    );
    const incomingEvent = switchboard.events.find((e) => e.event === "incoming");
    assert(
      "incoming forwarded to Switchboard without group context",
      Boolean(incomingEvent && incomingEvent.platformUserId === "555000111"),
    );
    const incomingSessionId = String(incoming.sessionId);

    // Answer with peer mismatch -> 409, then success with matching peer
    const mismatchRes = await fetch(
      `${base}/telegram/calls/sessions/${incomingSessionId}/answer`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ...validBody, direction: "incoming" }),
      },
    );
    const mismatch = await readJson(mismatchRes);
    assert(
      "answer peer mismatch -> 409",
      mismatchRes.status === 409 && mismatch.error === "CALL_SESSION_PEER_MISMATCH",
    );
    const answerRes = await fetch(
      `${base}/telegram/calls/sessions/${incomingSessionId}/answer`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          ...validBody,
          direction: "incoming",
          platformUserId: "555000111",
        }),
      },
    );
    const answered = await readJson(answerRes);
    assert(
      "answer incoming -> 200 with offer",
      answerRes.status === 200 &&
        answered.success === true &&
        Boolean((answered.offer as { sdp?: string })?.sdp),
    );

    // Delete tears down at the helper too
    const deleteRes = await fetch(`${base}/telegram/calls/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    const helperDelete = helper.requests.find(
      (r) => r.method === "DELETE" && r.path === `/calls/${sessionId}`,
    );
    assert("delete -> 200 and forwarded to helper", deleteRes.status === 200 && Boolean(helperDelete));

    // Account mismatch guard
    const accountConfig = baseConfig({
      helperUrl: `http://127.0.0.1:${helperPort}`,
      enableRealCalls: true,
      allowAnyPrivatePeer: true,
      voipAccountId: "the-real-account",
    });
    const accountRuntime = createGatewayRuntime(accountConfig);
    const accountServer = createGatewayServer(accountRuntime);
    const accountPort = await listen(accountServer);
    const mismatchAccountRes = await fetch(
      `http://127.0.0.1:${accountPort}/telegram/calls/sessions`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validBody),
      },
    );
    const mismatchAccount = await readJson(mismatchAccountRes);
    assert(
      "configured account mismatch -> 403 VOIP_ACCOUNT_MISMATCH",
      mismatchAccountRes.status === 403 && mismatchAccount.error === "VOIP_ACCOUNT_MISMATCH",
    );
    accountServer.close();
    await once(accountServer, "close").catch(() => null);
  } finally {
    server.close();
    downServer.close();
    helper.server.close();
    switchboard.server.close();
    await Promise.allSettled([
      once(server, "close"),
      once(downServer, "close"),
      once(helper.server, "close"),
      once(switchboard.server, "close"),
    ]);
  }

  const failed = results.filter((result) => result.status === "FAIL");
  console.log(JSON.stringify({ verdict: failed.length ? "FAIL" : "PASS", results }, null, 2));
  if (failed.length) process.exit(1);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
