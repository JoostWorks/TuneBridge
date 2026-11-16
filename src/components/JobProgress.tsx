"use client";
import { useEffect, useState } from "react";

interface Job { id: string; status: string; total: number; processed: number; matched: number; unmatched: number; added: number; error?: string; waitingUntil?: string; dest?: { name: string; url: string | null } | null }
const DONE = ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"];

export default function JobProgress({ id, initial }: { id: string; initial: Job }) {
  const [job, setJob] = useState<Job>(initial);
  useEffect(() => {
    if (DONE.includes(job.status)) return;
    const t = setInterval(async () => {
      try { const r = await fetch(`/api/jobs/${id}`, { cache: "no-store" }); if (r.ok) setJob(await r.json()); } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [id, job.status]);

  const pct = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : job.status === "SUCCEEDED" ? 100 : 0;
  const done = DONE.includes(job.status);
  return (
    <div className="card">
      <div className="row" style={{ borderTop: 0 }}>
        <div className="grow"><strong>{job.status.toLowerCase().replace("_", " ")}</strong>{job.status === "WAITING_RATE_LIMIT" && <span className="mute small"> · Spotify asked us to slow down; resuming automatically</span>}</div>
        <span className="mute small">{job.processed}/{job.total} checked</span>
      </div>
      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      <p className="mute small">{job.matched} matched · {job.unmatched} not found · {job.added} added to the new playlist</p>
      {job.error && <div className="alert">{job.error}</div>}
      {done && (
        <div className="actions">
          {job.dest?.url && <a className="btn" href={job.dest.url} target="_blank" rel="noreferrer">Open in Spotify</a>}
          {job.unmatched > 0 && <a className="btn ghost" href={`/api/jobs/${id}/missing`}>Missing tracks (CSV)</a>}
        </div>
      )}
    </div>
  );
}
