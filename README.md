# TuneBridge

Self-hostable, free alternative to TuneMyMusic / Soundiiz: back up playlists to CSV/TXT, import lists, and transfer them to Spotify
with a matching engine and a "missing tracks" report. Sign in with Google (or any OIDC provider).

- **Run it:** `docker compose up -d` (see `.env.example`) · Pterodactyl: `docs/DEPLOY-PTERODACTYL.md` · Nomad: `deploy/nomad/`
- **Design:** `docs/ARCHITECTURE.md` · **Tests:** `npm test` (embedded Postgres, no Docker needed)
- One image, `APP_ROLE=web|worker|all`. Only dependency: PostgreSQL (queue + rate limits live there too).
