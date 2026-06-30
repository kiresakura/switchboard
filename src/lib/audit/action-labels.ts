/**
 * Translate audit log action codes into human-readable Traditional Chinese labels.
 *
 * Action codes come from many API routes (some UPPERCASE legacy, most dot.snake_case).
 * This module is the single source of truth for turning them into UI strings so we
 * don't expose raw machine codes to customer-facing operators.
 *
 * Unknown codes fall back to the raw code (prefixed with "⚠️") so operators can
 * still see something, and the log clearly signals "new action type, needs label".
 */

const ACTION_LABELS: Record<string, string> = {
  // ── Auth ──
  LOGIN_FAILED: "登入失敗",
  LOGOUT: "登出",
  "auth.kicked_previous_sessions": "踢掉先前登入的工作階段",
  "password.changed": "變更密碼",

  // ── Users / system admin ──
  "user.updated": "更新使用者",
  "workspace.update": "更新工作空間",
  "workspace.member_added": "新增工作空間成員",
  WORKSPACE_DEACTIVATED: "停用工作空間",
  WORKSPACE_DELETED: "刪除工作空間",

  // ── Workspace membership ──
  "member.add": "新增成員",
  "member.update": "更新成員",

  // ── Roles ──
  "role.create": "建立身份組",
  "role.update": "更新身份組",
  "role.delete": "刪除身份組",

  // ── Communication accounts ──
  "account.create": "建立通訊帳號",
  "account.update": "更新通訊帳號",
  "account.delete": "刪除通訊帳號",
  "account.auth_start": "開始帳號驗證",
  "account.auth_complete": "完成帳號驗證",
  REGISTER_TELEGRAM_ACCOUNT: "註冊 Telegram 帳號",
  VERIFY_TELEGRAM_ACCOUNT: "驗證 Telegram 帳號",
  RESEND_TELEGRAM_CODE: "重新寄送 Telegram 驗證碼",

  // ── Groups ──
  "group.update": "更新群組",
  "group.delete": "刪除群組",
  "group.deactivate": "停用群組",
  "groups.selective_sync": "選擇性同步群組",

  // ── Pairings ──
  "pairing.create": "建立配對",
  "pairing.update": "更新配對",
  "pairing.delete": "刪除配對",
  "pairing.deactivate": "停用配對",

  // ── Compliance rules ──
  "rule.create": "建立規則",
  "rule.update": "更新規則",
  "rule.delete": "刪除規則",
  "rules.update": "更新規則設定",
  "rules.directional.create": "新增方向性規則",
  "rules.directional.delete": "刪除方向性規則",
  "rules.term.update": "更新受保護詞彙",
  "rules.term.delete": "刪除受保護詞彙",

  // ── Review queue ──
  "review.approve": "放行訊息",
  "review.reject": "攔截訊息",
  "review.edit_approve": "修改後放行",
  "review.instant_approve": "快速放行",
  "review.instant_reject": "快速攔截",
  "review.instant_edit_approve": "快速修改後放行",
  "review.batch_approve": "批次放行",
  "review.batch_reject": "批次攔截",
  "review.batch_edit_approve": "批次修改後放行",
  "review.convert_to_announcement": "轉傳公佈欄",
  "review.forward_internal": "轉傳至內部群",
  "review.lock.force_released": "強制釋放鎖定",
  ATTACHED_TO_ANNOUNCEMENT: "已附加至公佈欄",

  // ── 公佈欄 / 交接 ──
  "announcement.created": "建立公告",
  "announcement.updated": "更新公告",
  "announcement.pinned": "釘選公告",
  "announcement.unpinned": "取消釘選公告",
  "announcement.hidden": "軟刪除公告",
  "handover.created": "建立交接",
  "handover.read": "確認交接",
  created: "建立",
  created_from_review: "由審核佇列建立",
  updated: "更新",

  // ── Conversations ──
  "conversation.update": "更新對話狀態",
  "conversation.batch_pin": "批量釘選對話",

  // ── Direct chat ──
  "direct_chat.send": "直面對話 - 傳送訊息",
  "direct_chat.message_pin": "釘選 / 取消釘選訊息",
  "direct_chat.call_intent": "直面對話 - 啟動通話/視訊入口",
  "direct_chat.embedded_call_start": "直面對話 - 啟動內嵌通話",
  "direct_chat.embedded_call_answer": "直面對話 - 接聽內嵌通話",
  "direct_chat.embedded_call_end": "直面對話 - 結束內嵌通話",

  // ── Schedule rules ──
  "schedule_rule.create": "建立排程規則",
  "schedule_rule.update": "更新排程規則",
  "schedule_rule.delete": "刪除排程規則",

  // ── Bridge / system ──
  BRIDGE_RECONNECT_FAILED: "Bridge 重新連線失敗",
  "admin.sse_subscribe": "管理員訂閱即時事件",

  // ── Bug report ──
  "bug_report.submitted": "提交異常回報",
};

/**
 * Returns the Chinese label for an audit action code.
 * Unknown codes return the raw code so nothing breaks and the UI still
 * shows something meaningful (operators can report it back to us).
 */
export function formatAuditAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * Sort a list of action codes for filter dropdowns by their Chinese label.
 */
export function sortActionsByLabel(actions: string[]): string[] {
  return [...actions].sort((a, b) =>
    formatAuditAction(a).localeCompare(formatAuditAction(b), "zh-Hant"),
  );
}
