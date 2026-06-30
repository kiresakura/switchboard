/**
 * Media File Manager (Server-side only)
 *
 * Handles file storage, validation, and cleanup
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger('Media');

// First bytes of files we accept. The browser-supplied MIME is a hint —
// magic bytes confirm what the file actually is.
const MAGIC_BYTES: Record<string, Array<{ offset: number; bytes: number[] }>> = {
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  'image/gif': [
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
  ],
  'image/webp': [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }], // RIFF (WebP wraps in RIFF)
  'application/pdf': [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
  'application/zip': [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }], // PK..
  'audio/mpeg': [
    { offset: 0, bytes: [0x49, 0x44, 0x33] }, // ID3 tag
    { offset: 0, bytes: [0xff, 0xfb] }, // MPEG-1 Layer 3 frame sync
    { offset: 0, bytes: [0xff, 0xf3] },
    { offset: 0, bytes: [0xff, 0xf2] },
  ],
  'audio/wav': [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }], // RIFF
  'video/mp4': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }], // ....ftyp
  'video/quicktime': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
};

// MIME types where docx/xlsx/etc. share the ZIP magic — accept ZIP magic.
const ZIP_BASED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
]);

function checkMagicBytes(buffer: Buffer, mimeType: string): boolean {
  // Office docs are ZIPs under the hood
  const expected = ZIP_BASED_MIMES.has(mimeType)
    ? MAGIC_BYTES['application/zip']
    : MAGIC_BYTES[mimeType];
  // Types we don't have signatures for (text/plain, .doc legacy, mov shares ftyp): allow.
  if (!expected) return true;

  return expected.some(({ offset, bytes }) => {
    if (buffer.length < offset + bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) {
      if (buffer[offset + i] !== bytes[i]) return false;
    }
    return true;
  });
}

// Strip filesystem-significant or invisible characters before storing the
// (already-prefixed) filename. Keeps CJK + word chars + dot/hyphen.
function sanitizeFilename(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '') // control chars / NUL
    .replace(/[/\\?%*:|"<>]/g, '_')                 // path / shell metas
    .replace(/\.{2,}/g, '.')                         // ".." sequences
    .trim();
}

export interface MediaFileRecord {
  id: string;
  workspaceId: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
}

export interface UploadResult {
  id: string;
  url: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export class MediaFileManager {
  // 必須跟 bridge 用的 file-manager.ts (MEDIA_UPLOAD_DIR || './uploads') 一致；
  // 否則 bridge 寫入 ./uploads/<ws>/<file>、API 卻去 ./media/uploads 找 → 找不到 → 圖片載入失敗
  private static readonly UPLOAD_DIR = process.env.MEDIA_UPLOAD_DIR || './uploads';
  private static readonly MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
  
  private static readonly ALLOWED_TYPES = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'text/plain': '.txt',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov'
  };

  /**
   * Initialize media storage directory
   */
  private static async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * Validate file type and size
   */
  private static validateFile(file: File): void {
    if (file.size > this.MAX_FILE_SIZE) {
      throw new Error(`File too large. Maximum size is ${this.MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }

    if (!this.ALLOWED_TYPES[file.type as keyof typeof this.ALLOWED_TYPES]) {
      throw new Error(`File type ${file.type} is not supported`);
    }
  }

  /**
   * Generate unique filename
   */
  private static generateFilename(originalName: string, mimeType: string): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    const extension = this.ALLOWED_TYPES[mimeType as keyof typeof this.ALLOWED_TYPES] || '';
    const rawName = path.parse(originalName).name.substring(0, 50);
    const nameWithoutExt = sanitizeFilename(rawName) || 'file';

    return `${timestamp}_${random}_${nameWithoutExt}${extension}`;
  }

  /**
   * Store uploaded file
   */
  static async storeFile(
    file: File, 
    workspaceId: string,
    messageId?: string
  ): Promise<UploadResult> {
    // Validate file
    this.validateFile(file);

    // Ensure upload directory exists
    const workspaceDir = path.join(this.UPLOAD_DIR, workspaceId);
    await this.ensureDirectoryExists(workspaceDir);

    // Generate unique filename
    const filename = this.generateFilename(file.name, file.type);
    const filePath = path.join(workspaceDir, filename);
    const relativePath = path.join(workspaceId, filename);

    try {
      // Write file to disk
      const buffer = Buffer.from(await file.arrayBuffer());

      // Magic-byte check — reject MIME spoofing. The validateFile() pass above
      // only checks the browser-supplied content-type which a hostile client
      // can lie about.
      if (!checkMagicBytes(buffer, file.type)) {
        throw new Error(`檔案內容與宣告的類型 (${file.type}) 不符`);
      }

      await fs.writeFile(filePath, buffer);

      // Save to database. (`messageId` column dropped in H4 broker-strip —
      // DCM stores the resulting /api/media/<id> URL directly in mediaUrl.)
      void messageId;
      const mediaFile = await prisma.mediaFile.create({
        data: {
          workspaceId,
          filePath: relativePath,
          originalName: file.name,
          mimeType: file.type,
          size: file.size,
        }
      });

      return {
        id: mediaFile.id,
        url: `/api/media/${mediaFile.id}`,
        filePath: relativePath,
        originalName: file.name,
        mimeType: file.type,
        size: file.size
      };
    } catch (error) {
      // Clean up file if database save failed
      try {
        await fs.unlink(filePath);
      } catch {}
      
      throw error;
    }
  }

  /**
   * Retrieve file by ID
   */
  static async getFile(fileId: string): Promise<{
    buffer: Buffer;
    record: MediaFileRecord
  } | null> {
    const record = await prisma.mediaFile.findUnique({
      where: { id: fileId }
    });

    if (!record) {
      return null;
    }

    // 歷史包袱：兩個 MediaFileManager 對 filePath 的存法不一致
    //   - file-manager.server.ts (本檔，前端 upload API): 只存 `<wsId>/<file>`
    //   - file-manager.ts (bridge worker 用): 存 `<UPLOAD_DIR>/<wsId>/<file>`
    // 過去 getFile 只試 `path.resolve(UPLOAD_DIR, filePath)`，碰到 bridge 寫入的
    // 紀錄會疊成 `<UPLOAD_DIR>/<UPLOAD_DIR>/<wsId>/<file>` → ENOENT → 圖片載入失敗。
    // 兩種候選都試，任何一條落在 UPLOAD_DIR 底下且能讀到，就回那個。
    const uploadRoot = path.resolve(this.UPLOAD_DIR);
    const candidates = [
      path.resolve(this.UPLOAD_DIR, record.filePath),
      path.resolve(record.filePath),
    ];

    for (const fullPath of candidates) {
      if (!fullPath.startsWith(uploadRoot)) continue; // path traversal guard
      try {
        const buffer = await fs.readFile(fullPath);
        return { buffer, record };
      } catch {
        // try next candidate
      }
    }

    log.error('failed to read file (all candidates exhausted)', {
      fileId,
      filePath: record.filePath,
      candidates,
    });
    return null;
  }

  /**
   * Delete file
   */
  static async deleteFile(fileId: string): Promise<boolean> {
    const record = await prisma.mediaFile.findUnique({
      where: { id: fileId }
    });

    if (!record) {
      return false;
    }

    // C1 fix: path traversal prevention
    const fullPath = path.resolve(this.UPLOAD_DIR, record.filePath);
    if (!fullPath.startsWith(path.resolve(this.UPLOAD_DIR))) {
      log.error('path traversal attempt detected on delete', { filePath: record.filePath });
      return false;
    }

    try {
      // Delete physical file first, then DB (M7 fix: correct order)
      await fs.unlink(fullPath).catch(() => {});

      // Delete from database
      await prisma.mediaFile.delete({
        where: { id: fileId }
      });

      return true;
    } catch (error) {
      log.error('failed to delete file', { error: String(error) });
      return false;
    }
  }

  /**
   * Clean up orphaned files (files without database records)
   */
  static async cleanupOrphanedFiles(workspaceId: string): Promise<number> {
    const workspaceDir = path.join(this.UPLOAD_DIR, workspaceId);

    try {
      const files = await fs.readdir(workspaceDir);
      if (files.length === 0) return 0;

      // Batch lookup — one query for all files in the directory instead of
      // one per file (the previous implementation was N+1).
      const candidatePaths = files.map((f) => path.join(workspaceId, f));
      const known = await prisma.mediaFile.findMany({
        where: { filePath: { in: candidatePaths } },
        select: { filePath: true },
      });
      const knownSet = new Set(known.map((r) => r.filePath));

      let cleanedCount = 0;
      for (const file of files) {
        const relativePath = path.join(workspaceId, file);
        if (knownSet.has(relativePath)) continue;
        try {
          await fs.unlink(path.join(workspaceDir, file));
          cleanedCount++;
        } catch (error) {
          log.error('failed to delete orphaned file', { file, error: String(error) });
        }
      }

      return cleanedCount;
    } catch (error) {
      log.error('failed to cleanup orphaned files', { error: String(error) });
      return 0;
    }
  }

  /**
   * Get workspace file statistics
   */
  static async getWorkspaceStats(workspaceId: string): Promise<{
    totalFiles: number;
    totalSize: number;
    byType: Record<string, { count: number; size: number }>;
  }> {
    const files = await prisma.mediaFile.findMany({
      where: { workspaceId },
      select: {
        mimeType: true,
        size: true
      }
    });

    const stats = {
      totalFiles: files.length,
      totalSize: files.reduce((sum, file) => sum + file.size, 0),
      byType: {} as Record<string, { count: number; size: number }>
    };

    files.forEach(file => {
      if (!stats.byType[file.mimeType]) {
        stats.byType[file.mimeType] = { count: 0, size: 0 };
      }
      stats.byType[file.mimeType].count++;
      stats.byType[file.mimeType].size += file.size;
    });

    return stats;
  }

  // createThumbnail removed — the previous implementation returned tiny
  // hard-coded base64 placeholders that pretended to succeed. If real
  // thumbnails are needed, add `sharp` and reintroduce a working version.
}