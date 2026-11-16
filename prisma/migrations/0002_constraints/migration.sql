-- Things Prisma's schema language can't express. Apply as a second migration:
--
--   npx prisma migrate dev --name init            # generates + applies the tables
--   npx prisma migrate dev --create-only --name constraints
--   # paste this file into the generated migration.sql, then:
--   npx prisma migrate dev
--
-- (In Docker/Nomad the entrypoint runs `prisma migrate deploy`, which applies both.)

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Schedule sanity ─────────────────────────────────────────────────────────
ALTER TABLE "SyncJob"
  ADD CONSTRAINT sync_hour_range   CHECK ("hourOfDay"    BETWEEN 0 AND 23),
  ADD CONSTRAINT sync_minute_range CHECK ("minuteOfHour" BETWEEN 0 AND 59),
  ADD CONSTRAINT sync_dow_range    CHECK ("dayOfWeek" IS NULL OR "dayOfWeek" BETWEEN 0 AND 6),
  ADD CONSTRAINT sync_dom_range    CHECK ("dayOfMonth" IS NULL OR "dayOfMonth" = -1 OR "dayOfMonth" BETWEEN 1 AND 28),
  ADD CONSTRAINT sync_freq_fields  CHECK (
        ("frequency" = 'WEEKLY'  AND "dayOfWeek"  IS NOT NULL)
     OR ("frequency" = 'MONTHLY' AND "dayOfMonth" IS NOT NULL)
     OR ("frequency" IN ('HOURLY','DAILY'))
  ),
  ADD CONSTRAINT sync_distinct_ends CHECK ("sourcePlaylistId" <> "destPlaylistId"),
  ADD CONSTRAINT sync_threshold     CHECK ("matchThreshold" BETWEEN 0.5 AND 1.0);

-- ── Data quality ────────────────────────────────────────────────────────────
ALTER TABLE "Track"
  ADD CONSTRAINT track_isrc_format CHECK ("isrc" IS NULL OR "isrc" ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$');

ALTER TABLE "TrackMapping"
  ADD CONSTRAINT mapping_conf_range CHECK ("confidence" BETWEEN 0 AND 1);

ALTER TABLE "JobTrackResult"
  ADD CONSTRAINT result_conf_range CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1);

-- ── One liked-songs playlist per connected account ──────────────────────────
CREATE UNIQUE INDEX playlist_one_liked_per_account
  ON "Playlist" ("connectedAccountId") WHERE "kind" = 'LIKED_SONGS';

-- ── Ad-hoc runs have no scheduledFor; NULLs are distinct so the UNIQUE(syncJobId, scheduledFor)
--    only bites for scheduler-created runs. Prevent two *active* runs for the same sync job: ──
CREATE UNIQUE INDEX jobrun_one_active_per_sync
  ON "JobRun" ("syncJobId")
  WHERE "syncJobId" IS NOT NULL AND "status" IN ('QUEUED','RUNNING','WAITING_RATE_LIMIT');

-- ── Hot-path partial index for the scheduler tick ───────────────────────────
CREATE INDEX syncjob_due ON "SyncJob" ("nextRunAt") WHERE "enabled" = true;

-- ── Atomic token-bucket acquire (used by src/lib/rate-limit) ────────────────
-- Returns 0 when `want` tokens were granted, otherwise the milliseconds to wait.
CREATE OR REPLACE FUNCTION rl_acquire(p_key text, p_want double precision DEFAULT 1)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  b "RateLimitBucket"%ROWTYPE;
  refilled double precision;
  wait_ms integer;
BEGIN
  SELECT * INTO b FROM "RateLimitBucket" WHERE "key" = p_key FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;                       -- unknown key = unlimited

  IF b."blockedUntil" IS NOT NULL AND b."blockedUntil" > now() THEN
    RETURN CEIL(EXTRACT(EPOCH FROM (b."blockedUntil" - now())) * 1000)::int;
  END IF;

  refilled := LEAST(b."capacity",
                    b."tokens" + EXTRACT(EPOCH FROM (now() - b."updatedAt")) * b."refillPerSec");

  IF refilled >= p_want THEN
    UPDATE "RateLimitBucket" SET "tokens" = refilled - p_want, "updatedAt" = now() WHERE "key" = p_key;
    RETURN 0;
  END IF;

  wait_ms := CEIL(((p_want - refilled) / b."refillPerSec") * 1000)::int;
  UPDATE "RateLimitBucket" SET "tokens" = refilled, "updatedAt" = now() WHERE "key" = p_key;
  RETURN wait_ms;
END $$;
