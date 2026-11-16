import type { PrismaClient } from "@prisma/client";

/** Default buckets: [capacity, refill/sec]. Conservative on purpose; tune per instance. */
const DEFAULTS: Record<string, [number, number]> = {
  "SPOTIFY:app": [10, 4],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureBucket(db: PrismaClient, key: string) {
  const [capacity, refill] = DEFAULTS[key] ?? [5, 2];
  await db.$executeRaw`INSERT INTO "RateLimitBucket" ("key","tokens","capacity","refillPerSec")
    VALUES (${key}, ${capacity}, ${capacity}, ${refill}) ON CONFLICT ("key") DO NOTHING`;
}

/** Waits (up to maxWaitMs) until `n` tokens are available. Returns false if it would wait longer. */
export async function acquire(db: PrismaClient, key: string, n = 1, maxWaitMs = 60_000): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const rows = await db.$queryRaw<{ w: number }[]>`SELECT rl_acquire(${key}, ${n}::double precision) AS w`;
    const wait = rows[0]?.w ?? 0;
    if (wait <= 0) return true;
    if (Date.now() - started + wait > maxWaitMs) return false;
    await sleep(wait + Math.floor(Math.random() * 50));
  }
}

/** Honour a provider's 429 Retry-After for every worker, not just this one. */
export async function blockUntil(db: PrismaClient, key: string, until: Date) {
  await db.$executeRaw`UPDATE "RateLimitBucket" SET "blockedUntil" = GREATEST(COALESCE("blockedUntil", now()), ${until}::timestamp) WHERE "key" = ${key}`;
}
