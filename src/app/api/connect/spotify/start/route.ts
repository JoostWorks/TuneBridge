import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { getDb, getVault } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { publicUrl } from "@/lib/env";
import { redirectTo } from "@/lib/http";
import { spotify, SPOTIFY_SCOPES } from "@/providers/spotify";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return redirectTo("/login");
  if (!process.env.SPOTIFY_CLIENT_ID) return redirectTo("/?error=spotify_not_configured");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  await getDb().oAuthState.create({
    data: { state, userId: user.id, provider: "SPOTIFY", codeVerifierEnc: getVault().encrypt(verifier, `oauth:${state}`), expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
  const url = spotify.buildAuthUrl({
    state,
    redirectUri: publicUrl("/api/connect/spotify/callback").href,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    scopes: [...SPOTIFY_SCOPES.backup, ...SPOTIFY_SCOPES.write],
  });
  return NextResponse.redirect(url, 303);
}
