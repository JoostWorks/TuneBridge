import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { TokenVault } from "./crypto/token-vault";
import { TokenManager } from "./tokens/token-manager";
import { getProvider } from "../providers/registry";

const g = globalThis as unknown as { __tb?: { db?: PrismaClient; vault?: TokenVault; tokens?: TokenManager } };
const store = (g.__tb ??= {});

export function getDb(): PrismaClient {
  return (store.db ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 10) }),
  }));
}
export function getVault(): TokenVault {
  return (store.vault ??= new TokenVault());
}
export function getTokens(): TokenManager {
  return (store.tokens ??= new TokenManager(getDb(), getVault(), getProvider));
}
