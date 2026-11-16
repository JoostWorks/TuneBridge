import Papa from "papaparse";
import { splitArtists } from "./match/normalize";

export interface ParsedTrack { title: string; artists: string[]; album?: string; isrc?: string; durationMs?: number }
export interface ExportRow { title: string; artists: string[]; album?: string | null; durationMs?: number | null; isrc?: string | null; providerId?: string | null; addedAt?: Date | null }

/** CSV cells starting with = + - @ are executed by spreadsheet apps (formula injection): neutralise. */
const safe = (v: unknown) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function toCsv(rows: ExportRow[]): string {
  return Papa.unparse(
    {
      fields: ["title", "artist", "album", "duration_ms", "isrc", "provider_track_id", "added_at"],
      data: rows.map((r) => [safe(r.title), safe(r.artists.join(", ")), safe(r.album ?? ""), r.durationMs ?? "", r.isrc ?? "", r.providerId ?? "", r.addedAt?.toISOString() ?? ""]),
    },
    { newline: "\r\n" },
  );
}

export function toTxt(rows: ExportRow[]): string {
  return rows.map((r) => `${r.artists.join(", ")} - ${r.title}`).join("\n") + "\n";
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const FIELD: Record<string, string[]> = {
  title: ["title", "track", "trackname", "song", "songname", "name"],
  artist: ["artist", "artists", "artistname", "artistnames", "artistnamess", "performer"],
  album: ["album", "albumname"],
  isrc: ["isrc", "trackisrc"],
  duration: ["durationms", "duration", "length", "tracklengthms"],
};

function parseDuration(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d+:\d{2}$/.test(t)) { const [m, s] = t.split(":").map(Number); return (m * 60 + s) * 1000; }
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1000 ? n * 1000 : Math.round(n); // seconds vs ms heuristic
}

export function parseTrackFile(text: string, filename = "", opts: { txtOrder?: "artist-title" | "title-artist" } = {}): { tracks: ParsedTrack[]; skipped: number } {
  const body = text.replace(/^﻿/, "");
  const looksCsv = /\.csv$/i.test(filename) || (!/\.txt$/i.test(filename) && /^[^\n]*,[^\n]*\n/.test(body) && /(title|track|song|isrc)/i.test(body.split("\n")[0]));
  const tracks: ParsedTrack[] = [];
  let skipped = 0;

  if (looksCsv) {
    const parsed = Papa.parse<Record<string, string>>(body, { header: true, skipEmptyLines: true });
    const headers = parsed.meta.fields ?? [];
    const col = (names: string[]) => headers.find((h) => names.includes(key(h)));
    const [cT, cA, cAl, cI, cD] = [col(FIELD.title), col(FIELD.artist), col(FIELD.album), col(FIELD.isrc), col(FIELD.duration)];
    for (const r of parsed.data) {
      const title = cT ? r[cT]?.trim() : "";
      const artistRaw = cA ? r[cA]?.trim() : "";
      const isrc = cI ? r[cI]?.trim().toUpperCase().replace(/-/g, "") : undefined;
      if (!title && !isrc) { skipped++; continue; }
      tracks.push({ title: title || "", artists: artistRaw ? splitArtists(artistRaw) : [], album: cAl ? r[cAl]?.trim() || undefined : undefined, isrc: isrc || undefined, durationMs: parseDuration(cD ? r[cD] : undefined) });
    }
    return { tracks, skipped };
  }

  const order = opts.txtOrder ?? "artist-title";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.includes("\t") ? line.split("\t") : line.split(/\s+[-–—]\s+/);
    if (parts.length < 2) { skipped++; continue; }
    const [first, ...rest] = parts;
    const second = rest.join(" - ").trim();
    const [artist, title] = order === "artist-title" ? [first.trim(), second] : [second, first.trim()];
    if (!artist || !title) { skipped++; continue; }
    tracks.push({ title, artists: splitArtists(artist) });
  }
  return { tracks, skipped };
}
