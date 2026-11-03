// Tolerant PostgreSQL DDL parser. It understands the statements that describe a
// schema (extensions, enums, tables, indexes, comments, FK alters) and keeps
// everything else verbatim so a round trip never silently drops SQL.

import { uid } from '../model/ids';
import type { Column, FkAction, Index, Relation, Schema, Table } from '../model/types';
import { emptySchema } from '../model/types';
import { lex, splitStatements, type Tok } from './lexer';
import { baseTypeName, isBuiltinType } from './pg';

export interface Diagnostic {
  from: number;
  to: number;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface ParseResult {
  schema: Schema;
  diagnostics: Diagnostic[];
  /** Base64 layout blob found in `-- dedal:layout:` (or legacy `-- asterion:layout:` / `-- opendb:layout:`) comments, if any. */
  layoutBlob?: string;
}

interface PendingRel {
  name?: string;
  fromTable: Table;
  fromCols: string[];
  toSchema?: string;
  toName: string;
  toCols: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
  tok: Tok;
}

interface PendingComment {
  kind: 'table' | 'column' | 'type';
  path: string[];
  text: string | null;
  tok: Tok;
}

interface TypeRef {
  col: Column;
  quoted: boolean;
  tok: Tok;
}

class ParseError extends Error {
  constructor(
    message: string,
    public tok?: Tok,
  ) {
    super(message);
  }
}

class Cursor {
  i = 0;
  constructor(
    public toks: Tok[],
    public src: string,
  ) {}
  get done() {
    return this.i >= this.toks.length;
  }
  peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new ParseError('Unexpected end of statement', this.toks[this.toks.length - 1]);
    return t;
  }
  isKw(kw: string, o = 0) {
    const t = this.peek(o);
    return !!t && t.t === 'id' && t.v === kw;
  }
  isOp(op: string, o = 0) {
    const t = this.peek(o);
    return !!t && t.t === 'op' && t.v === op;
  }
  acceptKw(...kws: string[]): boolean {
    for (let k = 0; k < kws.length; k++) if (!this.isKw(kws[k], k)) return false;
    this.i += kws.length;
    return true;
  }
  acceptOp(op: string): boolean {
    if (this.isOp(op)) {
      this.i++;
      return true;
    }
    return false;
  }
  expectKw(kw: string) {
    const t = this.peek();
    if (!this.acceptKw(kw)) throw new ParseError(`Expected ${kw.toUpperCase()}`, t);
  }
  expectOp(op: string) {
    const t = this.peek();
    if (!this.acceptOp(op)) throw new ParseError(`Expected "${op}"`, t);
  }
  ident(): { name: string; quoted: boolean; tok: Tok } {
    const t = this.next();
    if (t.t === 'id') return { name: t.v, quoted: false, tok: t };
    if (t.t === 'qid') return { name: t.v, quoted: true, tok: t };
    throw new ParseError('Expected an identifier', t);
  }
  /** `a`, `s.a` or `s.t.c` → parts. */
  qname(): { parts: string[]; quoted: boolean[]; tok: Tok } {
    const first = this.ident();
    const parts = [first.name];
    const quoted = [first.quoted];
    while (this.isOp('.')) {
      this.i++;
      const p = this.ident();
      parts.push(p.name);
      quoted.push(p.quoted);
    }
    return { parts, quoted, tok: first.tok };
  }
  text(a: Tok, b: Tok) {
    return this.src.slice(a.start, b.end);
  }
  /** Parse `( … )` and return the inner raw text and the tokens inside. */
  parens(): { text: string; toks: Tok[] } {
    const open = this.peek();
    this.expectOp('(');
    const startIdx = this.i;
    let depth = 1;
    while (!this.done) {
      const t = this.next();
      if (t.t === 'op' && (t.v === '(' || t.v === '[')) depth++;
      else if (t.t === 'op' && (t.v === ')' || t.v === ']')) {
        depth--;
        if (depth === 0) {
          const inner = this.toks.slice(startIdx, this.i - 1);
          return { text: inner.length ? this.text(inner[0], inner[inner.length - 1]) : '', toks: inner };
        }
      }
    }
    throw new ParseError('Unbalanced parentheses', open);
  }
  /** Collect tokens until `stop` matches at paren depth 0 (not consumed). */
  until(stop: (c: Cursor) => boolean): Tok[] {
    const out: Tok[] = [];
    let depth = 0;
    while (!this.done) {
      if (depth === 0 && stop(this)) break;
      const t = this.next();
      if (t.t === 'op' && (t.v === '(' || t.v === '[')) depth++;
      if (t.t === 'op' && (t.v === ')' || t.v === ']')) depth--;
      out.push(t);
    }
    return out;
  }
}

