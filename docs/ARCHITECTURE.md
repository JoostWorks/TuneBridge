# TuneBridge — Architecture (Sections 1 & 2)

Self-hostable replacement for TuneMyMusic / Soundiiz. Runs on Docker Compose, Pterodactyl, or Nomad from one image.

## 1. System architecture

### 1.1 The decision that shapes everything: self-hosted ⇒ bring-your-own API keys

A hosted SaaS has one Spotify app shared by thousands of users, so it fights rate limits, quota extensions and bans.
A self-hosted instance inverts that: **the operator registers their own developer app per provider** (stored in
`ProviderCredential` or env), and the instance only serves its owner / friends. Each instance gets its own quota pool,
so "don't get our keys banned" becomes "be polite to your own quota". The rate limiter, quota ledger and queue
are still built properly (Sections 3–4) because several providers have tiny quotas even for one person.

### 1.2 Stack

| Concern | Choice | Why |
|---|---|---|
| Frontend + API | **Next.js (App Router, `output: "standalone"`) + TypeScript** | One deployable, SSR for share pages (`/s/<slug>` needs OG tags), small image |
| Worker | **Same codebase, separate entrypoint** (`worker.js`, bundled with tsup) | Shares adapters, matcher, Prisma client; scales independently |
| DB | **PostgreSQL 16/17** + `pg_trgm` + `citext` | Relational integrity, trigram fuzzy search for the matcher |
| ORM | **Prisma 6** | Typed schema; raw SQL only where needed (`rl_acquire`, partial indexes) |
| Queue + scheduler | **pg-boss** (queue in Postgres) | **No Redis**: one stateful dependency, which matters on Pterodactyl and for Nomad ops |
| Rate limiting | Token buckets in Postgres (`rl_acquire()`), quota ledger table | Same reason; atomic, shared across replicas |
| Auth | Local email+password (argon2id) with optional OIDC; DB sessions | Self-hosters often want SSO via Authelia/Authentik |
| AI | Anthropic API behind a `PlaylistSuggester` interface | Swappable for Ollama so it stays free to self-host |

**Why not BullMQ/Redis?** It is the right tool at SaaS scale. For one instance, pg-boss gives retries, delays,
singleton keys, cron and `SKIP LOCKED` fan-out with zero extra infrastructure. All queue access goes through a small
`QueuePort` interface, so swapping in BullMQ later is a contained change if you outgrow it.

**Why not Python/Celery?** One language end-to-end means the provider adapters, matcher and UI types are shared.
(The unofficial `ytmusicapi` is Python; if you opt into it, run it as an optional sidecar behind the same adapter interface.)

### 1.3 Topology

```
            ┌───────────────┐  HTTPS   ┌────────────────────────────┐
 Browser ──►│ Reverse proxy │─────────►│ web  (Next.js, N replicas) │
            │ (Traefik/NPM) │          │  UI · REST/SSE · OAuth cb  │
            └───────────────┘          └──────────────┬─────────────┘
                                                      │ enqueue / read progress
                                                      ▼
                                       ┌────────────────────────────┐
                                       │ PostgreSQL                  │
                                       │  app tables · pg-boss queue │
                                       │  rate-limit buckets · quota │
                                       └──────────────▲─────────────┘
                                                      │ SKIP LOCKED fetch
                              ┌───────────────────────┴───────────────────────┐
                              │ worker (M replicas)                           │
                              │  • scheduler tick: due SyncJobs → JobRuns     │
                              │  • transfer / sync / backup / import / AI     │
                              │  • TokenManager → provider adapters ──────────┼──► Spotify, Google,
                              └───────────────────────────────────────────────┘    Apple, TIDAL, …
```

`APP_ROLE=web | worker | all`. `all` runs both in one container (Pterodactyl / small installs);
Compose and Nomad run them as separate services.

### 1.4 Deployment targets

**Docker Compose**: `docker-compose.yml` (db + web + worker). `docker compose up -d --scale worker=3`.

**Pterodactyl**: it runs a single container per server from an "egg", so use `APP_ROLE=all` and point at an
**external Postgres**. Two gotchas: Pterodactyl's built-in database hosts are **MySQL/MariaDB only**, so run Postgres as a
separate egg/VM or use a managed free tier; and OAuth needs a **public HTTPS URL** (reverse proxy in front of the
allocated port) because providers reject plain-HTTP redirect URIs. The entrypoint honours `SERVER_PORT`.
Egg essentials: Docker image = your published image, startup = default entrypoint, variables = the keys in `.env.example`.

**Nomad**: `deploy/nomad/tunebridge.nomad.hcl` — `web` group (2×, Traefik tags, health check, prestart `migrate` task) and a
`worker` group (2×, spread across nodes, 60 s `kill_timeout` so in-flight jobs are handed back cleanly). Secrets via
Nomad Variables; swap the template for Vault if you have it.

### 1.5 OAuth2 token lifecycle

