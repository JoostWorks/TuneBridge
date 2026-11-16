import { createHash } from "node:crypto";

export const stripDiacritics = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

/** Version tags that make two recordings *different* (a live cut is not the studio track). */
const STRICT: [string, RegExp][] = [
  ["remix", /\b(remix|rmx|rework|bootleg|vip mix)\b/],
  ["live", /\b(live|unplugged|in concert)\b/],
  ["acoustic", /\bacoustic\b/],
  ["instrumental", /\binstrumental\b/],
  ["demo", /\bdemo\b/],
  ["karaoke", /\bkaraoke\b/],
  ["sped", /\b(sped up|slowed|nightcore|reverb)\b/],
];
/** Cosmetic suffixes: stripped from the title but NOT treated as a different recording. */
const COSMETIC = /\b(remaster(ed)?|mono|stereo|deluxe|bonus|explicit|clean|radio edit|single version|album version|edit|version|from\b.*|original mix|feat\.?|ft\.?|with)\b/;

export function versionTags(raw: string): string[] {
  const s = stripDiacritics(raw).toLowerCase();
  return STRICT.filter(([, re]) => re.test(s)).map(([t]) => t).sort();
}

export function normalizeTitle(raw: string): string {
  let s = stripDiacritics(raw).toLowerCase();
  // (feat. X) [live] (2011 remaster) … : drop any bracket group with a version/feature word
  s = s.replace(/[(\[][^)\]]*[)\]]/g, (g) => (COSMETIC.test(g) || STRICT.some(([, re]) => re.test(g)) || /\b(19|20)\d{2}\b/.test(g) ? " " : g));
  // " - 2011 Remaster", " - Live at …", " - feat. X"
  s = s.replace(/\s+-\s+.*$/, (g) => (COSMETIC.test(g) || STRICT.some(([, re]) => re.test(g)) || /\b(19|20)\d{2}\b/.test(g) ? " " : g));
  s = s.replace(/\b(feat\.?|ft\.?|featuring)\b.*$/, " ");
  return s.replace(/&/g, " and ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function normalizeArtist(raw: string): string {
  return stripDiacritics(raw).toLowerCase().replace(/^the\s+/, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function splitArtists(raw: string): string[] {
  return raw
    .split(/\s*(?:,|;|\/|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b|\bwith\b|\band\b(?=\s+[A-Z]))\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

export function fingerprint(normTitle: string, primaryArtistNorm: string, tags: string[]): string {
  return createHash("sha1").update(`${normTitle}|${primaryArtistNorm}|${tags.join(",")}`).digest("hex");
}

export interface CanonicalFields {
  title: string;
  normTitle: string;
  versionTags: string[];
  artists: string[];
  normArtists: string;
  fingerprint: string;
}

export function canonicalize(title: string, artists: string[]): CanonicalFields {
  const tags = versionTags(title);
  const normTitle = normalizeTitle(title);
  const normA = artists.map(normalizeArtist).filter(Boolean);
  return {
    title,
    normTitle,
    versionTags: tags,
    artists,
    normArtists: [...normA].sort().join("|"),
    fingerprint: fingerprint(normTitle, normA[0] ?? "", tags),
  };
}
