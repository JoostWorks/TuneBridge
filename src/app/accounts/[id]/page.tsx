import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getDb } from "@/lib/db";
export const dynamic = "force-dynamic";

export default async function Account({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser().catch(() => redirect("/login"));
  const { id } = await params;
  const { error } = await searchParams;
  const db = getDb();
  const acct = await db.connectedAccount.findFirst({ where: { id, userId: user.id } });
  if (!acct) notFound();
  const playlists = await db.playlist.findMany({ where: { connectedAccountId: id }, orderBy: [{ kind: "desc" }, { name: "asc" }] });
  return (
    <>
      <h1>Spotify · {acct.displayName ?? acct.providerUserId}</h1>
      <p className="sub">{playlists.length ? `${playlists.length} playlists` : "No playlists loaded yet."}</p>
      {error && <div className="alert">{error}</div>}
      <div className="actions" style={{ marginBottom: 16 }}>
        <form className="inline" action={`/api/accounts/${id}/sync`} method="post"><button>{playlists.length ? "Refresh playlists" : "Load playlists"}</button></form>
        <form className="inline" action={`/api/accounts/${id}/disconnect`} method="post"><button className="danger">Disconnect &amp; delete local data</button></form>
      </div>
      <div className="card">
        {playlists.map((p) => (
          <div className="row" key={p.id}>
            <div className="grow trunc"><Link href={`/playlists/${p.id}`}>{p.name}</Link> {!p.ownedByUser && <span className="pill warn" title="Spotify only lets apps read the contents of playlists you own">followed</span>}</div>
            <span className="mute small">{p.trackCount} tracks</span>
            {p.ownedByUser ? <><a className="btn ghost" href={`/api/export/${p.id}?format=csv`}>CSV</a><a className="btn ghost" href={`/api/export/${p.id}?format=txt`}>TXT</a></> : <span className="mute small">contents unavailable</span>}
          </div>
        ))}
        {!playlists.length && <p className="mute">Press “Load playlists”.</p>}
      </div>
    </>
  );
}
