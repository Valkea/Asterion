// Schema → router input: cards, region frames and one line per drawn relation.

import type { Schema, Table } from '../model/types';
import { CARD_W, cardHeight, HEADER_H, rowCenterY, type Detail } from './geometry';
import { countRouteCrossings, routeEdges, type Route, type RouterCard, type RouterEdge, type RouterRegion } from './router';

/** Region frame around a group's tables (same padding as the Atlas region node). */
export function regionFrame(schema: Schema, groupId: string, detail: Detail) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of schema.tables) {
    if (t.groupId !== groupId) continue;
    x0 = Math.min(x0, t.x);
    y0 = Math.min(y0, t.y);
    x1 = Math.max(x1, t.x + CARD_W);
    y1 = Math.max(y1, t.y + cardHeight(t, schema, detail));
  }
  if (x0 === Infinity) return null;
  const pad = 28;
  const top = detail === 'compact' ? 64 : 56;
  return { x: x0 - pad, y: y0 - top, w: x1 - x0 + pad * 2, h: y1 - y0 + top + pad };
}

/** Room between two columns' points on a far-zoom block: line-end markers reach 7px either side. */
const BLOCK_PORT_STEP = 16;

/**
 * Far zoom draws no rows, so every line would start from the middle of its block's side, on top of the
 * others. Instead each column with lines gets its own point around the middle, in the order of where
 * its lines go (higher ones higher), so lines from different columns leave side by side without crossing.
 * Returns the y offset from the card top, by `table:column`.
 */
function blockPorts(schema: Schema, edges: { f: Table; fc: string; t: Table; tc: string }[]): Map<string, number> {
  const mid = (t: Table) => t.y + cardHeight(t, schema, 'full') / 2;
  const toward = new Map<string, Map<string, number[]>>();
  const add = (t: Table, col: string, y: number) => {
    let cols = toward.get(t.id);
    if (!cols) toward.set(t.id, (cols = new Map()));
    const ys = cols.get(col);
    if (ys) ys.push(y);
    else cols.set(col, [y]);
  };
  for (const { f, fc, t, tc } of edges) {
    add(f, fc, mid(t));
    add(t, tc, mid(f));
  }
  const out = new Map<string, number>();
  for (const t of schema.tables) {
    const cols = toward.get(t.id);
    if (!cols) continue;
    const h = cardHeight(t, schema, 'full');
    const avg = (ys: number[]) => ys.reduce((a, b) => a + b, 0) / ys.length;
    const order = [...cols].map(([col, ys]) => ({ col, y: avg(ys) })).sort((a, b) => a.y - b.y || (a.col < b.col ? -1 : 1));
    const step = Math.min(BLOCK_PORT_STEP, (h - HEADER_H) / order.length);
    order.forEach(({ col }, i) => out.set(`${t.id}:${col}`, Math.round(h / 2 + (i - (order.length - 1) / 2) * step)));
  }
  return out;
}

export function routeSchema(schema: Schema, detail: Detail, hidden: Set<string> = new Set()): Map<string, Route> {
  const groupIds = new Set(schema.groups.map((g) => g.id));
  const cards: RouterCard[] = schema.tables.map((t) => ({
    id: t.id,
    x: t.x,
    y: t.y,
    w: CARD_W,
    h: cardHeight(t, schema, detail),
    region: t.groupId && groupIds.has(t.groupId) ? t.groupId : undefined,
  }));
  const regions: RouterRegion[] = [];
  for (const g of schema.groups) {
    const f = regionFrame(schema, g.id, detail);
    if (f) regions.push({ id: g.id, ...f });
  }
  const byId = new Map(schema.tables.map((t) => [t.id, t]));
  const drawn: { id: string; f: Table; fc: string; t: Table; tc: string }[] = [];
  for (const r of schema.relations) {
    if (hidden.has(r.id)) continue;
    const f = byId.get(r.from.table);
    const t = byId.get(r.to.table);
    if (f && t) drawn.push({ id: r.id, f, fc: r.from.columns[0], t, tc: r.to.columns[0] });
  }
  const ports = detail === 'compact' ? blockPorts(schema, drawn) : null;
  const rowY = (t: Table, col: string) => t.y + (ports?.get(`${t.id}:${col}`) ?? rowCenterY(t, col, schema, detail));
  const edges: RouterEdge[] = drawn.map(({ id, f, fc, t, tc }) => ({
    id,
    net: `${t.id}:${tc}`,
    src: { card: f.id, y: rowY(f, fc) },
    dst: { card: t.id, y: rowY(t, tc) },
  }));
  return routeEdges({ cards, regions, edges });
}

/** Line crossings as drawn (after routing) at the given detail level. */
export function routedCrossings(schema: Schema, hidden: Set<string> = new Set(), detail: Detail = 'full'): number {
  return countRouteCrossings(routeSchema(schema, detail, hidden));
}
