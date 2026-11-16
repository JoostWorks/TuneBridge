import Link from "next/link";
import { currentUser } from "@/lib/session";
import { Landing } from "@/components/Landing";
import { getDb } from "@/lib/db";
export const dynamic = "force-dynamic";

const ERR: Record<string, string> = { spotify_not_configured: "Spotify isn't configured on this instance (SPOTIFY_CLIENT_ID).", spotify_denied: "Spotify access was denied.", spotify_failed: "Connecting Spotify failed.", bad_state: "The connection attempt expired. Try again." };
const pill = (s: string) => (s === "SUCCEEDED" ? "ok" : s === "FAILED" ? "bad" : s === "PARTIAL" || s === "WAITING_RATE_LIMIT" ? "warn" : "");

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await currentUser().catch(() => null);
  if (!user) return <Landing />;
  const { error } = await searchParams;
  const db = getDb();
  const [accounts, imported, runs] = await Promise.all([
    db.connectedAccount.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    db.playlist.findMany({ where: { userId: user.id, origin: "IMPORTED" }, orderBy: { createdAt: "desc" }, take: 8 }),
    db.jobRun.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 8, include: { sourcePl: { select: { name: true } } } }),
  ]);
  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Connect a service, then export a playlist or transfer one.</p>
      <div className="stats">
        <div className="stat"><b>{accounts.length}</b><span>connected {accounts.length === 1 ? "service" : "services"}</span></div>
        <div className="stat"><b>{imported.length}</b><span>imported playlists</span></div>
        <div className="stat"><b>{runs.filter((r) => r.status === "SUCCEEDED").length}</b><span>recent transfers done</span></div>
      </div>
      {error && <div className="alert">{ERR[error] ?? error}</div>}

      <h2>Connected services</h2>
      <div className="card">
        {accounts.map((a) => (
          <div className="row" key={a.id}>
            <span className="avatar spotify">S</span><div className="grow"><strong>Spotify</strong> <span className="mute">· {a.displayName ?? a.providerUserId}</span></div>
            <span className={`pill ${a.status === "ACTIVE" ? "ok" : "bad"}`}>{a.status === "ACTIVE" ? "connected" : "reconnect needed"}</span>
            {a.status === "ACTIVE" ? <Link className="btn ghost" href={`/accounts/${a.id}`}>Open</Link> : <a className="btn" href="/api/connect/spotify/start">Reconnect</a>}
          </div>
        ))}
        <div className="row"><span className="avatar spotify">S</span><div className="grow mute">{accounts.length ? "Add another account" : "No services connected yet"}</div><a className="btn" href="/api/connect/spotify/start">Connect Spotify</a></div>
      </div>

      <h2>Imported playlists</h2>
      <div className="card">
        {imported.map((p) => <div className="row" key={p.id}><Link className="grow" href={`/playlists/${p.id}`}>{p.name}</Link><span className="mute small">{p.trackCount} tracks</span></div>)}
        <div className="row"><div className="grow mute">Have a CSV or a list of songs?</div><Link className="btn ghost" href="/import">Import</Link></div>
      </div>

      {runs.length > 0 && (<><h2>Recent transfers</h2><div className="card">
        {runs.map((r) => <div className="row" key={r.id}><Link className="grow trunc" href={`/jobs/${r.id}`}>{r.sourcePl?.name ?? "Transfer"}</Link><span className="mute small">{r.matchedItems}/{r.totalItems}</span><span className={`pill ${pill(r.status)}`}>{r.status.toLowerCase().replace("_", " ")}</span></div>)}
      </div></>)}
    </>
  );
}
