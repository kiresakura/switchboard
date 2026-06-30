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
        ringingConfirmed: false,
        calleeHeardBrowser: false,
        browserHeardCallee: false,
        muteWorks: false,
        hangupWorks: false,
        auditRecorded: false,
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
  const gatewayUrl = (
    process.env.TELEGRAM_VOIP_GATEWAY_URL ||
    process.env.VOIP_GATEWAY_URL ||
    "http://127.0.0.1:3002"
  ).replace(/\/$/, "");
  const secret = (
    process.env.TELEGRAM_VOIP_GATEWAY_SECRET ||
    process.env.VOIP_GATEWAY_SECRET ||
    ""
  ).trim();

  record(
    "gateway-secret",
    secret ? "PASS" : "FAIL",
    secret ? "secret configured (redacted)" : "TELEGRAM_VOIP_GATEWAY_SECRET is missing",
  );

  let health: Record<string, unknown> = {};
  try {
    const { res, data } = await fetchJson(`${gatewayUrl}/health`, {
      cache: "no-store",
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
    });
    health = data;
    record(
      "gateway-health",
      res.ok ? "PASS" : "FAIL",
      `status=${res.status}; mediaBridgeReady=${String(data.mediaBridgeReady)}; fullDuplexAudioReady=${String(data.fullDuplexAudioReady)}`,
    );
  } catch (err) {
    record("gateway-health", "FAIL", err instanceof Error ? err.message : "gateway health failed");
  }

  record(
    "full-duplex-audio-ready",
    health.fullDuplexAudioReady === true ? "PASS" : "FAIL",
    `fullDuplexAudioReady=${String(health.fullDuplexAudioReady)}`,
  );

  if (checks.some((check) => check.status === "FAIL")) {
    output("BLOCKED", {
      reason:
        "C4 requires a native Telegram media bridge with browser <-> Telegram full duplex audio; current gateway reports fullDuplexAudioReady=false.",
    });
    return;
  }

  output("BLOCKED", {
    reason:
      "C4 full duplex voice is not implemented in this gateway build; do not claim full call PASS.",
  });
}

void main().catch((err) => {
  record("qa-runtime", "FAIL", err instanceof Error ? err.message : String(err));
  output("FAIL");
});
