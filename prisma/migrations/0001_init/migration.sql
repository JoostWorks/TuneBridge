-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('SPOTIFY', 'APPLE_MUSIC', 'YOUTUBE_MUSIC', 'TIDAL', 'DEEZER', 'AMAZON_MUSIC', 'LASTFM');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'DISABLED');

-- CreateEnum
CREATE TYPE "PlaylistKind" AS ENUM ('PLAYLIST', 'LIKED_SONGS');

-- CreateEnum
CREATE TYPE "PlaylistOrigin" AS ENUM ('REMOTE', 'IMPORTED', 'AI_GENERATED');

-- CreateEnum
CREATE TYPE "LibraryItemKind" AS ENUM ('ALBUM', 'ARTIST');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('ISRC', 'EXACT', 'FUZZY', 'MANUAL', 'CACHE');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('TRANSFER', 'SYNC_RUN', 'BACKUP', 'IMPORT', 'AI_GENERATE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_RATE_LIMIT', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TriggerSource" AS ENUM ('USER', 'SCHEDULER', 'API');

-- CreateEnum
CREATE TYPE "TrackOutcome" AS ENUM ('MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'SKIPPED_DUPLICATE', 'SKIPPED_EXISTS', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('ONE_WAY', 'TWO_WAY');

-- CreateEnum
CREATE TYPE "SyncFrequency" AS ENUM ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "AiStatus" AS ENUM ('PENDING', 'GENERATED', 'DEPLOYED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "idp" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" CITEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginState" (
    "state" TEXT NOT NULL,
    "idp" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifierEnc" TEXT NOT NULL,
    "redirectAfter" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginState_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "provider" "Provider" NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "state" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "codeVerifierEnc" TEXT,
    "redirectAfter" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "email" TEXT,
    "storefront" TEXT,
    "scopes" TEXT[] NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "accessExpiresAt" TIMESTAMP(3),
    "refreshExpiresAt" TIMESTAMP(3),
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastRefreshAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "rateLimitedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Track" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "isrc" VARCHAR(12),
    "title" TEXT NOT NULL,
    "normTitle" TEXT NOT NULL,
    "versionTags" TEXT[] NOT NULL,
    "artists" TEXT[] NOT NULL,
    "normArtists" TEXT NOT NULL,
    "albumTitle" TEXT,
    "durationMs" INTEGER,
    "explicit" BOOLEAN,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackMapping" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trackId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "providerTrackId" TEXT NOT NULL,
    "uri" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "matchMethod" "MatchMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "verifiedByUser" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchMiss" (
    "trackId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastTriedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retryAfter" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MatchMiss_pkey" PRIMARY KEY ("trackId", "provider")
);

-- CreateTable
CREATE TABLE "Playlist" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "connectedAccountId" UUID,
    "provider" "Provider",
    "providerPlaylistId" TEXT,
    "kind" "PlaylistKind" NOT NULL DEFAULT 'PLAYLIST',
    "origin" "PlaylistOrigin" NOT NULL DEFAULT 'REMOTE',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "isCollaborative" BOOLEAN NOT NULL DEFAULT false,
    "ownedByUser" BOOLEAN NOT NULL DEFAULT true,
    "trackCount" INTEGER NOT NULL DEFAULT 0,
    "remoteVersion" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistTrack" (
    "id" BIGSERIAL NOT NULL,
    "playlistId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "trackId" UUID NOT NULL,
    "providerTrackId" TEXT,
    "addedAt" TIMESTAMP(3),
    CONSTRAINT "PlaylistTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "connectedAccountId" UUID NOT NULL,
    "kind" "LibraryItemKind" NOT NULL,
    "providerItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normName" TEXT NOT NULL,
    "artistName" TEXT,
    "upc" TEXT,
    "imageUrl" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LibraryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sourcePlaylistId" UUID NOT NULL,
    "destPlaylistId" UUID NOT NULL,
    "direction" "SyncDirection" NOT NULL DEFAULT 'ONE_WAY',
    "frequency" "SyncFrequency" NOT NULL DEFAULT 'DAILY',
    "hourOfDay" INTEGER NOT NULL DEFAULT 3,
    "minuteOfHour" INTEGER NOT NULL DEFAULT 0,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "removeMissing" BOOLEAN NOT NULL DEFAULT true,
    "keepOrder" BOOLEAN NOT NULL DEFAULT true,
    "matchThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" "JobStatus",
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "pausedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncBaseline" (
    "syncJobId" UUID NOT NULL,
    "trackId" UUID NOT NULL,
    "copies" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "SyncBaseline_pkey" PRIMARY KEY ("syncJobId", "trackId")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "TriggerSource" NOT NULL DEFAULT 'USER',
    "syncJobId" UUID,
    "sourceAccountId" UUID,
    "destAccountId" UUID,
    "sourcePlaylistId" UUID,
    "destPlaylistId" UUID,
    "options" JSONB NOT NULL DEFAULT '{}',
    "scheduledFor" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "queueJobId" TEXT,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "matchedItems" INTEGER NOT NULL DEFAULT 0,
    "unmatchedItems" INTEGER NOT NULL DEFAULT 0,
    "addedItems" INTEGER NOT NULL DEFAULT 0,
    "removedItems" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "waitingUntil" TIMESTAMP(3),
    "stats" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTrackResult" (
    "id" BIGSERIAL NOT NULL,
    "jobRunId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "trackId" UUID NOT NULL,
    "outcome" "TrackOutcome" NOT NULL,
    "method" "MatchMethod",
    "confidence" DOUBLE PRECISION,
    "matchedProviderId" TEXT,
    "candidates" JSONB,
    "reason" TEXT,
    CONSTRAINT "JobTrackResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "playlistId" UUID NOT NULL,
    "title" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "nativeUrls" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiGeneration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT,
    "status" "AiStatus" NOT NULL DEFAULT 'PENDING',
    "suggestions" JSONB,
    "resultPlaylistId" UUID,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL,
    "refillPerSec" DOUBLE PRECISION NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "QuotaLedger" (
    "provider" "Provider" NOT NULL,
    "day" DATE NOT NULL,
    "unitsUsed" INTEGER NOT NULL DEFAULT 0,
    "unitLimit" INTEGER NOT NULL,
    CONSTRAINT "QuotaLedger_pkey" PRIMARY KEY ("provider", "day")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_idp_subject_key" ON "AuthIdentity"("idp", "subject");

-- CreateIndex
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

-- CreateIndex
CREATE INDEX "LoginState_expiresAt_idx" ON "LoginState"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_userId_provider_providerUserId_key" ON "ConnectedAccount"("userId", "provider", "providerUserId");

-- CreateIndex
CREATE INDEX "ConnectedAccount_provider_status_idx" ON "ConnectedAccount"("provider", "status");

-- CreateIndex
CREATE INDEX "ConnectedAccount_accessExpiresAt_idx" ON "ConnectedAccount"("accessExpiresAt");

-- CreateIndex
CREATE INDEX "Track_isrc_idx" ON "Track"("isrc");

-- CreateIndex
CREATE INDEX "Track_fingerprint_idx" ON "Track"("fingerprint");

-- CreateIndex
CREATE INDEX "track_norm_title_trgm" ON "Track" USING GIN("normTitle" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "track_norm_artists_trgm" ON "Track" USING GIN("normArtists" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "TrackMapping_provider_providerTrackId_key" ON "TrackMapping"("provider", "providerTrackId");

-- CreateIndex
CREATE INDEX "TrackMapping_trackId_provider_idx" ON "TrackMapping"("trackId", "provider");

-- CreateIndex
CREATE INDEX "MatchMiss_retryAfter_idx" ON "MatchMiss"("retryAfter");

-- CreateIndex
CREATE UNIQUE INDEX "Playlist_connectedAccountId_providerPlaylistId_key" ON "Playlist"("connectedAccountId", "providerPlaylistId");

-- CreateIndex
CREATE INDEX "Playlist_userId_provider_idx" ON "Playlist"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistTrack_playlistId_position_key" ON "PlaylistTrack"("playlistId", "position");

-- CreateIndex
CREATE INDEX "PlaylistTrack_playlistId_trackId_idx" ON "PlaylistTrack"("playlistId", "trackId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryItem_connectedAccountId_kind_providerItemId_key" ON "LibraryItem"("connectedAccountId", "kind", "providerItemId");

-- CreateIndex
CREATE INDEX "LibraryItem_userId_kind_idx" ON "LibraryItem"("userId", "kind");

-- CreateIndex
CREATE INDEX "LibraryItem_upc_idx" ON "LibraryItem"("upc");

-- CreateIndex
CREATE UNIQUE INDEX "SyncJob_sourcePlaylistId_destPlaylistId_key" ON "SyncJob"("sourcePlaylistId", "destPlaylistId");

-- CreateIndex
CREATE INDEX "SyncJob_enabled_nextRunAt_idx" ON "SyncJob"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "SyncJob_userId_idx" ON "SyncJob"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_idempotencyKey_key" ON "JobRun"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_syncJobId_scheduledFor_key" ON "JobRun"("syncJobId", "scheduledFor");

-- CreateIndex
CREATE INDEX "JobRun_userId_createdAt_idx" ON "JobRun"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "JobRun_status_waitingUntil_idx" ON "JobRun"("status", "waitingUntil");

-- CreateIndex
CREATE UNIQUE INDEX "JobTrackResult_jobRunId_position_key" ON "JobTrackResult"("jobRunId", "position");

-- CreateIndex
CREATE INDEX "JobTrackResult_jobRunId_outcome_idx" ON "JobTrackResult"("jobRunId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_slug_key" ON "ShareLink"("slug");

-- CreateIndex
CREATE INDEX "ShareLink_ownerId_idx" ON "ShareLink"("ownerId");

-- CreateIndex
CREATE INDEX "ShareLink_playlistId_idx" ON "ShareLink"("playlistId");

-- CreateIndex
CREATE INDEX "AiGeneration_userId_createdAt_idx" ON "AiGeneration"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackMapping" ADD CONSTRAINT "TrackMapping_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMiss" ADD CONSTRAINT "MatchMiss_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistTrack" ADD CONSTRAINT "PlaylistTrack_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistTrack" ADD CONSTRAINT "PlaylistTrack_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryItem" ADD CONSTRAINT "LibraryItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryItem" ADD CONSTRAINT "LibraryItem_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_sourcePlaylistId_fkey" FOREIGN KEY ("sourcePlaylistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_destPlaylistId_fkey" FOREIGN KEY ("destPlaylistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncBaseline" ADD CONSTRAINT "SyncBaseline_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "SyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncBaseline" ADD CONSTRAINT "SyncBaseline_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "SyncJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_destAccountId_fkey" FOREIGN KEY ("destAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_sourcePlaylistId_fkey" FOREIGN KEY ("sourcePlaylistId") REFERENCES "Playlist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_destPlaylistId_fkey" FOREIGN KEY ("destPlaylistId") REFERENCES "Playlist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTrackResult" ADD CONSTRAINT "JobTrackResult_jobRunId_fkey" FOREIGN KEY ("jobRunId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTrackResult" ADD CONSTRAINT "JobTrackResult_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
