"use client";

import { useState } from 'react';
import { mediaThumbUrl } from '@/lib/utils';

interface MessageDisplayProps {
  message: {
    id: string;
    originalContent: string;
    messageType: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' | 'STICKER' | 'VOICE' | 'VIDEO_NOTE' | 'LOCATION' | 'CONTACT' | 'POLL' | 'DICE' | 'STORY';
    mediaUrl?: string | null;
    mediaType?: string | null;
    mediaSize?: number | null;
    mediaFileName?: string | null;
    senderDisplayName?: string | null;
    platformTimestamp?: Date | null;
  };
  showSender?: boolean;
  className?: string;
}

export function MessageDisplay({ 
  message, 
  showSender = true, 
  className = "" 
}: MessageDisplayProps) {
  const [imageError, setImageError] = useState(false);

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const getFileIcon = (mimeType?: string | null) => {
    if (!mimeType) return '📄';
    
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType === 'application/pdf') return '📕';
    if (mimeType.includes('word')) return '📝';
    if (mimeType.includes('excel') || mimeType.includes('sheet')) return '📊';
    
    return '📄';
  };

  const handleImageClick = () => {
    if (message.mediaUrl) {
      window.open(message.mediaUrl, '_blank');
    }
  };

  return (
    <div className={`border rounded-lg p-4 ${className}`}>
      {/* Sender and timestamp */}
      {showSender && (
        <div className="flex items-center justify-between mb-2 text-sm text-[var(--muted-foreground)]">
          <span className="font-medium">
            {message.senderDisplayName || '未知使用者'}
          </span>
          {message.platformTimestamp && (
            <span>
              {new Date(message.platformTimestamp).toLocaleString('zh-TW')}
            </span>
          )}
        </div>
      )}

      {/* Message content */}
      <div className="space-y-3">
        {/* Text content */}
        {message.originalContent && (
          <div className="text-[var(--foreground)]">
            {message.originalContent}
          </div>
        )}

        {/* Media content */}
        {message.messageType === 'IMAGE' && message.mediaUrl && (
          <div className="space-y-2">
            {!imageError ? (
              <div 
                className="cursor-pointer group relative inline-block"
                onClick={handleImageClick}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- dynamic media URL from Telegram */}
                <img
                  src={mediaThumbUrl(message.mediaUrl, 800)}
                  alt={message.mediaFileName || '圖片'}
                  className="max-w-full max-h-64 rounded-lg shadow-sm hover:shadow-md transition-shadow"
                  onError={() => setImageError(true)}
                />
                <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all rounded-lg flex items-center justify-center">
                  <span className="text-white opacity-0 group-hover:opacity-100 bg-black bg-opacity-50 px-2 py-1 rounded text-sm">
                    點擊放大
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center space-x-2 p-3 bg-[var(--card)] rounded border-dashed border-2">
                <span>🖼️</span>
                <div>
                  <div className="font-medium">圖片載入失敗</div>
                  <div className="text-sm text-[var(--muted-foreground)]">
                    {message.mediaFileName}
                    {message.mediaSize && ` • ${formatFileSize(message.mediaSize)}`}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Document/File content */}
        {['DOCUMENT', 'AUDIO', 'VIDEO'].includes(message.messageType) && message.mediaUrl && (
          <div className="flex items-center space-x-3 p-3 bg-[var(--card)] rounded border">
            <span className="text-2xl">
              {getFileIcon(message.mediaType)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                {message.mediaFileName || '未知檔案'}
              </div>
              <div className="text-sm text-[var(--muted-foreground)]">
                {message.mediaType}
                {message.mediaSize && ` • ${formatFileSize(message.mediaSize)}`}
              </div>
            </div>
            <a
              href={message.mediaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600 transition-colors"
            >
              下載
            </a>
          </div>
        )}

        {/* Sticker */}
        {message.messageType === 'STICKER' && (
          <div className="flex items-center space-x-2">
            <span>🎭</span>
            <span className="text-[var(--muted-foreground)]">貼圖</span>
          </div>
        )}
      </div>

      {/* Message type indicator */}
      {message.messageType !== 'TEXT' && (
        <div className="mt-2 pt-2 border-t text-xs text-[var(--muted-foreground)]">
          訊息類型: {message.messageType}
        </div>
      )}
    </div>
  );
}