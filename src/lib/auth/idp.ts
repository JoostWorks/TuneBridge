/**
 * Login identity providers, configured purely from env so operators can enable any combination.
 *
 *   Google:   GOOGLE_AUTH_CLIENT_ID / GOOGLE_AUTH_CLIENT_SECRET   (falls back to GOOGLE_CLIENT_ID/SECRET)
 *   Generic:  OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET [/ OIDC_NAME]   (Authentik, Authelia, Keycloak, …)
 *
 * Redirect URI to register at the provider:  ${APP_URL}/api/auth/<idp>/callback
 */
export interface IdpConfig {
  id: "google" | "oidc";
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

export function enabledIdps(env: NodeJS.ProcessEnv = process.env): IdpConfig[] {
  const out: IdpConfig[] = [];
  const gId = env.GOOGLE_AUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const gSecret = env.GOOGLE_AUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
  if (gId && gSecret) {
    out.push({ id: "google", label: "Google", issuer: "https://accounts.google.com", clientId: gId, clientSecret: gSecret, scope: "openid email profile" });
  }
  if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
    out.push({ id: "oidc", label: env.OIDC_NAME || "SSO", issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, scope: "openid email profile" });
  }
  return out;
}

export function redirectUri(idp: string, appUrl = process.env.APP_URL!) {
  return `${appUrl.replace(/\/$/, "")}/api/auth/${idp}/callback`;
}

/** Who may sign in. Without this, anyone with a Google account could use YOUR instance. */
export interface SignupPolicy {
  mode: "allowlist" | "open" | "closed";
  emails: Set<string>;
  domains: Set<string>;
}

export function signupPolicy(env: NodeJS.ProcessEnv = process.env): SignupPolicy {
  const list = (v?: string) => new Set((v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  const mode = (env.AUTH_SIGNUP ?? "allowlist") as SignupPolicy["mode"];
  if (!["allowlist", "open", "closed"].includes(mode)) throw new Error("AUTH_SIGNUP must be allowlist|open|closed");
  return { mode, emails: list(env.ALLOWED_EMAILS), domains: list(env.ALLOWED_EMAIL_DOMAINS) };
}

export function mayRegister(p: SignupPolicy, email: string): boolean {
  const e = email.toLowerCase();
  if (p.mode === "open") return true;
  if (p.mode === "closed") return false;
  return p.emails.has(e) || p.domains.has(e.split("@")[1] ?? "");
}
