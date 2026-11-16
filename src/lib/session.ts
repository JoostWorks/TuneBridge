import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "./db";
import { getSessionUser } from "./auth/login";

export const SESSION_COOKIE = "tb_session";

export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUser(getDb(), token);
}

export async function requireUser() {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

/** Cheap CSRF guard for state-changing routes (SameSite=Lax already blocks most cross-site POSTs). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients / same-origin GET-style navigations
  try {
    return new URL(origin).origin === new URL(process.env.APP_URL!).origin;
  } catch {
    return false;
  }
}
