import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser, sameOrigin } from "@/lib/session";
import { forbidden, redirectTo, unauthorized } from "@/lib/http";
import { enqueue, QUEUES } from "@/lib/queue";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthorized();
  const form = await req.formData();
  const playlistId = String(form.get("playlistId") ?? "");
  const destAccountId = String(form.get("destAccountId") ?? "");
  const db = getDb();
  const [pl, dest] = await Promise.all([
    db.playlist.findFirst({ where: { id: playlistId, userId: user.id } }),
    db.connectedAccount.findFirst({ where: { id: destAccountId, userId: user.id, status: "ACTIVE" } }),
  ]);
  if (!pl || !dest) return redirectTo(`/playlists/${playlistId}?error=bad_request`);
  const name = String(form.get("name") || `${pl.name}`).slice(0, 120);
  const run = await db.jobRun.create({
    data: { userId: user.id, type: "TRANSFER", trigger: "USER", sourcePlaylistId: pl.id, sourceAccountId: pl.connectedAccountId, destAccountId: dest.id, options: { name, threshold: 0.88 }, totalItems: pl.trackCount },
  });
  const qid = await enqueue(QUEUES.transfer, { runId: run.id });
  await db.jobRun.update({ where: { id: run.id }, data: { queueJobId: qid ?? undefined } });
  return redirectTo(`/jobs/${run.id}`);
}
