import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = 54330;
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
process.env.APP_URL = "https://tunebridge.example.com";
process.env.DB_POOL_MAX = "1";
process.env.TOKEN_ENC_KEYS = `1:${randomBytes(32).toString("base64")}`;
process.env.TOKEN_ENC_ACTIVE = "1";
process.env.MIGRATIONS_DIR = process.cwd() + "/prisma/migrations";

const { migrate } = await import("../src/server/migrate");
const { getDb, getVault } = await import("../src/lib/db");
const { TokenVault } = await import("../src/lib/crypto/token-vault");
const { TokenManager } = await import("../src/lib/tokens/token-manager");
const { parseTrackFile, toCsv } = await import("../src/lib/csv");
const { canonicalize } = await import("../src/lib/match/normalize");
const { resolveTrackIds, persistPlaylistTracks, guarded } = await import("../src/lib/services/library");
const { handleTransfer, runTransfer } = await import("../src/server/jobs/transfer");
const { RateLimitedError, ReauthRequiredError } = await import("../src/providers/types");
const { createSession, getSessionUser } = await import("../src/lib/auth/login");
const { mayRegister, signupPolicy } = await import("../src/lib/auth/idp");

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓", name); };

// ── infrastructure ────────────────────────────────────────────────────────
const pg = await PGlite.create({ extensions: { citext, pg_trgm } });
const server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
await server.start();

await migrate();
await migrate(); // idempotent
ok("migrations apply, and re-running is a no-op");

const db = getDb();
const vault = getVault();
const user = await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } });

// ── fake Spotify ──────────────────────────────────────────────────────────
type T = { providerTrackId: string; title: string; artists: string[]; durationMs?: number; isrc?: string; available?: boolean };
const CATALOG: T[] = [
  { providerTrackId: "sp1", title: "Digital Love", artists: ["Daft Punk"], durationMs: 301000, isrc: "GBDUW0000059" },
  { providerTrackId: "sp2", title: "Hyperballad - 2012 Remaster", artists: ["Björk"], durationMs: 321000 },
  { providerTrackId: "sp3", title: "Creep", artists: ["Radiohead"], durationMs: 238000 },
  { providerTrackId: "sp4", title: "Creep - Live", artists: ["Radiohead"], durationMs: 260000 },
  { providerTrackId: "sp5", title: "One More Time", artists: ["Daft Punk"], durationMs: 320000, isrc: "FRZ039800212" },
  { providerTrackId: "sp6", title: "Starlight (Acoustic)", artists: ["Muse"], durationMs: 240000 },
];
const calls = { search: 0, isrc: 0, create: 0, added: [] as string[][], refresh: 0 };
let searchBehaviour: (n: number) => void = () => {};
const norm = (s: string) => s.toLowerCase();
const fake: any = {
  id: "SPOTIFY",
  capabilities: { supportsIsrcLookup: true, maxWriteBatch: 2, supportsLikedSongs: true },
  async search(_: any, q: { title: string; artist: string }) {
    calls.search++; searchBehaviour(calls.search);
    return CATALOG.filter((t) => norm(t.title).includes(norm(q.title).split(" ")[0]) && (!q.artist || norm(t.artists[0]).includes(norm(q.artist).split(" ")[0])));
  },
  async findByIsrc(_: any, isrcs: string[]) { calls.isrc++; return new Map(isrcs.map((i) => [i, CATALOG.filter((t) => t.isrc === i)])); },
  async createPlaylist(_: any, p: { name: string }) { calls.create++; return { providerPlaylistId: `pl${calls.create}`, name: p.name, ownedByUser: true, trackCount: 0 }; },
  async addTracks(_: any, __: string, ids: string[]) { calls.added.push(ids); },
  async refresh() { calls.refresh++; await new Promise((r) => setTimeout(r, 50)); return { accessToken: "new-access", accessExpiresAt: new Date(Date.now() + 3600_000), refreshToken: "rotated-refresh" }; },
};

