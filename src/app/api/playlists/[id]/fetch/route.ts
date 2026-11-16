import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser, sameOrigin } from "@/lib/session";
import { forbidden, redirectTo, unauthorized } from "@/lib/http";
import { clientFor, fetchAllTracks, persistPlaylistTracks } from "@/lib/services/library";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const db = getDb();
  const pl = await db.playlist.findFirst({ where: { id, userId: user.id } });
  if (!pl || !pl.connectedAccountId || !pl.providerPlaylistId) return redirectTo("/");
  try {
    const c = await clientFor(pl.connectedAccountId);
    await persistPlaylistTracks(db, pl.id, pl.provider, await fetchAllTracks(c, pl.providerPlaylistId));
    return redirectTo(`/playlists/${id}`);
  } catch (e) {
    console.error("[fetch tracks]", e);
    return redirectTo(`/playlists/${id}?error=${encodeURIComponent((e as Error).message.slice(0, 160))}`);
  }
}
