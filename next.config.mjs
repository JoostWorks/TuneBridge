import path from "node:path";
/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  poweredByHeader: false,
  webpack(config) {
    config.resolve.alias["@"] = path.resolve(process.cwd(), "src");
    return config;
  },
  serverExternalPackages: ["pg", "pg-boss", "@prisma/client", "@prisma/adapter-pg"],
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
    ] }];
  },
};
export default config;
