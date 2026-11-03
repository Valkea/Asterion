import { produce } from 'immer';
import { create } from 'zustand';
import { uid } from '../model/ids';
import { mergeParsed } from '../model/merge';
import { NOTE_COLORS, paletteColor } from '../model/palette';
import type { Schema, Table, ViewMode } from '../model/types';
import { emptySchema } from '../model/types';
import { type Diagnostic, parseSql } from '../sql/parser';
import { applyLayout } from '../sql/layoutMeta';
import { decodeSchema } from '../share/codec';
import { diffSchemas } from '../analysis/diff';
import { autoLayout, type ArrangeMode, type Direction } from '../layout/auto';
import { suggestGroups } from '../layout/cluster';
import type { Detail } from '../layout/geometry';
import { routedCrossings } from '../layout/routing';
import type { SearchMessage, SearchRequest } from '../layout/arrange.worker';
import { inDegree } from '../analysis/graph';
import { isPhone } from '../util/phone';

export type Selection =
  | { kind: 'table'; id: string; columnId?: string }
  | { kind: 'relation'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'enum'; id: string }
  | { kind: 'group'; id: string }
  | null;

export type SidebarTab = 'tables' | 'enums' | 'extensions' | 'health' | 'diff' | 'paths';

export interface Toast {
  id: string;
  text: string;
  tone?: 'ok' | 'warn' | 'err';
}

interface State {
  schema: Schema;
  past: Schema[];
  future: Schema[];
  /** Coalescing key of the last commit (typing in a field shouldn't create 1 undo step per key). */
  lastKey?: string;
  lastAt: number;
  /** Who produced the latest schema change; the SQL pane ignores its own edits. */
  origin: 'canvas' | 'sql' | 'load';
  revision: number;

  selection: Selection;
  /** Items left by following links in the inspector; only valid while `at` is still the selection. */
  trail: { stack: NonNullable<Selection>[]; at: Selection } | null;
  sidebar: SidebarTab | null;
  sqlOpen: boolean;
  theme: 'dark' | 'light';
  importDiagnostics: Diagnostic[];
  focus: { enabled: boolean; hops: number };
  path: { a?: string; b?: string };
  diffBase: { name: string; schema: Schema } | null;
  starFocus: string | null;
  portals: boolean;
  /** Tables and notes can't be dragged (default): avoids moving things by accident while panning or tapping. */
  moveLocked: boolean;
  hubThreshold: number;
  layoutBusy: boolean;
  /** After Arrange, a worker keeps looking for a cleaner arrangement and applies each one it finds. */
  layoutSearch: boolean;
  direction: Direction;
  arrangeMode: ArrangeMode;
  /** Dependency arrangement: pack each column instead of lining cards up with their links (smaller, more crossings). */
  flowCompact: boolean;
  /** Detail level the canvas currently draws at (set by the canvas from the zoom). */
  viewDetail: Detail;
  /** An image export is being captured: the canvas draws everything at full detail, with no selection or hover. */
  exporting: boolean;
  toasts: Toast[];
  welcome: boolean;
  /** Bumped when the camera should frame the whole drawing. */
  fitRequest: number;
  /** Why the link the page was opened with could not be loaded. */
  linkError: string | null;

  commit: (fn: (d: Schema) => void, key?: string) => void;
  setTransient: (fn: (d: Schema) => void) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  load: (schema: Schema, origin?: State['origin']) => void;
  /** Back to the welcome screen with an empty schema; undoable (and the browser's Back works too). */
  startOver: () => void;
  importSql: (sql: string, name?: string) => Promise<void>;
  /** Load an older version (SQL text or a share link) to compare against. Returns an error message. */
  loadCompareBase: (text: string, name: string) => string | null;
  applySqlFromPane: (sql: string) => Diagnostic[];
  select: (s: Selection) => void;
  /** Run a navigation from the inspector, remembering the current item for the back button. */
  visit: (go: () => void) => void;
  back: () => void;
  setView: (v: ViewMode) => void;
  set: (p: Partial<State>) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  runAutoLayout: (opts?: { regroup?: boolean }) => Promise<void>;
  stopLayoutSearch: () => void;
  /** background: a move by the layout search, part of the Arrange's undo step and dropped once the search is stopped. */
  animateTo: (target: Map<string, { x: number; y: number }>, opts?: { background?: boolean }) => Promise<void>;
  addTable: (at: { x: number; y: number }) => string;
  addNote: (at: { x: number; y: number }, attachedTo?: string) => void;
  deleteSelection: () => void;
}

