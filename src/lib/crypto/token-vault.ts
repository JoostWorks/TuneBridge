import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope format:  v<keyVersion>.<iv>.<authTag>.<ciphertext>   (all base64url)
 *
 * - AES-256-GCM, fresh 96-bit IV per encryption.
 * - AAD binds the ciphertext to its row + column ("<accountId>:<field>"), so a DB-level
 *   attacker can't copy Alice's refresh token into Bob's row and have it decrypt.
 * - Keys come from env, never the DB:
 *     TOKEN_ENC_KEYS="1:<base64 32 bytes>,2:<base64 32 bytes>"
 *     TOKEN_ENC_ACTIVE=2
 *   Rotation: add a new key, bump ACTIVE, run `rotate-keys` (re-encrypts rows lazily on read or in bulk),
 *   drop the old key once no row references it.
 *
 * Generate a key:  openssl rand -base64 32
 */

export type KeyRing = { active: number; keys: Map<number, Buffer> };

export function loadKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const raw = env.TOKEN_ENC_KEYS;
  const active = Number(env.TOKEN_ENC_ACTIVE);
  if (!raw || !Number.isInteger(active)) {
    throw new Error("TOKEN_ENC_KEYS and TOKEN_ENC_ACTIVE must be set");
  }
  const keys = new Map<number, Buffer>();
  for (const part of raw.split(",")) {
    const [ver, b64] = part.trim().split(":");
    const key = Buffer.from(b64 ?? "", "base64");
    if (!Number.isInteger(Number(ver)) || key.length !== 32) {
      throw new Error(`TOKEN_ENC_KEYS entry "${ver}" must be "<int>:<base64 of 32 bytes>"`);
    }
    keys.set(Number(ver), key);
  }
  if (!keys.has(active)) throw new Error(`TOKEN_ENC_ACTIVE=${active} not present in TOKEN_ENC_KEYS`);
  return { active, keys };
}

const b64u = (b: Buffer) => b.toString("base64url");

export class TokenVault {
  constructor(private readonly ring: KeyRing = loadKeyRing()) {}

  get activeVersion() {
    return this.ring.active;
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.ring.keys.get(this.ring.active)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `v${this.ring.active}.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(ct)}`;
  }

  decrypt(envelope: string, aad: string): string {
    const [v, iv, tag, ct] = envelope.split(".");
    const version = Number(v?.slice(1));
    const key = this.ring.keys.get(version);
    if (!key || !iv || !tag || !ct) throw new Error("Malformed or unknown-key token envelope");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  }

  /** True if the envelope was written with a non-active key and should be re-encrypted. */
  needsRotation(envelope: string): boolean {
    return Number(envelope.split(".")[0]?.slice(1)) !== this.ring.active;
  }

  static aad(accountId: string, field: "access" | "refresh") {
    return `${accountId}:${field}`;
  }
}
