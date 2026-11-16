import { NextRequest, NextResponse } from "next/server";
import Papa from "papaparse";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { notFound, unauthorized } from "@/lib/http";
export const dynamic = "force-dynamic";

/** The "Missing Tracks" report: everything that did not end up in the destination playlist. */
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const db = getDb();
  if (!(await db.jobRun.findFirst({ where: { id, userId: user.id }, select: { id: true } }))) return notFound();
  const rows = await db.jobTrackResult.findMany({ where: { jobRunId: id, outcome: { in: ["UNMATCHED", "AMBIGUOUS", "FAILED"] } }, orderBy: { position: "asc" }, include: { track: true } });
  const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  const csv = Papa.unparse({
    fields: ["position", "title", "artist", "album", "isrc", "status", "reason", "best_candidate"],
    data: rows.map((r) => {
      const cand = Array.isArray(r.candidates) ? (r.candidates as any[])[0] : null;
      return [r.position + 1, safe(r.track.title), safe(r.track.artists.join(", ")), safe(r.track.albumTitle ?? ""), r.track.isrc ?? "", r.outcome, r.reason ?? "", cand ? safe(`${cand.artists?.join(", ")} - ${cand.title} (${cand.score})`) : ""];
    }),
  }, { newline: "\r\n" });
  return new NextResponse("﻿" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="missing-tracks-${id.slice(0, 8)}.csv"` } });
}