**Connect flow**
1. `POST /api/oauth/:provider/start` → create `OAuthState` (random `state`, PKCE verifier encrypted, 10 min TTL) → redirect.
2. `GET /api/oauth/:provider/callback` → consume `state` (single use, bound to the session user) → `exchangeCode` →
   upsert `ConnectedAccount` with **encrypted** tokens, granted scopes, `providerUserId`.
3. Request the **minimum scopes per feature** and record them in `ConnectedAccount.scopes`. A "backup only" connection never
   gets write scopes; upgrading is an incremental re-consent, not a default.

**Use / refresh** — all token reads go through `TokenManager.getAccessToken(accountId)` (`src/lib/tokens/token-manager.ts`):
- Fresh (>2 min left) → decrypt and return. Otherwise take `pg_advisory_xact_lock(account)`, **re-check**, refresh, write back.
  The lock + re-check prevents two workers refreshing at once, which with rotating refresh tokens can kill the grant.
- If the provider returns a new refresh token it replaces the old one; otherwise the old one is kept.
- `invalid_grant`, revoked consent, or an expired Apple token ⇒ `status = NEEDS_REAUTH`, that account's `SyncJob`s are paused
  with `pausedReason`, and the UI shows a reconnect banner. The error is thrown **after** the transaction commits so the status write sticks.
- A sweeper job refreshes tokens expiring in the next 15 min so scheduled 03:00 syncs don't start with a cold refresh.

**At rest** — AES-256-GCM envelopes `v<keyVersion>.<iv>.<tag>.<ct>` (`src/lib/crypto/token-vault.ts`), keys from env, AAD =
`accountId:field` so ciphertext can't be moved between rows; key-ring rotation is supported (tested: round trip, old-key read
after rotation, AAD swap and tamper rejection). Tokens never go in logs, job payloads or the browser; queue payloads carry only `accountId`.

**Provider reality check** (verify current terms before building each adapter; these change):