const acct = await db.connectedAccount.create({ data: { userId: user.id, provider: "SPOTIFY", providerUserId: "spuser", displayName: "Me", scopes: [] } });
const setTokens = async (access: string, refresh: string | null, exp: Date) => db.connectedAccount.update({ where: { id: acct.id }, data: { status: "ACTIVE", accessTokenEnc: vault.encrypt(access, TokenVault.aad(acct.id, "access")), refreshTokenEnc: refresh ? vault.encrypt(refresh, TokenVault.aad(acct.id, "refresh")) : null, accessExpiresAt: exp } });
await setTokens("access-1", "refresh-1", new Date(Date.now() + 3600_000));
const getClient = async () => ({ adapter: fake, ctx: { accessToken: "x" }, accountId: acct.id, provider: "SPOTIFY" as const, db });

// ── token manager ─────────────────────────────────────────────────────────
console.log("token manager");
{
  const tm = new TokenManager(db, vault, () => fake);
  assert.equal((await tm.getAccessToken(acct.id)).accessToken, "access-1");
  ok("fresh token is returned without a refresh");

  await setTokens("stale", "refresh-1", new Date(Date.now() - 1000));
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => tm.getAccessToken(acct.id)));
  assert.ok(results.every((r) => r.accessToken === "new-access"));
  assert.equal(calls.refresh, 1);
  ok("5 concurrent callers trigger exactly one refresh");

  const row = await db.connectedAccount.findUniqueOrThrow({ where: { id: acct.id } });
  assert.equal(vault.decrypt(row.refreshTokenEnc!, TokenVault.aad(acct.id, "refresh")), "rotated-refresh");
  assert.ok(!row.accessTokenEnc!.includes("new-access"));
  ok("rotated refresh token is persisted, encrypted at rest");

  await setTokens("stale", "refresh-1", new Date(Date.now() - 1000));
  const bad: any = { ...fake, refresh: async () => { throw new ReauthRequiredError("invalid_grant", "SPOTIFY"); } };
  await assert.rejects(() => new TokenManager(db, vault, () => bad).getAccessToken(acct.id), ReauthRequiredError);
  assert.equal((await db.connectedAccount.findUniqueOrThrow({ where: { id: acct.id } })).status, "NEEDS_REAUTH");
  ok("invalid_grant marks the account NEEDS_REAUTH (and the write survives the throw)");
  await setTokens("access-1", "refresh-1", new Date(Date.now() + 3600_000));
}

// ── import parsing ────────────────────────────────────────────────────────
console.log("import");
const txt = "Daft Punk - Digital Love\nBjörk - Hyperballad\nRadiohead - Creep\nNobody Real - Nonexistent Song\nDaft Punk - Digital Love\nMuse - Starlight\n# comment\nnot a track line\n";
const csv = "Track Name,Artist Name(s),ISRC,Duration (ms)\nOne More Time,Daft Punk,FRZ039800212,320000\n=cmd|' /C calc'!A0,Evil,,\n";
{
  const a = parseTrackFile(txt, "list.txt");
  assert.equal(a.tracks.length, 6); assert.equal(a.skipped, 1);
  const b = parseTrackFile(csv, "x.csv");
  assert.equal(b.tracks.length, 2); assert.equal(b.tracks[0].isrc, "FRZ039800212"); assert.equal(b.tracks[0].durationMs, 320000);
  ok("TXT (Artist - Title) and Exportify-style CSV parse correctly");
  assert.ok(toCsv([{ title: "=1+1", artists: ["a"] }]).includes("'=1+1"));
  ok("CSV export neutralises spreadsheet formula injection");
}

async function makeImported(name: string, tracks: ReturnType<typeof parseTrackFile>["tracks"]) {
  const ids = await resolveTrackIds(db, tracks.map((t) => ({ ...canonicalize(t.title, t.artists), isrc: t.isrc, durationMs: t.durationMs })));
  const pl = await db.playlist.create({ data: { userId: user.id, origin: "IMPORTED", name, trackCount: ids.length } });
  await db.playlistTrack.createMany({ data: ids.map((trackId, position) => ({ playlistId: pl.id, position, trackId })) });
  return pl;
}
const newRun = (playlistId: string, name: string) => db.jobRun.create({ data: { userId: user.id, type: "TRANSFER", sourcePlaylistId: playlistId, destAccountId: acct.id, options: { name } } });

