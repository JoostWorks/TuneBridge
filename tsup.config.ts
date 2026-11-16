import { defineConfig } from "tsup";
export default defineConfig({
  entry: { worker: "src/server/worker.ts", migrate: "src/server/migrate.ts" },
  format: ["cjs"], target: "node22", platform: "node", outDir: "dist", clean: true, sourcemap: false,
  external: ["@prisma/client", "@prisma/adapter-pg", "pg", ".prisma/client"],
  noExternal: [/^(?!@prisma\/client|@prisma\/adapter-pg|pg$|\.prisma).*/],
});
