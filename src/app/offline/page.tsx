"use client";

export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-6">&#128268;</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          目前離線
        </h1>
        <p className="text-gray-600 mb-6">
          無法連接到伺服器，請檢查您的網路連線後重試。
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          重新連線
        </button>
      </div>
    </div>
  );
}
