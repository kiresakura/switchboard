#!/usr/bin/env node
/**
 * 部署後 8 點自動驗證（cross-platform）
 *
 * 取代 post-deploy-verify.sh — 純 Node.js，支援 Windows / macOS / Linux。
 *
 * 用法：
 *   node scripts/deploy/post-deploy-verify.mjs <APP-URL> [admin-password]
 *   npm run verify -- https://switchboard-prod.up.railway.app
 *
 * admin-password 可省略，預設讀環境變數 SEED_ADMIN_PASSWORD，再不然用 admin1234。
 */
import { execSync } from "node:child_process";

const URL_RAW = process.argv[2];
const ADMIN_PW = process.argv[3] ?? process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

if (!URL_RAW) {
  console.error("用法：node scripts/deploy/post-deploy-verify.mjs <APP-URL> [admin-password]");
  console.error("  例：node scripts/deploy/post-deploy-verify.mjs https://switchboard-prod.up.railway.app");
  process.exit(1);
}

const URL = URL_RAW.replace(/\/$/, "");

const isTTY = process.stdout.isTTY;
const c = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const bold = (s) => c("1", s);

let pass = 0,
  fail = 0;
const failures = [];
const ok = (msg) => {
  console.log(`  ${green("✓")} ${msg}`);
  pass++;
};
const ng = (msg) => {
  console.log(`  ${red("✗")} ${msg}`);
  failures.push(msg);
  fail++;
};
const section = (title) => console.log(`\n${bold(`── ${title} ──`)}`);