const HISTORY = 200;

const isBlank = (s: Schema) => !s.tables.length && !s.notes.length;

function readTheme(): 'dark' | 'light' {
  try {
    const t = localStorage.getItem('odbe-theme');
    if (t === 'dark' || t === 'light') return t;
  } catch {
    /* storage unavailable */
  }
  return 'dark'; // dark unless the user picked light with the toggle
}

/** A table whose inbound references are drawn as portals, with the mark its chips wear. */
export interface Hub {
  id: string;
  name: string;
  color: string;
  glyph: string;
  /** Tables referencing it, in schema order (itself excluded). */
  referrers: string[];
}

/** With a colour, tells hubs apart: 10 colours × 8 glyphs give 40 distinct marks. */
const HUB_GLYPHS = ['◆', '●', '▲', '■', '★', '⬟', '▼', '✚'];

/** Portal hubs: tables set to always, plus (with portals on) the busy ones not set to never. */
export function portalHubs(schema: Schema, portals: boolean, threshold: number): Map<string, Hub> {
  const deg = inDegree(schema);
  const hubs = new Map<string, Hub>();
  for (const t of schema.tables) {
    if (!(t.portal === true || (t.portal !== false && portals && (deg.get(t.id) ?? 0) >= threshold))) continue;
    const i = hubs.size;
    hubs.set(t.id, { id: t.id, name: t.name, color: paletteColor(i), glyph: HUB_GLYPHS[i % HUB_GLYPHS.length], referrers: [] });
  }
  const order = new Map(schema.tables.map((t, i) => [t.id, i]));
  for (const r of schema.relations) {
    const h = hubs.get(r.to.table);
    if (h && r.from.table !== h.id && !h.referrers.includes(r.from.table)) h.referrers.push(r.from.table);
  }
  for (const h of hubs.values()) h.referrers.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return hubs;
}

export function hiddenRelations(schema: Schema, portals: boolean, threshold: number): Set<string> {
  const hubs = portalHubs(schema, portals, threshold);
  return new Set(schema.relations.filter((r) => hubs.has(r.to.table)).map((r) => r.id));
}

