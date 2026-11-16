import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getDb } from "@/lib/db";
export const dynamic = "force-dynamic";

export default async function PlaylistPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser().catch(() => redirect("/login"));
  const { id } = await params;
  const { error } = await searchParams;
  const db = getDb();
  const pl = await db.playlist.findFirst({ where: { id, userId: user.id } });
  if (!pl) notFound();
  const [tracks, accounts] = await Promise.all([
    db.playlistTrack.findMany({ where: { playlistId: id }, orderBy: { position: "asc" }, take: 200, include: { track: true } }),
    db.connectedAccount.findMany({ where: { userId: user.id, status: "ACTIVE" } }),
  ]);
  const remote = !!pl.connectedAccountId;
  return (
    <>
      <h1>{pl.name}</h1>
      <p className="sub">{pl.trackCount} tracks · {remote ? "Spotify" : "imported"}</p>
      {error && <div className="alert">{error}</div>}
      <div className="actions" style={{ marginBottom: 16 }}>
        {(pl.ownedByUser || !remote) && <><a className="btn" href={`/api/export/${id}?format=csv`}>Export CSV</a><a className="btn ghost" href={`/api/export/${id}?format=txt`}>Export TXT</a></>}
        {remote && pl.ownedByUser && <form className="inline" action={`/api/playlists/${id}/fetch`} method="post"><button className="ghost">{tracks.length ? "Refresh tracks" : "Load tracks"}</button></form>}
      </div>

      {tracks.length > 0 && accounts.length > 0 && !(remote && accounts.length === 1 && accounts[0].id === pl.connectedAccountId && false) && (
        <div className="card" style={{ marginBottom: 20 }}>
          <strong>Transfer to Spotify</strong>
          <form action="/api/transfer" method="post">
            <input type="hidden" name="playlistId" value={id} />
            <label>Destination account</label>
            <select name="destAccountId">{accounts.map((a) => <option key={a.id} value={a.id}>Spotify · {a.displayName ?? a.providerUserId}</option>)}</select>
            <label>New playlist name</label>
            <input name="name" defaultValue={pl.name} maxLength={120} />
            <div style={{ marginTop: 14 }}><button>Start transfer</button></div>
          </form>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>#</th><th>Title</th><th>Artist</th><th>ISRC</th></tr></thead>
          <tbody>{tracks.map((t) => <tr key={t.id.toString()}><td className="mute">{t.position + 1}</td><td>{t.track.title}</td><td className="mute">{t.track.artists.join(", ")}</td><td className="mute small">{t.track.isrc ?? ""}</td></tr>)}</tbody>
        </table>
        {pl.trackCount > tracks.length && <p className="mute small">Showing the first {tracks.length}; exports include everything.</p>}
        {!tracks.length && <p className="mute">No tracks loaded yet.</p>}
      </div>
    </>
  );
}
