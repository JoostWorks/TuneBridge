import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { redirectTo, forbidden } from "@/lib/http";
import { sameOrigin, SESSION_COOKIE } from "@/lib/session";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return forbidden();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await getDb().session.deleteMany({ where: { tokenHash: createHash("sha256").update(token).digest("hex") } });
  const res = redirectTo("/login");
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
