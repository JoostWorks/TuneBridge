import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { notFound, unauthorized } from "@/lib/http";
export const dynamic = "force-dynamic";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const r = await getDb().jobRun.findFirst({ where: { id, userId: user.id }, include: { destPl: { select: { id: true, name: true, providerPlaylistId: true, provider: true } } } });
  if (!r) return notFound();
  return NextResponse.json({
    id: r.id, status: r.status, total: r.totalItems, processed: r.processedItems, matched: r.matchedItems, unmatched: r.unmatchedItems, added: r.addedItems,
    waitingUntil: r.waitingUntil, error: r.errorMessage, errorCode: r.errorCode,
    dest: r.destPl && { id: r.destPl.id, name: r.destPl.name, url: r.destPl.provider === "SPOTIFY" && r.destPl.providerPlaylistId ? `https://open.spotify.com/playlist/${r.destPl.providerPlaylistId}` : null },
  });
}
