import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser, sameOrigin } from "@/lib/session";
import { forbidden, redirectTo, unauthorized } from "@/lib/http";
import { parseTrackFile } from "@/lib/csv";
import { canonicalize } from "@/lib/match/normalize";
import { resolveTrackIds } from "@/lib/services/library";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthorized();
  const form = await req.formData();
  const file = form.get("file");
  let text = String(form.get("text") ?? "");
  let filename = "";
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) return redirectTo("/import?error=file_too_large");
    text = await file.text();
    filename = file.name;
  }
  if (!text.trim()) return redirectTo("/import?error=empty");

  const order = form.get("order") === "title-artist" ? "title-artist" : "artist-title";
  const { tracks, skipped } = parseTrackFile(text, filename, { txtOrder: order });
  if (!tracks.length) return redirectTo("/import?error=no_tracks");
  if (tracks.length > 20_000) return redirectTo("/import?error=too_many");

  const name = String(form.get("name") || filename.replace(/\.[^.]+$/, "") || "Imported playlist").slice(0, 120);
  const db = getDb();
  const inputs = tracks.map((t) => ({ ...canonicalize(t.title || "Unknown", t.artists), isrc: t.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc) ? t.isrc : undefined, albumTitle: t.album, durationMs: t.durationMs }));
  const ids = await resolveTrackIds(db, inputs);
  const pl = await db.playlist.create({ data: { userId: user.id, origin: "IMPORTED", name, trackCount: ids.length, description: skipped ? `${skipped} line(s) skipped during import` : null } });
  for (let i = 0; i < ids.length; i += 1000)
    await db.playlistTrack.createMany({ data: ids.slice(i, i + 1000).map((trackId, j) => ({ playlistId: pl.id, position: i + j, trackId })) });
  return redirectTo(`/playlists/${pl.id}`);
}
