import { NextRequest } from "next/server";
import { getDb, getVault } from "@/lib/db";
import { enabledIdps } from "@/lib/auth/idp";
import { beginLogin } from "@/lib/auth/login";
import { redirectTo } from "@/lib/http";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ idp: string }> }) {
  const { idp } = await params;
  const cfg = enabledIdps().find((i) => i.id === idp);
  if (!cfg) return redirectTo("/login?error=unknown_provider");
  try {
    const url = await beginLogin(getDb(), getVault(), cfg, req.nextUrl.searchParams.get("next") ?? undefined);
    return NextResponse.redirect(url, 303);
  } catch (e) {
    console.error("[auth] start failed", e);
    return redirectTo("/login?error=failed");
  }
}