| Provider | Auth | Notes that affect design |
|---|---|---|
| Spotify | Auth Code + PKCE, refresh token (may rotate; ~6-month lifetime since mid-2026) | **Feb/Mar 2026 changes** (verified against Spotify's changelog): Development Mode needs a **Premium owner and allows max 5 users**; playlist endpoints moved from `/tracks` to **`/items`** and contents are only readable for playlists **the user owns**; `POST /me/playlists` replaces `/users/{id}/playlists`; search `limit` max is **10**; track `external_ids` (ISRC) was kept. Batch ISRC lookup doesn't exist (one `q=isrc:…` search per track). Followed playlists can't be exported or transferred. |
| YouTube Music | Google OAuth2 (YouTube Data API v3) | **No official YT Music API**; playlists are YouTube playlists. Default quota is 10,000 units/day; `search.list` ≈ 100 units and `playlistItems.insert` ≈ 50, so roughly **100–200 tracks/day per project**. `QuotaLedger` exists for this. Google apps in "testing" mode have 7-day refresh tokens, so publish the consent screen or accept weekly re-auth. Unofficial `ytmusicapi` is an opt-in, ToS-risky alternative. |
| Apple Music | Developer token (JWT/ES256 from a `.p8`) + **Music-User-Token from MusicKit JS in the browser** | Needs a paid Apple Developer account. **No refresh token**; user tokens expire (~6 months) ⇒ `reauthOnExpiry`. Storefront matters for catalog lookups. |
| TIDAL | OAuth2 PKCE (developer.tidal.com) | Official API access has been limited; keep behind capability flags. |
| Deezer | OAuth2 | New developer-app registration has been restricted; treat as best-effort. |
| Amazon Music | none usable | No general public playlist-write API: ship as **file import/export only** until that changes. |

The `ProviderCapabilities` block in `src/providers/types.ts` encodes these differences (rotation, batch size, ISRC support,
quota cost), so the runner and matcher branch on capabilities, never on provider name.

## 2. Database schema

Full schema: `prisma/schema.prisma` (validated); extras Prisma can't express (CHECKs, partial indexes, `rl_acquire()`): `prisma/migrations/0002_constraints`.

### 2.1 Entity groups

```
User ─┬─ Session
      ├─ ConnectedAccount ─┬─ Playlist ── PlaylistTrack ── Track ◄── TrackMapping (per provider)
      │                    └─ LibraryItem (albums / artists)         ◄── MatchMiss  (negative cache)
      ├─ SyncJob ── SyncBaseline            (definition + last reconciled state)
      │      └───── JobRun ── JobTrackResult (execution + per-track outcomes = "Missing Tracks" report)
      ├─ ShareLink ── Playlist
      └─ AiGeneration
Instance-level: ProviderCredential, OAuthState, RateLimitBucket, QuotaLedger
```

### 2.2 Decisions worth knowing

- **`Track` + `TrackMapping` is the cross-platform memory.** A match found once (e.g. ISRC → Spotify id + YouTube id) is reused by every
  later transfer and sync with zero API calls. This cache is the biggest quota saver. `MatchMiss` adds backoff (1d → 30d) so
  unmatched tracks aren't re-searched every night. Manual user picks (`verifiedByUser`) outrank auto matches.
- **Normalised columns** (`normTitle`, `normArtists`, `versionTags`, `fingerprint`) with **trigram GIN indexes** feed the fuzzy stage
  and dedupe when ISRC is missing. `versionTags` (remix/live/acoustic/remaster) lets the matcher refuse to match a studio
  track to a live one.
- **`PlaylistTrack` uses a surrogate key + `UNIQUE(playlistId, position)`** because real playlists contain duplicates; order is a first-class column.
- **`Playlist.remoteVersion`** (Spotify `snapshot_id`, YouTube etag, …) lets a sync skip an unchanged source with one cheap call.
- **Scheduling is split into definition and execution.** `SyncJob` stores the schedule (`frequency`, `hourOfDay`, `dayOfWeek`/`dayOfMonth`,
  IANA `timezone`) and a precomputed `nextRunAt` (DST-aware, calculated in app code, indexed with a partial index). `JobRun`
  is one execution. Three guards make the scheduler safe with many replicas: `UNIQUE(syncJobId, scheduledFor)` (one run per slot),
  a partial unique index allowing only one *active* run per sync, and `idempotencyKey`.
- **`SyncBaseline`** stores the last reconciled track set so `TWO_WAY` can tell "added on A" from "deleted on B" (3-way merge) and
  `ONE_WAY` can diff without re-reading the destination.
- **`JobTrackResult` is the Missing Tracks report.** `WHERE outcome <> 'MATCHED'` becomes the CSV; `AMBIGUOUS` rows keep their top
  candidates so the UI can offer "pick the right one", which then writes a `MANUAL` mapping.
- **Rate limiting without Redis:** `RateLimitBucket` + `rl_acquire(key, n)` (atomic, row-locked token bucket that also honours
  `blockedUntil` from a 429 `Retry-After`), and `QuotaLedger` for hard daily quotas.
- **Secrets:** only `*Enc` columns, written by `TokenVault`; `ProviderCredential.clientSecretEnc` follows the same envelope format.
- **Cascades:** deleting a user removes everything they own; deleting a `ConnectedAccount` removes its playlists and sync jobs
  (disconnect = full local purge, which is what privacy-minded self-hosters expect). `Track`/`TrackMapping` are global and contain no personal data.

### 2.3 Migrations

`prisma/migrations/0001_init` + `0002_constraints` are applied at container start by a ~60-line forward-only migrator
(`src/server/migrate.ts`, Postgres advisory lock, checksum-verified), so the runtime image needs neither the Prisma CLI nor its
engines. The client uses Prisma's engine-less `engineType = "client"` with `@prisma/adapter-pg`.
`0001_init` was produced by `scripts/gen-init-sql.cjs` (Prisma's migration engine could not be downloaded in the build
sandbox). For future schema changes run `prisma migrate dev --create-only` on a normal machine, review the SQL, and commit the new folder.

## 3. Next: Section 3 (matching engine) and Section 4 (queue, scheduler, rate-limit governor)

## Addendum: Sign in with Google / OIDC

- **Models:** `AuthIdentity` (idp + OIDC `sub` → user), `LoginState` (state/nonce/PKCE before a user exists). Streaming connections stay in `ConnectedAccount`; the two are deliberately separate (different scopes, lifecycles and revocation).
- **Flow** (`src/lib/auth/login.ts`, `openid-client` v6): authorization code + PKCE + nonce; state is single-use and expires in 10 min; post-login redirect is restricted to same-site paths.
- **Account resolution order:** known `(idp, sub)` → log in; else require a **verified** email → link to an existing user with that email; else create a user if the signup policy allows. First user becomes ADMIN.
- **Signup policy** (`AUTH_SIGNUP`): `allowlist` (default; `ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS`), `open`, or `closed`. Without it, any Google account could register on your instance.
- **Sessions:** random 256-bit token in an HttpOnly, Secure, SameSite=Lax cookie; only its SHA-256 is stored.
- **Google setup:** Cloud Console → OAuth client (Web) → add redirect URI `$APP_URL/api/auth/google/callback`. You can reuse the same Google client for YouTube access; the YouTube scopes are requested separately when connecting that service.

## Phase 1 status (what exists)

Sign in with Google/OIDC, Spotify connect, playlist list, **Spotify → CSV/TXT export**, **CSV/TXT import**, and a queued
**import → Spotify transfer** with the first-generation matcher (cache → ISRC → search + scoring with version-tag penalties),
per-track results, a Missing Tracks CSV, shared rate limiter, resumable jobs, negative cache, token sweeper. Covered by
`npm test` (27 checks on an embedded Postgres, incl. a mock OIDC issuer). **Not built yet:** YouTube Music/Apple adapters,
Spotify→other-service transfers, scheduled sync, sharing links, AI generator (Phases 2–4).
