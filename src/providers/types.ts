import type { Provider } from "@prisma/client";

/** Normalised track as returned by any adapter (before it becomes a canonical `Track`). */
export interface RemoteTrack {
  providerTrackId: string;
  uri?: string;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string;
  explicit?: boolean;
  available?: boolean;
  addedAt?: Date;
}

export interface RemotePlaylist {
  providerPlaylistId: string;
  name: string;
  description?: string;
  imageUrl?: string;
  isPublic?: boolean;
  isCollaborative?: boolean;
  ownedByUser: boolean;
  trackCount: number;
  /** snapshot_id / etag / lastModifiedDate – lets the worker skip unchanged playlists. */
  version?: string;
}

export interface Page<T> {
  items: T[];
  next?: string; // opaque cursor
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string; // present only if the provider rotates / issues one
  accessExpiresAt?: Date;
  refreshExpiresAt?: Date;
  scopes?: string[];
}

/** What the matching engine and scheduler need to know to treat each provider correctly. */
export interface ProviderCapabilities {
  authKind: "oauth2-code" | "oauth2-pkce" | "apple-musickit" | "oauth2-device";
  /** Refresh response may contain a NEW refresh token that replaces the old one. */
  refreshTokenRotates: boolean;
  /** No refresh at all: user must re-authorise on expiry (Apple Music user tokens). */
  reauthOnExpiry: boolean;
  supportsIsrcLookup: boolean;
  supportsBatchIsrcLookup: boolean;
  /** Max items per add/remove call. */
  maxWriteBatch: number;
  maxReadPageSize: number;
  supportsRemoveTracks: boolean;
  supportsInsertAtPosition: boolean;
  supportsReplaceAll: boolean;
  supportsLikedSongs: boolean;
  supportsAlbumsAndArtists: boolean;
  /** Hard daily quota in provider-defined units, if any (YouTube Data API). */
  dailyQuotaUnits?: number;
  /** Cost model so the planner can estimate a job before running it. */
  quotaCost?: { search: number; write: number; read: number };
}

export interface AdapterContext {
  accessToken: string;
  /** Apple storefront / market code used for catalog lookups. */
  storefront?: string;
  /** The provider-side user id of the connected account (to tell owned playlists from followed ones). */
  providerUserId?: string;
  signal?: AbortSignal;
}

/** One adapter per streaming service. Pure I/O: no DB access, no retry logic (the runner owns that). */
export interface MusicProvider {
  readonly id: Provider;
  readonly capabilities: ProviderCapabilities;

  // ── OAuth ────────────────────────────────────────────────────────────
  buildAuthUrl(p: { state: string; redirectUri: string; codeChallenge?: string; scopes: string[] }): string;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string }): Promise<TokenSet & { providerUserId: string; displayName?: string; email?: string; storefront?: string }>;
  refresh(p: { refreshToken: string }): Promise<TokenSet>;

  // ── Read ─────────────────────────────────────────────────────────────
  listPlaylists(ctx: AdapterContext, cursor?: string): Promise<Page<RemotePlaylist>>;
  getPlaylistTracks(ctx: AdapterContext, playlistId: string, cursor?: string): Promise<Page<RemoteTrack>>;
  getLikedTracks?(ctx: AdapterContext, cursor?: string): Promise<Page<RemoteTrack>>;

  // ── Catalog lookup (matching engine) ─────────────────────────────────
  findByIsrc(ctx: AdapterContext, isrcs: string[]): Promise<Map<string, RemoteTrack[]>>;
  search(ctx: AdapterContext, q: { title: string; artist: string; album?: string; limit?: number }): Promise<RemoteTrack[]>;

  // ── Write ────────────────────────────────────────────────────────────
  createPlaylist(ctx: AdapterContext, p: { name: string; description?: string; isPublic?: boolean }): Promise<RemotePlaylist>;
  addTracks(ctx: AdapterContext, playlistId: string, providerTrackIds: string[], position?: number): Promise<void>;
  removeTracks?(ctx: AdapterContext, playlistId: string, providerTrackIds: string[]): Promise<void>;
  replaceTracks?(ctx: AdapterContext, playlistId: string, providerTrackIds: string[]): Promise<void>;
  likeTracks?(ctx: AdapterContext, providerTrackIds: string[]): Promise<void>;
}

// ── Error taxonomy: the job runner switches on these, adapters just throw them ──────────

export class ProviderError extends Error {
  constructor(message: string, readonly provider: Provider, readonly status?: number) {
    super(message);
  }
}
/** 429 / quota exhausted. Runner parks the job until `retryAt` instead of failing it. */
export class RateLimitedError extends ProviderError {
  constructor(provider: Provider, readonly retryAt: Date, readonly scope: "app" | "account" | "daily-quota" = "app") {
    super(`${provider} rate limited until ${retryAt.toISOString()}`, provider, 429);
  }
}
/** invalid_grant / revoked / Apple token expired: mark account NEEDS_REAUTH, pause its syncs, notify user. */
export class ReauthRequiredError extends ProviderError {}
/** 5xx / network / timeout: retry with exponential backoff + jitter. */
export class TransientProviderError extends ProviderError {}
/** 4xx that will never succeed (playlist deleted, forbidden): fail the item, not the job. */
export class PermanentProviderError extends ProviderError {}