/** Split tokens on top-level commas. */
function splitCommas(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.t === 'op' && (t.v === '(' || t.v === '[')) depth++;
    if (t.t === 'op' && (t.v === ')' || t.v === ']')) depth--;
    if (depth === 0 && t.t === 'op' && t.v === ',') {
      out.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

const COLUMN_CONSTRAINT_KW = new Set([
  'constraint', 'not', 'null', 'default', 'primary', 'unique', 'check', 'references',
  'generated', 'collate', 'deferrable', 'initially',
]);

function parseAction(c: Cursor): FkAction {
  if (c.acceptKw('no', 'action')) return 'NO ACTION';
  if (c.acceptKw('restrict')) return 'RESTRICT';
  if (c.acceptKw('cascade')) return 'CASCADE';
  if (c.acceptKw('set', 'null')) {
    if (c.isOp('(')) c.parens();
    return 'SET NULL';
  }
  if (c.acceptKw('set', 'default')) {
    if (c.isOp('(')) c.parens();
    return 'SET DEFAULT';
  }
  throw new ParseError('Expected a referential action', c.peek());
}

function identList(toks: Tok[]): string[] {
  return splitCommas(toks).map((part) => {
    const t = part[0];
    return t.t === 'id' || t.t === 'qid' ? t.v : '';
  });
}

export function parseSql(src: string): ParseResult {
  const schema = emptySchema();
  const diagnostics: Diagnostic[] = [];
  const diag = (tok: Tok | undefined, message: string, severity: Diagnostic['severity'] = 'error', endTok?: Tok) => {
    const t = tok ?? { start: Math.max(0, src.length - 1), end: src.length, line: 1 };
    diagnostics.push({ from: t.start, to: (endTok ?? t).end, line: t.line, severity, message });
  };

  const blob = [...src.matchAll(/^--\s*(?:dedal|asterion|opendb):layout:(\S+)\s*$/gm)].map((m) => m[1]).join('');

  const { tokens, errors } = lex(src);
  for (const e of errors) diagnostics.push({ from: e.start, to: e.end, line: e.line, severity: 'error', message: e.message });

  const pendingRels: PendingRel[] = [];
  const pendingComments: PendingComment[] = [];
  const typeRefs: TypeRef[] = [];
  const tableKey = (sch: string | undefined, name: string) => `${sch ?? ''}.${name}`;
  const tables = new Map<string, Table>();
  const findTable = (sch: string | undefined, name: string) =>
    tables.get(tableKey(sch, name)) ?? (sch === 'public' ? tables.get(tableKey(undefined, name)) : undefined) ??
    (sch === undefined ? tables.get(tableKey('public', name)) : undefined);

  const splitName = (parts: string[]) =>
    parts.length > 1 ? { schema: parts[parts.length - 2], name: parts[parts.length - 1] } : { schema: undefined, name: parts[0] };

  // ---------- statement handlers ----------

  const parseColumn = (c: Cursor, table: Table, lead: string[] | undefined) => {
    const nameTok = c.ident();
    const col: Column = { id: uid(), name: nameTok.name, type: '', nullable: true, pk: false, unique: false };
    if (lead?.length) col.comment = lead.join('\n');
    const typeToks = c.until((cc) => {
      const t = cc.peek()!;
      return (t.t === 'id' && COLUMN_CONSTRAINT_KW.has(t.v)) || (t.t === 'op' && t.v === ',');
    });
    if (!typeToks.length) throw new ParseError(`Column "${col.name}" has no type`, nameTok.tok);
    let quoted = false;
    let type = '';
    for (let k = 0; k < typeToks.length; k++) {
      const t = typeToks[k];
      const prev = typeToks[k - 1];
      const glue = prev && !(t.t === 'op') && !(prev.t === 'op' && (prev.v === '(' || prev.v === '.')) ? ' ' : '';
      if (t.t === 'qid') quoted = true;
      const piece = t.t === 'op' ? (t.v === ',' ? ', ' : t.v) : t.t === 'str' ? `'${t.v}'` : t.v;
      type += glue + piece;
    }
    col.type = type.replace(/\s+/g, ' ').replace(/ \(/g, '(').trim();
    typeRefs.push({ col, quoted, tok: typeToks[0] });

    let constraintName: string | undefined;
    while (!c.done && !c.isOp(',')) {
      const t = c.peek()!;
      if (c.acceptKw('constraint')) {
        constraintName = c.ident().name;
        continue;
      }
      if (c.acceptKw('not', 'null')) col.nullable = false;
      else if (c.acceptKw('null')) col.nullable = true;
      else if (c.acceptKw('default')) {
        const d = c.until((cc) => {
          const p = cc.peek()!;
          return (p.t === 'id' && COLUMN_CONSTRAINT_KW.has(p.v) && p.v !== 'null') || (p.t === 'op' && p.v === ',');
        });
        if (!d.length) throw new ParseError('DEFAULT needs an expression', t);
        col.default = c.text(d[0], d[d.length - 1]);
      } else if (c.acceptKw('primary', 'key')) {
        col.pk = true;
        col.nullable = false;
        if (constraintName) table.pkName = constraintName;
      } else if (c.acceptKw('unique')) {
        c.acceptKw('nulls', 'not', 'distinct') || c.acceptKw('nulls', 'distinct');
        col.unique = true;
      } else if (c.isKw('check')) {
        c.next();
        col.check = c.parens().text;
        c.acceptKw('no', 'inherit');
      } else if (c.acceptKw('references')) {
        const ref = c.qname();
        const { schema: rs, name: rn } = splitName(ref.parts);
        const toCols = c.isOp('(') ? identList(c.parens().toks) : [];
        const rel: PendingRel = { name: constraintName, fromTable: table, fromCols: [col.name], toSchema: rs, toName: rn, toCols, onDelete: 'NO ACTION', onUpdate: 'NO ACTION', tok: ref.tok };
        parseRefTail(c, rel);
        pendingRels.push(rel);
      } else if (c.acceptKw('generated')) {
        if (c.acceptKw('always', 'as', 'identity')) col.identity = 'ALWAYS';
        else if (c.acceptKw('by', 'default', 'as', 'identity')) col.identity = 'BY DEFAULT';
        else if (c.acceptKw('always', 'as')) {
          col.generated = c.parens().text;
          c.acceptKw('stored') || c.acceptKw('virtual');
          continue;
        } else throw new ParseError('Unsupported GENERATED clause', t);
        if (col.identity) col.nullable = false;
        if (c.isOp('(')) c.parens();
      } else if (c.acceptKw('collate')) {
        c.qname();
      } else if (c.acceptKw('deferrable') || c.acceptKw('not', 'deferrable')) {
        // ignore
      } else if (c.acceptKw('initially')) {
        c.next();
      } else {
        throw new ParseError(`Unexpected "${src.slice(t.start, t.end)}" in column definition`, t);
      }
      constraintName = undefined;
    }
    table.columns.push(col);
  };

  const parseRefTail = (c: Cursor, rel: PendingRel) => {
    for (;;) {
      if (c.acceptKw('on', 'delete')) rel.onDelete = parseAction(c);
      else if (c.acceptKw('on', 'update')) rel.onUpdate = parseAction(c);
      else if (c.acceptKw('match')) c.next();
      else if (c.acceptKw('deferrable') || c.acceptKw('not', 'deferrable')) continue;
      else if (c.acceptKw('initially')) c.next();
      else if (c.acceptKw('not', 'valid')) continue;
      else break;
    }
  };

  /** Table-level constraint (inside CREATE TABLE or ALTER TABLE ADD). Returns false if not a constraint. */
  const parseTableConstraint = (c: Cursor, table: Table): boolean => {
    const startTok = c.peek()!;
    let name: string | undefined;
    if (c.acceptKw('constraint')) name = c.ident().name;
    if (c.acceptKw('primary', 'key')) {
      const cols = identList(c.parens().toks);
      for (const cn of cols) {
        const col = table.columns.find((x) => x.name === cn);
        if (col) {
          col.pk = true;
          col.nullable = false;
        } else diag(startTok, `PRIMARY KEY references unknown column "${cn}"`, 'warning');
      }
      if (name) table.pkName = name;
      c.until((cc) => cc.isOp(','));
      return true;
    }
    if (c.acceptKw('unique')) {
      c.acceptKw('nulls', 'not', 'distinct') || c.acceptKw('nulls', 'distinct');
      const cols = identList(c.parens().toks);
      c.until((cc) => cc.isOp(','));
      if (cols.length === 1 && !name) {
        const col = table.columns.find((x) => x.name === cols[0]);
        if (col) {
          col.unique = true;
          return true;
        }
      }
      table.constraints.push({ id: uid(), name, kind: 'unique', columns: cols });
      return true;
    }
    if (c.acceptKw('check')) {
      const expr = c.parens().text;
      c.until((cc) => cc.isOp(','));
      table.constraints.push({ id: uid(), name, kind: 'check', expr });
      return true;
    }
    if (c.acceptKw('foreign', 'key')) {
      const fromCols = identList(c.parens().toks);
      c.expectKw('references');
      const ref = c.qname();
      const { schema: rs, name: rn } = splitName(ref.parts);
      const toCols = c.isOp('(') ? identList(c.parens().toks) : [];
      const rel: PendingRel = { name, fromTable: table, fromCols, toSchema: rs, toName: rn, toCols, onDelete: 'NO ACTION', onUpdate: 'NO ACTION', tok: ref.tok };
      parseRefTail(c, rel);
      pendingRels.push(rel);
      return true;
    }
    if (c.isKw('exclude')) {
      const rest = c.until((cc) => cc.isOp(','));
      table.constraints.push({ id: uid(), name, kind: 'raw', expr: c.text(rest[0], rest[rest.length - 1]) });
      return true;
    }
    if (name) throw new ParseError('Unsupported constraint', c.peek());
    return false;
  };

  const handleCreateTable = (c: Cursor) => {
    c.acceptKw('if', 'not', 'exists');
    const qn = c.qname();
    const { schema: sch, name } = splitName(qn.parts);
    if (tables.has(tableKey(sch, name))) diag(qn.tok, `Table "${name}" is defined twice; the later definition wins`, 'warning');
    const table: Table = { id: uid(), name, schema: sch, columns: [], indexes: [], constraints: [], x: 0, y: 0 };
    if (c.isKw('as') || c.isKw('partition')) throw new ParseError('CREATE TABLE AS / PARTITION OF is kept as raw SQL', qn.tok);
    const body = c.parens();
    const lastTok = body.toks[body.toks.length - 1];
    if (lastTok?.t === 'op' && lastTok.v === ',') diag(lastTok, 'Trailing comma in column list');
    for (const part of splitCommas(body.toks)) {
      if (!part.length) {
        diag(qn.tok, `Empty element in the column list of "${name}" (double comma?)`);
        continue;
      }
      const pc = new Cursor(part, src);
      try {
        if (pc.isKw('like')) {
          diag(part[0], 'LIKE clauses are not expanded', 'warning');
          continue;
        }
        if (!parseTableConstraint(pc, table)) parseColumn(pc, table, part[0].lead);
        if (!pc.done) throw new ParseError(`Unexpected "${src.slice(pc.peek()!.start, pc.peek()!.end)}"`, pc.peek());
      } catch (e) {
        if (e instanceof ParseError) diag(e.tok ?? part[0], e.message, 'error', e.tok ? undefined : part[part.length - 1]);
        else throw e;
      }
    }
    const rest = c.until(() => false);
    if (rest.length) diag(rest[0], 'Table options after the column list are ignored', 'info', rest[rest.length - 1]);
    tables.set(tableKey(sch, name), table);
    const existing = schema.tables.findIndex((t) => t.name === name && t.schema === sch);
    if (existing >= 0) schema.tables[existing] = table;
    else schema.tables.push(table);
  };

  const handleCreateIndex = (c: Cursor, unique: boolean) => {
    c.acceptKw('concurrently');
    c.acceptKw('if', 'not', 'exists');
    let name = '';
    if (!c.isKw('on')) name = c.qname().parts.pop()!;
    c.expectKw('on');
    c.acceptKw('only');
    const qn = c.qname();
    const { schema: sch, name: tname } = splitName(qn.parts);
    const table = findTable(sch, tname);
    if (!table) throw new ParseError(`Index on unknown table "${tname}"`, qn.tok);
    let method: string | undefined;
    if (c.acceptKw('using')) method = c.next().v;
    const body = c.parens();
    const columns = splitCommas(body.toks).map((p) =>
      p.length === 1 && (p[0].t === 'id' || p[0].t === 'qid') ? p[0].v : src.slice(p[0].start, p[p.length - 1].end).replace(/\s+/g, ' '),
    );
    let where: string | undefined;
    while (!c.done) {
      if (c.acceptKw('where')) {
        const w = c.until(() => false);
        where = c.text(w[0], w[w.length - 1]).replace(/\s+/g, ' ');
      } else if (c.acceptKw('include') || c.acceptKw('with')) c.parens();
      else if (c.acceptKw('tablespace')) c.next();
      else if (c.acceptKw('nulls', 'not', 'distinct') || c.acceptKw('nulls', 'distinct')) continue;
      else throw new ParseError('Unsupported index option', c.peek());
    }
    if (!name) name = `${tname}_${columns.map((x) => x.replace(/\W+/g, '_')).join('_')}_idx`;
    const idx: Index = { id: uid(), name, columns, unique };
    if (method && method !== 'btree') idx.method = method;
    if (where) idx.where = where;
    table.indexes.push(idx);
  };

  const handleCreateType = (c: Cursor, stmt: Tok[]) => {
    const qn = c.qname();
    const { schema: sch, name } = splitName(qn.parts);
    if (!c.acceptKw('as', 'enum')) {
      schema.raw.push(c.text(stmt[0], stmt[stmt.length - 1]));
      diag(qn.tok, 'Only ENUM types are modelled; this type is kept as raw SQL', 'info');
      return;
    }
    const body = c.parens();
    const values = splitCommas(body.toks).map((p) => {
      if (p[0]?.t !== 'str') throw new ParseError('Enum values must be string literals', p[0]);
      return p[0].v;
    });
    schema.enums.push({ id: uid(), name, schema: sch, values });
  };

  const handleComment = (c: Cursor) => {
    c.expectKw('on');
    const kindTok = c.next();
    const kind = kindTok.v;
    if (kind !== 'table' && kind !== 'column' && kind !== 'type') {
      throw new ParseError(`COMMENT ON ${kind.toUpperCase()} is not modelled`, kindTok);
    }
    const qn = c.qname();
    c.expectKw('is');
    const v = c.next();
    pendingComments.push({ kind, path: qn.parts, text: v.t === 'str' ? v.v : null, tok: qn.tok });
  };

  const handleAlterTable = (c: Cursor, stmt: Tok[]) => {
    c.acceptKw('if', 'exists');
    c.acceptKw('only');
    const qn = c.qname();
    const { schema: sch, name } = splitName(qn.parts);
    const table = findTable(sch, name);
    if (!table) throw new ParseError(`ALTER of unknown table "${name}"`, qn.tok);
    const actions = splitCommas(c.until(() => false));
    for (const a of actions) {
      const ac = new Cursor(a, src);
      if (ac.acceptKw('add')) {
        if (ac.acceptKw('column')) {
          ac.acceptKw('if', 'not', 'exists');
          parseColumn(ac, table, a[0].lead);
        } else if (!parseTableConstraint(ac, table)) parseColumn(ac, table, a[0].lead);
        if (!ac.done) throw new ParseError('Unexpected tokens after ADD', ac.peek());
      } else {
        schema.raw.push(c.text(stmt[0], stmt[stmt.length - 1]));
        diag(a[0], 'This ALTER TABLE action is kept as raw SQL', 'info');
        return;
      }
    }
  };

  // ---------- main loop ----------

  for (const stmt of splitStatements(tokens)) {
    const c = new Cursor(stmt, src);
    const first = stmt[0];
    const raw = () => c.text(stmt[0], stmt[stmt.length - 1]);
    try {
      if (c.acceptKw('create')) {
        c.acceptKw('or', 'replace');
        if (c.acceptKw('extension')) {
          c.acceptKw('if', 'not', 'exists');
          const name = c.ident().name;
          let extSchema: string | undefined;
          while (!c.done) {
            if (c.acceptKw('schema')) extSchema = c.ident().name;
            else c.next();
          }
          if (!schema.extensions.some((e) => e.name === name)) schema.extensions.push({ name, schema: extSchema });
          continue;
        }
        if (c.acceptKw('type')) {
          handleCreateType(c, stmt);
          continue;
        }
        if (c.acceptKw('schema')) continue;
        if (c.acceptKw('unique', 'index')) {
          handleCreateIndex(c, true);
          continue;
        }
        if (c.acceptKw('index')) {
          handleCreateIndex(c, false);
          continue;
        }
        c.acceptKw('global') || c.acceptKw('local');
        c.acceptKw('temporary') || c.acceptKw('temp') || c.acceptKw('unlogged');
        if (c.acceptKw('table')) {
          handleCreateTable(c);
          continue;
        }
        schema.raw.push(raw());
        continue;
      }
      if (c.acceptKw('comment')) {
        handleComment(c);
        continue;
      }
      if (c.acceptKw('alter', 'table')) {
        handleAlterTable(c, stmt);
        continue;
      }
      if (c.isKw('set') || c.isKw('begin') || c.isKw('commit') || c.isKw('drop') || c.isKw('start')) continue;
      schema.raw.push(raw());
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      const keep = /kept as raw/.test(e.message);
      diag(e.tok ?? first, e.message, keep ? 'info' : 'error', e.tok ? undefined : stmt[stmt.length - 1]);
      if (keep) schema.raw.push(raw());
    }
  }

  // ---------- resolution ----------

  // Type references → enum names (case-insensitive, with a folding warning).
  for (const ref of typeRefs) {
    const base = baseTypeName(ref.col.type);
    const exact = schema.enums.find((e) => e.name === base || `${e.schema}.${e.name}` === base);
    if (exact) {
      ref.col.type = ref.col.type.replace(base, exact.name);
      continue;
    }
    const ci = schema.enums.find((e) => e.name.toLowerCase() === base.toLowerCase());
    if (ci) {
      if (!ref.quoted && ci.name !== ci.name.toLowerCase()) {
        diag(ref.tok, `Type ${base} is unquoted, so PostgreSQL folds it to ${base.toLowerCase()} — but the enum was created as "${ci.name}". Exported SQL quotes it.`, 'warning');
      }
      ref.col.type = ref.col.type.replace(new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ci.name);
      continue;
    }
    if (isBuiltinType(base)) ref.col.type = ref.col.type.toLowerCase();
  }

  for (const pc of pendingComments) {
    if (pc.kind === 'column') {
      const colName = pc.path[pc.path.length - 1];
      const { schema: sch, name } = splitName(pc.path.slice(0, -1));
      const table = findTable(sch, name);
      const col = table?.columns.find((x) => x.name === colName);
      if (!col) {
        diag(pc.tok, `COMMENT ON unknown column ${pc.path.join('.')}`, 'warning');
        continue;
      }
      col.comment = pc.text ?? undefined;
    } else if (pc.kind === 'table') {
      const { schema: sch, name } = splitName(pc.path);
      const table = findTable(sch, name);
      if (!table) diag(pc.tok, `COMMENT ON unknown table ${pc.path.join('.')}`, 'warning');
      else table.comment = pc.text ?? undefined;
    } else {
      const en = schema.enums.find((e) => e.name === pc.path[pc.path.length - 1]);
      if (en) en.comment = pc.text ?? undefined;
    }
  }

  for (const pr of pendingRels) {
    const target = findTable(pr.toSchema, pr.toName);
    if (!target) {
      diag(pr.tok, `Foreign key references unknown table "${pr.toName}"`, 'error');
      continue;
    }
    const toColNames = pr.toCols.length ? pr.toCols : target.columns.filter((x) => x.pk).map((x) => x.name);
    const fromCols = pr.fromCols.map((n) => pr.fromTable.columns.find((x) => x.name === n));
    const toCols = toColNames.map((n) => target.columns.find((x) => x.name === n));
    if (fromCols.some((x) => !x) || toCols.some((x) => !x) || fromCols.length !== toCols.length) {
      diag(pr.tok, `Foreign key ${pr.fromTable.name}(${pr.fromCols.join(', ')}) → ${pr.toName}(${toColNames.join(', ')}) has unknown or mismatched columns`, 'error');
      continue;
    }
    const rel: Relation = {
      id: uid(),
      name: pr.name,
      from: { table: pr.fromTable.id, columns: fromCols.map((x) => x!.id) },
      to: { table: target.id, columns: toCols.map((x) => x!.id) },
      onDelete: pr.onDelete,
      onUpdate: pr.onUpdate,
    };
    schema.relations.push(rel);
  }

  return { schema, diagnostics, layoutBlob: blob || undefined };
}