const all = [...parseTrackFile(txt, "list.txt").tracks, ...parseTrackFile(csv, "x.csv").tracks.slice(0, 1)];
const imported = await makeImported("Test list", all);
{
  const n = await db.track.count({ where: { title: "Digital Love" } });
  assert.equal(n, 1);
  ok("duplicate source lines dedupe to one canonical Track");
}

// ── transfer ──────────────────────────────────────────────────────────────
console.log("transfer");
{
  let first = true;
  searchBehaviour = () => { if (first) { first = false; throw new RateLimitedError("SPOTIFY", new Date(Date.now() + 1200)); } };
  const run = await newRun(imported.id, "Result 1");
  const t0 = Date.now();
  await handleTransfer(run.id, { db, getClient });
  const r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.ok(Date.now() - t0 >= 1000);
  ok("a short 429 is absorbed (bucket blocked, waited, retried) without failing the job");
  searchBehaviour = () => {};

  const res = await db.jobTrackResult.findMany({ where: { jobRunId: run.id }, orderBy: { position: "asc" }, include: { track: true } });
  const by = Object.fromEntries(res.map((x) => [x.track.title + "#" + x.position, x.outcome + ":" + (x.method ?? "")]));
  assert.equal(by["Digital Love#0"], "MATCHED:EXACT");
  assert.equal(by["Hyperballad#1"], "MATCHED:EXACT"); // "- 2012 Remaster" is cosmetic
  assert.equal(by["Creep#2"], "MATCHED:EXACT");
  assert.equal(by["Nonexistent Song#3"], "UNMATCHED:");
  assert.equal(by["Digital Love#4"], "SKIPPED_DUPLICATE:");
  assert.equal(by["Starlight#5"], "UNMATCHED:"); // only an acoustic version exists
  assert.equal(by["One More Time#6"], "MATCHED:ISRC");
  ok("matching: exact, cosmetic-suffix, studio≠live, acoustic≠studio, ISRC, duplicate, not-found");

  const flat = calls.added.flat();
  assert.deepEqual(flat, ["sp1", "sp2", "sp3", "sp5"]);
  assert.ok(calls.added.every((b) => b.length <= 2));
  ok("tracks are added in source order, in provider-sized batches (2)");

  assert.equal(r.status, "PARTIAL"); assert.equal(r.matchedItems, 4); assert.equal(r.unmatchedItems, 2); assert.equal(r.addedItems, 4);
  const miss = await db.matchMiss.count();
  assert.equal(miss, 2);
  ok("job ends PARTIAL with correct counters; unmatched tracks enter the negative cache");

  const chosen = await db.trackMapping.findFirst({ where: { providerTrackId: "sp3" } });
  assert.ok(chosen); assert.equal(await db.trackMapping.count({ where: { providerTrackId: "sp4" } }), 0);
  ok("match results are cached as TrackMapping (and the live version was never chosen)");
}

console.log("cache reuse");
{
  const before = { search: calls.search, isrc: calls.isrc };
  const run = await newRun(imported.id, "Result 2");
  await handleTransfer(run.id, { db, getClient });
  assert.equal(calls.search, before.search); assert.equal(calls.isrc, before.isrc);
  const r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(r.matchedItems, 4);
  ok("second transfer of the same list makes ZERO provider search calls (cache + negative cache)");
}

console.log("resume after long rate limit");
{
  const pl = await makeImported("Resume list", ["Muse - Showbiz", "Dido - Thank You", "Foo - Bar", "Baz - Qux", "Oasis - Wonderwall", "Pulp - Common People"].flatMap((l) => parseTrackFile(l, "a.txt").tracks));
  const run = await newRun(pl.id, "Result 3");
  const seen: number[] = [];
  searchBehaviour = (n) => { seen.push(n); if (seen.length === 3) throw new RateLimitedError("SPOTIFY", new Date(Date.now() + 120_000)); };
  await assert.rejects(() => handleTransfer(run.id, { db, getClient }), RateLimitedError);
  let r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(r.status, "WAITING_RATE_LIMIT");
  assert.ok(r.waitingUntil && r.waitingUntil.getTime() > Date.now() + 100_000);
  const doneBefore = await db.jobTrackResult.count({ where: { jobRunId: run.id } });
  assert.equal(doneBefore, 2);
  ok("a long 429 parks the job as WAITING_RATE_LIMIT and rethrows for queue retry; finished work is saved");

  await db.$executeRaw`UPDATE "RateLimitBucket" SET "blockedUntil" = NULL`;
  const createdBefore = calls.create; const searchesBefore = calls.search;
  searchBehaviour = () => {};
  await handleTransfer(run.id, { db, getClient });
  r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(calls.create, createdBefore); // dest playlist not re-created
  assert.equal(calls.search - searchesBefore, 4); // only the 4 remaining tracks searched
  assert.equal(await db.jobTrackResult.count({ where: { jobRunId: run.id } }), 6);
  assert.ok(["PARTIAL", "SUCCEEDED"].includes(r.status));
  ok("retry resumes: same destination playlist, only unprocessed tracks are searched");
}

