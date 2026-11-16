import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { localAdmin, recordFailure, throttled, verifyLocal } from "@/lib/auth/local";
import { createSession } from "@/lib/auth/login";
import { publicUrl } from "@/lib/env";
import { forbidden, redirectTo } from "@/lib/http";
import { sameOrigin } from "@/lib/session";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return forbidden();
  const admin = localAdmin();
  if (!admin) return redirectTo("/login?error=unknown_provider");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (throttled(ip)) return redirectTo("/login?error=rate_limited");

  const form = await req.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  if (!verifyLocal(email, password)) {
    recordFailure(ip);
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return redirectTo("/login?error=bad_credentials");
  }

  const db = getDb();
  const user = await db.user.upsert({
    where: { email: admin.email },
    update: { role: "ADMIN" },
    create: { email: admin.email, name: "Admin", role: "ADMIN" },
  });
  const s = await createSession(db, user.id, { userAgent: req.headers.get("user-agent") ?? undefined, ip });
  const res = NextResponse.redirect(publicUrl("/"), 303);
  res.cookies.set(s.cookie.name, s.token, { httpOnly: true, secure: s.cookie.secure, sameSite: "lax", path: "/", expires: s.expiresAt });
  return res;
}
