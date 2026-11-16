import Link from "next/link";

const features = [
  ["🎯", "Smart matching", "ISRC first, then fuzzy title/artist/duration scoring. Remixes, live and karaoke versions are never swapped in for the original."],
  ["🧾", "Missing-track report", "Anything that can't be matched confidently is listed with the reason, and you can download it as CSV."],
  ["📦", "CSV import & export", "Back up any playlist to a file, or bring in a list of songs from anywhere."],
  ["🔐", "Tokens encrypted at rest", "Provider tokens are sealed with AES-256-GCM and refreshed safely, one at a time per account."],
  ["🏠", "Self-hosted", "One container plus Postgres. No ads, no song limits, no subscription. Your data stays on your server."],
  ["🔁", "Resumable transfers", "Transfers run in a background queue and respect each service's rate limits, so big playlists still finish."],
] as const;

export function Landing() {
  return (
    <>
      <section className="hero">
        <h1>Move your music between <em>streaming services</em></h1>
        <p>Transfer playlists, back them up and keep them in sync. Free, private and running on your own server.</p>
        <div className="actions">
          <Link className="btn lg" href="/login">Get started</Link>
          <a className="btn ghost lg" href="#how">How it works</a>
        </div>
        <div className="flow" aria-hidden="true">
          <div className="node"><span className="avatar spotify">S</span>Spotify</div>
          <span className="arrow">→</span>
          <div className="node"><span className="avatar csv">⇄</span>TuneBridge</div>
          <span className="arrow">→</span>
          <div className="node"><span className="avatar youtube">▶</span>YouTube Music</div>
        </div>
      </section>

      <section className="section" id="how">
        <h2 className="big">How it works</h2>
        <p className="mute">Three steps, no copy-pasting.</p>
        <div className="steps">
          <div className="step"><h3>Connect</h3><p>Sign in, then link your music account with the service's own consent screen. We never see your password.</p></div>
          <div className="step"><h3>Pick a playlist</h3><p>Choose a playlist from your library, or import a CSV or a list of songs.</p></div>
          <div className="step"><h3>Transfer</h3><p>Watch live progress, then review anything that couldn't be matched and download it as a report.</p></div>
        </div>
      </section>

      <section className="section" id="features">
        <h2 className="big">Built to be trustworthy</h2>
        <div className="grid">
          {features.map(([ico, t, d]) => (
            <div className="feature" key={t}><div className="ico">{ico}</div><h3>{t}</h3><p>{d}</p></div>
          ))}
        </div>
      </section>

      <section className="section" id="services">
        <h2 className="big">Services</h2>
        <div className="card" style={{ marginTop: 18 }}>
          <div className="row"><span className="avatar spotify">S</span><div className="grow"><strong>Spotify</strong><div className="mute small">Read playlists, create and fill new ones</div></div><span className="pill ok">available</span></div>
          <div className="row"><span className="avatar csv">⇪</span><div className="grow"><strong>CSV / text lists</strong><div className="mute small">Import and export any playlist</div></div><span className="pill ok">available</span></div>
          <div className="row"><span className="avatar youtube">▶</span><div className="grow"><strong>YouTube Music</strong><div className="mute small">Uses the YouTube Data API, which has a daily quota</div></div><span className="pill">coming soon</span></div>
        </div>
      </section>

      <section className="cta">
        <div className="box">
          <h2>Ready to move your library?</h2>
          <p>Sign in to connect your first service.</p>
          <Link className="btn lg" href="/login">Sign in</Link>
        </div>
      </section>
    </>
  );
}
