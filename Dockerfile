# syntax=docker/dockerfile:1.7
# One image, three roles: APP_ROLE=web | worker | all (default). Runs unmodified under Docker Compose,
# Nomad and Pterodactyl (arbitrary uid, read-only app dir, config purely via env).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=postgresql://build:build@localhost:5432/build APP_URL=http://localhost:3000
RUN npx prisma generate && npx next build && npx tsup

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 APP_ROLE=all NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 10001 -d /tmp app
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/dist/worker.js /app/dist/migrate.js ./
COPY --from=build /app/prisma/migrations ./prisma/migrations
COPY deploy/docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /usr/local/bin/entrypoint && chmod -R a+rX /app
USER 10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||process.env.PORT)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","-g","--","/usr/local/bin/entrypoint"]
