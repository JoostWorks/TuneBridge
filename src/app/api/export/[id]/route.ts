import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { notFound, unauthorized } from "@/lib/http";
import { toCsv, toTxt, type ExportRow } from "@/lib/csv";
import { clientFor, fetchAllTracks, persistPlaylistTracks } from "@/lib/services/library";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const slug = (s: string) => s.replace(/[^\p{L}\p{N}._ -]/gu, "").trim().replace(/\s+/g, "_").slice(0, 80) || "playlist";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const db = getDb();
  const pl = await db.playlist.findFirst({ where: { id, userId: user.id } });
  if (!pl) return notFound();
  const format = req.nextUrl.searchParams.get("format") === "txt" ? "txt" : "csv";

  // Remote playlists: always export the live list from the provider, and refresh our local copy.
  if (pl.connectedAccountId && pl.providerPlaylistId) {
    try {
      const c = await clientFor(pl.connectedAccountId);
      const tracks = await fetchAllTracks(c, pl.providerPlaylistId);
      await persistPlaylistTracks(db, pl.id, pl.provider, tracks).catch((e) => console.warn("[export] persist failed", e));
      const rows: ExportRow[] = tracks.map((t) => ({ title: t.title, artists: t.artists, album: t.album, durationMs: t.durationMs, isrc: t.isrc, providerId: t.providerTrackId, addedAt: t.addedAt }));
      return file(rows, format, pl.name);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
  }
  const pts = await db.playlistTrack.findMany({ where: { playlistId: pl.id }, orderBy: { position: "asc" }, include: { track: true } });
  return file(pts.map((p) => ({ title: p.track.title, artists: p.track.artists, album: p.track.albumTitle, durationMs: p.track.durationMs, isrc: p.track.isrc, providerId: p.providerTrackId, addedAt: p.addedAt })), format, pl.name);
}

function file(rows: ExportRow[], format: "csv" | "txt", name: string) {
  const body = format === "csv" ? "﻿" + toCsv(rows) : toTxt(rows);
  return new NextResponse(body, { headers: { "Content-Type": `${format === "csv" ? "text/csv" : "text/plain"}; charset=utf-8`, "Content-Disposition": `attachment; filename="${slug(name)}.${format}"`, "Cache-Control": "no-store" } });
}
