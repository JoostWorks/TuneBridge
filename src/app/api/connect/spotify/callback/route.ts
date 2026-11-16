import { NextRequest } from "next/server";
import { getDb, getVault } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { publicUrl } from "@/lib/env";
import { redirectTo } from "@/lib/http";
import { TokenVault } from "@/lib/crypto/token-vault";
import { spotify } from "@/providers/spotify";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return redirectTo("/login");
  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return redirectTo("/?error=spotify_denied");
  const db = getDb(), vault = getVault();
  const state = sp.get("state") ?? "";
  const row = await db.oAuthState.delete({ where: { state } }).catch(() => null); // single use
  if (!row || row.userId !== user.id || row.provider !== "SPOTIFY" || row.expiresAt < new Date()) return redirectTo("/?error=bad_state");
  try {
    const t = await spotify.exchangeCode({
      code: sp.get("code") ?? "",
      redirectUri: publicUrl("/api/connect/spotify/callback").href,
      codeVerifier: vault.decrypt(row.codeVerifierEnc!, `oauth:${state}`),
    });
    const acct = await db.connectedAccount.upsert({
      where: { userId_provider_providerUserId: { userId: user.id, provider: "SPOTIFY", providerUserId: t.providerUserId } },
      create: { userId: user.id, provider: "SPOTIFY", providerUserId: t.providerUserId, displayName: t.displayName, scopes: t.scopes ?? [] },
      update: { displayName: t.displayName, scopes: t.scopes ?? [], status: "ACTIVE", lastErrorCode: null },
    });
    await db.connectedAccount.update({
      where: { id: acct.id },
      data: {
        accessTokenEnc: vault.encrypt(t.accessToken, TokenVault.aad(acct.id, "access")),
        ...(t.refreshToken ? { refreshTokenEnc: vault.encrypt(t.refreshToken, TokenVault.aad(acct.id, "refresh")) } : {}),
        accessExpiresAt: t.accessExpiresAt, refreshExpiresAt: t.refreshExpiresAt, keyVersion: vault.activeVersion, lastRefreshAt: new Date(),
      },
    });
    return redirectTo(`/accounts/${acct.id}`);
  } catch (e) {
    console.error("[spotify] connect failed", e);
    return redirectTo("/?error=spotify_failed");
  }
}
