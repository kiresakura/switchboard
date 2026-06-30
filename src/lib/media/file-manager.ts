/**
 * Media File Manager
 *
 * Handles file storage, validation, and cleanup
 *
 * Note: This module is used by the bridge worker (server-side only).
 * The API routes use file-manager.server.ts instead.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger('Media');

export interface FileUploadResult {
  fileId: string;
  filePath: string;
  url: string;
}

export interface MediaValidationOptions {
  maxSizeBytes?: number;
  allowedTypes?: string[];
  workspaceId: string;
  /**
   * Skip the MIME-type allowlist. Set for Telegram-sourced media: it arrives
   * over the trusted MTProto channel (not a browser upload), TG sends every
   * file kind imaginable (tgs/webm stickers, voice, video, arbitrary docs),
   * and the /api/media serving route already gates inline display via
   * SAFE_MIME_TYPES. Size cap + image magic-byte check still apply.
   */
  trustSource?: boolean;
}

export class MediaFileManager {
  private static readonly UPLOAD_DIR = process.env.MEDIA_UPLOAD_DIR || './uploads';
  private static readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB default
  private static readonly ALLOWED_IMAGE_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp'
  ];
  private static readonly ALLOWED_DOCUMENT_TYPES = [
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ];

  /**
   * Store a file from buffer with validation
   */
  static async storeFile(
    fileBuffer: Buffer,
    originalName: string,
    mimeType: string,
    options: MediaValidationOptions
  ): Promise<FileUploadResult> {
    // Validation
    this.validateFile(fileBuffer, mimeType, options);

    // Generate unique filename
    // Sanitize extension to prevent path traversal
    const rawExt = path.extname(path.basename(originalName));
    const fileExt = rawExt.replace(/[^a-zA-Z0-9.]/g, '');
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex').substring(0, 16);
    // Add random entropy so concurrent uploads of identical bytes at the
    // same millisecond can't collide on filesystem or clobber each other.
    const entropy = crypto.randomBytes(8).toString('hex');
    const fileName = `${Date.now()}_${entropy}_${hash}${fileExt}`;

    // Create workspace directory
    const workspaceDir = path.join(this.UPLOAD_DIR, options.workspaceId);
    await fs.mkdir(workspaceDir, { recursive: true });

    const filePath = path.join(workspaceDir, fileName);

    // Write file
    await fs.writeFile(filePath, fileBuffer);

    // Create database record
    const mediaFile = await prisma.mediaFile.create({
      data: {
        workspaceId: options.workspaceId,
        filePath,
        originalName,
        mimeType,
        size: fileBuffer.length
      }
    });

    // Thumbnails are generated on-the-fly by GET /api/media/<id>?w=<n>
    // (sharp resize) — no separate pre-generated thumbnail file.
    return {
      fileId: mediaFile.id,
      filePath,
      url: `/api/media/${mediaFile.id}`,
    };
  }

  /**
   * Download file from Telegram and store it
   */
  static async storeFromTelegram(
    downloadBuffer: Buffer,
    fileName: string,
    mimeType: string,
    workspaceId: string
  ): Promise<FileUploadResult> {
    return this.storeFile(downloadBuffer, fileName, mimeType, {
      workspaceId,
      // 50 MB — matches client-manager's MAX_MEDIA_SIZE download gate so a
      // file that already passed download isn't then rejected here on size.
      maxSizeBytes: 50 * 1024 * 1024,
      // TG sends tgs/webm stickers, voice, video, audio, arbitrary documents
      // — a browser-upload allowlist would silently drop them all. The
      // serving route still sanitizes inline display. See trustSource.
      trustSource: true,
    });
  }

  /**
   * Get file by ID with access control
   */
  static async getFile(fileId: string, workspaceId: string): Promise<Buffer | null> {
    const mediaFile = await prisma.mediaFile.findFirst({
      where: {
        id: fileId,
        workspaceId
      }
    });

    if (!mediaFile) return null;

    try {
      // Verify the file path is within the expected upload directory
      const resolvedPath = path.resolve(mediaFile.filePath);
      const expectedDir = path.resolve(path.join(this.UPLOAD_DIR, workspaceId));
      if (!resolvedPath.startsWith(expectedDir)) {
        log.error("path traversal detected on read", { resolvedPath });
        return null;
      }
      return await fs.readFile(resolvedPath);
    } catch {
      return null;
    }
  }

  /**
   * Delete file and cleanup
   */
  static async deleteFile(fileId: string, workspaceId: string): Promise<boolean> {
    const mediaFile = await prisma.mediaFile.findFirst({
      where: {
        id: fileId,
        workspaceId
      }
    });

    if (!mediaFile) return false;

    // M2 fix: path traversal check before delete
    const resolvedPath = path.resolve(mediaFile.filePath);
    const expectedDir = path.resolve(path.join(this.UPLOAD_DIR, workspaceId));
    if (!resolvedPath.startsWith(expectedDir)) {
      log.error("path traversal detected on delete", { resolvedPath });
      return false;
    }

    try {
      // Delete physical file
      await fs.unlink(resolvedPath);

      // Delete database record
      await prisma.mediaFile.delete({
        where: { id: fileId }
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleanup orphaned files
   */
  static async cleanupOrphanedFiles(workspaceId: string): Promise<number> {
    // Orphan = no DCM references the file via mediaUrl. Old code joined
    // through MediaFile.messageId → Message, but that FK was dropped in
    // H4 broker-strip. The check is now: MediaFile older than 24h whose
    // /api/media/<id> URL doesn't appear in any DCM.mediaUrl.
    const ageCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const candidates = await prisma.mediaFile.findMany({
      where: { workspaceId, uploadedAt: { lt: ageCutoff } },
    });
    const referenced = await prisma.directChatMessage.findMany({
      where: {
        workspaceId,
        mediaUrl: { in: candidates.map((f) => `/api/media/${f.id}`) },
      },
      select: { mediaUrl: true },
    });
    const referencedSet = new Set(
      referenced.map((r) => r.mediaUrl).filter((u): u is string => !!u),
    );
    const orphanedFiles = candidates.filter(
      (f) => !referencedSet.has(`/api/media/${f.id}`),
    );

    let cleaned = 0;
    for (const file of orphanedFiles) {
      if (await this.deleteFile(file.id, workspaceId)) {
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * File validation
   */
  private static validateFile(
    fileBuffer: Buffer,
    mimeType: string,
    options: MediaValidationOptions
  ): void {
    // Size check
    const maxSize = options.maxSizeBytes || this.MAX_FILE_SIZE;
    if (fileBuffer.length > maxSize) {
      throw new Error(`檔案大小超過限制 (${Math.round(maxSize / 1024 / 1024)}MB)`);
    }

    // Type check — skipped for trusted Telegram-sourced media (see
    // MediaValidationOptions.trustSource). Browser uploads still go through it.
    if (!options.trustSource) {
      const allowedTypes = options.allowedTypes || [
        ...this.ALLOWED_IMAGE_TYPES,
        ...this.ALLOWED_DOCUMENT_TYPES,
      ];
      if (!allowedTypes.includes(mimeType)) {
        throw new Error(`不支援的檔案類型: ${mimeType}`);
      }
    }

    // Magic number verification for images
    if (this.isImage(mimeType)) {
      this.validateImageMagicNumbers(fileBuffer, mimeType);
    }
  }

  /**
   * Validate image magic numbers for security
   */
  private static validateImageMagicNumbers(fileBuffer: Buffer, mimeType: string): void {
    const magicNumbers: Record<string, Buffer[]> = {
      'image/jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
      'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
      'image/gif': [Buffer.from('GIF87a'), Buffer.from('GIF89a')],
      'image/webp': [Buffer.from('WEBP')] // WEBP at offset 8
    };

    const expected = magicNumbers[mimeType];
    if (expected) {
      const isValid = expected.some(magic => {
        if (mimeType === 'image/webp') {
          return fileBuffer.slice(8, 12).equals(magic);
        }
        return fileBuffer.slice(0, magic.length).equals(magic);
      });

      if (!isValid) {
        throw new Error('檔案格式驗證失敗');
      }
    }
  }

  /**
   * Check if mime type is image
   */
  static isImage(mimeType: string): boolean {
    return this.ALLOWED_IMAGE_TYPES.includes(mimeType);
  }

  /**
   * Get human readable file size
   */
  static formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}
