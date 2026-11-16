export const env = {
  get appUrl() {
    const u = process.env.APP_URL;
    if (!u) throw new Error("APP_URL is not set");
    return u.replace(/\/$/, "");
  },
  get secureCookies() {
    return (process.env.APP_URL ?? "").startsWith("https");
  },
  get databaseUrl() {
    const u = process.env.DATABASE_URL;
    if (!u) throw new Error("DATABASE_URL is not set");
    return u;
  },
};

/** Absolute URL on the PUBLIC origin (never trust the Host header behind a reverse proxy). */
export const publicUrl = (path: string) => new URL(path, env.appUrl + "/");
