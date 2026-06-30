/**
 * Telegram Authentication Flow
 *
 * Handles the complete authentication process for Telegram accounts:
 * 1. Phone number verification
 * 2. SMS code verification
 * 3. Two-factor authentication (if enabled)
 * 4. Session management
 *
 * IMPORTANT: Auth sessions are stored in the database (PendingAuthSession table)
 * to support multi-instance deployments like Railway. Server memory is not shared
 * across instances, so we use Postgres to persist phoneCodeHash between the
 * "send code" and "verify code" requests.
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto/encryption";
import { logger } from "@/lib/logger";

const log = logger("TelegramAuth");

// GramJS RPCError shape we actually consume. Using a narrow type keeps the
// catch blocks honest without tying us to GramJS internals.
type TgErrorLike = { errorMessage?: string; message?: string };
function asTgError(err: unknown): TgErrorLike {
  return (err && typeof err === "object" ? (err as TgErrorLike) : {});
}

interface AuthResult {
  success: boolean;
  userId?: string;
  error?: string;
  passwordRequired?: boolean;
  needsNewCode?: boolean;
}

interface InitAuthResult {
  authRequired: boolean;
  codeSent: boolean;
  mockMode?: boolean;
  error?: string;
}

interface AuthStatus {
  isAuthenticated: boolean;
  needsCode: boolean;
  needsPassword: boolean;
  error?: string;
}

// 2026-04-14 會議決議(2026-05-21 再次確認):不共用環境變數,避免封號連鎖。
// 每個 Telegram 帳號必須自行於 https://my.telegram.org 申請獨立 App,
// 在驗證 UI 填入該帳號專用的 API ID / API Hash。
//
// 為什麼不做「系統預設值」:api_id/hash 共用一組 App,萬一被 Telegram 標記
// 濫用,所有掛在這組 App 上的帳號會一起受影響。每帳號獨立 App 把風險隔離掉。
//
// 未提供時自動進入 mock 模式,驗證碼固定為 "12345"(只用於本機/QA/自動化)。
function resolveCredentials(
  apiId?: number | null,
  apiHash?: string | null
): { apiId: number; apiHash: string; source: "per-account" | "missing" } {
  if (apiId && apiHash) return { apiId, apiHash, source: "per-account" };
  return { apiId: 0, apiHash: "", source: "missing" };
}

// Clean up expired auth sessions from the database
setInterval(() => {
  prisma.pendingAuthSession
    .deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    })
    .catch((err) => {
      log.warn("Failed to cleanup expired auth sessions", { error: String(err) });
    });
}, 5 * 60 * 1000); // Every 5 minutes

export class TelegramAuthFlow {
  /**
   * 初始化認證:建立 TelegramClient 並發送驗證碼
   *
   * apiId / apiHash 參數是**每帳號獨立**的 Telegram app credentials
   * (使用者於 my.telegram.org 申請)。未提供時會 fallback 到 env,
   * 但那是 legacy/dev convenience,prod 不建議共用。
   */
  static async initializeAuth(
    accountId: string,
    phoneNumber: string,
    apiId?: number,
    apiHash?: string
  ): Promise<InitAuthResult> {
    const creds = resolveCredentials(apiId, apiHash);
    if (creds.source === "missing") {
      log.info("Mock mode: sending code (no credentials configured)", { phoneNumber });
      return { authRequired: true, codeSent: true, mockMode: true };
    }

    const client = new TelegramClient(
      new StringSession(""),
      creds.apiId,
      creds.apiHash,
      { connectionRetries: 3, timeout: 30000 }
    );

    try {
      await client.connect();

      const result = await client.sendCode(
        {
          apiId: creds.apiId,
          apiHash: creds.apiHash,
        },
        phoneNumber
      );

      // 儲存認證會話到資料庫 — 包含 per-account creds + GramJS session string
      // 供後續 verifyCode 使用。sessionString 含 dcId/serverAddress/port/authKey,
      // 在 sendCode 時 GramJS 已經做完 PHONE_MIGRATE → 連到正確 DC 並交換完
      // authKey,把這狀態 dump 出來;verify 端重建 StringSession 就能無痛接力,
      // 不會因為連回 default DC 拿到 PHONE_CODE_EXPIRED。
      const sessionString = client.session.save() as unknown as string;
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 30);

      await prisma.pendingAuthSession.upsert({
        where: { accountId },
        create: {
          accountId,
          phoneNumber,
          phoneCodeHash: result.phoneCodeHash,
          apiId: creds.apiId,
          apiHash: creds.apiHash,
          sessionString,
          expiresAt,
        },
        update: {
          phoneNumber,
          phoneCodeHash: result.phoneCodeHash,
          apiId: creds.apiId,
          apiHash: creds.apiHash,
          sessionString,
          expiresAt,
        },
      });

      // Disconnect the temporary client — verify will rebuild from sessionString.
      await client.disconnect();

      log.info("Code sent", { phoneNumber, accountId });

      return {
        authRequired: true,
        codeSent: true,
      };
    } catch (error: unknown) {
      const tgErr = asTgError(error);
      log.error("Failed to send code", { phoneNumber, error: String(error) });
      await client.disconnect();
      // Map common Telegram error codes to Chinese
      let errorMsg = "發送驗證碼失敗，請稍後再試";
      if (tgErr.errorMessage?.includes("PHONE_NUMBER_INVALID")) {
        errorMsg = "電話號碼格式無效，請確認含有正確的國碼";
      } else if (tgErr.errorMessage?.includes("PHONE_NUMBER_BANNED")) {
        errorMsg = "此電話號碼已被 Telegram 封禁";
      } else if (tgErr.errorMessage?.includes("PHONE_NUMBER_FLOOD")) {
        errorMsg = "操作過於頻繁，請稍後再試";
      } else if (tgErr.errorMessage?.includes("FLOOD_WAIT")) {
        errorMsg = "請求過於頻繁，請稍後再試";
      } else if (tgErr.errorMessage) {
        errorMsg = `發送驗證碼失敗：${tgErr.errorMessage}`;
      }

      return {
        authRequired: true,
        codeSent: false,
        error: errorMsg,
      };
    }
  }

  /**
   * 驗證認證碼
   */
  static async verifyCode(
    accountId: string,
    code: string,
    password?: string
  ): Promise<AuthResult> {
    // Load auth session from database
    const pendingAuth = await prisma.pendingAuthSession.findUnique({
      where: { accountId },
    });

    if (!pendingAuth) {
      // Distinguish "session expired" from "mock mode":
      // If the account already has a TelegramSession with real credentials,
      // then pendingAuth being empty means the auth session expired —
      // the user must restart the flow.
      const existingSession = await prisma.telegramSession.findUnique({
        where: { accountId },
        select: { apiId: true },
      });
      const hasPriorRealSession = existingSession && existingSession.apiId > 0;
      if (hasPriorRealSession) {
        return {
          success: false,
          error: "認證會話已過期，請重新發送驗證碼",
          needsNewCode: true,
        };
      }

      // No prior session + no pending auth = mock mode (dev/QA only)
      log.info("Mock mode: verifying code", { accountId });
      if (code === "12345") {
        const mockSession = JSON.stringify({
          sessionString: "mock_session_" + Date.now(),
        });
        await this.saveEncryptedSession(accountId, mockSession, 0, "");
        return {
          success: true,
          userId: "mock_user_" + accountId.slice(-6),
        };
      }
      return {
        success: false,
        error: "驗證碼無效。模擬模式下請輸入 12345。",
      };
    }

    // Check if session expired
    if (pendingAuth.expiresAt < new Date()) {
      await prisma.pendingAuthSession.delete({ where: { accountId } });
      return {
        success: false,
        error: "認證會話已過期，請重新發送驗證碼",
        needsNewCode: true,
      };
    }

    // ⚠️ 雙重雷區避免:
    // 1. 不能用 GramJS 的高層 client.signInUser — 它內部會自己 sendCode
    //    (node_modules/telegram/client/auth.js:85),用新 phoneCodeHash 蓋掉
    //    我們存的舊 hash → PHONE_CODE_INVALID。
    // 2. 不能用空的 StringSession 創 client — 那會連到 default DC (DC2),
    //    但 phoneCodeHash 是 sendCode 時 phone_migrated 後在另一個 DC (常見 DC5)
    //    產生的。在錯 DC invoke SignIn(hash) → Telegram 回 PHONE_CODE_EXPIRED
    //    (其實是「我不認識這 hash」)。
    //
    // 正解:用 PendingAuthSession 存的 sessionString 重建 client(會自動連到
    // 同一個 DC + 帶之前的 authKey),然後直接 invoke 低階 Api.auth.SignIn 帶 hash。
    // 2FA 走 signInWithPassword(只做 SRP,不會 sendCode)。
    const client = new TelegramClient(
      new StringSession(pendingAuth.sessionString || ""),
      pendingAuth.apiId,
      pendingAuth.apiHash,
      { connectionRetries: 3, timeout: 30000 }
    );

    try {
      await client.connect();

      let signedInUser: Api.User | undefined;

      try {
        const signInResult = await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: pendingAuth.phoneNumber,
            phoneCodeHash: pendingAuth.phoneCodeHash,
            phoneCode: code,
          })
        );
        // Returns Api.auth.Authorization { user } on success, or
        // Api.auth.AuthorizationSignUpRequired (no user) for unregistered numbers.
        const maybeUser =
          signInResult &&
          typeof signInResult === "object" &&
          "user" in signInResult
            ? ((signInResult as { user?: unknown }).user as Api.User | undefined)
            : undefined;
        if (!maybeUser) {
          throw new Error("SIGNUP_REQUIRED");
        }
        signedInUser = maybeUser;
      } catch (signInErr: unknown) {
        const sigTgErr = asTgError(signInErr);
        const sigMsg = sigTgErr.errorMessage || sigTgErr.message || "";

        if (sigMsg.includes("SESSION_PASSWORD_NEEDED")) {
          if (!password) {
            // 告訴前端要密碼;保留 PendingAuthSession 讓使用者重試帶密碼
            await client.disconnect();
            return { success: false, passwordRequired: true };
          }
          // 帶 2FA 密碼走 signInWithPassword (SRP-based, 不會 sendCode)
          try {
            const me = await client.signInWithPassword(
              { apiId: pendingAuth.apiId, apiHash: pendingAuth.apiHash },
              {
                password: async () => password,
                onError: async (err: Error) => {
                  log.error("2FA password error", { error: String(err) });
                  return true; // stop retrying
                },
              }
            );
            signedInUser = me as Api.User;
          } catch (pwErr: unknown) {
            // 2FA 密碼錯誤 — cleanup 並要求重新發送驗證碼
            const pwTgErr = asTgError(pwErr);
            log.error("2FA failed", { error: String(pwErr) });
            await client.disconnect();
            await prisma.pendingAuthSession.delete({ where: { accountId } });
            const pwMsg = pwTgErr.errorMessage || "";
            if (pwMsg.includes("PASSWORD_HASH_INVALID")) {
              return {
                success: false,
                error: "兩步驗證密碼錯誤,請重新發送驗證碼後再試",
                needsNewCode: true,
              };
            }
            return {
              success: false,
              error: pwMsg ? `兩步驗證失敗:${pwMsg}` : "兩步驗證失敗",
              needsNewCode: true,
            };
          }
        } else {
          // 重拋給外層的錯誤分類處理
          throw signInErr;
        }
      }

      // Save session — 存入該帳號自己的 apiId/apiHash,供未來 client-manager reconnect 使用
      const session = client.session.save() as unknown as string;
      await this.saveEncryptedSession(accountId, session, pendingAuth.apiId, pendingAuth.apiHash);

      // Fetch Telegram self info (firstName/lastName/username) and backfill
      // onto CommunicationAccount. Non-fatal — user can refresh later.
      try {
        const me: unknown = await client.getMe();
        const firstName =
          me && typeof me === "object" && "firstName" in me
            ? String((me as { firstName?: unknown }).firstName ?? "") || null
            : null;
        const lastName =
          me && typeof me === "object" && "lastName" in me
            ? String((me as { lastName?: unknown }).lastName ?? "") || null
            : null;
        const username =
          me && typeof me === "object" && "username" in me
            ? String((me as { username?: unknown }).username ?? "") || null
            : null;
        const telegramUserId =
          me && typeof me === "object" && "id" in me
            ? String((me as { id?: unknown }).id)
            : null;

        // 若使用者沒填自訂暱稱（displayName 為 null/空），把 TG 名稱當預設寫入 displayName
        // 好處：UI 各處只看 displayName 一個欄位就好，不用每處都寫 fallback 邏輯
        // 順序：firstName + lastName → username → 不寫（保持 null）
        const existing = await prisma.communicationAccount.findUnique({
          where: { id: accountId },
          select: { displayName: true },
        });
        const tgNameFallback =
          [firstName, lastName].filter(Boolean).join(" ").trim() ||
          username ||
          null;
        const shouldBackfillDisplayName =
          (!existing?.displayName || existing.displayName.trim() === "") &&
          tgNameFallback;

        await prisma.communicationAccount.update({
          where: { id: accountId },
          data: {
            telegramFirstName: firstName,
            telegramLastName: lastName,
            telegramUsername: username,
            ...(telegramUserId ? { telegramUserId } : {}),
            ...(shouldBackfillDisplayName ? { displayName: tgNameFallback } : {}),
          },
        });
      } catch (err) {
        log.warn("Failed to fetch Telegram self info", { error: String(err) });
        // Non-fatal; user can refresh later
      }

      // Cleanup: delete pending auth session and disconnect client
      await prisma.pendingAuthSession.delete({ where: { accountId } });
      await client.disconnect();

      const userId = signedInUser?.id?.toString() || "unknown";
      log.info("Successfully authenticated user", { userId });

      return {
        success: true,
        userId,
      };

    } catch (error: unknown) {
      log.error("Verification failed", { error: String(error) });
      const tgErr = asTgError(error);

      // 直接 invoke Api.auth.SignIn 後,catch 收到的就是真實 RPCError;
      // 不再像 signInUser 包裝成 AUTH_USER_CANCEL,所以只需查 tgErr。
      // (SESSION_PASSWORD_NEEDED 已經在 inner try 處理掉,走不到這裡。)
      await client.disconnect();

      const errMsg = tgErr.errorMessage || tgErr.message || "";
      const errMatches = (pattern: string) => errMsg.includes(pattern);

      if (errMatches("PHONE_CODE_INVALID") || errMatches("PHONE_CODE_EXPIRED")) {
        await prisma.pendingAuthSession.delete({ where: { accountId } });
        return {
          success: false,
          error: "驗證碼無效或已過期,請重新發送",
          needsNewCode: true,
        };
      }
      if (errMatches("PHONE_CODE_EMPTY")) {
        return {
          success: false,
          error: "驗證碼不能為空",
        };
      }
      if (errMatches("PHONE_NUMBER_UNOCCUPIED") || errMatches("SIGNUP_REQUIRED")) {
        await prisma.pendingAuthSession.delete({ where: { accountId } });
        return {
          success: false,
          error: "此電話號碼尚未註冊 Telegram,無法登入",
        };
      }

      // Map remaining Telegram errors to Chinese
      await prisma.pendingAuthSession.delete({ where: { accountId } });
      let errorMsg = "驗證失敗,請稍後再試";
      if (errMatches("FLOOD_WAIT")) {
        errorMsg = "操作過於頻繁,請稍後再試";
      } else if (errMsg && errMsg !== "AUTH_USER_CANCEL") {
        errorMsg = `驗證失敗:${errMsg}`;
      }

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * 重新發送驗證碼
   */
  static async resendCode(accountId: string): Promise<{ success: boolean; error?: string }> {
    const pendingAuth = await prisma.pendingAuthSession.findUnique({
      where: { accountId },
    });

    if (!pendingAuth) {
      // Mock fallback: no per-account creds → 當成已重發
      log.info("Mock mode: resending code", { accountId });
      return { success: true };
    }

    // 同 verifyCode:用 stored sessionString(若有)避免 DC mismatch。
    // resend 後 phoneCodeHash 會更新,順便重 save sessionString(authKey 不變但端對端保險)。
    const client = new TelegramClient(
      new StringSession(pendingAuth.sessionString || ""),
      pendingAuth.apiId,
      pendingAuth.apiHash,
      { connectionRetries: 2, timeout: 30000 }
    );

    try {
      await client.connect();
      const result = await client.sendCode(
        { apiId: pendingAuth.apiId, apiHash: pendingAuth.apiHash },
        pendingAuth.phoneNumber
      );
      const sessionString = client.session.save() as unknown as string;
      await prisma.pendingAuthSession.update({
        where: { accountId },
        data: {
          phoneCodeHash: result.phoneCodeHash,
          sessionString,
          // 重新發送 → 重置 30 分鐘 expiry
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      await client.disconnect();
      return { success: true };
    } catch (error: unknown) {
      await client.disconnect();
      const tgErr = asTgError(error);
      log.error("Failed to resend code", { error: String(error) });
      return {
        success: false,
        error: tgErr.errorMessage?.includes("FLOOD_WAIT")
          ? "操作過於頻繁，請稍後再試"
          : tgErr.errorMessage
          ? `重新發送失敗：${tgErr.errorMessage}`
          : "重新發送驗證碼失敗，請稍後再試"
      };
    }
  }

  /**
   * 獲取認證狀態
   */
  static async getAuthStatus(accountId: string): Promise<AuthStatus> {
    const pendingAuth = await prisma.pendingAuthSession.findUnique({
      where: { accountId },
    });

    if (!pendingAuth) {
      // 檢查是否已經有保存的會話
      const account = await prisma.communicationAccount.findUnique({
        where: { id: accountId },
        include: { telegramSession: true }
      });

      return {
        isAuthenticated: !!account?.telegramSession,
        needsCode: !account?.telegramSession,
        needsPassword: false
      };
    }

    // Check if expired
    if (pendingAuth.expiresAt < new Date()) {
      await prisma.pendingAuthSession.delete({ where: { accountId } });
      return {
        isAuthenticated: false,
        needsCode: true,
        needsPassword: false,
        error: "認證會話已過期",
      };
    }

    return {
      isAuthenticated: false,
      needsCode: true,
      needsPassword: false
    };
  }

  /**
   * 2026-05-21 Batch 4 — Session 字串登入。
   *
   * 跳過手機 / 驗證碼流程:直接用一段預先產生的 GramJS StringSession + 該帳號
   * 專屬的 api_id / api_hash 登入。流程:先存 session,再用既有的 testSession
   * (connect + getMe + 回填 TG 名稱)驗證;驗證失敗就把剛存的無效 session 清掉。
   *
   * 為什麼提供這條路:手機 / 驗證碼流程受 phoneCodeHash 過期、FLOOD_WAIT、
   * 30 分鐘 PendingAuthSession 視窗影響,偶爾不穩。已能在他處正常連線的帳號
   * 可直接匯出 session 字串貼進來,穩定得多。
   */
  static async loginWithSessionString(
    accountId: string,
    sessionString: string,
    apiId: number,
    apiHash: string,
  ): Promise<{ success: boolean; userId?: string; error?: string }> {
    const trimmed = sessionString.trim();
    if (!trimmed) {
      return { success: false, error: "Session 字串不可為空" };
    }
    if (!apiId || !apiHash) {
      return {
        success: false,
        error: "請提供此帳號專屬的 API ID 與 API Hash",
      };
    }
    // 先把 session 存起來。
    try {
      await this.saveEncryptedSession(accountId, trimmed, apiId, apiHash);
    } catch (err) {
      log.error("loginWithSessionString save failed", {
        accountId,
        error: String(err),
      });
      return { success: false, error: "Session 登入失敗,無法儲存會話" };
    }
    // session 已落地。從這裡起,任何「驗證沒成功」的路徑(回 false 或拋例外)
    // 都必須把這筆無效 session 清掉,否則 bridge reconnect loop 會撿到它。
    try {
      const test = await this.testSession(accountId);
      if (test.isValid) {
        log.info("Session-string login succeeded", { accountId });
        return { success: true, userId: test.userId };
      }
      await this.deleteSession(accountId).catch(() => {});
      return {
        success: false,
        error: test.error ?? "Session 字串無效,無法連線 Telegram",
      };
    } catch (err) {
      // testSession 拋例外 → 一樣清掉剛存的無效 session(best-effort)。
      await this.deleteSession(accountId).catch(() => {});
      log.error("loginWithSessionString validation failed", {
        accountId,
        error: String(err),
      });
      return {
        success: false,
        error: "Session 登入失敗,請確認字串與 API 憑證是否正確",
      };
    }
  }

  /**
   * 保存加密的 Telegram 會話到資料庫
   */
  private static async saveEncryptedSession(
    accountId: string,
    sessionString: string,
    apiId: number,
    apiHash: string
  ): Promise<void> {
    const encrypted = encrypt(sessionString);

    await prisma.telegramSession.upsert({
      where: { accountId },
      update: {
        encryptedSession: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        apiId,
        apiHash,
        lastConnectedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        accountId,
        encryptedSession: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        apiId,
        apiHash,
        lastConnectedAt: new Date(),
      },
    });

    log.info("Session saved", { accountId });
  }

  /**
   * 載入加密的 Telegram 會話
   */
  static async loadEncryptedSession(accountId: string): Promise<{
    sessionString: string;
    apiId: number;
    apiHash: string;
  } | null> {
    const session = await prisma.telegramSession.findUnique({
      where: { accountId },
    });

    if (!session) {
      return null;
    }

    try {
      const sessionString = decrypt(
        session.encryptedSession,
        session.iv,
        session.authTag,
      );

      return {
        sessionString,
        apiId: session.apiId,
        apiHash: session.apiHash,
      };
    } catch (error) {
      log.error("Failed to decrypt session", { accountId, error: String(error) });
      return null;
    }
  }

  /**
   * 刪除保存的會話
   */
  static async deleteSession(accountId: string): Promise<void> {
    await prisma.telegramSession.deleteMany({
      where: { accountId }
    });

    // 同時清理資料庫中的認證會話
    await prisma.pendingAuthSession.deleteMany({
      where: { accountId }
    });

    log.info("Session deleted", { accountId });
  }

  /**
   * 測試已保存會話的連接性
   */
  static async testSession(accountId: string): Promise<{
    isValid: boolean;
    userId?: string;
    error?: string
  }> {
    const sessionData = await this.loadEncryptedSession(accountId);
    if (!sessionData) {
      return { isValid: false, error: "找不到已儲存的會話" };
    }

    // Mock sessions have apiId === 0 — no real Telegram connection to test.
    if (sessionData.apiId === 0) {
      return { isValid: true, userId: "mock_user_" + accountId.slice(-6) };
    }

    const client = new TelegramClient(
      new StringSession(sessionData.sessionString),
      sessionData.apiId,
      sessionData.apiHash,
      { connectionRetries: 2, timeout: 10000 }
    );

    try {
      await client.connect();
      const me = await client.getMe();
      await client.disconnect();

      // Backfill Telegram self info onto CommunicationAccount so existing
      // accounts can get their firstName/lastName/username filled in.
      // Non-fatal — don't break session test on update failure.
      try {
        const meObj: unknown = me;
        const firstName =
          meObj && typeof meObj === "object" && "firstName" in meObj
            ? String((meObj as { firstName?: unknown }).firstName ?? "") || null
            : null;
        const lastName =
          meObj && typeof meObj === "object" && "lastName" in meObj
            ? String((meObj as { lastName?: unknown }).lastName ?? "") || null
            : null;
        const username =
          meObj && typeof meObj === "object" && "username" in meObj
            ? String((meObj as { username?: unknown }).username ?? "") || null
            : null;
        const telegramUserId =
          meObj && typeof meObj === "object" && "id" in meObj
            ? String((meObj as { id?: unknown }).id)
            : null;
        await prisma.communicationAccount.update({
          where: { id: accountId },
          data: {
            telegramFirstName: firstName,
            telegramLastName: lastName,
            telegramUsername: username,
            ...(telegramUserId ? { telegramUserId } : {}),
          },
        });
      } catch (err) {
        log.warn("Failed to backfill Telegram self info on session test", {
          accountId,
          error: String(err),
        });
      }

      return {
        isValid: true,
        userId: me.id.toString()
      };
    } catch (error: unknown) {
      const tgErr = asTgError(error);
      log.error("Session test failed", { accountId, error: String(error) });
      await client.disconnect();

      return {
        isValid: false,
        error: tgErr.errorMessage
          ? `會話驗證失敗：${tgErr.errorMessage}`
          : "會話連線測試失敗"
      };
    }
  }
}
