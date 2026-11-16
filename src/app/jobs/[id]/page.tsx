import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getDb } from "@/lib/db";
import JobProgress from "@/components/JobProgress";
export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser().catch(() => redirect("/login"));
  const { id } = await params;
  const r = await getDb().jobRun.findFirst({ where: { id, userId: user.id }, include: { sourcePl: { select: { name: true } }, destPl: { select: { name: true, providerPlaylistId: true, provider: true } } } });
  if (!r) notFound();
  const initial = {
    id: r.id, status: r.status, total: r.totalItems, processed: r.processedItems, matched: r.matchedItems, unmatched: r.unmatchedItems, added: r.addedItems, error: r.errorMessage ?? undefined,
    dest: r.destPl && { name: r.destPl.name, url: r.destPl.provider === "SPOTIFY" && r.destPl.providerPlaylistId ? `https://open.spotify.com/playlist/${r.destPl.providerPlaylistId}` : null },
  };
  return (<><h1>Transfer</h1><p className="sub">{r.sourcePl?.name} → Spotify</p><JobProgress id={r.id} initial={initial} /></>);
}