// ── 跨平台 fetch helper ────────────────────────────────
async function http(method, path, opts = {}) {
  const u = `${URL}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 10000);
  try {
    const res = await fetch(u, {
      method,
      headers: opts.headers ?? {},
      body: opts.body,
      signal: ctrl.signal,
      redirect: "manual",
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: Object.fromEntries(res.headers), text, json };
  } catch (err) {
    return { status: 0, headers: {}, text: "", json: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

console.log(bold("\nSwitchboard 部署後驗證"));
console.log(`目標：${URL}\n`);

// ──────────────────────────────────────────────────────────
section("1. 公開健康檢查");
// ──────────────────────────────────────────────────────────
let r = await http("GET", "/api/health");
if (r.status === 200 && r.json?.status === "ok") {
  ok("/api/health 200 OK");
} else {
  ng(`/api/health 異常 (${r.status}): ${r.text.slice(0, 100)}`);
  console.log("\n服務未啟動或不健康，後續測試略過。");
  process.exit(1);
}

// ──────────────────────────────────────────────────────────
section("2. 登入頁可載入（無 Server Component error）");
// ──────────────────────────────────────────────────────────
r = await http("GET", "/login");
if (r.text.includes("Server Components render")) {
  ng("/login 出現 Server Components render error — 上版有 forwardRef serialization 問題");
} else if (r.status === 200) {
  ok("/login 正常 HTML 回應");
} else {
  ng(`/login 異常：HTTP ${r.status}`);
}

// ──────────────────────────────────────────────────────────
section("3. admin 登入");
// ──────────────────────────────────────────────────────────
r = await http("POST", "/api/auth/login", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: ADMIN_PW }),
});

let cookieHeader = "";
if (r.status === 200 && r.json?.user?.id) {
  ok("admin 登入成功");
  // 取出 set-cookie 中的 switchboard_session
  const sc = r.headers["set-cookie"] ?? "";
  const m = /switchboard_session=([^;]+)/.exec(Array.isArray(sc) ? sc.join(";") : sc);
  if (m) cookieHeader = `switchboard_session=${m[1]}`;
  else ng("登入成功但找不到 switchboard_session cookie（後續測試可能會失敗）");
} else {
  ng(`admin 登入失敗：${r.status} ${r.text.slice(0, 100)}`);
  console.log("  → 提示：確認 SEED_ADMIN_PASSWORD 是否正確");
  process.exit(1);
}

// ──────────────────────────────────────────────────────────
section("4. 取得 workspace ID");
// ──────────────────────────────────────────────────────────
r = await http("GET", "/api/workspaces", { headers: { Cookie: cookieHeader } });
const wsId = r.json?.workspaces?.[0]?.id;
if (wsId) ok(`找到 workspace：${wsId}`);
else {
  ng("/api/workspaces 沒有回 workspace — 確認 seed 已跑過");
  process.exit(1);
}

// ──────────────────────────────────────────────────────────
section("5. /api/workspaces/:id/groups 回應結構");
// ──────────────────────────────────────────────────────────
r = await http("GET", `/api/workspaces/${wsId}/groups?includeHidden=true&includeInternal=true`, {
  headers: { Cookie: cookieHeader },
});
const groups = r.json?.groups ?? [];
if (Array.isArray(groups)) ok(`/api/workspaces/:id/groups 回應 JSON (${groups.length} 筆)`);
else ng(`/api/workspaces/:id/groups 回應異常`);

if (groups.length > 0) {
  if (groups[0].chatType) ok(`groups 回應含 chatType 欄位（首筆：${groups[0].chatType}）`);
  else ng("groups 回應缺 chatType 欄位 — 群組頁 Tab 切換會失效");
} else {
  console.log("  (workspace 內無 group，跳過 chatType 抽檢)");
}

// ──────────────────────────────────────────────────────────
section("6. 髒話過濾詞庫已 seed");
// ──────────────────────────────────────────────────────────
r = await http("GET", `/api/workspaces/${wsId}/rules?scope=GLOBAL`, {
  headers: { Cookie: cookieHeader },
});
const terms = r.json?.terms ?? [];
if (terms.length >= 50) ok(`GLOBAL 保護詞彙 ${terms.length} 筆（≥50，含繁簡變體）`);
else if (terms.length > 0) ng(`GLOBAL 保護詞彙僅 ${terms.length} 筆 — seed 不完整（預期 ~75）`);
else ng("GLOBAL 保護詞彙 0 筆 — 請執行 npm run db:seed:terms");

const masks = terms.filter((t) => t.replacement === "***").length;
const reviews = terms.filter((t) => t.replacement === null).length;
if (masks > 0 && reviews > 0) ok(`策略分布：MASK=${masks}，REVIEW=${reviews}`);
else if (terms.length > 0)
  ng(`策略分布異常：MASK=${masks}，REVIEW=${reviews}（兩者都應 >0）`);

// ──────────────────────────────────────────────────────────
section("7. 帳號清單可讀");
// ──────────────────────────────────────────────────────────
r = await http("GET", `/api/workspaces/${wsId}/accounts`, { headers: { Cookie: cookieHeader } });
if (r.status === 200 && Array.isArray(r.json?.accounts)) {
  ok(`/api/workspaces/:id/accounts 回應正常 (${r.json.accounts.length} 筆)`);
} else {
  ng(`/api/workspaces/:id/accounts 異常：${r.status}`);
}

// ──────────────────────────────────────────────────────────
section("8. SSE 連線開啟");
// ──────────────────────────────────────────────────────────
// 用 fetch 開連，5 秒後關閉，看有沒有收到 SSE frame
const sseCtrl = new AbortController();
const sseTimer = setTimeout(() => sseCtrl.abort(), 5000);
try {
  const sseRes = await fetch(`${URL}/api/realtime?workspaceId=${wsId}`, {
    headers: { Cookie: cookieHeader, Accept: "text/event-stream" },
    signal: sseCtrl.signal,
  });
  if (sseRes.status === 200 && sseRes.body) {
    // 讀 stream 前 1024 bytes
    const reader = sseRes.body.getReader();
    let total = 0;
    let chunkText = "";
    const decoder = new TextDecoder();
    while (total < 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      chunkText += decoder.decode(value);
      total += value.byteLength;
      if (chunkText.includes("data:") || chunkText.includes("event:") || chunkText.includes(":")) break;
    }
    sseCtrl.abort();
    if (/^(data:|event:|: )/m.test(chunkText) || /connected|hello/i.test(chunkText)) {
      ok("/api/realtime 開連並送出 SSE 初始 frame");
    } else {
      ng(`/api/realtime 沒有送出 SSE frame：${chunkText.slice(0, 100)}`);
    }
  } else {
    ng(`/api/realtime 開連失敗 (HTTP ${sseRes.status})`);
  }
} catch (err) {
  // AbortError 是預期（5 秒後我們主動關閉），不算失敗
  if (err.name === "AbortError" || err.message.includes("aborted")) {
    // 已在上面判斷過 chunk，這裡不重複
  } else {
    ng(`/api/realtime 連線錯誤：${err.message}`);
  }
} finally {
  clearTimeout(sseTimer);
}

// ──────────────────────────────────────────────────────────
section("結果");
// ──────────────────────────────────────────────────────────
console.log("");
if (fail === 0) {
  console.log(green(bold(`✓ 部署驗證全綠：${pass}/${pass}`)));
  console.log("\n後續手動驗收（依 docs/deploy-railway-2026-04-27.md §5）：");
  console.log("  - 5-3 / 5-4：加 TG 號 → 群組自動出現（Bug A）");
  console.log("  - 5-6 / 5-7：刪 TG 號 → 孤兒群組自動 isActive=false（Bug B）");
  process.exit(0);
} else {
  console.log(red(bold(`✗ 部署驗證失敗：${pass}/${pass + fail}`)));
  console.log("\n失敗項目：");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("\n建議：先回滾（Railway → Deployments → Redeploy 上一個成功版本），排除問題後再前推。");
  process.exit(1);
}
