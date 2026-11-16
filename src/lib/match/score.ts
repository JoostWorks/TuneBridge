import type { RemoteTrack } from "../../providers/types";
import { normalizeArtist, normalizeTitle, versionTags } from "./normalize";

export interface SourceTrack {
  title: string;
  artists: string[];
  durationMs?: number | null;
  versionTags?: string[];
}

const bigrams = (s: string) => {
  const t = s.replace(/\s/g, "");
  const out = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1);
  return out;
};
/** Sørensen–Dice on character bigrams; 1 for equal strings. */
export function dice(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

export interface Scored { track: RemoteTrack; score: number; titleSim: number; artistOk: boolean }

export function scoreCandidate(src: SourceTrack, cand: RemoteTrack): Scored {
  const sTitle = normalizeTitle(src.title);
  const cTitle = normalizeTitle(cand.title);
  const titleSim = dice(sTitle, cTitle);

  const sArt = src.artists.map(normalizeArtist).filter(Boolean);
  const cArt = cand.artists.map(normalizeArtist).filter(Boolean);
  const primaryOk = sArt.length === 0 || cArt.some((c) => dice(c, sArt[0]) >= 0.85);
  const shared = sArt.filter((a) => cArt.some((c) => dice(c, a) >= 0.85)).length;
  const artistSim = sArt.length ? shared / sArt.length : 0.5;

  let dur = 0.7; // unknown: neutral
  if (src.durationMs && cand.durationMs) {
    const d = Math.abs(src.durationMs - cand.durationMs) / 1000;
    dur = d <= 2 ? 1 : d <= 5 ? 0.8 : d <= 10 ? 0.45 : 0;
  }

  let score = 0.5 * titleSim + 0.3 * artistSim + 0.2 * dur;
  const sTags = (src.versionTags ?? versionTags(src.title)).join(",");
  const cTags = versionTags(cand.title).join(",");
  if (sTags !== cTags) score *= 0.5; // studio vs live/remix/acoustic…
  if (!primaryOk) score *= 0.6;
  if (cand.available === false) score *= 0.8;
  return { track: cand, score, titleSim, artistOk: primaryOk };
}

export const AUTO_ACCEPT = 0.88;
export const AMBIGUOUS_FLOOR = 0.65;

export function rank(src: SourceTrack, cands: RemoteTrack[]): Scored[] {
  return cands.map((c) => scoreCandidate(src, c)).sort((a, b) => b.score - a.score);
}
