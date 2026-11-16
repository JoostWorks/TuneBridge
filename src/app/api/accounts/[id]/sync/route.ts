import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser, sameOrigin } from "@/lib/session";
import { forbidden, redirectTo, unauthorized } from "@/lib/http";
import { syncAccountPlaylists } from "@/lib/services/library";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const acct = await getDb().connectedAccount.findFirst({ where: { id, userId: user.id } });
  if (!acct) return redirectTo("/");
  try {
    await syncAccountPlaylists(id);
    return redirectTo(`/accounts/${id}`);
  } catch (e) {
    console.error("[sync]", e);
    return redirectTo(`/accounts/${id}?error=${encodeURIComponent((e as Error).message.slice(0, 160))}`);
  }
}
