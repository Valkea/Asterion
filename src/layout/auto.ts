// Auto-layout: ELK "layered" on a compound graph (groups contain tables, ports
// sit on the exact column rows) to minimise crossings, then locked tables are
// honoured by anchoring their group and pushing everything else out of the way.

import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { Schema } from '../model/types';
import { CARD_W, cardHeight, rowCenterY, type Detail, type Rect } from './geometry';
import { cellKey, clonePlan, depthRange, flowLinks, flowPlan, placeFlow, type FlowPlan } from './flow';
import { routedCrossings } from './routing';

export type Direction = 'RIGHT' | 'DOWN';
/** groups: islands per group, fewest crossings. flow: columns by dependency depth, groups as bands. */
export type ArrangeMode = 'groups' | 'flow';

export interface LayoutOptions {
  direction: Direction;
  /** Relations to leave out (e.g. drawn as portals). */
  hiddenRelations?: Set<string>;
  spacing?: number;
  /** Force one strategy instead of picking the best. */
  only?: Strategy;
  mode?: ArrangeMode;
  /** Flow only: pack each column instead of lining cards up with their links. */
  compact?: boolean;
  /** Detail level the lines are drawn at, so crossings are counted on the drawing the user sees. */
  detail?: Detail;
}

type Pos = { x: number; y: number };

let elkPromise: Promise<{ layout: (g: ElkNode) => Promise<ElkNode> }> | null = null;
function getElk() {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return elkPromise;
}

/** `current` keeps the drawing as it is, `islands-keep` keeps where each group sits and re-lays out its inside. */
export type Strategy = 'compound' | 'islands-down' | 'islands-right' | 'islands-stress' | 'islands-keep' | 'current' | 'flow';

export interface LayoutResult {
  pos: Map<string, Pos>;
  strategy: Strategy;
  crossings: number;
}

const TARGET_ASPECT = 1.7;

/** Lower is better: crossings dominate, then an elongated or sprawling drawing. */
function score(schema: Schema, pos: Map<string, Pos>, hidden: Set<string>, detail: Detail): { score: number; crossings: number } {
  // rounded like the final drawing: half a pixel can change how lines are routed
  const probe: Schema = {
    ...schema,
    tables: schema.tables.map((t) => {
      const p = pos.get(t.id);
      return p ? { ...t, x: Math.round(p.x), y: Math.round(p.y) } : t;
    }),
  };
  const crossings = routedCrossings(probe, hidden, detail);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
  for (const t of probe.tables) {
    const h = cardHeight(t, schema);
    x0 = Math.min(x0, t.x);
    y0 = Math.min(y0, t.y);
    x1 = Math.max(x1, t.x + CARD_W);
    y1 = Math.max(y1, t.y + h);
    area += CARD_W * h;
  }
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const aspect = Math.abs(Math.log(w / h / TARGET_ASPECT));
  const sprawl = (w * h) / Math.max(1, area);
  // empty room inside group frames: tall, airy groups cost a little
  const frames = new Map<string, [number, number, number, number]>();
  for (const t of probe.tables) {
    if (!t.groupId) continue;
    const f = frames.get(t.groupId) ?? [Infinity, Infinity, -Infinity, -Infinity];
    frames.set(t.groupId, [Math.min(f[0], t.x), Math.min(f[1], t.y), Math.max(f[2], t.x + CARD_W), Math.max(f[3], t.y + cardHeight(t, schema))]);
  }
  let framed = 0;
  for (const [fx0, fy0, fx1, fy1] of frames.values()) framed += (fx1 - fx0) * (fy1 - fy0);
  return { score: crossings + aspect * 10 + sprawl * 1.5 + (framed / Math.max(1, area)) * 1.5, crossings };
}

export async function autoLayout(schema: Schema, opts: LayoutOptions): Promise<Map<string, Pos>> {
  return (await autoLayoutDetailed(schema, opts)).pos;
}

