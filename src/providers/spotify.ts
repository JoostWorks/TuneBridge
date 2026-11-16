import type { Provider } from "@prisma/client";
import {
  PermanentProviderError, RateLimitedError, ReauthRequiredError, TransientProviderError,
  type AdapterContext, type MusicProvider, type Page, type RemotePlaylist, type RemoteTrack, type TokenSet,
} from "./types";

const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";
const ID: Provider = "SPOTIFY";

/** Scopes per feature; keep minimal. Library read is needed for liked songs. */
export const SPOTIFY_SCOPES = {
  backup: ["playlist-read-private", "playlist-read-collaborative", "user-library-read"],
  write: ["playlist-modify-private", "playlist-modify-public"],
};

const clientId = () => {
  const v = process.env.SPOTIFY_CLIENT_ID;
  if (!v) throw new PermanentProviderError("SPOTIFY_CLIENT_ID is not configured", ID);
  return v;
};

async function call<T>(ctx: AdapterContext, path: string, init: RequestInit & { query?: Record<string, string | number> } = {}): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : API + path);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: ctx.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    throw new TransientProviderError(`network: ${e?.message ?? e}`, ID);
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
  if (res.status === 429) {
    const secs = Number(res.headers.get("retry-after") ?? "5");
    throw new RateLimitedError(ID, new Date(Date.now() + (Number.isFinite(secs) ? secs : 5) * 1000), "app");
  }
  if (res.status === 401) throw new ReauthRequiredError("spotify 401", ID, 401);
  const body = await res.text().catch(() => "");
  if (res.status === 403)
    throw new PermanentProviderError(
      "Spotify 403: in Development Mode the app owner needs Premium and the user must be on the app's allowlist (max 5). " + body.slice(0, 200),
      ID, 403,
    );
  if (res.status >= 500) throw new TransientProviderError(`spotify ${res.status}`, ID, res.status);
  throw new PermanentProviderError(`spotify ${res.status}: ${body.slice(0, 200)}`, ID, res.status);
}

function mapTrack(t: any, addedAt?: string): RemoteTrack | null {
  if (!t || t.type === "episode" || !t.id) return null; // local files / episodes / removed tracks
  return {
    providerTrackId: t.id,
    uri: t.uri,
    title: t.name,
    artists: (t.artists ?? []).map((a: any) => a.name).filter(Boolean),
    album: t.album?.name,
    durationMs: t.duration_ms,
    isrc: t.external_ids?.isrc?.toUpperCase(),
    explicit: t.explicit,
    available: t.is_playable !== false,
    addedAt: addedAt ? new Date(addedAt) : undefined,
  };
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${ACCOUNTS}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    throw new TransientProviderError(`network: ${e?.message ?? e}`, ID);
  }
  const json: any = await res.json().catch(() => ({}));
  if (res.ok) return json;
  if (json.error === "invalid_grant") throw new ReauthRequiredError("invalid_grant", ID, res.status);
  if (res.status >= 500) throw new TransientProviderError(`spotify token ${res.status}`, ID, res.status);
  throw new PermanentProviderError(`spotify token error: ${json.error_description ?? json.error ?? res.status}`, ID, res.status);
}

const toTokenSet = (j: any): TokenSet => ({
  accessToken: j.access_token,
  refreshToken: j.refresh_token,
  accessExpiresAt: new Date(Date.now() + (j.expires_in ?? 3600) * 1000),
  // Spotify introduced a ~6 month refresh-token lifetime in 2026; track it so the UI can warn before it lapses.
  refreshExpiresAt: j.refresh_token ? new Date(Date.now() + 170 * 86_400_000) : undefined,
  scopes: typeof j.scope === "string" ? j.scope.split(" ") : undefined,
});

