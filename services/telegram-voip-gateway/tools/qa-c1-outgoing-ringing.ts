export {};

type Verdict = "PASS" | "PARTIAL" | "BLOCKED" | "FAIL";

type Check = {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
};

const checks: Check[] = [];
const notes: string[] = [];

function record(name: string, status: Check["status"], detail: string) {
  checks.push({ name, status, detail });
}

function gatewayBaseUrl() {
  return (
    process.env.TELEGRAM_VOIP_GATEWAY_URL ||
    process.env.VOIP_GATEWAY_URL ||
    "http://127.0.0.1:3002"
  ).replace(/\/$/, "");
}

function gatewaySecret() {
  return (
    process.env.TELEGRAM_VOIP_GATEWAY_SECRET ||
    process.env.VOIP_GATEWAY_SECRET ||
    ""
  ).trim();
}

function approvedTarget() {
  return (
    process.env.QA_APPROVED_CALLEE_PLATFORM_USER_ID ||
    process.env.QA_APPROVED_CALLEE_GROUP_ID ||
    ""
  ).trim();
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, data };
}

function output(verdict: Verdict, extra: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify(
      {
        verdict,
        ringingObservedByGateway: false,
        ringingConfirmedByCallee: false,
        sessionId: null,
        notes,
        checks,
        ...extra,
      },
      null,
      2,
    ),
  );
  if (verdict !== "PASS" && verdict !== "PARTIAL") process.exitCode = 1;
}

async function pollSession(baseUrl: string, secret: string, sessionId: string) {
  const deadline = Date.now() + 15_000;
  let lastState = "";
  while (Date.now() < deadline) {
    const { res, data } = await fetchJson(`${baseUrl}/telegram/calls/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    if (res.ok && typeof data.state === "string") {
      lastState = data.state;
      if (["ringing", "accepted", "discarded", "missed", "ended", "failed"].includes(lastState)) {
        return lastState;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return lastState || "unknown";
}

async function main() {
  const baseUrl = gatewayBaseUrl();
  const secret = gatewaySecret();
  const enableRealCall = process.env.QA_ENABLE_REAL_TELEGRAM_CALL === "1";
  const target = approvedTarget();
  const confirmedByCallee = process.env.QA_CALLEE_CONFIRMED_RINGING === "1";

  if (!secret) {
    record("gateway-secret", "FAIL", "TELEGRAM_VOIP_GATEWAY_SECRET is missing");
  } else {
    record("gateway-secret", "PASS", "secret configured (redacted)");
  }

  let health: Record<string, unknown> = {};
  try {
    const { res, data } = await fetchJson(`${baseUrl}/health`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
      cache: "no-store",
    });
    health = data;
    record(
      "gateway-health",
      res.ok ? "PASS" : "FAIL",
      `status=${res.status}; mode=${String(data.mode || "")}; realTelegramCalls=${String(data.realTelegramCalls)}; telegramSessionReady=${String(data.telegramSessionReady)}; outgoingRingingSpikeReady=${String(data.outgoingRingingSpikeReady)}`,
    );
  } catch (err) {
    record("gateway-health", "FAIL", err instanceof Error ? err.message : "gateway health failed");
  }

  if (!enableRealCall) {
    record("qa-enable-real-call", "FAIL", "QA_ENABLE_REAL_TELEGRAM_CALL=1 is required; no call attempted");
  } else {
    record("qa-enable-real-call", "PASS", "real-call QA flag enabled");
  }

  if (!target) {
    record(
      "approved-callee-target",
      "FAIL",
      "QA_APPROVED_CALLEE_PLATFORM_USER_ID or QA_APPROVED_CALLEE_GROUP_ID is required; no call attempted",
    );
  } else {
    record("approved-callee-target", "PASS", "approved callee target configured (redacted)");
  }

  if (!enableRealCall || !target || !secret) {
    output("BLOCKED");
    return;
  }

  if (health.telegramSessionReady !== true) {
    record("telegram-session-ready", "FAIL", `telegramSessionReady=${String(health.telegramSessionReady)}`);
    output("BLOCKED");
    return;
  }

  if (health.realTelegramCalls !== true || health.outgoingRingingSpikeReady !== true) {
    record(
      "outgoing-ringing-readiness",
      "FAIL",
      `realTelegramCalls=${String(health.realTelegramCalls)}; outgoingRingingSpikeReady=${String(health.outgoingRingingSpikeReady)}`,
    );
    output("BLOCKED");
    return;
  }

  const groupId = process.env.QA_APPROVED_CALLEE_GROUP_ID || process.env.QA_GROUP_ID || "qa-c1-group";
  const body = {
    workspaceId: process.env.QA_WORKSPACE_ID || "qa-c1-workspace",
    groupId,
    accountId: process.env.QA_ACCOUNT_ID || "qa-c1-account",
    platformUserId: process.env.QA_APPROVED_CALLEE_PLATFORM_USER_ID || target,
    mode: "voice",
    direction: "outgoing",
    operatorUserId: process.env.QA_OPERATOR_USER_ID || "qa-c1-operator",
  };

  const { res, data } = await fetchJson(`${baseUrl}/telegram/calls/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || typeof data.sessionId !== "string") {
    record(
      "start-outgoing-call",
      "FAIL",
      `status=${res.status}; error=${String(data.error || "")}; reason=${String(data.reason || "")}`,
    );
    output(res.status === 403 || res.status === 503 ? "BLOCKED" : "FAIL", {
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
    });
    return;
  }

  const sessionId = data.sessionId;
  record("start-outgoing-call", "PASS", "Telegram outgoing call request submitted");
  notes.push("No media bridge is implemented in C1; this QA only verifies ringing.");

  const state = await pollSession(baseUrl, secret, sessionId);
  const ringingObservedByGateway = ["ringing", "accepted"].includes(state);
  record(
    "gateway-ringing-update",
    ringingObservedByGateway ? "PASS" : "FAIL",
    `lastState=${state}`,
  );

  if (!confirmedByCallee) {
    notes.push("Set QA_CALLEE_CONFIRMED_RINGING=1 only after the approved callee confirms Telegram app ringing.");
  }

  const verdict: Verdict = confirmedByCallee && ringingObservedByGateway
    ? "PASS"
    : ringingObservedByGateway || res.ok
      ? "PARTIAL"
      : "FAIL";

  output(verdict, {
    ringingObservedByGateway,
    ringingConfirmedByCallee: confirmedByCallee,
    sessionId,
  });
}

void main().catch((err) => {
  notes.push(err instanceof Error ? err.message : String(err));
  output("FAIL");
});