/** Try several strategies, polish the most promising ones, and keep the cleanest drawing (never one with more crossings than now). */
export async function autoLayoutDetailed(schema: Schema, opts: LayoutOptions): Promise<LayoutResult> {
  const hidden = opts.hiddenRelations ?? new Set<string>();
  const detail = opts.detail ?? 'full';
  if (opts.mode === 'flow' || opts.only === 'flow') {
    const plan = flowPlan(schema, hidden);
    const placed = placeFlow(schema, plan, opts.direction, hidden, opts.compact);
    const best = opts.only ? { pos: placed, ...score(schema, placed, hidden, detail) } : await refineFlow(schema, plan, opts.direction, hidden, detail, performance.now() + REFINE_MS, opts.compact);
    return { pos: finalize(schema, best.pos), strategy: 'flow', crossings: best.crossings };
  }
  const placed = schema.tables.length > 1 && schema.tables.some((t) => t.x || t.y);
  const strategies: Strategy[] = opts.only
    ? [opts.only]
    : schema.groups.length
      ? ['islands-down', 'islands-right', 'islands-stress', 'compound', ...(placed ? (['islands-keep', 'current'] as const) : [])]
      : ['compound', ...(placed ? (['current'] as const) : [])];
  const candidates: (LayoutResult & { score: number })[] = [];
  for (const strategy of strategies) {
    const raw =
      strategy === 'current'
        ? new Map(schema.tables.map((t) => [t.id, { x: t.x, y: t.y }]))
        : strategy === 'compound'
          ? await compoundLayout(schema, opts)
          : await islandsLayout(schema, opts, strategy);
    // a hand-made drawing stays as it is unless tables sit too close
    if (strategy !== 'current' || crowded(schema, raw)) spaceOut(schema, raw);
    const sc = score(schema, raw, hidden, detail);
    candidates.push({ pos: raw, strategy, crossings: sc.crossings, score: sc.score });
  }
  // polish the best few; `current` always, so a hand-made drawing can only get better
  const better = (a: { crossings: number; score: number }, b: { crossings: number; score: number }) => a.crossings - b.crossings || a.score - b.score;
  candidates.sort(better);
  const polish = candidates.filter((c, i) => i < 2 || c.strategy === 'current' || c.strategy === 'islands-keep');
  if (!opts.only) {
    const end = performance.now() + REFINE_MS;
    for (const [i, c] of polish.entries()) {
      await new Promise((r) => setTimeout(r)); // let the UI breathe
      Object.assign(c, refineBlocks(schema, c.pos, hidden, detail, performance.now() + (end - performance.now()) / (polish.length - i)));
    }
  }
  const best = candidates.sort(better)[0];
  if (!opts.only) Object.assign(best, refineBlocks(schema, best.pos, hidden, detail, performance.now() + COMPACT_MS, true));
  const pos = finalize(schema, best.pos);
  return { pos, strategy: best.strategy, crossings: best.crossings };
}

/** Time the local search may take in total, so big schemas stay responsive. */
const REFINE_MS = 1500;
/** Extra time for closing up gaps in the winning drawing. */
const COMPACT_MS = 500;

/**
 * Local search on a flow plan, keeping its promise that lines run from referenced to referencing:
 * swap two bands, swap neighbours in a cell, or move a table one column within its allowed range.
 */
async function refineFlow(schema: Schema, start: FlowPlan, direction: Direction, hidden: Set<string>, detail: Detail, deadline: number, compact = false) {
  const links = flowLinks(schema, hidden);
  const moves: ((p: FlowPlan) => boolean)[] = [];
  for (let i = 0; i < start.bands.length; i++)
    for (let j = i + 1; j < start.bands.length; j++)
      moves.push((p) => {
        [p.bands[i], p.bands[j]] = [p.bands[j], p.bands[i]];
        return true;
      });
  for (const t of schema.tables) {
    // swap with the next table of its cell
    moves.push((p) => {
      const cell = p.cells.get(cellKey(p.bandOf.get(t.id)!, p.depth.get(t.id)!))!;
      const i = cell.indexOf(t.id);
      if (i < 0 || i === cell.length - 1) return false;
      [cell[i], cell[i + 1]] = [cell[i + 1], cell[i]];
      return true;
    });
    for (const step of [-1, 1])
      moves.push((p) => {
        const d = p.depth.get(t.id)!;
        const [lo, hi] = depthRange(t.id, p.depth, links, p.maxDepth);
        const to = d + step;
        if (to < lo || to > hi) return false;
        const b = p.bandOf.get(t.id)!;
        const from = p.cells.get(cellKey(b, d))!;
        const i = from.indexOf(t.id);
        from.splice(i, 1);
        const into = p.cells.get(cellKey(b, to))!;
        into.splice(Math.min(i, into.length), 0, t.id);
        p.depth.set(t.id, to);
        return true;
      });
  }
  let n = 0;
  const better = (a: { crossings: number; score: number }, b: { crossings: number; score: number }) =>
    a.crossings < b.crossings || (a.crossings === b.crossings && a.score < b.score - 1e-6);
  const climb = async (from: FlowPlan) => {
    let plan = from;
    let pos = placeFlow(schema, plan, direction, hidden, compact);
    let cur = score(schema, pos, hidden, detail);
    let improved = true;
    while (improved && performance.now() < deadline) {
      improved = false;
      for (const move of moves) {
        if (performance.now() >= deadline) break;
        if (++n % 50 === 0) await new Promise((r) => setTimeout(r)); // let the UI breathe
        const next = clonePlan(plan);
        if (!move(next)) continue;
        const nextPos = placeFlow(schema, next, direction, hidden, compact);
        const sc = score(schema, nextPos, hidden, detail);
        if (better(sc, cur)) {
          plan = next;
          pos = nextPos;
          cur = sc;
          improved = true;
        }
      }
    }
    return { plan, pos, ...cur };
  };
  // climb, then keep kicking the best plan with a few random moves and climbing again
  let best = await climb(start);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  while (performance.now() < deadline) {
    const kicked = clonePlan(best.plan);
    for (let k = 0; k < 3 + Math.floor(rand() * 4); k++) moves[Math.floor(rand() * moves.length)](kicked);
    const r = await climb(kicked);
    if (better(r, best)) best = r;
  }
  return { pos: best.pos, crossings: best.crossings, score: best.score };
}

