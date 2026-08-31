#!/usr/bin/env node
/**
 * Generates `src/types/database.ts` from the migrations.
 *
 * `supabase gen types` needs either Docker or a linked cloud project. This
 * needs neither: it applies the real migrations to PGlite (Postgres 17 in
 * WebAssembly) and introspects the catalog, so `npm install` is the only
 * prerequisite and it runs identically on a laptop and in CI.
 *
 * The output is deliberately shaped exactly like the CLI's, so switching back to
 * `supabase gen types` later is a one-line change to the npm script and produces
 * the same file. This is a shortcut around the tooling, not around the types.
 *
 * The source of truth is `supabase/migrations/`. If the generated file and the
 * migrations disagree, the migrations are right and this should be re-run —
 * which is what `npm run db:types:check` verifies in CI.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { freshDatabase } from "../supabase/tests/harness.mjs";

/** Postgres type name -> TypeScript type. */
const SCALARS = {
  bool: "boolean",
  int2: "number",
  int4: "number",
  int8: "number",
  float4: "number",
  float8: "number",
  numeric: "number",
  text: "string",
  varchar: "string",
  bpchar: "string",
  citext: "string",
  uuid: "string",
  date: "string",
  time: "string",
  timetz: "string",
  timestamp: "string",
  timestamptz: "string",
  json: "Json",
  jsonb: "Json",
  inet: "string",
  cidr: "string",
  macaddr: "string",
  bytea: "string",
  interval: "string",
  void: "undefined",
  record: "Record<string, unknown>",
};

function tsType(pgType, enums) {
  if (pgType.startsWith("_")) {
    const inner = tsType(pgType.slice(1), enums);
    return `${inner}[]`;
  }
  if (enums.has(pgType)) return `Database["public"]["Enums"]["${pgType}"]`;
  return SCALARS[pgType] ?? "unknown";
}

const db = await freshDatabase();

/* ------------------------------------------------------------------ enums */

const { rows: enumRows } = await db.query(`
  select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
   group by t.typname
   order by t.typname
`);

const enumNames = new Set(enumRows.map((r) => r.name));

/* ----------------------------------------------------------------- tables */

const { rows: columnRows } = await db.query(`
  select c.relname            as table_name,
         c.relkind            as kind,
         a.attname            as column_name,
         t.typname            as pg_type,
         a.attnotnull         as not_null,
         (d.adbin is not null) as has_default,
         a.attidentity <> ''  as is_identity,
         a.attnum             as position
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
   order by c.relname, a.attnum
`);

const tables = new Map();
for (const row of columnRows) {
  if (!tables.has(row.table_name)) {
    tables.set(row.table_name, { kind: row.kind, columns: [] });
  }
  tables.get(row.table_name).columns.push(row);
}

/* -------------------------------------------------------------- functions */

const { rows: functionRows } = await db.query(`
  select p.proname                             as name,
         pg_get_function_arguments(p.oid)      as args,
         rt.typname                            as return_type,
         p.proretset                           as returns_set,
         coalesce(p.proargnames, '{}')         as arg_names,
         p.proargtypes                         as arg_type_oids,
         -- OUT/TABLE columns, for functions declared RETURNS TABLE(...).
         coalesce(p.proallargtypes, '{}')      as all_arg_type_oids,
         coalesce(p.proargmodes, '{}')         as arg_modes
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type rt on rt.oid = p.prorettype
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname not like 'pg_%'
     -- Trigger functions are not callable through the API.
     and rt.typname <> 'trigger'
   order by p.proname
`);

const { rows: typeOidRows } = await db.query(`select oid, typname from pg_type`);
const typeByOid = new Map(typeOidRows.map((r) => [String(r.oid), r.typname]));

/* ------------------------------------------------------------------ emit */

const indent = (n) => " ".repeat(n);

function emitTable(name, spec) {
  const rowLines = [];
  const insertLines = [];
  const updateLines = [];

  for (const col of spec.columns) {
    const ts = tsType(col.pg_type, enumNames);
    const nullable = !col.not_null;
    const rowType = nullable ? `${ts} | null` : ts;

    rowLines.push(`${indent(10)}${col.column_name}: ${rowType};`);

    // Insert: optional when the database can supply a value (default, identity)
    // or when null is acceptable.
    const insertOptional = col.has_default || col.is_identity || nullable;
    insertLines.push(`${indent(10)}${col.column_name}${insertOptional ? "?" : ""}: ${rowType};`);

    updateLines.push(`${indent(10)}${col.column_name}?: ${rowType};`);
  }

  return [
    `${indent(6)}${name}: {`,
    `${indent(8)}Row: {`,
    ...rowLines,
    `${indent(8)}};`,
    `${indent(8)}Insert: {`,
    ...insertLines,
    `${indent(8)}};`,
    `${indent(8)}Update: {`,
    ...updateLines,
    `${indent(8)}};`,
    `${indent(8)}Relationships: [];`,
    `${indent(6)}};`,
  ].join("\n");
}

