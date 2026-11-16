import type { PrismaClient, Track } from "@prisma/client";
import { guarded, type AccountClient } from "../../lib/services/library";
import { AMBIGUOUS_FLOOR, rank } from "../../lib/match/score";
import { PermanentProviderError, RateLimitedError, ReauthRequiredError, type RemoteTrack } from "../../providers/types";

type Outcome = "MATCHED" | "UNMATCHED" | "AMBIGUOUS" | "SKIPPED_DUPLICATE" | "FAILED";
interface Resolution { outcome: Outcome; method?: "ISRC" | "EXACT" | "FUZZY" | "CACHE"; confidence?: number; providerId?: string; candidates?: unknown; reason?: string }

export interface TransferDeps { db: PrismaClient; getClient: (accountId: string) => Promise<AccountClient> }
export const MAX_ATTEMPTS = 6;
const MISS_BACKOFF_DAYS = [1, 3, 7, 30];

/** Resolve one canonical track to a provider track: cache → ISRC → search+score. */
export async function resolveOne(c: AccountClient, t: Track, threshold: number): Promise<Resolution> {
  const { db } = c;
  const mapping = await db.trackMapping.findFirst({
    where: { trackId: t.id, provider: c.provider, available: true },
    orderBy: [{ verifiedByUser: "desc" }, { confidence: "desc" }],
  });
  if (mapping) return { outcome: "MATCHED", method: "CACHE", confidence: mapping.confidence, providerId: mapping.providerTrackId };

  const miss = await db.matchMiss.findUnique({ where: { trackId_provider: { trackId: t.id, provider: c.provider } } });
  if (miss && miss.retryAfter > new Date()) return { outcome: "UNMATCHED", reason: "recent_miss" };

  const src = { title: t.title, artists: t.artists, durationMs: t.durationMs, versionTags: t.versionTags };

  if (t.isrc && c.adapter.capabilities.supportsIsrcLookup) {
    const found = await guarded(c, () => c.adapter.findByIsrc(c.ctx, [t.isrc!]));
    const ranked = rank(src, found.get(t.isrc) ?? []).filter((r) => r.track.available !== false);
    // ISRC identifies the recording; the title guard only protects against bad ISRC metadata.
    if (ranked[0] && ranked[0].titleSim >= 0.6) return { outcome: "MATCHED", method: "ISRC", confidence: 1, providerId: ranked[0].track.providerTrackId };
  }

  const cands: RemoteTrack[] = await guarded(c, () => c.adapter.search(c.ctx, { title: t.title.replace(/\s*[(\[].*?[)\]]/g, "").trim() || t.title, artist: t.artists[0] ?? "", album: undefined, limit: 10 }));
  const ranked = rank(src, cands);
  const best = ranked[0];
  if (best && best.score >= threshold && best.artistOk)
    return { outcome: "MATCHED", method: best.titleSim === 1 ? "EXACT" : "FUZZY", confidence: Number(best.score.toFixed(3)), providerId: best.track.providerTrackId };
  if (best && best.score >= AMBIGUOUS_FLOOR)
    return { outcome: "AMBIGUOUS", confidence: Number(best.score.toFixed(3)), reason: "below_threshold", candidates: ranked.slice(0, 3).map((r) => ({ id: r.track.providerTrackId, title: r.track.title, artists: r.track.artists, score: Number(r.score.toFixed(3)) })) };
  return { outcome: "UNMATCHED", reason: cands.length ? "no_close_candidate" : "no_results" };
}