const clonePos = (pos: Map<string, Pos>) => new Map([...pos].map(([k, p]) => [k, { ...p }]));

/**
 * Local search on whole blocks (groups and lone tables): mirror a block, or swap two blocks,
 * and keep the move whenever the drawing gets cleaner. ELK places blocks as boxes and can't
 * see which side of a group a line enters; this is where most leftover crossings come from.
 */
export function refineBlocks(schema: Schema, start: Map<string, Pos>, hidden: Set<string>, detail: Detail = 'full', deadline = Infinity, slidesOnly = false): { pos: Map<string, Pos>; crossings: number; score: number } {
  const blocks = new Map<string, string[]>();
  for (const t of schema.tables) {
    const k = t.groupId ? `g:${t.groupId}` : t.id;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(t.id);
  }
  // blocks holding a locked table get pinned back by honourLocks, so moving them gains nothing
  const isLocked = isLockedFn(schema);
  const locked = new Set(schema.tables.filter(isLocked).map((t) => t.id));
  const list = [...blocks.values()].filter((ids) => !ids.some((id) => locked.has(id)));
  const heightOf = new Map(schema.tables.map((t) => [t.id, cardHeight(t, schema)]));
  let pos = clonePos(start);
  let cur = score(schema, pos, hidden, detail);
  const flip = (p: Map<string, Pos>, ids: string[], axis: 'x' | 'y') => {
    const size = (id: string) => (axis === 'x' ? CARD_W : heightOf.get(id)!);
    const lo = Math.min(...ids.map((id) => p.get(id)![axis]));
    const hi = Math.max(...ids.map((id) => p.get(id)![axis] + size(id)));
    for (const id of ids) p.get(id)![axis] = lo + hi - p.get(id)![axis] - size(id);
  };
  const center = (p: Map<string, Pos>, ids: string[]) => {
    const r = bounds(ids, schema, p);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };
  const moves: ((p: Map<string, Pos>) => void)[] = [];
  for (const ids of list) {
    if (ids.length > 1) moves.push((p) => flip(p, ids, 'x'), (p) => flip(p, ids, 'y'));
  }
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      moves.push((p) => {
        const ca = center(p, a);
        const cb = center(p, b);
        for (const id of a) {
          p.get(id)!.x += cb.x - ca.x;
          p.get(id)!.y += cb.y - ca.y;
        }
        for (const id of b) {
          p.get(id)!.x += ca.x - cb.x;
          p.get(id)!.y += ca.y - cb.y;
        }
        removeBlockOverlaps(schema, p, () => false);
      });
    }
  /** Whether the group holding `id` now reaches into another block's frame (moves inside a group only check cards). */
  const intrudes = (p: Map<string, Pos>, id: string) => {
    const mine = list.find((b) => b.includes(id)) ?? [id];
    const m = bounds(mine, schema, p);
    return [...blocks.values()].some((b) => {
      if (b === mine) return false;
      const o = bounds(b, schema, p);
      return m.x < o.x + o.w && o.x < m.x + m.w && m.y < o.y + o.h && o.y < m.y + m.h;
    });
  };
  // swap two tables of one group, when their cards fit each other's spot
  const overlapsAny = (p: Map<string, Pos>, id: string) => {
    const a = p.get(id)!;
    const ha = heightOf.get(id)!;
    return schema.tables.some((t) => {
      if (t.id === id) return false;
      const b = p.get(t.id)!;
      return a.x < b.x + CARD_W + MIN_GAP_X && b.x < a.x + CARD_W + MIN_GAP_X && a.y < b.y + heightOf.get(t.id)! + MIN_GAP_Y && b.y < a.y + ha + MIN_GAP_Y;
    });
  };
  for (const ids of list)
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        moves.push((p) => {
          const pa = p.get(a)!;
          const pb = p.get(b)!;
          // keep vertical centres so cards of different heights stay in their row
          const ya = pa.y + heightOf.get(a)! / 2;
          const yb = pb.y + heightOf.get(b)! / 2;
          [pa.x, pb.x] = [pb.x, pa.x];
          pa.y = yb - heightOf.get(a)! / 2;
          pb.y = ya - heightOf.get(b)! / 2;
          if (overlapsAny(p, a) || overlapsAny(p, b) || intrudes(p, a)) p.clear();
        });
      }
  // slide a table toward its group's centre, or a block toward the drawing's centre, until it touches something
  if (slidesOnly) moves.length = 0;
  // cards side by side need room for line lanes between them; stacked ones don't
  const GAP = 32;
  const GAP_X = 100;
  const rectOf = (p: Map<string, Pos>, id: string) => ({ ...p.get(id)!, w: CARD_W, h: heightOf.get(id)! });
  /** Free distance from `mine` to the nearest obstacle ahead: other cards for a table, other blocks' frames for a block. */
  const room = (p: Map<string, Pos>, mine: string[], asBlock: boolean, axis: 'x' | 'y', dir: number) => {
    const own = new Set(mine);
    const m = asBlock ? bounds(mine, schema, p) : rectOf(p, mine[0]);
    const others = asBlock
      ? [...blocks.values()].filter((b) => !b.some((id) => own.has(id))).map((b) => bounds(b, schema, p))
      : schema.tables.filter((t) => !own.has(t.id)).map((t) => rectOf(p, t.id));
    const gap = asBlock ? MARGIN : axis === 'x' ? GAP_X : GAP;
    const across = asBlock ? MARGIN : axis === 'x' ? GAP : GAP_X;
    const len = (r: Rect) => (axis === 'x' ? r.w : r.h);
    let free = Infinity;
    for (const o of others) {
      const [a, sa, b, sb] = axis === 'x' ? [m.y, m.h, o.y, o.h] : [m.x, m.w, o.x, o.w];
      if (a >= b + sb + across || b >= a + sa + across) continue; // not in the way
      if (dir > 0 && o[axis] >= m[axis] + len(m)) free = Math.min(free, o[axis] - m[axis] - len(m) - gap);
      if (dir < 0 && o[axis] + len(o) <= m[axis]) free = Math.min(free, m[axis] - o[axis] - len(o) - gap);
    }
    return Math.max(0, free);
  };
  const slide = (p: Map<string, Pos>, ids: string[], asBlock: boolean, target: Pos, axis: 'x' | 'y') => {
    const c = center(p, ids);
    const want = target[axis] - c[axis];
    if (Math.abs(want) < 8) return p.clear();
    const d = Math.sign(want) * Math.min(Math.abs(want), room(p, ids, asBlock, axis, Math.sign(want)));
    if (Math.abs(d) < 8) return p.clear();
    for (const id of ids) p.get(id)![axis] += d;
  };
  for (const ids of list) {
    if (ids.length < 2) continue;
    for (const id of ids)
      for (const axis of ['x', 'y'] as const)
        moves.push((p) => {
          const r = bounds(ids, schema, p);
          slide(p, [id], false, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, axis);
        });
  }
  // move a table into a free spot of another column of its group, wherever that shrinks the group most
  const fits = (p: Map<string, Pos>, id: string, at: Pos) =>
    schema.tables.every((t) => {
      if (t.id === id) return true;
      const o = p.get(t.id)!;
      return at.x >= o.x + CARD_W + GAP_X || o.x >= at.x + CARD_W + GAP_X || at.y >= o.y + heightOf.get(t.id)! + GAP || o.y >= at.y + heightOf.get(id)! + GAP;
    });
  for (const ids of list) {
    if (ids.length < 2) continue;
    for (const id of ids)
      moves.push((p) => {
        const others = ids.filter((x) => x !== id);
        const area = (at: Pos) => {
          const r = bounds([...others, id], schema, new Map([...p, [id, at]]));
          return r.w * r.h;
        };
        const was = area(p.get(id)!);
        const h = heightOf.get(id)!;
        const top = Math.min(...others.map((o) => p.get(o)!.y));
        let best: { at: Pos; area: number } | null = null;
        for (const x of new Set(others.map((o) => p.get(o)!.x))) {
          const ys = [top, ...others.filter((o) => p.get(o)!.x === x).flatMap((o) => [p.get(o)!.y + heightOf.get(o)! + GAP, p.get(o)!.y - GAP - h])];
          for (const y of ys) {
            const at = { x, y };
            if (x === p.get(id)!.x || !fits(p, id, at)) continue;
            const a = area(at);
            if (a < was - 1 && (!best || a < best.area)) best = { at, area: a };
          }
        }
        if (!best) return p.clear();
        p.set(id, best.at);
        if (intrudes(p, id)) p.clear();
      });
  }
  for (const ids of list)
    for (const axis of ['x', 'y'] as const)
      moves.push((p) => {
        const all = bounds(schema.tables.map((t) => t.id), schema, p);
        slide(p, ids, true, { x: all.x + all.w / 2, y: all.y + all.h / 2 }, axis);
      });
  let improved = true;
  while (improved && performance.now() < deadline) {
    improved = false;
    for (const move of moves) {
      if (performance.now() >= deadline) break;
      const next = clonePos(pos);
      move(next);
      if (!next.size) continue; // move not possible here
      const sc = score(schema, next, hidden, detail);
      if (sc.crossings < cur.crossings || (sc.crossings === cur.crossings && sc.score < cur.score - 1e-6)) {
        pos = next;
        cur = sc;
        improved = true;
      }
    }
  }
  return { pos, ...cur };
}

