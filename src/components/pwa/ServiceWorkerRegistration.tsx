"use client";

import { useEffect, useState } from "react";
import { X, Bell } from "lucide-react";

export function ServiceWorkerRegistration() {
  const [swRegistration, setSwRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>("default");
  const [showNotificationBanner, setShowNotificationBanner] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // 2026-05-21:dev mode 主動 unregister 既存的 SW + 跳過註冊。
    // sw.js 對 /_next/static/* 走 cache-first,dev 重新打包後 chunk hash 變了
    // 但 SW 黏住舊 chunks → "module factory not available" 錯誤一直出現。
    // 只在 production build 才需要 PWA 離線 + 推播,dev 不需要。
    if (process.env.NODE_ENV === "development") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      // 清掉所有 caches.api caches(只在 dev 主動清,不影響 prod 行為)
      if (typeof caches !== "undefined") {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
      }
      return;
    }

    // Production:Register service worker(僅離線快取 + 推播,不彈安裝提示)
    let updateInterval: ReturnType<typeof setInterval> | null = null;
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        setSwRegistration(registration);
        updateInterval = setInterval(() => registration.update(), 60 * 60 * 1000); // hourly
      })
      .catch((err) => {
        console.error("[SW] Registration failed:", err);
      });

    // 抑制瀏覽器的 PWA 安裝提示（不呼叫 prompt()、不顯示 UI）
    const suppressInstallPrompt = (e: Event) => {
      e.preventDefault();
    };
    window.addEventListener("beforeinstallprompt", suppressInstallPrompt);

    // Check notification permission
    if ("Notification" in window) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNotificationPermission(Notification.permission);
      if (Notification.permission === "default") {
        const asked = localStorage.getItem("switchboard_notification_asked");
        if (!asked || Date.now() - parseInt(asked) > 3 * 24 * 60 * 60 * 1000) {
          setTimeout(() => setShowNotificationBanner(true), 5000);
        }
      }
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", suppressInstallPrompt);
      if (updateInterval) clearInterval(updateInterval);
    };
  }, []);

  const requestNotifications = async () => {
    localStorage.setItem("switchboard_notification_asked", Date.now().toString());
    setShowNotificationBanner(false);

    if (!("Notification" in window) || !swRegistration) return;

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);

    if (permission === "granted" && swRegistration.pushManager) {
      try {
        const vapidKey = document.querySelector<HTMLMetaElement>('meta[name="vapid-key"]')?.content;
        if (vapidKey) {
          const subscription = await swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
          });

          await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subscription),
          });
        }
      } catch {
        // Push subscription failed, notification permission still works for local notifications
      }
    }
  };

  const dismissNotification = () => {
    setShowNotificationBanner(false);
    localStorage.setItem("switchboard_notification_asked", Date.now().toString());
  };

  return (
    <>
      {/* Notification permission banner */}
      {showNotificationBanner && notificationPermission === "default" && (
        <div className="fixed bottom-20 md:bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 bg-white rounded-lg shadow-lg border border-gray-200 p-4 z-50">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-yellow-50 rounded-lg">
              <Bell className="w-5 h-5 text-yellow-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">開啟推播通知</p>
              <p className="text-xs text-gray-500 mt-0.5">
                接收審核佇列更新、任務指派等即時通知
              </p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={requestNotifications}
                  className="px-3 py-1.5 bg-yellow-500 text-white text-xs rounded-md hover:bg-yellow-600"
                >
                  開啟通知
                </button>
                <button
                  onClick={dismissNotification}
                  className="px-3 py-1.5 text-gray-600 text-xs hover:bg-gray-100 rounded-md"
                >
                  不用了
                </button>
              </div>
            </div>
            <button onClick={dismissNotification} className="text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
