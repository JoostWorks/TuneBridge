import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { currentUser } from "@/lib/session";
import { Logo } from "@/components/Logo";

export const metadata: Metadata = { title: { default: "TuneBridge — move your music between services", template: "%s · TuneBridge" }, description: "Free, self-hosted playlist transfer, backup and sync between streaming services." };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser().catch(() => null);
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand"><Logo /><b>Tune<span>Bridge</span></b></Link>
          {user ? (
            <>
              <nav><Link href="/">Dashboard</Link><Link href="/import">Import</Link></nav>
              <span className="mute small">{user.email}</span>
              <form action="/api/auth/logout" method="post"><button className="ghost">Sign out</button></form>
            </>
          ) : (
            <>
              <nav><a href="/#how">How it works</a><a href="/#features">Features</a><a href="/#services">Services</a></nav>
              <Link className="btn" href="/login">Sign in</Link>
            </>
          )}
        </header>
        <main className={user ? undefined : "wide"}>{children}</main>
        <footer className="site"><span>TuneBridge · free &amp; self-hosted · your data stays on your server</span><span>Not affiliated with Spotify or YouTube.</span></footer>
      </body>
    </html>
  );
}
