import type { Provider } from "@prisma/client";
import { PermanentProviderError, type MusicProvider } from "./types";
import { spotify } from "./spotify";

const ADAPTERS: Partial<Record<Provider, MusicProvider>> = { SPOTIFY: spotify };

export function getProvider(p: Provider): MusicProvider {
  const a = ADAPTERS[p];
  if (!a) throw new PermanentProviderError(`${p} is not supported yet`, p);
  return a;
}
export const supportedProviders = () => Object.keys(ADAPTERS) as Provider[];