function isLockedFn(schema: Schema) {
  const groupLocked = new Set(schema.groups.filter((g) => g.locked).map((g) => g.id));
  return (t: Schema['tables'][number]) => !!t.locked || (!!t.groupId && groupLocked.has(t.groupId));
}

/** Anchor to locked tables, or keep the drawing where it was so the camera doesn't jump. */
function finalize(schema: Schema, pos: Map<string, Pos>): Map<string, Pos> {
  const isLocked = isLockedFn(schema);
  if (schema.tables.some(isLocked)) return honourLocks(schema, pos, isLocked);
  if (crowded(schema, pos)) spaceOut(schema, pos);
  const minOf = (vals: number[]) => (vals.length ? Math.min(...vals) : 0);
  const dx = minOf(schema.tables.map((t) => t.x)) - minOf([...pos.values()].map((p) => p.x));
  const dy = minOf(schema.tables.map((t) => t.y)) - minOf([...pos.values()].map((p) => p.y));
  for (const p of pos.values()) {
    p.x = Math.round(p.x + dx);
    p.y = Math.round(p.y + dy);
  }
  return pos;
}

async function compoundLayout(schema: Schema, opts: LayoutOptions): Promise<Map<string, Pos>> {
  const elk = await getElk();
  const spacing = opts.spacing ?? 1;
  const horizontal = opts.direction === 'RIGHT';
  const hidden = opts.hiddenRelations ?? new Set<string>();
  const rels = schema.relations.filter((r) => !hidden.has(r.id) && r.from.table !== r.to.table);

  const usedCols = new Set<string>();
  for (const r of rels) {
    usedCols.add(r.from.columns[0]);
    usedCols.add(r.to.columns[0]);
  }

  const tableNode = (t: Schema['tables'][number]): ElkNode => portsFor(schema, t, usedCols, horizontal);

  const groupIds = new Set(schema.groups.map((g) => g.id));
  const children: ElkNode[] = [];
  for (const g of schema.groups) {
    const members = schema.tables.filter((t) => t.groupId === g.id);
    if (!members.length) continue;
    children.push({
      id: `g:${g.id}`,
      children: members.map(tableNode),
      layoutOptions: { 'elk.padding': '[top=72,left=36,bottom=36,right=36]' },
    });
  }
  for (const t of schema.tables) if (!t.groupId || !groupIds.has(t.groupId)) children.push(tableNode(t));

  const edges: ElkExtendedEdge[] = rels.map((r) => ({
    id: r.id,
    sources: [horizontal ? `${r.to.columns[0]}:E` : r.to.table],
    targets: [horizontal ? `${r.from.columns[0]}:W` : r.from.table],
  }));

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': opts.direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(110 * spacing)),
      'elk.spacing.nodeNode': String(Math.round(48 * spacing)),
      'elk.spacing.edgeNode': '24',
      'elk.spacing.componentComponent': String(Math.round(120 * spacing)),
      'elk.padding': '[top=40,left=40,bottom=40,right=40]',
    },
    children,
    edges,
  };

  const res = await elk.layout(graph);
  const pos = new Map<string, Pos>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      if (c.id.startsWith('g:')) walk(c, x, y);
      else pos.set(c.id, { x, y });
    }
  };
  walk(res, 0, 0);

  return pos;
}

