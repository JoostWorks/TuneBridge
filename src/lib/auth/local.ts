import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Optional built-in admin login for self-hosters who haven't set up an identity provider yet
 * (or want a break-glass account). Enabled only when BOTH env vars are set and the password is >= 12 chars.
 * The credentials live in env, never in the database.
 */
const h = (s: string) => createHash("sha256").update(s).digest();
const eq = (a: string, b: string) => timingSafeEqual(h(a), h(b));

export function localAdmin(env: NodeJS.ProcessEnv = process.env) {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  return email && password && password.length >= 12 ? { email, password } : null;
}
export const localLoginEnabled = () => localAdmin() !== null;

export function verifyLocal(email: string, password: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const a = localAdmin(env);
  if (!a) return false;
  // Evaluate both so timing doesn't reveal which half was wrong.
  const e = eq(email.trim().toLowerCase(), a.email);
  const p = eq(password, a.password);
  return e && p;
}

// Tiny in-process throttle: 8 failures per IP per 10 minutes (the Cloudflare tunnel adds X-Forwarded-For).
const fails = new Map<string, number[]>();
export function throttled(ip: string, now = Date.now()): boolean {
  const recent = (fails.get(ip) ?? []).filter((t) => now - t < 600_000);
  fails.set(ip, recent);
  return recent.length >= 8;
}
export const recordFailure = (ip: string, now = Date.now()) => fails.set(ip, [...(fails.get(ip) ?? []), now]);