// ── persist remote playlist ───────────────────────────────────────────────
console.log("library");
{
  const pl = await db.playlist.create({ data: { userId: user.id, connectedAccountId: acct.id, provider: "SPOTIFY", providerPlaylistId: "remote1", name: "Remote" } });
  const rt = CATALOG.slice(0, 4).map((t) => ({ ...t }));
  await persistPlaylistTracks(db, pl.id, "SPOTIFY", rt);
  await persistPlaylistTracks(db, pl.id, "SPOTIFY", [...rt].reverse()); // re-fetch replaces, keeps order
  const pts = await db.playlistTrack.findMany({ where: { playlistId: pl.id }, orderBy: { position: "asc" } });
  assert.deepEqual(pts.map((p) => p.providerTrackId), ["sp4", "sp3", "sp2", "sp1"]);
  ok("persisting a fetched playlist is idempotent and order-preserving");
  await assert.rejects(() => pg.query(`UPDATE "Track" SET isrc = 'bad' WHERE id = '${pts[0].trackId}'`), /track_isrc_format/);
  ok("DB CHECK constraints are active (invalid ISRC rejected)");
}

// ── sessions & policy ─────────────────────────────────────────────────────
console.log("auth");
{
  const s = await createSession(db, user.id);
  assert.equal((await getSessionUser(db, s.token))?.id, user.id);
  assert.equal(await getSessionUser(db, "garbage"), null);
  const row = await db.session.findFirstOrThrow();
  assert.notEqual(row.tokenHash, s.token);
  ok("sessions: raw token only in cookie, only its hash in the DB");
  const pol = { mode: "allowlist" as const, emails: new Set(["a@x.com"]), domains: new Set(["corp.io"]) };
  assert.ok(mayRegister(pol, "A@x.com") && mayRegister(pol, "bob@corp.io") && !mayRegister(pol, "evil@gmail.com"));
  assert.ok(!mayRegister({ ...pol, mode: "closed" }, "a@x.com") && mayRegister({ ...pol, mode: "open" }, "z@z.z"));
  process.env.AUTH_SIGNUP = "nonsense"; assert.throws(() => signupPolicy()); delete process.env.AUTH_SIGNUP;
  ok("signup policy: allowlist / domain / open / closed, and invalid config fails loudly");
}