function portsFor(schema: Schema, t: Schema['tables'][number], usedCols: Set<string>, horizontal: boolean): ElkNode {
  const ports: ElkPort[] = [];
  if (horizontal) {
    for (const c of t.columns) {
      if (!usedCols.has(c.id)) continue;
      const y = rowCenterY(t, c.id, schema) - 1;
      ports.push({ id: `${c.id}:E`, x: CARD_W, y, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'EAST' } });
      ports.push({ id: `${c.id}:W`, x: -1, y, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'WEST' } });
    }
  }
  return { id: t.id, width: CARD_W, height: cardHeight(t, schema), ports, layoutOptions: horizontal ? { 'elk.portConstraints': 'FIXED_POS' } : {} };
}

const GROUP_PAD = { top: 72, side: 36, bottom: 36 };

/** Phase 1: each group laid out on its own (left → right). Phase 2: the groups, as rigid islands, arranged in 2D. */
async function islandsLayout(schema: Schema, opts: LayoutOptions, strategy: Strategy): Promise<Map<string, Pos>> {
  const elk = await getElk();
  const spacing = opts.spacing ?? 1;
  const hidden = opts.hiddenRelations ?? new Set<string>();
  const rels = schema.relations.filter((r) => !hidden.has(r.id) && r.from.table !== r.to.table);
  const groupIds = new Set(schema.groups.map((g) => g.id));
  const blockOf = (t: Schema['tables'][number]) => (t.groupId && groupIds.has(t.groupId) ? `g:${t.groupId}` : `t:${t.id}`);
  const byId = new Map(schema.tables.map((t) => [t.id, t]));
  const blocks = new Map<string, Schema['tables']>();
  for (const t of schema.tables) {
    const b = blockOf(t);
    if (!blocks.has(b)) blocks.set(b, []);
    blocks.get(b)!.push(t);
  }

  // phase 1
  const local = new Map<string, Pos>();
  const size = new Map<string, { w: number; h: number }>();
  for (const [bid, members] of blocks) {
    if (members.length === 1) {
      local.set(members[0].id, { x: bid.startsWith('g:') ? GROUP_PAD.side : 0, y: bid.startsWith('g:') ? GROUP_PAD.top : 0 });
      const grouped = bid.startsWith('g:');
      size.set(bid, { w: CARD_W + (grouped ? GROUP_PAD.side * 2 : 0), h: cardHeight(members[0], schema) + (grouped ? GROUP_PAD.top + GROUP_PAD.bottom : 0) });
      continue;
    }
    const ids = new Set(members.map((m) => m.id));
    const inner = rels.filter((r) => ids.has(r.from.table) && ids.has(r.to.table));
    const used = new Set(inner.flatMap((r) => [r.from.columns[0], r.to.columns[0]]));
    const res = await elk.layout({
      id: bid,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(100 * spacing)),
        'elk.spacing.nodeNode': String(Math.round(40 * spacing)),
        'elk.spacing.componentComponent': String(Math.round(48 * spacing)),
        'elk.aspectRatio': '1.4',
        'elk.padding': `[top=${GROUP_PAD.top},left=${GROUP_PAD.side},bottom=${GROUP_PAD.bottom},right=${GROUP_PAD.side}]`,
      },
      children: members.map((m) => portsFor(schema, m, used, true)),
      edges: inner.map((r) => ({ id: r.id, sources: [`${r.to.columns[0]}:E`], targets: [`${r.from.columns[0]}:W`] })),
    });
    for (const c of res.children ?? []) local.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
    size.set(bid, { w: res.width ?? 0, h: res.height ?? 0 });
  }

  if (strategy === 'islands-keep') {
    const pos = new Map<string, Pos>();
    for (const [bid, members] of blocks) {
      const r = bounds(members.map((m) => m.id), schema, new Map(members.map((m) => [m.id, { x: m.x, y: m.y }])));
      const { w, h } = size.get(bid)!;
      const ox = r.x + r.w / 2 - w / 2;
      const oy = r.y + r.h / 2 - h / 2;
      for (const t of members) {
        const l = local.get(t.id)!;
        const grouped = bid.startsWith('g:');
        // lone tables are laid out without the group padding
        pos.set(t.id, { x: ox + l.x + (grouped ? 0 : 36), y: oy + l.y + (grouped ? 0 : 72) });
      }
    }
    return pos;
  }

  // phase 2: one edge per inter-island relation (parent island → child island)
  const outer = rels
    .map((r) => ({ id: r.id, s: blockOf(byId.get(r.to.table)!), t: blockOf(byId.get(r.from.table)!) }))
    .filter((e) => e.s !== e.t);
  const algo = strategy === 'islands-stress' ? 'stress' : 'layered';
  const res = await elk.layout({
    id: 'root',
    layoutOptions:
      algo === 'stress'
        ? { 'elk.algorithm': 'stress', 'elk.stress.desiredEdgeLength': String(Math.round(260 * spacing)), 'elk.stress.dimension': 'XY' }
        : {
            'elk.algorithm': 'layered',
            'elk.direction': strategy === 'islands-down' ? 'DOWN' : 'RIGHT',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(120 * spacing)),
            'elk.spacing.nodeNode': String(Math.round(90 * spacing)),
            'elk.spacing.componentComponent': String(Math.round(120 * spacing)),
            'elk.layered.wrapping.strategy': 'MULTI_EDGE',
            'elk.aspectRatio': String(TARGET_ASPECT),
          },
    children: [...blocks.keys()].map((b) => ({ id: b, width: size.get(b)!.w, height: size.get(b)!.h })),
    edges: outer.map((e) => ({ id: e.id, sources: [e.s], targets: [e.t] })),
  });
  const pos = new Map<string, Pos>();
  for (const c of res.children ?? []) {
    for (const t of blocks.get(c.id) ?? []) {
      const l = local.get(t.id)!;
      // group padding is part of the island; table coordinates are absolute
      pos.set(t.id, { x: (c.x ?? 0) + l.x, y: (c.y ?? 0) + l.y });
    }
  }
  return pos;
}