export async function runTransfer(runId: string, { db, getClient }: TransferDeps) {
  const run = await db.jobRun.findUniqueOrThrow({ where: { id: runId } });
  if (["SUCCEEDED", "PARTIAL", "CANCELLED", "FAILED"].includes(run.status)) return;
  if (!run.sourcePlaylistId || !run.destAccountId) throw new PermanentProviderError("transfer needs a source playlist and destination account", "SPOTIFY");

  const opts = (run.options ?? {}) as { name?: string; threshold?: number; isPublic?: boolean };
  const threshold = opts.threshold ?? 0.88;
  const src = await db.playlist.findUniqueOrThrow({ where: { id: run.sourcePlaylistId }, include: { tracks: { orderBy: { position: "asc" }, include: { track: true } } } });
  const c = await getClient(run.destAccountId);
  const acct = await db.connectedAccount.findUniqueOrThrow({ where: { id: run.destAccountId } });

  await db.jobRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: run.startedAt ?? new Date(), attempts: { increment: 1 }, totalItems: src.tracks.length, waitingUntil: null, errorCode: null, errorMessage: null } });

  // Destination playlist (created once; reused when a retry resumes).
  let dest = run.destPlaylistId ? await db.playlist.findUnique({ where: { id: run.destPlaylistId } }) : null;
  if (!dest) {
    const rp = await guarded(c, () => c.adapter.createPlaylist(c.ctx, { name: opts.name || `${src.name} (TuneBridge)`, description: `Transferred with TuneBridge`, isPublic: opts.isPublic }));
    dest = await db.playlist.create({ data: { userId: run.userId, connectedAccountId: acct.id, provider: acct.provider, providerPlaylistId: rp.providerPlaylistId, name: rp.name, ownedByUser: true, isPublic: rp.isPublic ?? false } });
    await db.jobRun.update({ where: { id: runId }, data: { destPlaylistId: dest.id } });
  }

  // Resume support: skip positions that already have a result; rebuild the "already chosen" set.
  const prior = await db.jobTrackResult.findMany({ where: { jobRunId: runId }, select: { position: true, outcome: true, matchedProviderId: true } });
  const done = new Set(prior.map((r) => r.position));
  const chosen = new Set(prior.filter((r) => r.outcome === "MATCHED" && r.matchedProviderId).map((r) => r.matchedProviderId!));

  let pending: any[] = [];
  const flush = async () => {
    if (!pending.length) return;
    await db.jobTrackResult.createMany({ data: pending, skipDuplicates: true });
    pending = [];
    const grouped = await db.jobTrackResult.groupBy({ by: ["outcome"], where: { jobRunId: runId }, _count: true });
    const n = (o: string) => grouped.find((g) => g.outcome === o)?._count ?? 0;
    await db.jobRun.update({ where: { id: runId }, data: { processedItems: grouped.reduce((a, g) => a + g._count, 0), matchedItems: n("MATCHED"), unmatchedItems: n("UNMATCHED") + n("AMBIGUOUS") + n("FAILED") } });
  };

  for (const pt of src.tracks) {
    if (done.has(pt.position)) continue;
    let r: Resolution;
    try {
      r = await resolveOne(c, pt.track, threshold);
    } catch (e) {
      if (e instanceof RateLimitedError || e instanceof ReauthRequiredError) { await flush(); throw e; }
      if (e instanceof PermanentProviderError && e.status === 403) throw e; // account-level problem: fail the job
      r = { outcome: "FAILED", reason: String((e as Error).message).slice(0, 200) };
    }
    if (r.outcome === "MATCHED" && r.providerId) {
      if (chosen.has(r.providerId)) r = { outcome: "SKIPPED_DUPLICATE", providerId: r.providerId, reason: "duplicate_in_source" };
      else {
        chosen.add(r.providerId);
        if (r.method !== "CACHE")
          await db.trackMapping.createMany({ data: [{ trackId: pt.trackId, provider: c.provider, providerTrackId: r.providerId, matchMethod: r.method!, confidence: r.confidence ?? 1 }], skipDuplicates: true });
        await db.matchMiss.deleteMany({ where: { trackId: pt.trackId, provider: c.provider } });
      }
    } else if (r.outcome === "UNMATCHED" && r.reason !== "recent_miss") {
      const prev = await db.matchMiss.findUnique({ where: { trackId_provider: { trackId: pt.trackId, provider: c.provider } } });
      const attempts = (prev?.attempts ?? 0) + 1;
      const retryAfter = new Date(Date.now() + MISS_BACKOFF_DAYS[Math.min(attempts - 1, 3)] * 86_400_000);
      await db.matchMiss.upsert({ where: { trackId_provider: { trackId: pt.trackId, provider: c.provider } }, create: { trackId: pt.trackId, provider: c.provider, attempts, retryAfter }, update: { attempts, lastTriedAt: new Date(), retryAfter } });
    }
    pending.push({ jobRunId: runId, position: pt.position, trackId: pt.trackId, outcome: r.outcome, method: r.method ?? null, confidence: r.confidence ?? null, matchedProviderId: r.outcome === "MATCHED" ? r.providerId : null, candidates: r.candidates ?? undefined, reason: r.reason ?? null });
    if (pending.length >= 20) await flush();
  }
  await flush();

  // Add matched tracks in source order, in batches; `addedItems` makes this resumable.
  const matched = await db.jobTrackResult.findMany({ where: { jobRunId: runId, outcome: "MATCHED" }, orderBy: { position: "asc" }, select: { matchedProviderId: true } });
  const ids = matched.map((m) => m.matchedProviderId!).filter(Boolean);
  const batch = c.adapter.capabilities.maxWriteBatch;
  let added = (await db.jobRun.findUniqueOrThrow({ where: { id: runId } })).addedItems;
  for (; added < ids.length; added += batch) {
    const part = ids.slice(added, added + batch);
    await guarded(c, () => c.adapter.addTracks(c.ctx, dest!.providerPlaylistId!, part));
    await db.jobRun.update({ where: { id: runId }, data: { addedItems: Math.min(added + part.length, ids.length) } });
  }

  const final = await db.jobRun.findUniqueOrThrow({ where: { id: runId } });
  await db.playlist.update({ where: { id: dest.id }, data: { trackCount: ids.length } });
  await db.jobRun.update({
    where: { id: runId },
    data: { status: final.unmatchedItems > 0 ? "PARTIAL" : "SUCCEEDED", finishedAt: new Date(), addedItems: ids.length, stats: { durationMs: Date.now() - (final.startedAt?.getTime() ?? Date.now()), skippedDuplicates: src.tracks.length - ids.length - final.unmatchedItems } },
  });
}

/** Wraps runTransfer with job-state bookkeeping. Returns normally for terminal failures (no retry), throws for retryable ones. */
export async function handleTransfer(runId: string, deps: TransferDeps) {
  const { db } = deps;
  try {
    await runTransfer(runId, deps);
  } catch (e) {
    const err = e as Error;
    const run = await db.jobRun.findUnique({ where: { id: runId }, select: { attempts: true } });
    if (e instanceof ReauthRequiredError) {
      await db.jobRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), errorCode: "reauth_required", errorMessage: "The account needs to be reconnected." } });
      return;
    }
    if (e instanceof PermanentProviderError) {
      await db.jobRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), errorCode: "provider_error", errorMessage: err.message.slice(0, 500) } });
      return;
    }
    if ((run?.attempts ?? 0) >= MAX_ATTEMPTS) {
      await db.jobRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), errorCode: "retries_exhausted", errorMessage: err.message.slice(0, 500) } });
      return;
    }
    await db.jobRun.update({
      where: { id: runId },
      data: e instanceof RateLimitedError
        ? { status: "WAITING_RATE_LIMIT", waitingUntil: e.retryAt, errorCode: "rate_limited" }
        : { status: "QUEUED", errorCode: "transient", errorMessage: err.message.slice(0, 500) },
    });
    throw e; // pg-boss retries with backoff
  }
}
