import * as oidc from "openid-client";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { TokenVault } from "../crypto/token-vault";
import { mayRegister, redirectUri, signupPolicy, type IdpConfig } from "./idp";

const configCache = new Map<string, Promise<oidc.Configuration>>();
const discover = (idp: IdpConfig) => {
  let c = configCache.get(idp.id);
  if (!c) {
    // OIDC_ALLOW_INSECURE=true permits plain-http issuers (e.g. Authentik on a LAN, or tests). Never for Google.
    const insecure = process.env.OIDC_ALLOW_INSECURE === "true" && idp.id !== "google";
    c = oidc.discovery(new URL(idp.issuer), idp.clientId, idp.clientSecret, undefined, insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
    c.catch(() => configCache.delete(idp.id)); // don't cache a failed discovery
    configCache.set(idp.id, c);
  }
  return c;
};

export class LoginDenied extends Error {
  constructor(readonly reason: "email_unverified" | "not_allowed" | "bad_state" | "no_email") {
    super(reason);
  }
}

/** Step 1 — route `GET /api/auth/:idp/start`: returns the URL to 302 to. */
export async function beginLogin(db: PrismaClient, vault: TokenVault, idp: IdpConfig, redirectAfter?: string) {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  await db.loginState.create({
    data: {
      state, idp: idp.id, nonce,
      codeVerifierEnc: vault.encrypt(verifier, `login:${state}`),
      // Only same-site relative paths; blocks open-redirect after login.
      redirectAfter: redirectAfter?.startsWith("/") && !redirectAfter.startsWith("//") ? redirectAfter : "/",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  const cfg = await discover(idp);
  return oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri(idp.id),
    scope: idp.scope,
    state, nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    ...(idp.id === "google" ? { prompt: "select_account" } : {}),
  }).href;
}

/** Step 2 — route `GET /api/auth/:idp/callback`: validates, resolves/creates the user, returns a session. */
export async function completeLogin(
  db: PrismaClient, vault: TokenVault, idp: IdpConfig, callbackUrl: URL, meta: { userAgent?: string; ip?: string } = {},
) {
  const state = callbackUrl.searchParams.get("state") ?? "";
  // Single use: delete-and-read atomically so a replayed callback fails.
  const row = await db.loginState.delete({ where: { state } }).catch(() => null);
  if (!row || row.idp !== idp.id || row.expiresAt < new Date()) throw new LoginDenied("bad_state");

  const cfg = await discover(idp);
  const tokens = await oidc.authorizationCodeGrant(cfg, callbackUrl, {
    pkceCodeVerifier: vault.decrypt(row.codeVerifierEnc, `login:${state}`),
    expectedState: state,
    expectedNonce: row.nonce,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new LoginDenied("bad_state");

  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
  const verified = claims.email_verified === true;
  const name = typeof claims.name === "string" ? claims.name : undefined;
  const image = typeof claims.picture === "string" ? claims.picture : undefined;

  const userId = await db.$transaction(async (tx) => {
    // 1) Known identity: the (idp, sub) pair is authoritative, even if the email later changes.
    const known = await tx.authIdentity.findUnique({ where: { idp_subject: { idp: idp.id, subject: claims.sub } } });
    if (known) {
      await tx.authIdentity.update({ where: { id: known.id }, data: { lastLoginAt: new Date(), email, emailVerified: verified } });
      return known.userId;
    }

    // 2) New identity: needs a verified email, otherwise anyone could claim someone else's address.
    if (!email) throw new LoginDenied("no_email");
    if (!verified) throw new LoginDenied("email_unverified");

    // 3) Existing user with this email (e.g. created by an earlier login method) → link.
    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) {
      await tx.authIdentity.create({ data: { userId: existing.id, idp: idp.id, subject: claims.sub, email, emailVerified: true } });
      return existing.id;
    }

    // 4) Brand-new user: enforce the signup policy. The very first user always becomes ADMIN.
    const isFirst = (await tx.user.count()) === 0;
    if (!isFirst && !mayRegister(signupPolicy(), email)) throw new LoginDenied("not_allowed");
    const user = await tx.user.create({
      data: {
        email, name, image, role: isFirst ? "ADMIN" : "USER",
        identities: { create: { idp: idp.id, subject: claims.sub, email, emailVerified: true } },
      },
    });
    return user.id;
  });

  const session = await createSession(db, userId, meta);
  return { ...session, redirectAfter: row.redirectAfter ?? "/" };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Raw token goes in an HttpOnly cookie; only its hash is stored. */
export async function createSession(db: PrismaClient, userId: string, meta: { userAgent?: string; ip?: string } = {}, days = 30) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await db.session.create({ data: { userId, tokenHash: sha256(token), userAgent: meta.userAgent, ip: meta.ip, expiresAt } });
  return { token, expiresAt, cookie: { name: "tb_session", httpOnly: true, secure: (process.env.APP_URL ?? "").startsWith("https"), sameSite: "lax" as const, path: "/", expires: expiresAt } };
}

export async function getSessionUser(db: PrismaClient, token: string | undefined) {
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  return s && s.expiresAt > new Date() ? s.user : null;
}
