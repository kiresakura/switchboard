#!/usr/bin/env node
/**
 * 部署前 preflight 檢查（cross-platform）
 *
 * 取代 preflight-check.sh — 用純 Node.js 實作，支援 Windows / macOS / Linux。
 *
 * 跑法（任一）：
 *   npm run preflight
 *   node scripts/deploy/preflight-check.mjs
 *
 * 退出碼：
 *   0 — 全部通過
 *   1 — 至少一項失敗
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 切到 repo root（避免在子目錄執行時路徑錯亂）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);

// ── 顏色（Windows 10 build 10586+ 的 cmd 也支援 ANSI）─────
const isTTY = process.stdout.isTTY;
const c = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const yellow = (s) => c("33", s);
const bold = (s) => c("1", s);

let pass = 0,
  fail = 0,
  warn = 0;
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
const wn = (msg) => {
  console.log(`  ${yellow("!")} ${msg}`);
  warn++;
};
const section = (title) => console.log(`\n${bold(`── ${title} ──`)}`);

// ── helpers ────────────────────────────────────────────
function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false, ...opts });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function tryRun(cmd, args = []) {
  try {
    return run(cmd, args);
  } catch {
    return { code: 1, out: "", err: "spawn failed" };
  }
}

// ──────────────────────────────────────────────────────────
section("1. 工具鏈");
// ──────────────────────────────────────────────────────────

const node = tryRun(process.execPath, ["-v"]);
const major = parseInt((node.out || "v0").replace(/^v/, "").split(".")[0], 10);
if (major >= 22) ok(`Node.js ${node.out}（≥22，與 Dockerfile 一致）`);
else ng(`Node.js ${node.out} 過舊（需 ≥22）`);

const npmVer = tryRun(process.platform === "win32" ? "npm.cmd" : "npm", ["-v"]);
if (npmVer.code === 0) ok(`npm ${npmVer.out}`);
else ng("缺少 npm");

const gitVer = tryRun("git", ["--version"]);
if (gitVer.code === 0) ok(`git ${gitVer.out.replace(/^git version /, "")}`);
else ng("缺少 git");

// ──────────────────────────────────────────────────────────
section("2. Git 狀態");
// ──────────────────────────────────────────────────────────

const branch = tryRun("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out;
if (branch === "main") ok("當前 branch: main");
else wn(`當前 branch: ${branch}（Railway 預設追 main，請確認 Railway 已切到此 branch）`);

const dirty = tryRun("git", ["status", "--porcelain"]).out;
if (!dirty) ok("Working tree 乾淨");
else {
  const count = dirty.split("\n").length;
  ng(`Working tree 有未 commit 變更：${count} 個檔案`);
}

const local = tryRun("git", ["rev-parse", "@"]).out;
const remote = tryRun("git", ["rev-parse", "@{u}"]).out;
if (remote && local === remote) ok("本機與 origin 同步");
else if (!remote) wn("找不到 upstream branch（git push -u origin 設定後再試）");
else ng("本機與 origin 不同步 — Railway 拿到的會是 origin 上的版本，請先 push");

// ──────────────────────────────────────────────────────────
section("3. Lockfile 一致性");
// ──────────────────────────────────────────────────────────

if (existsSync("package-lock.json")) ok("package-lock.json 存在");
else ng("package-lock.json 不存在 — Docker `npm ci` 會失敗");

try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  const lockRaw = readFileSync("package-lock.json", "utf8");
  const missing = allDeps.filter(
    (name) => !lockRaw.includes(`"node_modules/${name}"`) && !lockRaw.includes(`"${name}":`),
  );
  if (missing.length === 0) ok("所有 package.json 套件都在 lockfile 中");
  else ng(`lockfile 漂移：${missing.join(", ")} 在 package.json 但不在 lockfile — 請先 npm install`);
} catch (e) {
  ng(`無法解析 package.json / package-lock.json：${e.message}`);
}

// ──────────────────────────────────────────────────────────
section("4. TypeScript + ESLint");
// ──────────────────────────────────────────────────────────

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const check = tryRun(npmCmd, ["run", "check"]);
if (check.code === 0) ok("tsc --noEmit + eslint 通過");
else {
  ng("tsc 或 eslint 失敗");
  console.log(check.err.slice(0, 500) || check.out.slice(0, 500));
}

// ──────────────────────────────────────────────────────────
section("5. Docker 建置（如果有 docker，且未設 SKIP_DOCKER_BUILD=1）");
// ──────────────────────────────────────────────────────────

const hasDocker = tryRun("docker", ["--version"]).code === 0;
if (process.env.SKIP_DOCKER_BUILD === "1") {
  wn("已設 SKIP_DOCKER_BUILD=1，略過 Docker 建置（部署時 Railway 會重建）");
} else if (!hasDocker) {
  wn("Docker 未安裝 — 略過建置驗證");
} else {
  const appBuild = tryRun("docker", [
    "buildx",
    "build",
    "--target",
    "builder",
    "-f",
    "Dockerfile",
    "-o",
    "type=cacheonly",
    ".",
  ]);
  if (appBuild.code === 0) ok("Dockerfile（app）build 通過");
  else ng("Dockerfile（app）build 失敗");

  const bridgeBuild = tryRun("docker", [
    "buildx",
    "build",
    "-f",
    "Dockerfile.bridge",
    "-o",
    "type=cacheonly",
    ".",
  ]);
  if (bridgeBuild.code === 0) ok("Dockerfile.bridge build 通過");
  else ng("Dockerfile.bridge build 失敗");
}

// ──────────────────────────────────────────────────────────
section("6. 必要檔案存在");
// ──────────────────────────────────────────────────────────

// 只檢查目前 repo 確實會有的關鍵檔案。Railway 改用 UI 配置（不再
// 維護 railway.toml），所以那兩個 TOML 不在必要清單裡。
const required = [
  "Dockerfile",
  "Dockerfile.bridge",
  "package.json",
  "package-lock.json",
  "prisma/schema.prisma",
  "prisma/seed.ts",
  "prisma/migrations/0000_baseline/migration.sql",
  "src/app/api/health/route.ts",
  "workers/telegram-bridge.ts",
  "docs/deploy-railway.md",
  "scripts/deploy/post-deploy-verify.mjs",
  "scripts/deploy/generate-secrets.mjs",
];

for (const f of required) {
  if (existsSync(f)) ok(f);
  else ng(`缺少 ${f}`);
}

// ──────────────────────────────────────────────────────────
section("7. Dockerfile 健全度");
// ──────────────────────────────────────────────────────────

function checkDockerfile(file, expectedExpose) {
  if (!existsSync(file)) {
    ng(`${file} 不存在`);
    return;
  }
  const content = readFileSync(file, "utf8");
  if (content.includes(`EXPOSE ${expectedExpose}`)) ok(`${file} EXPOSE ${expectedExpose}`);
  else wn(`${file} 沒有 EXPOSE ${expectedExpose}（Railway 仍能跑，但確認 PORT 對得起來）`);
  if (content.match(/^FROM .+/m)) ok(`${file} 有 FROM 指令`);
  else ng(`${file} 沒有 FROM`);
}
checkDockerfile("Dockerfile", "3000");
checkDockerfile("Dockerfile.bridge", "3001");

// ──────────────────────────────────────────────────────────
section("8. Prisma migrations 與 schema 一致性");
// ──────────────────────────────────────────────────────────

const baselineSql = "prisma/migrations/0000_baseline/migration.sql";
if (existsSync(baselineSql)) {
  const sql = readFileSync(baselineSql, "utf8");
  if (
    sql.includes('CREATE TABLE "User"') &&
    sql.includes('CREATE TABLE "Workspace"') &&
    sql.includes('CREATE TABLE "ProtectedTerm"')
  ) {
    ok("baseline migration 含 User / Workspace / ProtectedTerm");
  } else {
    ng("baseline migration 缺少預期的 CREATE TABLE — schema 可能漂移");
  }
} else {
  ng("找不到 prisma/migrations/0000_baseline/migration.sql");
}

if (process.env.SKIP_PRISMA_DIFF === "1") {
  wn("已設 SKIP_PRISMA_DIFF=1，略過 Prisma schema drift 檢查");
} else if (!hasDocker) {
  wn("Docker 未安裝 — 無法檢查 schema drift");
} else {
  const shadowName = `switchboard-preflight-shadow-${process.pid}`;
  // 啟 shadow DB
  const startShadow = tryRun("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    shadowName,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=shadow",
    "-p",
    "15433:5432",
    "postgres:16.6-alpine",
  ]);
  if (startShadow.code !== 0) {
    wn("無法啟動 shadow DB，略過 drift 檢查");
  } else {
    // 等 Postgres 起來
    let ready = false;
    for (let i = 0; i < 12; i++) {
      const r = tryRun("docker", ["exec", shadowName, "pg_isready", "-U", "postgres", "-q"]);
      if (r.code === 0) {
        ready = true;
        break;
      }
      const ms = 1000;
      const start = Date.now();
      while (Date.now() - start < ms) {} // busy-wait（避免引入 sleep dep）
    }
    if (!ready) {
      wn("shadow DB 起不來，略過 drift 檢查");
    } else {
      const diff = tryRun(npmCmd, [
        "exec",
        "--",
        "prisma",
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema-datamodel",
        "prisma/schema.prisma",
        "--shadow-database-url",
        "postgresql://postgres:postgres@localhost:15433/shadow?schema=public",
        "--script",
      ]);
      const lines = diff.out
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("--"));
      if (lines.length === 0) ok("schema 與 migrations 同步（無 drift）");
      else ng(`schema 與 migrations 漂移（${lines.length} 行未含於 migration 檔）— 請補一支 migration`);
    }
    tryRun("docker", ["rm", "-f", shadowName]);
  }
}

// ──────────────────────────────────────────────────────────
section("結果");
// ──────────────────────────────────────────────────────────

console.log("");
if (fail === 0) {
  console.log(green(bold(`✓ Preflight 全部通過：${pass} pass / ${warn} warn`)));
  console.log("\n下一步：");
  console.log("  1. 確認 Railway 三個 service 都已建立（app / bridge / db plugin）");
  console.log("  2. 確認環境變數已填齊（見 docs/deploy-railway-2026-04-27.md §3）");
  console.log("  3. 確認 Config-as-Code Path 分別為 railway.toml / railway-bridge.toml");
  console.log("  4. git push origin main → Railway 自動 build");
  console.log("  5. node scripts/deploy/post-deploy-verify.mjs https://your-app.up.railway.app");
  process.exit(0);
} else {
  console.log(red(bold(`✗ Preflight 失敗：${pass} pass / ${fail} fail / ${warn} warn`)));
  console.log("\n失敗項目：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
