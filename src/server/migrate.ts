import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Tiny forward-only migrator over prisma/migrations/<name>/migration.sql.
 * Keeps the runtime image free of the Prisma CLI + engines. Safe with N replicas (advisory lock).
 */
export async function migrate(connectionString = process.env.DATABASE_URL!, dir = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "prisma/migrations")) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(`CREATE TABLE IF NOT EXISTS _tunebridge_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await client.query("SELECT name, checksum FROM _tunebridge_migrations")).rows.map((r) => [r.name as string, r.checksum as string]));
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "migration.sql"))).map((d) => d.name).sort();
    let ran = 0;
    for (const name of names) {
      const sql = fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8");
      const sum = createHash("sha256").update(sql).digest("hex");
      if (applied.has(name)) {
        if (applied.get(name) !== sum) throw new Error(`Migration ${name} was modified after being applied`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _tunebridge_migrations (name, checksum) VALUES ($1, $2)", [name, sum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(e as Error).message}`);
      }
      ran++;
      console.log(`[migrate] applied ${name}`);
    }
    console.log(ran ? `[migrate] ${ran} applied` : "[migrate] up to date");
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && /migrate\.(js|cjs|ts)$/.test(process.argv[1])) {
  migrate().catch((e) => { console.error(e); process.exit(1); });
}