export const useStore = create<State>((set, get) => ({
  schema: emptySchema(),
  past: [],
  future: [],
  lastAt: 0,
  origin: 'load',
  revision: 0,
  selection: null,
  trail: null,
  sidebar: isPhone() ? null : 'tables', // on a phone the panel would cover the whole diagram
  sqlOpen: false,
  theme: readTheme(),
  importDiagnostics: [],
  focus: { enabled: false, hops: 1 },
  path: {},
  diffBase: null,
  starFocus: null,
  portals: false,
  moveLocked: true,
  hubThreshold: 1,
  layoutBusy: false,
  layoutSearch: false,
  direction: 'RIGHT',
  arrangeMode: 'groups',
  flowCompact: false,
  viewDetail: 'full',
  exporting: false,
  toasts: [],
  welcome: false,
  fitRequest: 0,
  linkError: null,

  commit: (fn, key) => {
    const { schema, past, lastKey, lastAt } = get();
    const next = produce(schema, fn);
    if (next === schema) return;
    const now = Date.now();
    const coalesce = key && key === lastKey && now - lastAt < 1200;
    set({
      schema: next,
      past: coalesce ? past : [...past.slice(-HISTORY), schema],
      future: [],
      lastKey: key,
      lastAt: now,
      origin: 'canvas',
      revision: get().revision + 1,
    });
  },
  setTransient: (fn) => {
    const next = produce(get().schema, fn);
    if (next !== get().schema) set({ schema: next, origin: 'canvas' });
  },
  checkpoint: () => {
    const { schema, past } = get();
    set({ past: [...past.slice(-HISTORY), schema], future: [], lastKey: undefined });
  },
  undo: () => {
    stopSearch(); // even when Arrange changed nothing and the schema stays the same object
    const { past, schema, future } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({ schema: prev, past: past.slice(0, -1), future: [schema, ...future], origin: 'canvas', lastKey: undefined, revision: get().revision + 1, welcome: isBlank(prev) && get().welcome }); // undoing a start-over leaves the welcome screen
  },
  redo: () => {
    stopSearch();
    const { past, schema, future } = get();
    if (!future.length) return;
    set({ schema: future[0], future: future.slice(1), past: [...past, schema], origin: 'canvas', lastKey: undefined, revision: get().revision + 1, welcome: isBlank(future[0]) });
  },
  load: (schema, origin = 'load') => {
    set({ schema, past: [], future: [], selection: null, origin, revision: get().revision + 1, starFocus: null, path: {}, welcome: false, fitRequest: get().fitRequest + 1 });
  },

  startOver: () => {
    const { schema, past } = get();
    if (isBlank(schema)) return set({ welcome: true, selection: null });
    set({
      schema: emptySchema(),
      past: [...past.slice(-HISTORY), schema],
      future: [],
      lastKey: undefined,
      selection: null,
      origin: 'load',
      revision: get().revision + 1,
      starFocus: null,
      path: {},
      diffBase: null,
      welcome: true,
      linkError: null,
    });
    get().toast(isPhone() ? 'Started a new schema · Undo (⋯ menu) or Back brings the previous one back' : 'Started a new schema · ⌘Z or the browser’s Back brings the previous one back');
  },

  importSql: async (sql, name) => {
    const res = parseSql(sql);
    const schema = res.schema;
    if (name) schema.name = name.replace(/\.sql$/i, '');
    const placed = res.layoutBlob ? applyLayout(schema, res.layoutBlob) : false;
    const prev = get().schema;
    set({ importDiagnostics: res.diagnostics });
    if (prev.tables.length) set({ past: [...get().past, prev], future: [] });
    set({ schema, selection: null, origin: 'load', revision: get().revision + 1, welcome: false, starFocus: null, path: {}, diffBase: null });
    const errors = res.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = res.diagnostics.filter((d) => d.severity === 'warning').length;
    get().toast(
      `Imported ${schema.tables.length} tables, ${schema.relations.length} relations, ${schema.enums.length} enums` +
        (errors || warnings ? ` · ${errors} errors, ${warnings} warnings (see Health)` : ''),
      errors ? 'warn' : 'ok',
    );
    if (!placed && schema.tables.length) await get().runAutoLayout({ regroup: !schema.groups.length });
    set({ fitRequest: get().fitRequest + 1 });
  },

  loadCompareBase: (text, name) => {
    const t = text.trim();
    let base: Schema;
    try {
      const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(t);
      if (m) base = decodeSchema(m[1]);
      else {
        const r = parseSql(t);
        if (r.layoutBlob) applyLayout(r.schema, r.layoutBlob);
        if (!r.schema.tables.length) return `No tables found in ${name}`;
        base = r.schema;
      }
    } catch (e) {
      return (e as Error).message;
    }
    set({ diffBase: { name, schema: base }, sidebar: 'diff' });
    const n = diffSchemas(base, get().schema).count;
    get().toast(n ? `Comparing with ${name}: ${n} difference${n > 1 ? 's' : ''} highlighted` : `${name} is identical to the current schema`, n ? 'ok' : 'warn');
    return null;
  },

  applySqlFromPane: (sql) => {
    const res = parseSql(sql);
    const errors = res.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length) return res.diagnostics;
    const { schema, fresh } = mergeParsed(get().schema, res.schema);
    // place brand-new tables to the right of the drawing
    if (fresh.length) {
      const known = schema.tables.filter((t) => !fresh.includes(t.id));
      const maxX = known.length ? Math.max(...known.map((t) => t.x)) + 360 : 0;
      const minY = known.length ? Math.min(...known.map((t) => t.y)) : 0;
      let y = minY;
      for (const t of schema.tables) {
        if (!fresh.includes(t.id)) continue;
        t.x = maxX;
        t.y = y;
        y += 80 + t.columns.length * 26;
      }
    }
    const prev = get().schema;
    set({
      schema,
      past: get().lastKey === 'sql-pane' ? get().past : [...get().past.slice(-HISTORY), prev],
      future: [],
      lastKey: 'sql-pane',
      lastAt: Date.now(),
      origin: 'sql',
      revision: get().revision + 1,
    });
    return res.diagnostics;
  },

  select: (selection) => set({ selection }),
  visit: (go) => {
    const { selection: prev, trail } = get();
    const stack = trail && trail.at === prev ? trail.stack : [];
    go();
    const at = get().selection;
    if (prev && at !== prev) set({ trail: { stack: [...stack, prev], at } });
  },
  back: () => {
    const { selection, trail } = get();
    if (!trail || trail.at !== selection || !trail.stack.length) return;
    const stack = trail.stack.slice(0, -1);
    const to = trail.stack[trail.stack.length - 1];
    set({ selection: to, trail: stack.length ? { stack, at: to } : null });
  },
  setView: (v) => {
    set({ starFocus: null });
    get().commit((d) => void (d.view = v), 'view');
  },
  set: (p) => set(p),
  toast: (text, tone = 'ok') => {
    const t = { id: uid(), text, tone };
    set({ toasts: [...get().toasts, t] });
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), 4200);
  },

  runAutoLayout: async ({ regroup } = {}) => {
    if (get().layoutBusy) return;
    stopSearch();
    set({ layoutBusy: true });
    try {
      if (regroup) {
        const s = suggestGroups(get().schema);
        get().commit((d) => {
          d.groups = d.groups.filter((g) => d.tables.some((t) => t.groupId === g.id && t.locked));
          for (const t of d.tables) if (!t.locked) t.groupId = s.assignment.get(t.id);
          d.groups.push(...s.groups);
        });
      }
      const { schema, portals, hubThreshold, direction, arrangeMode, flowCompact, viewDetail } = get();
      const hidden = hiddenRelations(schema, portals, hubThreshold);
      const before = routedCrossings(schema, hidden, viewDetail);
      const pos = await autoLayout(schema, { direction, mode: arrangeMode, hiddenRelations: hidden, compact: flowCompact, detail: viewDetail });
      await get().animateTo(pos);
      const after = routedCrossings(get().schema, hidden, viewDetail);
      if (schema.tables.some((t) => t.x || t.y))
        get().toast(after === before ? `No cleaner arrangement found · ${after} line crossings` : `Auto-layout done · line crossings ${before} → ${after}`);
      if (get().schema.tables.length > 2)
        startSearch({ schema: get().schema, direction, mode: arrangeMode, compact: flowCompact, detail: viewDetail, hidden: [...hidden], seed: 1 + Math.floor(Math.random() * 1e6) }, after);
    } catch (e) {
      console.error(e);
      get().toast(`Layout failed: ${(e as Error).message}`, 'err');
    } finally {
      set({ layoutBusy: false });
    }
  },

  stopLayoutSearch: () => stopSearch(),

  animateTo: (target, opts) =>
    new Promise((resolve) => {
      const owner = opts?.background ? search : null;
      if (!owner) get().checkpoint();
      const write = (fn: (d: Schema) => void) => {
        if (owner) owner.writing = true;
        try {
          get().setTransient(fn);
        } finally {
          if (owner) owner.writing = false;
        }
      };
      const start = new Map(get().schema.tables.map((t) => [t.id, { x: t.x, y: t.y }]));
      const dur = 650;
      const t0 = performance.now();
      const ease = (k: number) => 1 - Math.pow(1 - k, 3);
      const frame = (now: number) => {
        if (owner && search !== owner) return resolve(); // the user undid or changed something: leave it be
        const k = Math.min(1, (now - t0) / dur);
        const e = ease(k);
        write((d) => {
          for (const t of d.tables) {
            const a = start.get(t.id);
            const b = target.get(t.id);
            if (!a || !b) continue;
            t.x = a.x + (b.x - a.x) * e;
            t.y = a.y + (b.y - a.y) * e;
          }
        });
        if (k < 1) requestAnimationFrame(frame);
        else {
          write((d) => {
            for (const t of d.tables) {
              const b = target.get(t.id);
              if (b) {
                t.x = Math.round(b.x);
                t.y = Math.round(b.y);
              }
            }
          });
          set({ revision: get().revision + 1 });
          resolve();
        }
      };
      requestAnimationFrame(frame);
    }),

  addTable: (at) => {
    const id = uid();
    const existing = new Set(get().schema.tables.map((t) => t.name));
    let n = 1;
    while (existing.has(`table_${n}`)) n++;
    const table: Table = {
      id,
      name: `table_${n}`,
      columns: [{ id: uid(), name: 'id', type: 'bigint', identity: 'ALWAYS', pk: true, nullable: false, unique: false }],
      indexes: [],
      constraints: [],
      x: Math.round(at.x),
      y: Math.round(at.y),
    };
    get().commit((d) => void d.tables.push(table));
    set({ selection: { kind: 'table', id } });
    return id;
  },
  addNote: (at, attachedTo) => {
    const id = uid();
    get().commit((d) =>
      void d.notes.push({ id, text: 'New note', x: Math.round(at.x), y: Math.round(at.y), w: 220, h: 140, color: NOTE_COLORS[d.notes.length % NOTE_COLORS.length], attachedTo }),
    );
    set({ selection: { kind: 'note', id } });
  },
  deleteSelection: () => {
    const sel = get().selection;
    if (!sel) return;
    get().commit((d) => {
      if (sel.kind === 'table') {
        if (sel.columnId) {
          const t = d.tables.find((x) => x.id === sel.id);
          if (!t) return;
          t.columns = t.columns.filter((c) => c.id !== sel.columnId);
          d.relations = d.relations.filter((r) => !r.from.columns.includes(sel.columnId!) && !r.to.columns.includes(sel.columnId!));
        } else {
          d.tables = d.tables.filter((t) => t.id !== sel.id);
          d.relations = d.relations.filter((r) => r.from.table !== sel.id && r.to.table !== sel.id);
          for (const n of d.notes) if (n.attachedTo === sel.id) n.attachedTo = undefined;
        }
      } else if (sel.kind === 'relation') d.relations = d.relations.filter((r) => r.id !== sel.id);
      else if (sel.kind === 'note') d.notes = d.notes.filter((n) => n.id !== sel.id);
      else if (sel.kind === 'enum') d.enums = d.enums.filter((e) => e.id !== sel.id);
      else if (sel.kind === 'group') {
        d.groups = d.groups.filter((g) => g.id !== sel.id);
        for (const t of d.tables) if (t.groupId === sel.id) t.groupId = undefined;
      }
    });
    set({ selection: null });
  },
}));