// ── OIDC login against a mock issuer ──────────────────────────────────────
console.log("oidc login");
{
  const http = await import("node:http");
  const jose = await import("jose");
  const { beginLogin, completeLogin, LoginDenied } = await import("../src/lib/auth/login");
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  let nextClaims: Record<string, unknown> = {};
  let lastTokenBody = "";
  const srv = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/.well-known/openid-configuration") return send({ issuer: base, authorization_endpoint: base + "/authorize", token_endpoint: base + "/token", jwks_uri: base + "/jwks", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"] });
    if (req.url === "/jwks") return send({ keys: [jwk] });
    if (req.url === "/token") {
      let body = ""; for await (const c of req) body += c; lastTokenBody = body;
      const nonce = (nextClaims as any).nonce;
      const idt = await new jose.SignJWT({ ...nextClaims, nonce }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(base).setAudience("cid").setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return send({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idt });
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  process.env.OIDC_ALLOW_INSECURE = "true";
  process.env.ALLOWED_EMAILS = "newfriend@example.com";
  const idp = { id: "oidc" as const, label: "Mock", issuer: `http://127.0.0.1:${(srv.address() as any).port}`, clientId: "cid", clientSecret: "sec", scope: "openid email profile" };

  async function login(claims: Record<string, unknown>, mutateState?: (s: string) => string) {
    const url = new URL(await beginLogin(db, vault, idp, "/accounts/1"));
    const state = url.searchParams.get("state")!;
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const row = await db.loginState.findUniqueOrThrow({ where: { state } });
    nextClaims = { ...claims, nonce: row.nonce };
    const cb = new URL(`https://tunebridge.example.com/api/auth/oidc/callback?code=abc&state=${mutateState ? mutateState(state) : state}`);
    return { state, result: await completeLogin(db, vault, idp, cb) };
  }

  const a = await login({ sub: "g-1", email: "NewFriend@example.com", email_verified: true, name: "New Friend" });
  assert.equal(a.result.redirectAfter, "/accounts/1");
  assert.ok(lastTokenBody.includes("code_verifier="));
  const u1 = await db.user.findUniqueOrThrow({ where: { email: "newfriend@example.com" } });
  assert.equal(u1.role, "USER");
  ok("allow-listed Google-style login creates the user; PKCE verifier is sent; redirect target preserved");

  const b = await login({ sub: "g-1", email: "changed-later@example.com", email_verified: true });
  assert.equal((await getSessionUser(db, b.result.token))?.id, u1.id);
  ok("returning identity is matched by `sub`, not email");

  await assert.rejects(() => login({ sub: "g-2", email: "stranger@gmail.com", email_verified: true }), (e: any) => e instanceof LoginDenied && e.reason === "not_allowed");
  ok("a Google account that is NOT on the allow-list is rejected");

  await assert.rejects(() => login({ sub: "g-3", email: "newfriend2@example.com", email_verified: false }), (e: any) => e.reason === "email_unverified");
  ok("unverified email is rejected");

  const c = await login({ sub: "g-4", email: "me@example.com", email_verified: true });
  assert.equal((await getSessionUser(db, c.result.token))?.id, user.id);
  assert.equal(await db.authIdentity.count({ where: { userId: user.id } }), 1);
  ok("verified email of an existing user links the new identity to that user");

  const d = await beginLogin(db, vault, idp);
  const st = new URL(d).searchParams.get("state")!;
  nextClaims = { sub: "g-5", email: "me@example.com", email_verified: true, nonce: "wrong" };
  await assert.rejects(() => completeLogin(db, vault, idp, new URL(`https://tunebridge.example.com/api/auth/oidc/callback?code=abc&state=${st}`)));
  await assert.rejects(() => completeLogin(db, vault, idp, new URL(`https://tunebridge.example.com/api/auth/oidc/callback?code=abc&state=${st}`)), (e: any) => e.reason === "bad_state");
  ok("wrong nonce fails, and a replayed/consumed state is rejected");

  const open = await beginLogin(db, vault, idp, "//evil.example.com");
  assert.equal((await db.loginState.findUniqueOrThrow({ where: { state: new URL(open).searchParams.get("state")! } })).redirectAfter, "/");
  ok("open-redirect via `next` is neutralised");
  srv.close();
}

// ── built-in admin login ──────────────────────────────────────────────────
console.log("local admin login");
{
  const { localAdmin, verifyLocal, throttled, recordFailure } = await import("../src/lib/auth/local");
  assert.equal(localAdmin({ ADMIN_EMAIL: "a@b.c", ADMIN_PASSWORD: "short" } as any), null);
  assert.equal(localAdmin({ ADMIN_EMAIL: "a@b.c" } as any), null);
  const env = { ADMIN_EMAIL: "Me@Example.com", ADMIN_PASSWORD: "correct horse battery" } as any;
  assert.ok(verifyLocal("me@example.com", "correct horse battery", env));
  assert.ok(!verifyLocal("me@example.com", "wrong password here", env));
  assert.ok(!verifyLocal("other@example.com", "correct horse battery", env));
  ok("admin login needs both vars (12+ char password) and checks email+password");
  for (let i = 0; i < 8; i++) recordFailure("9.9.9.9");
  assert.ok(throttled("9.9.9.9") && !throttled("1.1.1.1"));
  ok("repeated failures from one IP are throttled");
}

console.log(`\n${passed} checks passed`);
await db.$disconnect(); await server.stop(); await pg.close();
process.exit(0);
