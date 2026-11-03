// Model → PostgreSQL DDL. Output is deterministic and readable: extensions,
// enums, tables (+ comments, indexes), then foreign keys, then raw statements.

import type { Schema, Table } from '../model/types';
import { encodeLayout } from './layoutMeta';
import { baseTypeName, qualified, quoteIdent, quoteLiteral } from './pg';

export interface GenerateOptions {
  /** Append the canvas layout as `-- dedal:layout:` comment lines. */
  embedLayout?: boolean;
}

export function formatType(type: string, schema: Schema): string {
  const base = baseTypeName(type);
  const en = schema.enums.find((e) => e.name === base);
  if (!en) return type;
  return type.replace(base, qualified(en.name, en.schema));
}

function indexColumn(expr: string, table: Table): string {
  return table.columns.some((c) => c.name === expr) ? quoteIdent(expr) : expr;
}

export function tableDDL(table: Table, schema: Schema): string {
  const pkCols = table.columns.filter((c) => c.pk);
  const inlinePk = pkCols.length === 1 && !table.pkName;
  const width = Math.max(0, ...table.columns.map((c) => quoteIdent(c.name).length));
  const lines: string[] = [];
  for (const c of table.columns) {
    let line = `  ${quoteIdent(c.name).padEnd(width)} ${formatType(c.type, schema)}`;
    if (c.identity) line += ` GENERATED ${c.identity} AS IDENTITY`;
    if (c.generated) line += ` GENERATED ALWAYS AS (${c.generated}) STORED`;
    if (c.pk && inlinePk) line += ' PRIMARY KEY';
    else if (!c.nullable && !c.pk && !c.identity) line += ' NOT NULL';
    if (c.default !== undefined && c.default !== '') line += ` DEFAULT ${c.default}`;
    if (c.unique && !(c.pk && inlinePk)) line += ' UNIQUE';
    if (c.check) line += ` CHECK (${c.check})`;
    lines.push(line);
  }
  if (pkCols.length && !inlinePk) {
    const name = table.pkName ? `CONSTRAINT ${quoteIdent(table.pkName)} ` : '';
    lines.push(`  ${name}PRIMARY KEY (${pkCols.map((c) => quoteIdent(c.name)).join(', ')})`);
  }
  for (const k of table.constraints) {
    const name = k.name ? `CONSTRAINT ${quoteIdent(k.name)} ` : '';
    if (k.kind === 'unique') lines.push(`  ${name}UNIQUE (${(k.columns ?? []).map(quoteIdent).join(', ')})`);
    else if (k.kind === 'check') lines.push(`  ${name}CHECK (${k.expr})`);
    else lines.push(`  ${name}${k.expr}`);
  }
  const out = [`CREATE TABLE ${qualified(table.name, table.schema)} (\n${lines.join(',\n')}\n);`];
  const tq = qualified(table.name, table.schema);
  if (table.comment) out.push(`COMMENT ON TABLE ${tq} IS ${quoteLiteral(table.comment)};`);
  for (const c of table.columns) {
    if (c.comment) out.push(`COMMENT ON COLUMN ${tq}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)};`);
  }
  for (const i of table.indexes) out.push(indexDDL(table, i));
  return out.join('\n');
}

export function indexDDL(table: Table, i: Table['indexes'][number]): string {
  const using = i.method ? ` USING ${i.method}` : '';
  const where = i.where ? ` WHERE ${i.where}` : '';
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(i.name)} ON ${qualified(table.name, table.schema)}${using} (${i.columns
    .map((c) => indexColumn(c, table))
    .join(', ')})${where};`;
}

export function relationDDL(schema: Schema, relId: string): string | null {
  const r = schema.relations.find((x) => x.id === relId);
  if (!r) return null;
  const from = schema.tables.find((t) => t.id === r.from.table);
  const to = schema.tables.find((t) => t.id === r.to.table);
  if (!from || !to) return null;
  const fc = r.from.columns.map((id) => from.columns.find((c) => c.id === id)?.name).filter(Boolean) as string[];
  const tc = r.to.columns.map((id) => to.columns.find((c) => c.id === id)?.name).filter(Boolean) as string[];
  if (!fc.length || fc.length !== tc.length) return null;
  const name = r.name ? `CONSTRAINT ${quoteIdent(r.name)} ` : '';
  let s = `ALTER TABLE ${qualified(from.name, from.schema)}\n  ADD ${name}FOREIGN KEY (${fc.map(quoteIdent).join(', ')}) REFERENCES ${qualified(to.name, to.schema)} (${tc
    .map(quoteIdent)
    .join(', ')})`;
  if (r.onDelete !== 'NO ACTION') s += ` ON DELETE ${r.onDelete}`;
  if (r.onUpdate !== 'NO ACTION') s += ` ON UPDATE ${r.onUpdate}`;
  return s + ';';
}

export function enumDDL(e: Schema['enums'][number]): string {
  const vals = e.values.map(quoteLiteral);
  const body = vals.join(', ').length > 60 ? `\n  ${vals.join(',\n  ')}\n` : vals.join(', ');
  let s = `CREATE TYPE ${qualified(e.name, e.schema)} AS ENUM (${body});`;
  if (e.comment) s += `\nCOMMENT ON TYPE ${qualified(e.name, e.schema)} IS ${quoteLiteral(e.comment)};`;
  return s;
}

export function generateSql(schema: Schema, opts: GenerateOptions = {}): string {
  const parts: string[] = [];
  const schemas = new Set<string>();
  for (const t of schema.tables) if (t.schema && t.schema !== 'public') schemas.add(t.schema);
  for (const e of schema.enums) if (e.schema && e.schema !== 'public') schemas.add(e.schema);
  if (schemas.size) parts.push([...schemas].map((s) => `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`).join('\n'));
  if (schema.extensions.length) {
    parts.push(
      schema.extensions
        .map((e) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(e.name)}${e.schema ? ` WITH SCHEMA ${quoteIdent(e.schema)}` : ''};`)
        .join('\n'),
    );
  }
  if (schema.enums.length) parts.push(schema.enums.map(enumDDL).join('\n\n'));
  for (const t of schema.tables) parts.push(tableDDL(t, schema));
  const fks = schema.relations.map((r) => relationDDL(schema, r.id)).filter(Boolean);
  if (fks.length) parts.push(fks.join('\n'));
  for (const r of schema.raw) parts.push(r.trim().replace(/;?\s*$/, ';'));
  let sql = parts.join('\n\n') + '\n';
  if (opts.embedLayout) {
    const blob = encodeLayout(schema);
    const lines = blob.match(/.{1,96}/g) ?? [];
    sql += `\n-- Canvas layout for Dedal (safe to delete)\n${lines.map((l) => `-- dedal:layout:${l}`).join('\n')}\n`;
  }
  return sql;
}
