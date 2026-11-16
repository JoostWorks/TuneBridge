import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
export const dynamic = "force-dynamic";

const ERR: Record<string, string> = { file_too_large: "That file is larger than 5 MB.", empty: "Paste some songs or choose a file.", no_tracks: "No tracks could be read from that input.", too_many: "Too many tracks (max 20,000)." };

export default async function Import({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireUser().catch(() => redirect("/login"));
  const { error } = await searchParams;
  return (
    <>
      <h1>Import a playlist</h1>
      <p className="sub">Upload a CSV (title/artist/isrc columns; Exportify files work) or paste one song per line as <code>Artist - Title</code>.</p>
      {error && <div className="alert">{ERR[error] ?? error}</div>}
      <form className="card" action="/api/import" method="post" encType="multipart/form-data">
        <label>Playlist name</label><input name="name" placeholder="My playlist" maxLength={120} />
        <label>File (.csv or .txt)</label><input type="file" name="file" accept=".csv,.txt,text/csv,text/plain" />
        <label>…or paste text</label><textarea name="text" placeholder={"Daft Punk - Digital Love\nBjörk - Hyperballad"} />
        <label>Text line order</label>
        <select name="order"><option value="artist-title">Artist - Title</option><option value="title-artist">Title - Artist</option></select>
        <div style={{ marginTop: 14 }}><button>Import</button></div>
      </form>
    </>
  );
}