interface Block {
  ids: string[];
  fixed: boolean;
  rect: Rect;
}

const MARGIN = 48;
/** Least room between two tables an arrangement leaves: side by side, both lines' stubs fit (router STUB + CLEARANCE)… */
const MIN_GAP_X = 44;
/** …stacked, a line still passes between them. Hand-placed (locked) tables may sit closer. */
const MIN_GAP_Y = 30;

function honourLocks(schema: Schema, pos: Map<string, Pos>, isLocked: (t: Schema['tables'][number]) => boolean): Map<string, Pos> {
  const byId = new Map(schema.tables.map((t) => [t.id, t]));
  // blocks: one per group, one per ungrouped table
  const blocks = new Map<string, string[]>();
  for (const t of schema.tables) {
    const k = t.groupId ? `g:${t.groupId}` : t.id;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(t.id);
  }
  const out: Block[] = [];
  for (const ids of blocks.values()) {
    const locked = ids.filter((id) => isLocked(byId.get(id)!));
    if (locked.length) {
      // least-squares translation that brings locked tables back home
      let dx = 0;
      let dy = 0;
      for (const id of locked) {
        dx += byId.get(id)!.x - pos.get(id)!.x;
        dy += byId.get(id)!.y - pos.get(id)!.y;
      }
      dx /= locked.length;
      dy /= locked.length;
      for (const id of ids) {
        const p = pos.get(id)!;
        p.x += dx;
        p.y += dy;
      }
      for (const id of locked) pos.set(id, { x: byId.get(id)!.x, y: byId.get(id)!.y });
      separateWithin(ids, schema, pos, new Set(locked));
    }
    out.push({ ids, fixed: locked.length > 0, rect: bounds(ids, schema, pos) });
  }

  separateBlocks(out, pos);
  return pos;
}

