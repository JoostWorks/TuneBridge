import { NextRequest, NextResponse } from "next/server";
import { getDb, getVault } from "@/lib/db";
import { enabledIdps } from "@/lib/auth/idp";
import { completeLogin, LoginDenied } from "@/lib/auth/login";
import { publicUrl } from "@/lib/env";
import { redirectTo } from "@/lib/http";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ idp: string }> }) {
  const { idp } = await params;
  const cfg = enabledIdps().find((i) => i.id === idp);
  if (!cfg) return redirectTo("/login?error=unknown_provider");
  if (req.nextUrl.searchParams.get("error")) return redirectTo("/login?error=cancelled");
  try {
    // Rebuild the callback URL on the PUBLIC origin: behind a proxy req.url shows the internal host.
    const callbackUrl = publicUrl(req.nextUrl.pathname + req.nextUrl.search);
    const s = await completeLogin(getDb(), getVault(), cfg, callbackUrl, { userAgent: req.headers.get("user-agent") ?? undefined, ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() });
    const res = NextResponse.redirect(publicUrl(s.redirectAfter), 303);
    res.cookies.set(s.cookie.name, s.token, { httpOnly: true, secure: s.cookie.secure, sameSite: "lax", path: "/", expires: s.expiresAt });
    return res;
  } catch (e) {
    if (e instanceof LoginDenied) return redirectTo(`/login?error=${e.reason}`);
    console.error("[auth] callback failed", e);
    return redirectTo("/login?error=failed");
  }
}
