export {};

type Verdict = "PASS" | "PARTIAL" | "BLOCKED" | "FAIL";
type CheckStatus = "PASS" | "FAIL" | "SKIP";

type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
};

const checks: Check[] = [];

function record(name: string, status: CheckStatus, detail: string) {
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
        gatewayDetectedIncoming: false,
        switchboardCallbackAccepted: false,
        uiDisplayedIncoming: false,
        checks,
        ...extra,
      },
      null,
      2,
    ),
  );
  if (verdict !== "PASS" && verdict !== "PARTIAL") process.exitCode = 1;
}

async function main() {
  const baseUrl = gatewayBaseUrl();
  const secret = gatewaySecret();
  const incomingEnabled = process.env.QA_ENABLE_REAL_TELEGRAM_INCOMING_CALL === "1";
  const approvedCaller = (process.env.QA_APPROVED_CALLER_PLATFORM_USER_ID || "").trim();
  const switchboardBaseUrl = (process.env.SWITCHBOARD_BASE_URL || process.env.QA_BASE_URL || "").trim();

  record(
    "gateway-secret",
    secret ? "PASS" : "FAIL",
    secret ? "secret configured (redacted)" : "TELEGRAM_VOIP_GATEWAY_SECRET is missing",
  );
  record(
    "incoming-qa-enabled",
    incomingEnabled ? "PASS" : "FAIL",
    incomingEnabled
      ? "QA_ENABLE_REAL_TELEGRAM_INCOMING_CALL=1"
      : "QA_ENABLE_REAL_TELEGRAM_INCOMING_CALL=1 is required",
  );
  record(
    "approved-caller",
    approvedCaller ? "PASS" : "FAIL",
    approvedCaller
      ? "approved caller configured (redacted)"
      : "QA_APPROVED_CALLER_PLATFORM_USER_ID is required",
  );
  record(
    "switchboard-base-url",
    switchboardBaseUrl ? "PASS" : "FAIL",
    switchboardBaseUrl ? "SWITCHBOARD_BASE_URL configured" : "SWITCHBOARD_BASE_URL is required for callback verification",
  );

  let health: Record<string, unknown> = {};
  try {
    const { res, data } = await fetchJson(`${baseUrl}/health`, {
      cache: "no-store",
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
    });
    health = data;
    record(
      "gateway-health",
      res.ok ? "PASS" : "FAIL",
      `status=${res.status}; mode=${String(data.mode || "")}; telegramSessionReady=${String(data.telegramSessionReady)}; incomingDetectionReady=${String(data.incomingDetectionReady)}`,
    );
  } catch (err) {
    record("gateway-health", "FAIL", err instanceof Error ? err.message : "gateway health failed");
  }

  if (health.telegramSessionReady !== true) {
    record("telegram-session-ready", "FAIL", `telegramSessionReady=${String(health.telegramSessionReady)}`);
  }
  if (health.incomingDetectionReady !== true) {
    record("incoming-detection-ready", "FAIL", `incomingDetectionReady=${String(health.incomingDetectionReady)}`);
  }

  if (checks.some((check) => check.status === "FAIL")) {
    output("BLOCKED");
    return;
  }

  output("BLOCKED", {
    reason:
      "Gateway incoming UpdatePhoneCall handling requires a real approved caller event; this script does not ask anyone to place a call automatically.",
  });
}

void main().catch((err) => {
  record("qa-runtime", "FAIL", err instanceof Error ? err.message : String(err));
  output("FAIL");
});