/**
 * The row type of a `RETURNS TABLE(...)` function.
 *
 * Postgres records those columns as OUT parameters: their names sit in
 * `proargnames` alongside the IN parameters, their types in `proallargtypes`,
 * distinguished by `proargmodes` ('t' for TABLE, 'o' for OUT). Without reading
 * them, such a function types as an opaque record and every field access on a
 * result set goes unchecked — which defeats the point of generating types.
 *
 * Columns are emitted nullable because Postgres makes no not-null guarantee
 * about a function's output, however the body is written.
 *
 * Returns null when there are no OUT columns, so scalar returns fall through.
 */
function tableReturnShape(fn) {
  const modes = fn.arg_modes ?? [];
  if (modes.length === 0) return null;

  const allTypes = fn.all_arg_type_oids ?? [];
  const names = fn.arg_names ?? [];

  const columns = [];
  for (let i = 0; i < modes.length; i += 1) {
    if (modes[i] !== "t" && modes[i] !== "o") continue;
    const pgType = typeByOid.get(String(allTypes[i])) ?? "text";
    const name = names[i] ?? `column${i}`;
    columns.push(`${indent(12)}${name}: ${tsType(pgType, enumNames)} | null;`);
  }

  return columns.length > 0 ? columns : null;
}

function emitFunction(fn) {
  const oids = String(fn.arg_type_oids ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const names = fn.arg_names ?? [];

  const argLines = oids.map((oid, i) => {
    const argName = names[i] ?? `arg${i}`;
    const pgType = typeByOid.get(oid) ?? "text";
    return `${indent(10)}${argName}: ${tsType(pgType, enumNames)};`;
  });

  const tableColumns = tableReturnShape(fn);

  let returnType;
  if (tableColumns) {
    returnType = `{\n${tableColumns.join("\n")}\n${indent(8)}}[]`;
  } else {
    const returns = tsType(fn.return_type, enumNames);
    returnType = fn.returns_set ? `${returns}[]` : returns;
  }

  return [
    `${indent(6)}${fn.name}: {`,
    argLines.length > 0
      ? `${indent(8)}Args: {\n${argLines.join("\n")}\n${indent(8)}};`
      : `${indent(8)}Args: Record<PropertyKey, never>;`,
    `${indent(8)}Returns: ${returnType};`,
    `${indent(6)}};`,
  ].join("\n");
}

const tableEntries = [...tables.entries()].filter(([, s]) => s.kind === "r");
const viewEntries = [...tables.entries()].filter(([, s]) => s.kind !== "r");

const output = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate after every schema change:
 *
 *     npm run db:types
 *
 * Produced by scripts/generate-database-types.mjs, which applies
 * supabase/migrations/ to an in-memory Postgres and introspects the catalog.
 * The migrations are the source of truth; if this file disagrees with them, it
 * is this file that is wrong. \`npm run db:types:check\` fails CI when they drift.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
${tableEntries.map(([n, s]) => emitTable(n, s)).join("\n")}
    };
    Views: {${
      viewEntries.length === 0
        ? " [_ in never]: never "
        : `\n${viewEntries.map(([n, s]) => emitTable(n, s)).join("\n")}\n    `
    }};
    Functions: {
${functionRows.map(emitFunction).join("\n")}
    };
    Enums: {
${enumRows.map((e) => `${indent(6)}${e.name}: ${e.labels.map((l) => `"${l}"`).join(" | ")};`).join("\n")}
    };
    CompositeTypes: { [_ in never]: never };
  };
};
`;

const target = join(process.cwd(), "src", "types", "database.ts");
writeFileSync(target, output, "utf8");
await db.close();

console.log(
  `Generated src/types/database.ts — ${tableEntries.length} tables, ${viewEntries.length} views, ` +
    `${functionRows.length} functions, ${enumRows.length} enums.`,
);