/** Push blocks (groups / lone tables) apart until nothing overlaps. Fixed blocks never move. */
function separateBlocks(out: Block[], pos: Map<string, Pos>) {
  for (let iter = 0; iter < 400; iter++) {
    let moved = false;
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const A = out[i];
        const B = out[j];
        if (A.fixed && B.fixed) continue;
        const ox = Math.min(A.rect.x + A.rect.w, B.rect.x + B.rect.w) - Math.max(A.rect.x, B.rect.x) + MARGIN;
        const oy = Math.min(A.rect.y + A.rect.h, B.rect.y + B.rect.h) - Math.max(A.rect.y, B.rect.y) + MARGIN;
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const alongX = ox < oy;
        const amount = alongX ? ox : oy;
        const sign = alongX ? Math.sign(B.rect.x + B.rect.w / 2 - (A.rect.x + A.rect.w / 2)) || 1 : Math.sign(B.rect.y + B.rect.h / 2 - (A.rect.y + A.rect.h / 2)) || 1;
        const shareA = A.fixed ? 0 : B.fixed ? 1 : 0.5;
        shift(A, -sign * amount * shareA, alongX, pos);
        shift(B, sign * amount * (1 - shareA), alongX, pos);
      }
    if (!moved) break;
  }
}

export function removeBlockOverlaps(schema: Schema, pos: Map<string, Pos>, isFixed: (ids: string[]) => boolean) {
  const blocks = new Map<string, string[]>();
  for (const t of schema.tables) {
    const k = t.groupId ? `g:${t.groupId}` : t.id;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(t.id);
  }
  const out: Block[] = [...blocks.values()].map((ids) => ({ ids, fixed: isFixed(ids), rect: bounds(ids, schema, pos) }));
  separateBlocks(out, pos);
}

