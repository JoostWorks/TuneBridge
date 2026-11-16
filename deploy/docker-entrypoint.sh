#!/bin/sh
set -eu
cd /app

# Pterodactyl injects SERVER_PORT; Compose/Nomad use PORT.
export PORT="${SERVER_PORT:-${PORT:-3000}}"
export HOSTNAME=0.0.0.0

for v in DATABASE_URL APP_URL TOKEN_ENC_KEYS TOKEN_ENC_ACTIVE; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then echo "FATAL: $v is not set (see .env.example)" >&2; exit 64; fi
done

# The migrator takes a Postgres advisory lock, so many replicas starting together is safe.
if [ "${RUN_MIGRATIONS:-true}" = "true" ] && [ "${APP_ROLE:-all}" != "worker" ]; then
  node migrate.js
fi

case "${APP_ROLE:-all}" in
  web)    exec node server.js ;;
  worker) exec node worker.js ;;
  all)
    node worker.js & WORKER=$!
    node server.js & WEB=$!
    trap 'kill $WORKER $WEB 2>/dev/null' TERM INT
    # If either process dies, stop the container so the orchestrator restarts it.
    # (POSIX sh has no `wait -n`, so poll.)
    while kill -0 "$WORKER" 2>/dev/null && kill -0 "$WEB" 2>/dev/null; do sleep 1; done
    kill $WORKER $WEB 2>/dev/null || true
    exit 1
    ;;
  *) echo "APP_ROLE must be web|worker|all" >&2; exit 64 ;;
esac
