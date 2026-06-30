#!/usr/bin/env node
/**
 * Pre-push hook（cross-platform Node.js 版）
 *
 * 取代 .githooks/pre-push（bash 版）— 讓 Windows 開發者也能用。
 *
 * 啟用：
 *   git config core.hooksPath .githooks
 *
 * 在 Windows，git for Windows 會自動處理 shebang，照樣可跑。
 * 也可以手動把這個檔案 link 為 .githooks/pre-push（無副檔名）：
 *   - macOS / Linux: ln -s pre-push.mjs .githooks/pre-push  → 給 chmod +x
 *   - Windows:       由 git for Windows 的 sh 解讀 .githooks/pre-push（也是 .mjs）
 *
 * 為了在所有平台都能跑，我們維持單一入口 `.githooks/pre-push`（bash 版）作為
 * git 預設執行檔，內容只有一行 `node .githooks/pre-push.mjs "$@"`，由它呼叫
 * 這個 cross-platform 實作。Windows 上 git bash 也會走同條路徑。
 */
import { spawnSync } from "node:child_process";

console.log("▶ pre-push: typecheck + lint");

// Node.js 20+ 在 Windows 下 spawnSync 跑 .cmd / .bat 必須開 shell:true，
// 否則會回 EINVAL（這是 CVE-2024-27980 的安全修補引入的限制）。
// 用 shell:true 在 macOS / Linux 也照常工作。
const r = spawnSync("npm", ["run", "check"], {
  stdio: "inherit",
  shell: true,
});

if (r.status !== 0) {
  console.error("✗ pre-push: tsc / eslint 失敗 — push 中止");
  console.error("  跑 `npm run check` 看完整錯誤、修好之後再 push");
  process.exit(r.status ?? 1);
}

console.log("✓ pre-push: checks passed");
process.exit(0);
