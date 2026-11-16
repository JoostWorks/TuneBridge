import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser, sameOrigin } from "@/lib/session";
import { forbidden, redirectTo, unauthorized } from "@/lib/http";
export const dynamic = "force-dynamic";

/** Disconnect = full local purge of that account's tokens, playlists and library (cascade). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  await getDb().connectedAccount.deleteMany({ where: { id, userId: user.id } });
  return redirectTo("/");
}
