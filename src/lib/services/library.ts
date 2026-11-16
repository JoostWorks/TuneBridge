import type { PrismaClient, Provider } from "@prisma/client";
import { getDb, getTokens } from "../db";
import { acquire, blockUntil, ensureBucket } from "../rate-limit";
import { canonicalize } from "../match/normalize";
import { getProvider } from "../../providers/registry";
import { RateLimitedError, type AdapterContext, type MusicProvider, type RemoteTrack } from "../../providers/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export interface AccountClient { adapter: MusicProvider; ctx: AdapterContext; accountId: string; provider: Provider; db: PrismaClient }

/** Resolves a fresh token (refreshing under lock if needed) and returns a ready-to-use adapter context. */
export async function clientFor(accountId: string, db = getDb()): Promise<AccountClient> {
  const acct = await db.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
  const { accessToken, storefront } = await getTokens().getAccessToken(accountId);
  return { adapter: getProvider(acct.provider), ctx: { accessToken, storefront, providerUserId: acct.providerUserId }, accountId, provider: acct.provider, db };
}

/**
 * Runs one provider call under the shared rate limiter. A 429 blocks the bucket for ALL workers and
 * is retried here if the wait is short, otherwise bubbled up so the job can be parked/retried.
 */
export async function guarded<T>(c: AccountClient, fn: () => Promise<T>, tries = 4): Promise<T> {
  const key = `${c.provider}:app`;
  await ensureBucket(c.db, key);
  for (let i = 0; ; i++) {
    if (!(await acquire(c.db, key))) throw new RateLimitedError(c.provider, new Date(Date.now() + 60_000));
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RateLimitedError) {
        await blockUntil(c.db, key, e.retryAt);
        const wait = e.retryAt.getTime() - Date.now();
        if (i + 1 < tries && wait <= 60_000) { await sleep(Math.max(wait, 0) + 250); continue; }
      }
      throw e;
    }
  }
}

export async function fetchAllTracks(c: AccountClient, providerPlaylistId: string): Promise<RemoteTrack[]> {
  const out: RemoteTrack[] = [];
  let cursor: string | undefined;
  do {
    const page = providerPlaylistId === "liked" && c.adapter.getLikedTracks
      ? await guarded(c, () => c.adapter.getLikedTracks!(c.ctx, cursor))
      : await guarded(c, () => c.adapter.getPlaylistTracks(c.ctx, providerPlaylistId, cursor));
    out.push(...page.items);
    cursor = page.next;
  } while (cursor && out.length < 100_000);
  return out;
}

/** Lists remote playlists (+ liked songs) and upserts them. */
export async function syncAccountPlaylists(accountId: string, db = getDb()) {
  const c = await clientFor(accountId, db);
  const acct = await db.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
  let cursor: string | undefined;
  let n = 0;
  do {
    const page = await guarded(c, () => c.adapter.listPlaylists(c.ctx, cursor));
    for (const p of page.items) {
      const data = {
        name: p.name, description: p.description ?? null, imageUrl: p.imageUrl ?? null, isPublic: p.isPublic ?? false,
        isCollaborative: p.isCollaborative ?? false, ownedByUser: p.ownedByUser, trackCount: p.trackCount, remoteVersion: p.version ?? null,
      };
      await db.playlist.upsert({
        where: { connectedAccountId_providerPlaylistId: { connectedAccountId: accountId, providerPlaylistId: p.providerPlaylistId } },
        create: { userId: acct.userId, connectedAccountId: accountId, provider: acct.provider, providerPlaylistId: p.providerPlaylistId, ...data },
        update: data,
      });
      n++;
    }
    cursor = page.next;
  } while (cursor);

  if (c.adapter.capabilities.supportsLikedSongs) {
    const existing = await db.playlist.findFirst({ where: { connectedAccountId: accountId, kind: "LIKED_SONGS" } });
    if (!existing)
      await db.playlist.create({ data: { userId: acct.userId, connectedAccountId: accountId, provider: acct.provider, providerPlaylistId: "liked", kind: "LIKED_SONGS", name: "Liked Songs", ownedByUser: true } });
  }
  return n;
}

