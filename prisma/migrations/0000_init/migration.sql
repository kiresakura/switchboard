-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING_AUTH', 'ACTIVE', 'DISCONNECTED', 'AUTH_ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "GroupCategory" AS ENUM ('CUSTOMER', 'INTERNAL', 'UNASSIGNED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'SNOOZED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'STICKER', 'VOICE', 'VIDEO_NOTE', 'LOCATION', 'CONTACT', 'POLL', 'DICE', 'STORY');

-- CreateEnum
CREATE TYPE "ChatDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "QuickReplyScope" AS ENUM ('PRIVATE', 'TEAM', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "ScheduleBehaviorKind" AS ENUM ('REMINDER', 'FOLLOW_UP', 'BROADCAST', 'MAINTENANCE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ScheduleRecurrence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'INTERVAL');

-- CreateEnum
CREATE TYPE "ConversationTaskStatus" AS ENUM ('LOCAL_DRAFT', 'SYNCED', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isSystemAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "uiConfig" JSONB,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystemDefault" BOOLEAN NOT NULL DEFAULT false,
    "canEditWorkspaceSettings" BOOLEAN NOT NULL DEFAULT false,
    "canManageCommunicationAccounts" BOOLEAN NOT NULL DEFAULT false,
    "canManageGroupRegistry" BOOLEAN NOT NULL DEFAULT false,
    "canManageRouting" BOOLEAN NOT NULL DEFAULT false,
    "canManageModerationRules" BOOLEAN NOT NULL DEFAULT false,
    "canManageRoles" BOOLEAN NOT NULL DEFAULT false,
    "canAssignMemberRoles" BOOLEAN NOT NULL DEFAULT false,
    "canModerateMessages" BOOLEAN NOT NULL DEFAULT false,
    "canSendManualMessages" BOOLEAN NOT NULL DEFAULT false,
    "canDirectMessage" BOOLEAN NOT NULL DEFAULT false,
    "canManagePostPermissions" BOOLEAN NOT NULL DEFAULT false,
    "canViewAllAuditLogs" BOOLEAN NOT NULL DEFAULT false,
    "canViewOwnAuditLogs" BOOLEAN NOT NULL DEFAULT false,
    "canSuperviseTeam" BOOLEAN NOT NULL DEFAULT false,
    "canDelegateAccounts" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'telegram',
    "displayName" TEXT,
    "phoneNumber" TEXT,
    "telegramUserId" TEXT,
    "telegramFirstName" TEXT,
    "telegramLastName" TEXT,
    "telegramUsername" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING_AUTH',
    "teamId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "encryptedSession" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "apiId" INTEGER NOT NULL,
    "apiHash" TEXT NOT NULL,
    "lastConnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingAuthSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "phoneCodeHash" TEXT NOT NULL,
    "apiId" INTEGER NOT NULL,
    "apiHash" TEXT NOT NULL,
    "sessionString" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT now() + interval '30 minutes',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'telegram',
    "platformGroupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "side" "GroupCategory" NOT NULL DEFAULT 'UNASSIGNED',
    "chatType" TEXT NOT NULL DEFAULT 'GROUP',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customerName" TEXT,
    "notes" TEXT,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "conversationOwnerId" TEXT,
    "conversationStatus" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "conversationAssignedAt" TIMESTAMP(3),
    "conversationClosedAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "conversationPinnedAt" TIMESTAMP(3),
    "pinnedPlatformMessageId" TEXT,
    "pinnedRefreshedAt" TIMESTAMP(3),
    "notificationsMutedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "avatarPath" TEXT,
    "avatarMimeType" TEXT,
    "avatarRefreshedAt" TIMESTAMP(3),

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TgFolder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tgFilterId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "emoticon" TEXT,
    "groupIds" TEXT[],
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TgFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountGroupMembership" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "isListeningAccount" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountGroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SenderAvatar" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "mediaPath" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "refreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderAvatar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectChatMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderId" TEXT,
    "senderPlatformId" TEXT,
    "senderDisplayName" TEXT,
    "replyToPlatformId" TEXT,
    "direction" "ChatDirection" NOT NULL DEFAULT 'OUTBOUND',
    "content" TEXT NOT NULL,
    "messageType" "MessageType" NOT NULL DEFAULT 'TEXT',
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "mediaFileName" TEXT,
    "mediaMetadata" JSONB,
    "forwardedFrom" JSONB,
    "topicId" INTEGER,
    "viewCount" INTEGER,
    "quoteText" TEXT,
    "sentViaTelegram" BOOLEAN NOT NULL DEFAULT false,
    "platformMessageId" TEXT,
    "reactions" JSONB,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "entities" JSONB,
    "groupedId" TEXT,
    "replyMarkup" JSONB,
    "embedding" vector(1536),
    "pinnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectChatMessageEditHistory" (
    "id" TEXT NOT NULL,
    "dcmId" TEXT NOT NULL,
    "previousContent" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectChatMessageEditHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "supervisorUserId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAssignment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountDelegation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "reason" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickReply" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "tgShortcutId" INTEGER,
    "tgAccountId" TEXT,
    "scope" "QuickReplyScope" NOT NULL DEFAULT 'PRIVATE',
    "shortcut" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "quickReplyId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "behaviorKind" "ScheduleBehaviorKind" NOT NULL DEFAULT 'REMINDER',
    "recurrence" "ScheduleRecurrence" NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Taipei',
    "timeOfDay" TEXT,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "dayOfMonth" INTEGER,
    "intervalEvery" INTEGER,
    "intervalUnit" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "awayMessage" TEXT,
    "awayMessageSchedule" TEXT DEFAULT 'outside_work_hours',
    "greetingMessage" TEXT,
    "greetingInactivityDays" INTEGER DEFAULT 7,
    "workHours" JSONB,
    "workHoursUtcOffset" INTEGER,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessageTranslation" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "targetLang" TEXT NOT NULL,
    "translatedText" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessageTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "status" "ConversationTaskStatus" NOT NULL DEFAULT 'LOCAL_DRAFT',
    "externalSystem" TEXT,
    "externalRef" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "details" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_token_idx" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Role_workspaceId_idx" ON "Role"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_workspaceId_name_key" ON "Role"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "UserRole_userId_idx" ON "UserRole"("userId");

-- CreateIndex
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_roleId_key" ON "UserRole"("userId", "roleId");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_workspaceId_idx" ON "WorkspaceMembership"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMembership_userId_workspaceId_key" ON "WorkspaceMembership"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAccount_telegramUserId_key" ON "CommunicationAccount"("telegramUserId");

-- CreateIndex
CREATE INDEX "CommunicationAccount_workspaceId_idx" ON "CommunicationAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "CommunicationAccount_workspaceId_status_idx" ON "CommunicationAccount"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "CommunicationAccount_teamId_idx" ON "CommunicationAccount"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAccount_workspaceId_phoneNumber_key" ON "CommunicationAccount"("workspaceId", "phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramSession_accountId_key" ON "TelegramSession"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingAuthSession_accountId_key" ON "PendingAuthSession"("accountId");

-- CreateIndex
CREATE INDEX "PendingAuthSession_expiresAt_idx" ON "PendingAuthSession"("expiresAt");

-- CreateIndex
CREATE INDEX "Group_workspaceId_idx" ON "Group"("workspaceId");

-- CreateIndex
CREATE INDEX "Group_workspaceId_isActive_idx" ON "Group"("workspaceId", "isActive");

-- CreateIndex
CREATE INDEX "Group_workspaceId_isHidden_idx" ON "Group"("workspaceId", "isHidden");

-- CreateIndex
CREATE INDEX "Group_workspaceId_chatType_conversationStatus_idx" ON "Group"("workspaceId", "chatType", "conversationStatus");

-- CreateIndex
CREATE INDEX "Group_conversationOwnerId_idx" ON "Group"("conversationOwnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Group_workspaceId_platformGroupId_key" ON "Group"("workspaceId", "platformGroupId");

-- CreateIndex
CREATE INDEX "TgFolder_workspaceId_idx" ON "TgFolder"("workspaceId");

-- CreateIndex
CREATE INDEX "TgFolder_accountId_idx" ON "TgFolder"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "TgFolder_workspaceId_accountId_tgFilterId_key" ON "TgFolder"("workspaceId", "accountId", "tgFilterId");

-- CreateIndex
CREATE INDEX "AccountGroupMembership_groupId_idx" ON "AccountGroupMembership"("groupId");

-- CreateIndex
CREATE INDEX "AccountGroupMembership_groupId_isListeningAccount_idx" ON "AccountGroupMembership"("groupId", "isListeningAccount");

-- CreateIndex
CREATE UNIQUE INDEX "AccountGroupMembership_accountId_groupId_key" ON "AccountGroupMembership"("accountId", "groupId");

-- CreateIndex
CREATE INDEX "MediaFile_workspaceId_idx" ON "MediaFile"("workspaceId");

-- CreateIndex
CREATE INDEX "SenderAvatar_refreshedAt_idx" ON "SenderAvatar"("refreshedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SenderAvatar_workspaceId_platformUserId_key" ON "SenderAvatar"("workspaceId", "platformUserId");

-- CreateIndex
CREATE INDEX "DirectChatMessage_workspaceId_groupId_createdAt_idx" ON "DirectChatMessage"("workspaceId", "groupId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DirectChatMessage_workspaceId_accountId_idx" ON "DirectChatMessage"("workspaceId", "accountId");

-- CreateIndex
CREATE INDEX "DirectChatMessage_groupId_createdAt_idx" ON "DirectChatMessage"("groupId", "createdAt");

-- CreateIndex
CREATE INDEX "DirectChatMessage_accountId_createdAt_idx" ON "DirectChatMessage"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "DirectChatMessage_senderId_idx" ON "DirectChatMessage"("senderId");

-- CreateIndex
CREATE INDEX "DirectChatMessage_groupId_platformMessageId_idx" ON "DirectChatMessage"("groupId", "platformMessageId");

-- CreateIndex
CREATE INDEX "DirectChatMessage_groupId_groupedId_idx" ON "DirectChatMessage"("groupId", "groupedId");

-- CreateIndex
CREATE INDEX "DirectChatMessage_groupId_pinnedAt_idx" ON "DirectChatMessage"("groupId", "pinnedAt");

-- CreateIndex
CREATE INDEX "DirectChatMessageEditHistory_dcmId_editedAt_idx" ON "DirectChatMessageEditHistory"("dcmId", "editedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "Team_workspaceId_idx" ON "Team"("workspaceId");

-- CreateIndex
CREATE INDEX "Team_supervisorUserId_idx" ON "Team"("supervisorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_workspaceId_name_key" ON "Team"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "TeamMembership_userId_idx" ON "TeamMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMembership_teamId_userId_key" ON "TeamMembership"("teamId", "userId");

-- CreateIndex
CREATE INDEX "AccountAssignment_userId_idx" ON "AccountAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountAssignment_accountId_userId_key" ON "AccountAssignment"("accountId", "userId");

-- CreateIndex
CREATE INDEX "AccountDelegation_toUserId_expiresAt_idx" ON "AccountDelegation"("toUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "AccountDelegation_accountId_idx" ON "AccountDelegation"("accountId");

-- CreateIndex
CREATE INDEX "AccountDelegation_fromUserId_idx" ON "AccountDelegation"("fromUserId");

-- CreateIndex
CREATE INDEX "QuickReply_workspaceId_scope_idx" ON "QuickReply"("workspaceId", "scope");

-- CreateIndex
CREATE INDEX "QuickReply_ownerUserId_idx" ON "QuickReply"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickReply_tgAccountId_shortcut_key" ON "QuickReply"("tgAccountId", "shortcut");

-- CreateIndex
CREATE INDEX "ScheduleRule_workspaceId_isActive_idx" ON "ScheduleRule"("workspaceId", "isActive");

-- CreateIndex
CREATE INDEX "ScheduleRule_workspaceId_nextRunAt_idx" ON "ScheduleRule"("workspaceId", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduleRule_createdByUserId_idx" ON "ScheduleRule"("createdByUserId");

-- CreateIndex
CREATE INDEX "ScheduleRule_quickReplyId_idx" ON "ScheduleRule"("quickReplyId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_accountId_key" ON "BusinessProfile"("accountId");

-- CreateIndex
CREATE INDEX "BusinessProfile_accountId_idx" ON "BusinessProfile"("accountId");

-- CreateIndex
CREATE INDEX "ConversationMessageTranslation_messageId_idx" ON "ConversationMessageTranslation"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMessageTranslation_messageId_targetLang_key" ON "ConversationMessageTranslation"("messageId", "targetLang");

-- CreateIndex
CREATE INDEX "ConversationTask_workspaceId_status_idx" ON "ConversationTask"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ConversationTask_conversationId_idx" ON "ConversationTask"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationTask_createdById_idx" ON "ConversationTask"("createdById");

-- CreateIndex
CREATE INDEX "WorkspaceTag_workspaceId_idx" ON "WorkspaceTag"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceTag_workspaceId_name_key" ON "WorkspaceTag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_entityType_createdAt_idx" ON "AuditLog"("workspaceId", "entityType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_userId_createdAt_idx" ON "AuditLog"("workspaceId", "userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_action_createdAt_idx" ON "AuditLog"("workspaceId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_entityType_idx" ON "AuditLog"("action", "entityType");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationAccount" ADD CONSTRAINT "CommunicationAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationAccount" ADD CONSTRAINT "CommunicationAccount_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramSession" ADD CONSTRAINT "TelegramSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommunicationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_conversationOwnerId_fkey" FOREIGN KEY ("conversationOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TgFolder" ADD CONSTRAINT "TgFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TgFolder" ADD CONSTRAINT "TgFolder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommunicationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroupMembership" ADD CONSTRAINT "AccountGroupMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommunicationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroupMembership" ADD CONSTRAINT "AccountGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaFile" ADD CONSTRAINT "MediaFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SenderAvatar" ADD CONSTRAINT "SenderAvatar_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectChatMessage" ADD CONSTRAINT "DirectChatMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectChatMessage" ADD CONSTRAINT "DirectChatMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommunicationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectChatMessage" ADD CONSTRAINT "DirectChatMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectChatMessage" ADD CONSTRAINT "DirectChatMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectChatMessageEditHistory" ADD CONSTRAINT "DirectChatMessageEditHistory_dcmId_fkey" FOREIGN KEY ("dcmId") REFERENCES "DirectChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_supervisorUserId_fkey" FOREIGN KEY ("supervisorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAssignment" ADD CONSTRAINT "AccountAssignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommunicationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAssignment" ADD CONSTRAINT "AccountAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDelegation" ADD CONSTRAINT "AccountDelegation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommunicationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDelegation" ADD CONSTRAINT "AccountDelegation_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDelegation" ADD CONSTRAINT "AccountDelegation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDelegation" ADD CONSTRAINT "AccountDelegation_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_quickReplyId_fkey" FOREIGN KEY ("quickReplyId") REFERENCES "QuickReply"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommunicationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessageTranslation" ADD CONSTRAINT "ConversationMessageTranslation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DirectChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTask" ADD CONSTRAINT "ConversationTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTask" ADD CONSTRAINT "ConversationTask_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTask" ADD CONSTRAINT "ConversationTask_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DirectChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTask" ADD CONSTRAINT "ConversationTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceTag" ADD CONSTRAINT "WorkspaceTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

