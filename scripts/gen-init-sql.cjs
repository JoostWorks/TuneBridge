// Generates prisma/migrations/0001_init/migration.sql from schema.prisma using Prisma's own naming
// conventions (Model_pkey, Model_a_b_key, Model_a_idx, Model_col_fkey). Written because Prisma's
// schema-engine binary can't be downloaded in restricted sandboxes; on a normal machine you can
// instead run `prisma migrate dev --name init` and delete this script.
const fs = require("fs");
const path = require("path");
const wasm = require("@prisma/prisma-schema-wasm");

const root = path.resolve(__dirname, "..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const dmmf = JSON.parse(wasm.get_dmmf(JSON.stringify({ prismaSchema: schema, noColor: true }))).datamodel;
const q = (s) => `"${s}"`;

// --- @@index parsing (not exposed in DMMF) ---
const idx = {};
let cur = null;
for (const line of schema.split("\n")) {
  const m = line.match(/^model\s+(\w+)/);
  if (m) cur = m[1];
  const i = line.match(/@@index\(\[(.*?)\](?:,\s*(.*))?\)\s*(?:\/\/.*)?$/);
  if (i && cur) {
    const fields = i[1].split(/,(?![^(]*\))/).map((f) => f.trim()).map((f) => {
      const fm = f.match(/^(\w+)(?:\((.*)\))?$/);
      return { name: fm[1], ops: (fm[2] || "").match(/raw\("([^"]+)"\)/)?.[1], desc: /sort:\s*Desc/.test(fm[2] || "") };
    });
    const rest = i[2] || "";
    (idx[cur] ||= []).push({ fields, gin: /type:\s*Gin/.test(rest), map: rest.match(/map:\s*"([^"]+)"/)?.[1] });
  }
}

const sqlType = (f) => {
  const [nt, args] = f.nativeType || [];
  let t;
  if (f.kind === "enum") t = q(f.type);
  else if (nt === "Uuid") t = "UUID";
  else if (nt === "VarChar") t = `VARCHAR(${args[0]})`;
  else if (nt === "Citext") t = "CITEXT";
  else if (nt === "Date") t = "DATE";
  else
    t = { String: "TEXT", Boolean: "BOOLEAN", Int: "INTEGER", BigInt: "BIGINT", Float: "DOUBLE PRECISION", DateTime: "TIMESTAMP(3)", Json: "JSONB" }[f.type];
  if (!t) throw new Error(`unmapped type ${f.type}`);
  return t;
};

const defaultSql = (f) => {
  const d = f.default;
  if (d === undefined) return "";
  if (typeof d === "object" && !Array.isArray(d)) {
    if (d.name === "now") return " DEFAULT CURRENT_TIMESTAMP";
    if (d.name === "dbgenerated") return ` DEFAULT ${d.args[0]}`;
    if (d.name === "autoincrement") return ""; // handled as SERIAL
    throw new Error(`unsupported default ${JSON.stringify(d)}`);
  }
  if (typeof d === "boolean" || typeof d === "number") return ` DEFAULT ${d}`;
  return ` DEFAULT '${String(d).replace(/'/g, "''")}'`;
};

const out = [];
out.push(`-- CreateExtension\nCREATE EXTENSION IF NOT EXISTS "citext";\n\n-- CreateExtension\nCREATE EXTENSION IF NOT EXISTS "pg_trgm";\n`);
for (const e of dmmf.enums) {
  out.push(`-- CreateEnum\nCREATE TYPE ${q(e.name)} AS ENUM (${e.values.map((v) => `'${v.name}'`).join(", ")});\n`);
}

const tail = [];
for (const m of dmmf.models) {
  const cols = [];
  for (const f of m.fields.filter((f) => f.kind !== "object")) {
    const auto = f.default && f.default.name === "autoincrement";
    let t = auto ? (f.type === "BigInt" ? "BIGSERIAL" : "SERIAL") : sqlType(f) + (f.isList ? "[]" : "");
    cols.push(`    ${q(f.name)} ${t}${f.isRequired || auto ? " NOT NULL" : ""}${defaultSql(f)}`);
  }
  const pk = m.primaryKey ? m.primaryKey.fields : m.fields.filter((f) => f.isId).map((f) => f.name);
  cols.push(`    CONSTRAINT ${q(m.name + "_pkey")} PRIMARY KEY (${pk.map(q).join(", ")})`);
  out.push(`-- CreateTable\nCREATE TABLE ${q(m.name)} (\n${cols.join(",\n")}\n);\n`);

  for (const f of m.fields.filter((f) => f.isUnique))
    tail.push(`-- CreateIndex\nCREATE UNIQUE INDEX ${q(`${m.name}_${f.name}_key`)} ON ${q(m.name)}(${q(f.name)});\n`);
  for (const u of m.uniqueIndexes)
    tail.push(`-- CreateIndex\nCREATE UNIQUE INDEX ${q(u.name || `${m.name}_${u.fields.join("_")}_key`)} ON ${q(m.name)}(${u.fields.map(q).join(", ")});\n`);
  for (const ix of idx[m.name] || []) {
    const name = ix.map || `${m.name}_${ix.fields.map((f) => f.name).join("_")}_idx`;
    const cols2 = ix.fields.map((f) => q(f.name) + (f.ops ? ` ${f.ops}` : "") + (f.desc ? " DESC" : "")).join(", ");
    tail.push(`-- CreateIndex\nCREATE INDEX ${q(name)} ON ${q(m.name)}${ix.gin ? " USING GIN" : ""}(${cols2});\n`);
  }
}
for (const m of dmmf.models) {
  for (const f of m.fields.filter((f) => f.kind === "object" && f.relationFromFields && f.relationFromFields.length)) {
    const target = dmmf.models.find((x) => x.name === f.type);
    const onDel = f.relationOnDelete
      ? { Cascade: "CASCADE", SetNull: "SET NULL", Restrict: "RESTRICT", NoAction: "NO ACTION" }[f.relationOnDelete]
      : f.isRequired ? "RESTRICT" : "SET NULL";
    tail.push(
      `-- AddForeignKey\nALTER TABLE ${q(m.name)} ADD CONSTRAINT ${q(`${m.name}_${f.relationFromFields.join("_")}_fkey`)} FOREIGN KEY (${f.relationFromFields.map(q).join(", ")}) REFERENCES ${q(target.name)}(${f.relationToFields.map(q).join(", ")}) ON DELETE ${onDel} ON UPDATE CASCADE;\n`,
    );
  }
}

const dir = path.join(root, "prisma/migrations/0001_init");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "migration.sql"), out.concat(tail).join("\n"));
console.log(`wrote ${path.relative(root, dir)}/migration.sql (${dmmf.models.length} tables, ${dmmf.enums.length} enums)`);
