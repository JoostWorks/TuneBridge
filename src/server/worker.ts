import { getBoss, QUEUES } from "../lib/queue";
import { getDb, getTokens } from "../lib/db";
import { clientFor } from "../lib/services/library";
import { handleTransfer } from "./jobs/transfer";

async function main() {
  const db = getDb();
  const boss = await getBoss({ worker: true });
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);

  await boss.work<{ runId: string }>(QUEUES.transfer, { localConcurrency: concurrency }, async ([job]) => {
    console.log(`[transfer] start ${job.data.runId} (retry ${job.retryCount})`);
    await handleTransfer(job.data.runId, { db, getClient: (id) => clientFor(id, db) });
    console.log(`[transfer] done ${job.data.runId}`);
  });

  // Housekeeping: expired handshakes and sessions.
  await boss.schedule(QUEUES.housekeeping, "*/15 * * * *");
  await boss.work(QUEUES.housekeeping, async () => {
    const now = new Date();
    const [a, b, c] = await Promise.all([
      db.loginState.deleteMany({ where: { expiresAt: { lt: now } } }),
      db.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } }),
      db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);
    if (a.count + b.count + c.count) console.log(`[housekeeping] removed ${a.count} login, ${b.count} oauth states, ${c.count} sessions`);
  });

  // Proactive token refresh so scheduled work never starts with an expired token.
  await boss.schedule(QUEUES.tokenSweep, "*/10 * * * *");
  await boss.work(QUEUES.tokenSweep, async () => {
    const soon = new Date(Date.now() + 15 * 60_000);
    const accts = await db.connectedAccount.findMany({ where: { status: "ACTIVE", refreshTokenEnc: { not: null }, accessExpiresAt: { lt: soon } }, select: { id: true } });
    for (const a of accts) await getTokens().getAccessToken(a.id).catch((e) => console.warn(`[token-sweep] ${a.id}: ${e.message}`));
  });

  console.log(`[worker] ready (concurrency ${concurrency})`);

  const shutdown = async (sig: string) => {
    console.log(`[worker] ${sig}: draining`);
    await boss.stop({ graceful: true, timeout: 50_000 }).catch(() => {});
    await db.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => { console.error("[worker] fatal", e); process.exit(1); });