export const spotify: MusicProvider = {
  id: ID,
  capabilities: {
    authKind: "oauth2-pkce",
    refreshTokenRotates: true,
    reauthOnExpiry: false,
    supportsIsrcLookup: true, // via search q=isrc:…
    supportsBatchIsrcLookup: false,
    maxWriteBatch: 100,
    maxReadPageSize: 50,
    supportsRemoveTracks: false, // TODO: verify request body of DELETE /playlists/{id}/items after the 2026 rename
    supportsInsertAtPosition: true,
    supportsReplaceAll: true,
    supportsLikedSongs: true,
    supportsAlbumsAndArtists: false,
  },

  buildAuthUrl({ state, redirectUri, codeChallenge, scopes }) {
    const u = new URL(`${ACCOUNTS}/authorize`);
    u.search = new URLSearchParams({
      response_type: "code", client_id: clientId(), redirect_uri: redirectUri, scope: scopes.join(" "), state,
      ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: "S256" } : {}),
    }).toString();
    return u.toString();
  },

  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const j = await tokenRequest({
      grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId(), code_verifier: codeVerifier ?? "",
    });
    const me = await call<any>({ accessToken: j.access_token }, "/me");
    return { ...toTokenSet(j), providerUserId: me.id, displayName: me.display_name ?? me.id };
  },

  async refresh({ refreshToken }) {
    return toTokenSet(await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId() }));
  },

  async listPlaylists(ctx, cursor): Promise<Page<RemotePlaylist>> {
    const offset = Number(cursor ?? 0);
    const r = await call<any>(ctx, "/me/playlists", { query: { limit: 50, offset } });
    const items: RemotePlaylist[] = (r.items ?? []).filter(Boolean).map((p: any) => ({
      providerPlaylistId: p.id,
      name: p.name,
      description: p.description || undefined,
      imageUrl: p.images?.[0]?.url,
      isPublic: p.public ?? false,
      isCollaborative: p.collaborative ?? false,
      ownedByUser: ctx.providerUserId ? p.owner?.id === ctx.providerUserId : true,
      trackCount: p.items?.total ?? p.tracks?.total ?? 0, // `tracks` was renamed `items` in Feb 2026
      version: p.snapshot_id,
    }));
    return { items, next: r.next ? String(offset + 50) : undefined };
  },

  async getPlaylistTracks(ctx, playlistId, cursor): Promise<Page<RemoteTrack>> {
    const offset = Number(cursor ?? 0);
    // /tracks was removed in Feb 2026; /items only returns contents for playlists the user owns.
    const r = await call<any>(ctx, `/playlists/${playlistId}/items`, { query: { limit: 50, offset, additional_types: "track" } });
    const items = (r.items ?? []).map((i: any) => mapTrack(i.item ?? i.track, i.added_at)).filter(Boolean) as RemoteTrack[];
    return { items, next: r.next ? String(offset + 50) : undefined };
  },

  async getLikedTracks(ctx, cursor): Promise<Page<RemoteTrack>> {
    const offset = Number(cursor ?? 0);
    const r = await call<any>(ctx, "/me/tracks", { query: { limit: 50, offset } });
    const items = (r.items ?? []).map((i: any) => mapTrack(i.track, i.added_at)).filter(Boolean) as RemoteTrack[];
    return { items, next: r.next ? String(offset + 50) : undefined };
  },

  async findByIsrc(ctx, isrcs) {
    const out = new Map<string, RemoteTrack[]>();
    for (const isrc of isrcs) {
      const r = await call<any>(ctx, "/search", { query: { q: `isrc:${isrc}`, type: "track", limit: 10 } }); // limit max is 10 since Feb 2026
      out.set(isrc, (r.tracks?.items ?? []).map((t: any) => mapTrack(t)).filter(Boolean) as RemoteTrack[]);
    }
    return out;
  },

  async search(ctx, { title, artist, album, limit }) {
    const clean = (s: string) => s.replace(/["\\]/g, " ");
    const q = `track:${clean(title)}${artist ? ` artist:${clean(artist)}` : ""}${album ? ` album:${clean(album)}` : ""}`;
    const r = await call<any>(ctx, "/search", { query: { q, type: "track", limit: Math.min(limit ?? 10, 10) } });
    return (r.tracks?.items ?? []).map((t: any) => mapTrack(t)).filter(Boolean) as RemoteTrack[];
  },

  async createPlaylist(ctx, { name, description, isPublic }) {
    const p = await call<any>(ctx, "/me/playlists", { method: "POST", body: JSON.stringify({ name, description: description ?? "", public: !!isPublic }) });
    return { providerPlaylistId: p.id, name: p.name, ownedByUser: true, trackCount: 0, isPublic: p.public, version: p.snapshot_id };
  },

  async addTracks(ctx, playlistId, ids, position) {
    for (let i = 0; i < ids.length; i += 100) {
      const uris = ids.slice(i, i + 100).map((id) => `spotify:track:${id}`);
      await call(ctx, `/playlists/${playlistId}/items`, {
        method: "POST",
        body: JSON.stringify({ uris, ...(position !== undefined ? { position: position + i } : {}) }),
      });
    }
  },

  async replaceTracks(ctx, playlistId, ids) {
    const uris = ids.slice(0, 100).map((id) => `spotify:track:${id}`);
    await call(ctx, `/playlists/${playlistId}/items`, { method: "PUT", body: JSON.stringify({ uris }) });
    for (let i = 100; i < ids.length; i += 100) await this.addTracks(ctx, playlistId, ids.slice(i, i + 100));
  },
};