/** Turns provider tracks into canonical Track rows (deduped by ISRC, then fingerprint) and stores the ordered list. */
export async function persistPlaylistTracks(db: PrismaClient, playlistId: string, provider: Provider | null, tracks: RemoteTrack[]) {
  const canon = tracks.map((t) => ({ t, c: canonicalize(t.title, t.artists), isrc: t.isrc && ISRC_RE.test(t.isrc) ? t.isrc : undefined }));
  const trackIdFor = await resolveTrackIds(db, canon.map((x) => ({ ...x.c, isrc: x.isrc, albumTitle: x.t.album, durationMs: x.t.durationMs, explicit: x.t.explicit })));

  await db.$transaction(
    async (tx) => {
      if (provider) {
        const maps = canon.map((x, i) => ({
          trackId: trackIdFor[i], provider, providerTrackId: x.t.providerTrackId, uri: x.t.uri ?? null,
          matchMethod: (x.isrc ? "ISRC" : "EXACT") as "ISRC" | "EXACT", confidence: 1, available: x.t.available !== false,
        }));
        for (const part of chunk(maps, 1000)) await tx.trackMapping.createMany({ data: part, skipDuplicates: true });
      }
      await tx.playlistTrack.deleteMany({ where: { playlistId } });
      const rows = canon.map((x, i) => ({ playlistId, position: i, trackId: trackIdFor[i], providerTrackId: x.t.providerTrackId || null, addedAt: x.t.addedAt ?? null }));
      for (const part of chunk(rows, 1000)) await tx.playlistTrack.createMany({ data: part });
      await tx.playlist.update({ where: { id: playlistId }, data: { trackCount: rows.length, lastFetchedAt: new Date() } });
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  return tracks.length;
}

interface TrackInput { title: string; normTitle: string; versionTags: string[]; artists: string[]; normArtists: string; fingerprint: string; isrc?: string; albumTitle?: string; durationMs?: number; explicit?: boolean }

/** Returns the canonical Track id for every input (same order), creating missing ones. */
export async function resolveTrackIds(db: PrismaClient, inputs: TrackInput[]): Promise<string[]> {
  const isrcs = [...new Set(inputs.map((i) => i.isrc).filter(Boolean) as string[])];
  const fps = [...new Set(inputs.map((i) => i.fingerprint))];
  const byIsrc = new Map<string, string>();
  const byFp = new Map<string, string>();
  for (const part of chunk(isrcs, 1000)) for (const r of await db.track.findMany({ where: { isrc: { in: part } }, select: { id: true, isrc: true }, orderBy: { createdAt: "asc" } })) if (!byIsrc.has(r.isrc!)) byIsrc.set(r.isrc!, r.id);
  for (const part of chunk(fps, 1000)) for (const r of await db.track.findMany({ where: { fingerprint: { in: part } }, select: { id: true, fingerprint: true }, orderBy: { createdAt: "asc" } })) if (!byFp.has(r.fingerprint)) byFp.set(r.fingerprint, r.id);

  const toCreate = new Map<string, TrackInput>();
  for (const i of inputs) {
    if ((i.isrc && byIsrc.has(i.isrc)) || byFp.has(i.fingerprint)) continue;
    toCreate.set(i.isrc ? `i:${i.isrc}` : `f:${i.fingerprint}`, i);
  }
  for (const part of chunk([...toCreate.values()], 500)) {
    const created = await db.track.createManyAndReturn({
      data: part.map((i) => ({ title: i.title, normTitle: i.normTitle, versionTags: i.versionTags, artists: i.artists, normArtists: i.normArtists, fingerprint: i.fingerprint, isrc: i.isrc ?? null, albumTitle: i.albumTitle ?? null, durationMs: i.durationMs ?? null, explicit: i.explicit ?? null })),
      select: { id: true, isrc: true, fingerprint: true },
    });
    for (const r of created) { if (r.isrc && !byIsrc.has(r.isrc)) byIsrc.set(r.isrc, r.id); if (!byFp.has(r.fingerprint)) byFp.set(r.fingerprint, r.id); }
  }
  return inputs.map((i) => (i.isrc && byIsrc.get(i.isrc)) || byFp.get(i.fingerprint)!);
}
