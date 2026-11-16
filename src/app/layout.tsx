import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import { currentUser } from "@/lib/session";

export const metadata: Metadata = { title: "TuneBridge", description: "Move, back up and sync your music library between streaming services." };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser().catch(() => null);
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">Tune<span>Bridge</span></Link>
          {user && (
            <>
              <nav><Link href="/">Dashboard</Link><Link href="/import">Import</Link></nav>
              <span className="mute small">{user.email}</span>
              <form action="/api/auth/logout" method="post"><button className="ghost">Sign out</button></form>
            </>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
