import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSql } from '../src/sql/parser';
import { generateSql } from '../src/sql/generator';
import { applyLayout } from '../src/sql/layoutMeta';
import { decodeSchema, encodeSchema } from '../src/share/codec';

// private reference schema, not in the repo: SCHEMA_DIR=/path/to/dir with schema-v15.sql
const REF = `${process.env.SCHEMA_DIR ?? '.missing'}/schema-v15.sql`;

const strip = (s: ReturnType<typeof parseSql>['schema']) => ({
  ext: s.extensions.map((e) => e.name),
  enums: s.enums.map((e) => [e.name, e.values]),
  tables: s.tables.map((t) => ({
    name: t.name,
    comment: t.comment,
    cols: t.columns.map((c) => [c.name, c.type, c.nullable, c.pk, c.unique, c.default ?? null, c.check ?? null, c.comment ?? null]),
    idx: t.indexes.map((i) => [i.name, i.columns, i.unique, i.method ?? null, i.where ?? null]),
    cons: t.constraints.map((k) => [k.name ?? null, k.kind, k.columns ?? null, k.expr ?? null]),
  })),
  rels: s.relations.map((r) => {
    const name = (tid: string, cids: string[]) => {
      const t = s.tables.find((x) => x.id === tid)!;
      return `${t.name}(${cids.map((c) => t.columns.find((x) => x.id === c)!.name)})`;
    };
    return `${name(r.from.table, r.from.columns)}->${name(r.to.table, r.to.columns)} ${r.onDelete}/${r.onUpdate}`;
  }),
});

describe('parser', () => {
  it('parses columns, constraints and inline references', () => {
    const { schema, diagnostics } = parseSql(`
      CREATE EXTENSION IF NOT EXISTS ltree;
      CREATE TYPE mood AS ENUM ('sad', 'ok');
      CREATE TABLE a (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, path ltree NOT NULL UNIQUE, m mood DEFAULT 'ok');
      CREATE TABLE b (
        id serial,
        a_id bigint REFERENCES a ON DELETE CASCADE,
        price numeric(10, 2) CHECK (price > 0),
        tags text[],
        CONSTRAINT b_pk PRIMARY KEY (id),
        UNIQUE (a_id, price)
      );
      CREATE INDEX b_tags ON b USING gin (tags) WHERE tags IS NOT NULL;
      CREATE VIEW v AS SELECT 1;
    `);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const s = strip(schema);
    expect(s.ext).toEqual(['ltree']);
    expect(s.tables[0].cols[0]).toEqual(['id', 'bigint', false, true, false, null, null, null]);
    expect(s.tables[1].cols[2]).toEqual(['price', 'numeric(10, 2)', true, false, false, null, 'price > 0', null]);
    expect(s.tables[1].cols[3][1]).toEqual('text[]');
    expect(s.tables[1].cons).toEqual([[null, 'unique', ['a_id', 'price'], null]]);
    expect(s.tables[1].idx).toEqual([['b_tags', ['tags'], false, 'gin', 'tags IS NOT NULL']]);
    expect(s.rels).toEqual(['b(a_id)->a(id) CASCADE/NO ACTION']);
    expect(schema.tables[1].pkName).toBe('b_pk');
    expect(schema.raw).toEqual(['CREATE VIEW v AS SELECT 1']);
  });

  it('reports errors with positions and keeps going', () => {
    const { schema, diagnostics } = parseSql(`CREATE TABLE a (id int,, name text);\nCREATE TABLE b (id int);`);
    expect(schema.tables.map((t) => t.name)).toEqual(['a', 'b']);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('reads the layout comment, including the pre-rename `asterion:layout:` and `opendb:layout:` markers', () => {
    const { schema } = parseSql(readFileSync('src/sample.sql', 'utf8'));
    const sql = generateSql(schema, { embedLayout: true });
    const blob = parseSql(sql).layoutBlob;
    expect(blob).toBeTruthy();
    expect(sql).toContain('-- dedal:layout:');
    expect(parseSql(sql.replace(/dedal:layout:/g, 'asterion:layout:')).layoutBlob).toBe(blob);
    expect(parseSql(sql.replace(/dedal:layout:/g, 'opendb:layout:')).layoutBlob).toBe(blob);
  });

  it.runIf(existsSync(REF))('parses the reference schema and round-trips through SQL and the URL codec', () => {
    const src = readFileSync(REF, 'utf8');
    const first = parseSql(src);
    expect(first.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(first.schema.tables).toHaveLength(27);
    expect(first.schema.relations).toHaveLength(41);
    expect(first.schema.enums).toHaveLength(8);
    // the unquoted enum references are flagged
    expect(first.diagnostics.some((d) => /folds it to enum_weights_access/.test(d.message))).toBe(true);
    const models = first.schema.tables.find((t) => t.name === 'models')!;
    expect(models.columns.find((c) => c.name === 'weights_access')!.type).toBe('ENUM_WEIGHTS_ACCESS');

    const sql = generateSql(first.schema, { embedLayout: true });
    const second = parseSql(sql);
    expect(second.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(strip(second.schema)).toEqual(strip(first.schema));
    expect(applyLayout(second.schema, second.layoutBlob!)).toBe(true);

    const packed = encodeSchema(first.schema);
    expect(strip(decodeSchema(packed))).toEqual(strip(first.schema));
    console.log('generated SQL bytes', sql.length, 'URL payload chars', packed.length);
  });
});
