# Deploying TuneBridge on Pterodactyl

Prerequisites: your panel, a node with Docker, a public HTTPS hostname (e.g. `tunebridge.jac-sys.net`) that your reverse proxy
forwards to the server's allocated port, and the image published to a registry Wings can pull from.

## 1. Publish the image (once)
1. Create a GitHub repo and push this project. The `build` workflow tests it and pushes `ghcr.io/<owner>/tunebridge:latest`.
2. GitHub → Packages → *tunebridge* → Package settings → set visibility **Public** (so Wings can pull without credentials).

## 2. Postgres
Admin → Nests → *DataBase* → **Import Egg** → the official **Postgres 17** egg from <https://eggs.pterodactyl.io> (the panel's
built-in "Databases" feature is MariaDB only). Create a server from it, then create a `tunebridge` role and database:
`CREATE ROLE tunebridge LOGIN PASSWORD '…'; CREATE DATABASE tunebridge OWNER tunebridge;`
Your connection string is `postgresql://tunebridge:<password>@<postgres-host>:<port>/tunebridge`.

## 3. Import the TuneBridge egg
Edit `deploy/pterodactyl/egg-tunebridge.json` → replace `OWNER` in the docker image → Admin → Nests → *Websites Hosting* → **Import Egg**.

## 4. Create the server
Admin → Servers → Create New: pick the nest/egg, give it ≥ **768 MiB** RAM, a port allocation, then fill the variables:
`APP_URL`, `DATABASE_URL`, `TOKEN_ENC_KEYS` (`1:` + `openssl rand -base64 32`), `GOOGLE_AUTH_*`, `ALLOWED_EMAILS`, `SPOTIFY_CLIENT_ID`.
Start it; the console shows `Ready in …` once migrations ran.

## 5. Reverse proxy
Point `https://tunebridge.jac-sys.net` at `<node-ip>:<allocated port>` (TLS at the proxy; forward `Host`/`X-Forwarded-*`).

## 6. OAuth apps
- **Google** (Cloud Console → Credentials → OAuth client, Web): redirect URI `https://tunebridge.jac-sys.net/api/auth/google/callback`.
- **Spotify** (developer dashboard): redirect URI `https://tunebridge.jac-sys.net/api/connect/spotify/callback`. Development Mode needs a
  Premium owner and allows 5 users; add yourself under *User management*.

Back up the `TOKEN_ENC_KEYS` value: without it stored tokens can't be decrypted (users would just reconnect).
