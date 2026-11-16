import { Prisma, PrismaClient } from "@prisma/client";
import { TokenVault } from "../crypto/token-vault";
import { ReauthRequiredError, TransientProviderError, type MusicProvider } from "../../providers/types";

const SKEW_MS = 120_000; // refresh when < 2 min of life left

/**
 * The ONLY code path allowed to read decrypted tokens.
 *
 *  - Per-account `pg_advisory_xact_lock` serialises refreshes across every worker/replica, which
 *    matters for providers with refresh-token rotation (Spotify may rotate; a second concurrent
 *    refresh with the old token would permanently invalidate the grant).
 *  - Double-checked: after getting the lock we re-read the row, because another worker may have
 *    refreshed while we waited.
 *  - invalid_grant => status NEEDS_REAUTH and every SyncJob of that account is paused with a reason.
 *  - Tokens are re-encrypted with the active key whenever they're written back.
 */
export class TokenManager {
  constructor(
    private readonly db: PrismaClient,
    private readonly vault: TokenVault,
    private readonly providers: (p: Provider) => MusicProvider,
  ) {}

  async getAccessToken(accountId: string): Promise<{ accessToken: string; storefront?: string }> {
    const fresh = await this.readIfFresh(accountId);
    if (fresh) return fresh;

    const result = await this.db.$transaction(
      async (tx): Promise<Out | Reauth> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`;

        const acct = await tx.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
        if (acct.status !== "ACTIVE") return { reauth: "account_not_active", provider: acct.provider };
        if (this.isFresh(acct.accessExpiresAt) && acct.accessTokenEnc) {
          return this.out(acct);
        }

        // Apple Music & friends: no refresh grant. Expired == re-auth.
        if (!acct.refreshTokenEnc) return this.markReauth(tx, acct, "expired_no_refresh_token");

        const adapter = this.providers(acct.provider);
        let refreshToken: string;
        try {
          refreshToken = this.vault.decrypt(acct.refreshTokenEnc, TokenVault.aad(acct.id, "refresh"));
        } catch {
          return this.markReauth(tx, acct, "undecryptable_refresh_token");
        }

        let ts;
        try {
          ts = await adapter.refresh({ refreshToken });
        } catch (e: any) {
          if (e instanceof ReauthRequiredError) return this.markReauth(tx, acct, "invalid_grant");
          throw e instanceof TransientProviderError ? e : new TransientProviderError(String(e?.message ?? e), acct.provider);
        }

        const updated = await tx.connectedAccount.update({
          where: { id: acct.id },
          data: {
            accessTokenEnc: this.vault.encrypt(ts.accessToken, TokenVault.aad(acct.id, "access")),
            // Keep the old refresh token unless the provider rotated it.
            refreshTokenEnc: ts.refreshToken
              ? this.vault.encrypt(ts.refreshToken, TokenVault.aad(acct.id, "refresh"))
              : acct.refreshTokenEnc,
            accessExpiresAt: ts.accessExpiresAt ?? new Date(Date.now() + 3_300_000),
            refreshExpiresAt: ts.refreshExpiresAt ?? acct.refreshExpiresAt,
            keyVersion: this.vault.activeVersion,
            lastRefreshAt: new Date(),
            lastErrorCode: null,
            lastErrorAt: null,
          },
        });
        return this.out(updated);
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    // Throw only AFTER the transaction committed, so the NEEDS_REAUTH write isn't rolled back.
    if ("reauth" in result) throw new ReauthRequiredError(result.reauth, result.provider);
    return result;
  }

  private async readIfFresh(accountId: string) {
    const a = await this.db.connectedAccount.findUnique({ where: { id: accountId } });
    if (a && a.status === "ACTIVE" && a.accessTokenEnc && this.isFresh(a.accessExpiresAt)) return this.out(a);
    return null;
  }

  private isFresh(exp: Date | null) {
    return !!exp && exp.getTime() - Date.now() > SKEW_MS;
  }

  private out(a: { id: string; accessTokenEnc: string | null; storefront: string | null }) {
    return {
      accessToken: this.vault.decrypt(a.accessTokenEnc!, TokenVault.aad(a.id, "access")),
      storefront: a.storefront ?? undefined,
    };
  }

  private async markReauth(tx: Prisma.TransactionClient, acct: { id: string; provider: Provider }, code: string): Promise<Reauth> {
    await tx.connectedAccount.update({
      where: { id: acct.id },
      data: { status: "NEEDS_REAUTH", lastErrorCode: code, lastErrorAt: new Date() },
    });
    await tx.syncJob.updateMany({
      where: { enabled: true, OR: [{ source: { connectedAccountId: acct.id } }, { dest: { connectedAccountId: acct.id } }] },
      data: { enabled: false, pausedReason: "NEEDS_REAUTH" },
    });
    return { reauth: code, provider: acct.provider };
  }
}

type Provider = import("@prisma/client").Provider;
type Out = { accessToken: string; storefront?: string };
type Reauth = { reauth: string; provider: Provider };