interface Search {
  worker: Worker;
  /** The search is moving tables itself: not a reason to stop it. */
  writing: boolean;
  animating: boolean;
  pending?: { pos: Map<string, { x: number; y: number }>; crossings: number };
  done: boolean;
  /** Crossings when the search started, and in the latest arrangement it applied. */
  from: number;
  found: number | null;
}

let search: Search | null = null;

function stopSearch() {
  if (!search) return;
  search.worker.terminate();
  search = null;
  useStore.setState({ layoutSearch: false });
}

function startSearch(req: SearchRequest, crossings: number) {
  let worker: Worker;
  try {
    worker = new Worker(new URL('../layout/arrange.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return; // no workers here (e.g. opened from a file): Arrange's first answer stands
  }
  const me: Search = { worker, writing: false, animating: false, done: false, from: crossings, found: null };
  search = me;
  useStore.setState({ layoutSearch: true });
  const finish = () => {
    if (search !== me) return;
    if (me.found !== null)
      useStore.getState().toast(
        me.found < me.from ? `Found a cleaner arrangement · line crossings ${me.from} → ${me.found}` : `Found a more compact arrangement · ${me.found} line crossings`,
      );
    stopSearch();
  };
  const applyNext = async () => {
    if (me.animating || !me.pending) return;
    const { pos, crossings: n } = me.pending;
    me.pending = undefined;
    me.animating = true;
    await useStore.getState().animateTo(pos, { background: true });
    me.animating = false;
    if (search !== me) return;
    me.found = n;
    if (me.pending) void applyNext();
    else if (me.done) finish();
  };
  worker.onmessage = (e: MessageEvent<SearchMessage>) => {
    if (search !== me) return;
    if (e.data.type === 'done') {
      me.done = true;
      if (!me.animating && !me.pending) finish();
      return;
    }
    me.pending = { pos: new Map(e.data.pos.map(([id, x, y]) => [id, { x, y }])), crossings: e.data.crossings };
    void applyNext();
  };
  worker.onerror = () => search === me && stopSearch();
  worker.postMessage(req);
}

// Anything that changes the schema other than the search itself (undo, a drag, an edit, a load) ends it:
// its answer would be for a drawing that is no longer there.
useStore.subscribe((s, prev) => {
  if (search && !search.writing && s.schema !== prev.schema) stopSearch();
});

export function newGroupColor(schema: Schema): string {
  return paletteColor(schema.groups.length);
}
