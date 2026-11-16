import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { enabledIdps } from "@/lib/auth/idp";
import { localLoginEnabled } from "@/lib/auth/local";
import { Logo } from "@/components/Logo";
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  not_allowed: "This account isn't allowed to sign in to this instance. Ask the owner to add your email to ALLOWED_EMAILS.",
  email_unverified: "Your identity provider hasn't verified this email address.",
  no_email: "Your identity provider didn't share an email address.",
  bad_state: "The sign-in attempt expired. Please try again.",
  cancelled: "Sign-in was cancelled.",
  unknown_provider: "That sign-in method isn't enabled.",
  bad_credentials: "Wrong email or password.",
  rate_limited: "Too many attempts. Try again in a few minutes.",
  failed: "Sign-in failed. Check the server logs.",
};

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser().catch(() => null)) redirect("/");
  const { error } = await searchParams;
  const idps = enabledIdps();
  const local = localLoginEnabled();
  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");

  return (
    <div className="login-wrap">
      <div className="login">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><Logo size={44} /></div>
        <h1>Sign in to Tune<span style={{ color: "var(--accent)" }}>Bridge</span></h1>
        <p className="sub">Move, back up and sync your music library.</p>
        {error && <div className="alert">{ERRORS[error] ?? ERRORS.failed}</div>}

        <div className="card">
          {idps.map((i) => <a key={i.id} className="btn block" href={`/api/auth/${i.id}/start`}>Continue with {i.label}</a>)}

          {idps.length > 0 && local && <div className="or">or use the admin login</div>}
          {local && (
            <form action="/api/auth/local" method="post">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="username" required />
              <label htmlFor="password">Password</label>
              <input id="password" name="password" type="password" autoComplete="current-password" required />
              <button className="block" style={{ marginTop: 16, width: "100%" }}>Sign in</button>
            </form>
          )}

          {!idps.length && !local && (
            <>
              <h3 style={{ margin: "6px 0 2px" }}>One-time setup needed</h3>
              <p className="mute small" style={{ marginTop: 0 }}>No sign-in method is configured yet. Pick one, set the variables in your server&apos;s Startup settings, then restart.</p>
              <ol className="guide">
                <li><strong>Quickest:</strong> admin login. Set <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code> (12+ characters).</li>
                <li>
                  <strong>Google sign-in:</strong> in Google Cloud Console, create an OAuth client (type <em>Web application</em>) with this redirect URI:
                  <div style={{ margin: "6px 0" }}><code>{appUrl}/api/auth/google/callback</code></div>
                  Then set <code>GOOGLE_AUTH_CLIENT_ID</code>, <code>GOOGLE_AUTH_CLIENT_SECRET</code> and <code>ALLOWED_EMAILS</code> (your Google address).
                </li>
                <li><strong>Other SSO</strong> (Authentik, Keycloak…): set <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>, <code>OIDC_CLIENT_SECRET</code>.</li>
              </ol>
            </>
          )}
        </div>
        {!!idps.length && <p className="mute small" style={{ marginTop: 14 }}>Access is limited to people the owner has allowed.</p>}
      </div>
    </div>
  );
}
