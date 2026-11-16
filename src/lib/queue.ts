import { PgBoss } from "pg-boss";

export const QUEUES = {
  transfer: "transfer",
  housekeeping: "housekeeping",
  tokenSweep: "token-sweep",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const g = globalThis as unknown as { __boss?: Promise<PgBoss> };

/** One pg-boss client per process. The web tier only enqueues; the worker also subscribes. */
export function getBoss(opts: { worker?: boolean } = {}): Promise<PgBoss> {
  return (g.__boss ??= (async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      application_name: opts.worker ? "tunebridge-worker" : "tunebridge-web",
      // Only workers run maintenance & cron.
      supervise: !!opts.worker,
      schedule: !!opts.worker,
      max: Number(process.env.PGBOSS_POOL_MAX ?? (opts.worker ? 10 : 3)),
    });
    boss.on("error", (e) => console.error("[pg-boss]", e));
    await boss.start();
    for (const q of Object.values(QUEUES)) await boss.createQueue(q);
    return boss;
  })());
}

export async function enqueue(name: QueueName, data: object, options: Record<string, unknown> = {}) {
  const boss = await getBoss();
  return boss.send(name, data, { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 6 * 3600, ...options });
}
