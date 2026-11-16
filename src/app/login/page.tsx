import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { enabledIdps } from "@/lib/auth/idp";
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  not_allowed: "This account isn't allowed to sign in to this instance. Ask the owner to add your email to ALLOWED_EMAILS.",
  email_unverified: "Your identity provider hasn't verified this email address.",
  no_email: "Your identity provider didn't share an email address.",
  bad_state: "The sign-in attempt expired. Please try again.",
  cancelled: "Sign-in was cancelled.",
  unknown_provider: "That sign-in method isn't enabled.",
  failed: "Sign-in failed. Check the server logs.",
};

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/");
  const { error } = await searchParams;
  const idps = enabledIdps();
  return (
    <div className="login">
      <h1>Tune<span style={{ color: "var(--accent)" }}>Bridge</span></h1>
      <p className="sub">Move, back up and sync your music library.</p>
      {error && <div className="alert">{ERRORS[error] ?? ERRORS.failed}</div>}
      <div className="card">
        {idps.map((i) => <a key={i.id} className="btn" href={`/api/auth/${i.id}/start`}>Continue with {i.label}</a>)}
        {!idps.length && <p className="mute">No sign-in method is configured. Set <code>GOOGLE_AUTH_CLIENT_ID</code> and <code>GOOGLE_AUTH_CLIENT_SECRET</code> (or <code>OIDC_*</code>) and restart.</p>}
      </div>
    </div>
  );
}