function shift(b: Block, d: number, alongX: boolean, pos: Map<string, Pos>) {
  if (!d) return;
  for (const id of b.ids) {
    const p = pos.get(id)!;
    if (alongX) p.x += d;
    else p.y += d;
  }
  if (alongX) b.rect.x += d;
  else b.rect.y += d;
}

function bounds(ids: string[], schema: Schema, pos: Map<string, Pos>): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const t = schema.tables.find((x) => x.id === id)!;
    const p = pos.get(id)!;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + CARD_W);
    y1 = Math.max(y1, p.y + cardHeight(t, schema));
  }
  // room for the group label above
  return { x: x0 - 36, y: y0 - 72, w: x1 - x0 + 72, h: y1 - y0 + 108 };
}

/** Whether two tables sit closer than MIN_GAP_X / MIN_GAP_Y. */
function crowded(schema: Schema, pos: Map<string, Pos>): boolean {
  const rects = schema.tables.map((t) => ({ ...pos.get(t.id)!, h: cardHeight(t, schema) }));
  return rects.some((a, i) =>
    rects.some((b, j) => j > i && a.x < b.x + CARD_W + MIN_GAP_X && b.x < a.x + CARD_W + MIN_GAP_X && a.y < b.y + b.h + MIN_GAP_Y && b.y < a.y + a.h + MIN_GAP_Y),
  );
}

/**
 * Blocks apart first (their frames keep tables of different blocks far apart), then tables of a block
 * at least MIN_GAP_X / MIN_GAP_Y from each other, and blocks apart again if that made one grow into another.
 */
function spaceOut(schema: Schema, pos: Map<string, Pos>) {
  removeBlockOverlaps(schema, pos, () => false);
  const blocks = new Map<string, string[]>();
  for (const t of schema.tables) {
    const k = t.groupId ? `g:${t.groupId}` : t.id;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(t.id);
  }
  let moved = false;
  for (const ids of blocks.values()) if (ids.length > 1 && separateWithin(ids, schema, pos, new Set())) moved = true;
  if (moved) removeBlockOverlaps(schema, pos, () => false);
}

function separateWithin(ids: string[], schema: Schema, pos: Map<string, Pos>, fixed: Set<string>): boolean {
  const heightOf = new Map(schema.tables.map((t) => [t.id, cardHeight(t, schema)]));
  const rect = (id: string): Rect => {
    const p = pos.get(id)!;
    return { x: p.x, y: p.y, w: CARD_W, h: heightOf.get(id)! };
  };
  let any = false;
  for (let iter = 0; iter < 200; iter++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        if (fixed.has(a) && fixed.has(b)) continue;
        const A = rect(a);
        const B = rect(b);
        const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) + MIN_GAP_X;
        const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) + MIN_GAP_Y;
        if (ox <= 0 || oy <= 0) continue;
        moved = any = true;
        const alongX = ox < oy;
        const amt = (alongX ? ox : oy) + 1; // + 1: still enough once positions are rounded
        const sign = alongX ? Math.sign(B.x - A.x) || 1 : Math.sign(B.y - A.y) || 1;
        const sa = fixed.has(a) ? 0 : fixed.has(b) ? 1 : 0.5;
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        if (alongX) {
          pa.x -= sign * amt * sa;
          pb.x += sign * amt * (1 - sa);
        } else {
          pa.y -= sign * amt * sa;
          pb.y += sign * amt * (1 - sa);
        }
      }
    if (!moved) break;
  }
  return any;
}
