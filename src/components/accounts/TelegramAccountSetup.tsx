"use client";

import { useState, useMemo } from "react";
import { Phone, Smartphone, Key, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { getPhoneLiveStatus, validatePhone } from "@/lib/validation/phone";

interface TelegramAccountSetupProps {
  workspaceId: string;
  onAccountAdded: (accountId: string) => void;
}

interface RegisterStep {
  step: 'phone' | 'code' | 'password' | 'success';
  accountId?: string;
  phoneNumber?: string;
  needsPassword?: boolean;
  mockMode?: boolean;
  error?: string;
}

export function TelegramAccountSetup({ 
  workspaceId, 
  onAccountAdded 
}: TelegramAccountSetupProps) {
  const [registerState, setRegisterState] = useState<RegisterStep>({ 
    step: 'phone' 
  });
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    phoneNumber: '',
    displayName: '',
    verificationCode: '',
    password: ''
  });

  // 即時電話格式狀態（給輸入框旁邊小提示用）
  const phoneLive = useMemo(
    () => getPhoneLiveStatus(formData.phoneNumber),
    [formData.phoneNumber],
  );

  // 步驟 1: 註冊電話號碼
  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.phoneNumber || !formData.displayName) return;

    // 防呆：送出前先正規化跟驗證電話。失敗的話直接擋下、回 inline error，
    // 不要送到後端再吃 400。
    const phoneCheck = validatePhone(formData.phoneNumber);
    if (!phoneCheck.ok) {
      setRegisterState((prev) => ({ ...prev, error: phoneCheck.error }));
      return;
    }
    const e164 = phoneCheck.e164;

    setLoading(true);
    setRegisterState((prev) => ({ ...prev, error: undefined }));
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/accounts/telegram/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phoneNumber: e164, // 送 E.164 格式給後端，TG 也吃這個
            displayName: formData.displayName
          })
        }
      );

      const result = await response.json();

      if (response.ok) {
        setRegisterState({
          step: 'code',
          accountId: result.accountId,
          phoneNumber: formData.phoneNumber,
          mockMode: result.mockMode || false,
        });
      } else {
        setRegisterState(prev => ({
          ...prev,
          error: result.error || '註冊失敗'
        }));
      }
    } catch {
      setRegisterState(prev => ({
        ...prev,
        error: '網路連線錯誤，請稍後再試'
      }));
    } finally {
      setLoading(false);
    }
  };

  // 步驟 2: 驗證認證碼
  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.verificationCode || !registerState.accountId) return;

    setLoading(true);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/accounts/telegram/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: registerState.accountId,
            verificationCode: formData.verificationCode,
            password: formData.password
          })
        }
      );

      const result = await response.json();

      if (response.ok) {
        setRegisterState(prev => ({
          step: 'success',
          accountId: prev.accountId
        }));
        if (registerState.accountId) onAccountAdded(registerState.accountId);
      } else {
        if (result.passwordRequired) {
          setRegisterState(prev => ({
            ...prev,
            needsPassword: true,
            error: undefined
          }));
        } else {
          setRegisterState(prev => ({
            ...prev,
            error: result.error || '驗證失敗'
          }));
        }
      }
    } catch {
      setRegisterState(prev => ({
        ...prev,
        error: '網路連線錯誤，請稍後再試'
      }));
    } finally {
      setLoading(false);
    }
  };

  // 重新發送驗證碼
  const handleResendCode = async () => {
    if (!registerState.accountId) return;

    setLoading(true);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/accounts/telegram/verify`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: registerState.accountId
          })
        }
      );

      if (response.ok) {
        setRegisterState(prev => ({
          ...prev,
          error: undefined
        }));
      }
    } catch {
      setRegisterState(prev => ({
        ...prev,
        error: '重新發送驗證碼失敗'
      }));
    } finally {
      setLoading(false);
    }
  };

  // 重新開始
  const handleRestart = () => {
    setRegisterState({ step: 'phone' });
    setFormData({
      phoneNumber: '',
      displayName: '',
      verificationCode: '',
      password: ''
    });
  };

  return (
    <div className="max-w-md mx-auto bg-white rounded-lg border border-gray-200 p-6">
      <div className="text-center mb-6">
        <Smartphone className="w-12 h-12 text-blue-500 mx-auto mb-3" />
        <h3 className="text-lg font-semibold text-gray-900">
          新增 Telegram 帳號
        </h3>
        <p className="text-sm text-gray-600 mt-1">
          連接員工的 Telegram 帳號到 Switchboard
        </p>
      </div>

      {/* 進度指示器 */}
      <div className="flex items-center justify-center mb-6">
        <div className="flex items-center space-x-2">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
            registerState.step === 'phone' 
              ? 'bg-blue-500 text-white' 
              : 'bg-green-500 text-white'
          }`}>
            {registerState.step === 'phone' ? '1' : <CheckCircle className="w-4 h-4" />}
          </div>
          <div className={`w-8 h-0.5 ${
            ['code', 'password', 'success'].includes(registerState.step) 
              ? 'bg-green-500' 
              : 'bg-gray-300'
          }`} />
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
            registerState.step === 'code' 
              ? 'bg-blue-500 text-white' 
              : ['password', 'success'].includes(registerState.step)
              ? 'bg-green-500 text-white'
              : 'bg-gray-300 text-gray-600'
          }`}>
            {['password', 'success'].includes(registerState.step) ? <CheckCircle className="w-4 h-4" /> : '2'}
          </div>
          <div className={`w-8 h-0.5 ${
            registerState.step === 'success' ? 'bg-green-500' : 'bg-gray-300'
          }`} />
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
            registerState.step === 'success' 
              ? 'bg-green-500 text-white' 
              : 'bg-gray-300 text-gray-600'
          }`}>
            {registerState.step === 'success' ? <CheckCircle className="w-4 h-4" /> : '3'}
          </div>
        </div>
      </div>

      {/* 錯誤訊息 */}
      {registerState.error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center">
            <AlertCircle className="w-4 h-4 text-red-500 mr-2" />
            <span className="text-sm text-red-700">{registerState.error}</span>
          </div>
        </div>
      )}

      {/* 步驟 1: 輸入電話號碼 */}
      {registerState.step === 'phone' && (
        <form onSubmit={handlePhoneSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              顯示名稱
            </label>
            <input
              type="text"
              required
              value={formData.displayName}
              onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
              placeholder="例如：王小明 (員工本人的 TG 顯示名稱)"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Telegram 電話號碼
            </label>
            <div className="relative">
              <Phone className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                // maxLength 寬鬆抓 25（E.164 最多 15 位 + 5 個格式字元 + buffer），
                // 防止剪貼一大段亂碼進來
                maxLength={25}
                required
                value={formData.phoneNumber}
                onChange={(e) => {
                  // 即時把不合法字元擋掉：只留 + / 數字 / 空格 / - / ( ) / .
                  const filtered = e.target.value.replace(/[^\d+\s\-().]/g, "");
                  setFormData({ ...formData, phoneNumber: filtered });
                  // 一打字就清掉先前的錯誤訊息（不要一直顯示）
                  if (registerState.error) {
                    setRegisterState((prev) => ({ ...prev, error: undefined }));
                  }
                }}
                placeholder="+886 912345678 或 0912345678"
                className={`w-full pl-10 pr-10 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                  phoneLive.status === "invalid"
                    ? "border-red-300"
                    : phoneLive.status === "valid"
                      ? "border-green-300"
                      : "border-gray-200"
                }`}
              />
              {/* 即時狀態 icon */}
              {phoneLive.status === "valid" && (
                <CheckCircle className="absolute right-3 top-2.5 w-4 h-4 text-green-500" aria-label="格式正確" />
              )}
              {phoneLive.status === "invalid" && (
                <AlertCircle className="absolute right-3 top-2.5 w-4 h-4 text-red-500" aria-label="格式錯誤" />
              )}
            </div>
            {/* 動態提示：根據輸入狀態顯示不同訊息 */}
            <div className="mt-1 text-xs min-h-[1rem]">
              {phoneLive.status === "valid" && phoneLive.e164 ? (
                <span className="text-green-600">
                  將以 {phoneLive.e164} 註冊
                </span>
              ) : phoneLive.status === "invalid" && phoneLive.hint ? (
                <span className="text-red-500">{phoneLive.hint}</span>
              ) : phoneLive.status === "incomplete" ? (
                <span className="text-gray-500">繼續輸入完整號碼...</span>
              ) : (
                <span className="text-gray-500">
                  支援台灣本地（0912...）或國際格式（+886912...）
                </span>
              )}
            </div>
          </div>

          <button
            type="submit"
            // 電話格式不對 / 名稱空白 / 載入中 → 都禁用
            disabled={loading || phoneLive.status !== "valid" || !formData.displayName.trim()}
            className="w-full bg-blue-500 text-white py-2 px-4 rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                發送驗證碼...
              </>
            ) : (
              '發送驗證碼'
            )}
          </button>
        </form>
      )}

      {/* 步驟 2: 輸入驗證碼 */}
      {registerState.step === 'code' && (
        <form onSubmit={handleCodeSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              驗證碼
            </label>
            <input
              type="text"
              required
              value={formData.verificationCode}
              onChange={(e) => setFormData({ ...formData, verificationCode: e.target.value })}
              placeholder="12345"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center text-lg tracking-widest"
              maxLength={6}
            />
            <p className="text-xs text-gray-500 mt-1">
              請輸入發送到 {registerState.phoneNumber} 的驗證碼
            </p>
            {registerState.mockMode && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-300 rounded-md">
                <p className="text-xs text-amber-700 font-medium">
                  目前為模擬模式(此帳號未填 API ID / Hash,無法與真實 Telegram 通訊)
                </p>
                <p className="text-xs text-amber-600">
                  請輸入 <strong>12345</strong> 完成模擬驗證;或回上一步填入 my.telegram.org 取得的憑證
                </p>
              </div>
            )}
          </div>

          {/* 2FA 密碼 (如果需要) */}
          {registerState.needsPassword && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                兩步驟驗證密碼
              </label>
              <div className="relative">
                <Key className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder="請輸入您的 Telegram 密碼"
                  className="w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          )}

          <div className="flex space-x-3">
            <button
              type="button"
              onClick={handleResendCode}
              disabled={loading}
              className="flex-1 border border-gray-200 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              重新發送
            </button>
            <button
              type="submit"
              disabled={loading || !formData.verificationCode}
              className="flex-1 bg-blue-500 text-white py-2 px-4 rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  驗證中...
                </>
              ) : (
                '驗證'
              )}
            </button>
          </div>
        </form>
      )}

      {/* 步驟 3: 成功 */}
      {registerState.step === 'success' && (
        <div className="text-center">
          <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h4 className="text-lg font-semibold text-gray-900 mb-2">
            帳號添加成功！
          </h4>
          <p className="text-gray-600 mb-6">
            員工的 Telegram 帳號已成功連接到 Switchboard
          </p>
          <button
            onClick={handleRestart}
            className="bg-blue-500 text-white py-2 px-4 rounded-lg hover:bg-blue-600"
          >
            添加另一個帳號
          </button>
        </div>
      )}
    </div>
  );
}