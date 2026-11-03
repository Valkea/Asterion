import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSql } from '../src/sql/parser';
import { suggestGroups } from '../src/layout/cluster';
import { autoLayout } from '../src/layout/auto';
import { CARD_W, cardHeight } from '../src/layout/geometry';
import { routeSchema, regionFrame } from '../src/layout/routing';
import { countRouteCrossings, routeEdges, type Route } from '../src/layout/router';
import type { Schema } from '../src/model/types';

// private reference schema, not in the repo: SCHEMA_DIR=/path/to/dir with schema-v15.sql
const REF = `${process.env.SCHEMA_DIR ?? '.missing'}/schema-v15.sql`;

type Seg = [number, number, number, number];
const segsOf = (r: Route): Seg[] => r.points.slice(1).map((p, i) => [r.points[i].x, r.points[i].y, p.x, p.y]);

/** Segments that cut through a card interior (ignoring the line's own end stubs). */
function cardHits(s: Schema, routes: Map<string, Route>): string[] {
  const hits: string[] = [];
  for (const [id, r] of routes) {
    const segs = segsOf(r);
    segs.forEach(([x1, y1, x2, y2], k) => {
      for (const t of s.tables) {
        const h = cardHeight(t, s);
        const ax = Math.min(x1, x2), bx = Math.max(x1, x2), ay = Math.min(y1, y2), by = Math.max(y1, y2);
        if (bx <= t.x + 0.5 || ax >= t.x + CARD_W - 0.5 || by <= t.y + 0.5 || ay >= t.y + h - 0.5) continue;
        hits.push(`${id}#${k} through ${t.name}`);
      }
    });
  }
  return hits;
}

/** Collinear overlapping segments of different nets (lines drawn on top of each other). */
function overlaps(routes: Map<string, Route>, net: Map<string, string>, log?: (m: string) => void): number {
  const all: { s: Seg; net: string; id: string; k: number; last: number }[] = [];
  for (const [id, r] of routes) segsOf(r).forEach((s, k, arr) => all.push({ s, net: net.get(id)!, id, k, last: arr.length - 1 }));
  let n = 0;
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const A = all[i], B = all[j];
      if (A.net === B.net) continue;
      const [a1, a2, a3, a4] = A.s, [b1, b2, b3, b4] = B.s;
      if (a1 === a3 && b1 === b3 && Math.abs(a1 - b1) < 3) {
        if (Math.min(Math.max(a2, a4), Math.max(b2, b4)) - Math.max(Math.min(a2, a4), Math.min(b2, b4)) > 4) {
          n++;
          log?.(`V ${A.id}#${A.k}/${A.last} ${JSON.stringify(A.s)} ~ ${B.id}#${B.k}/${B.last} ${JSON.stringify(B.s)}`);
        }
      } else if (a2 === a4 && b2 === b4 && Math.abs(a2 - b2) < 3) {
        if (Math.min(Math.max(a1, a3), Math.max(b1, b3)) - Math.max(Math.min(a1, a3), Math.min(b1, b3)) > 4) {
          n++;
          log?.(`H ${A.id}#${A.k}/${A.last} ${JSON.stringify(A.s)} ~ ${B.id}#${B.k}/${B.last} ${JSON.stringify(B.s)}`);
        }
      }
    }
  return n;
}

function toSvg(s: Schema, routes: Map<string, Route>): string {
  const xs = s.tables.flatMap((t) => [t.x, t.x + CARD_W]);
  const ys = s.tables.flatMap((t) => [t.y, t.y + cardHeight(t, s)]);
  const x0 = Math.min(...xs) - 150, y0 = Math.min(...ys) - 150;
  const w = Math.max(...xs) - x0 + 150, h = Math.max(...ys) - y0 + 150;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" width="${w}" height="${h}" style="background:#0b0d12">`];
  for (const g of s.groups) {
    const f = regionFrame(s, g.id, 'full');
    if (f) parts.push(`<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="18" fill="${g.color}" fill-opacity=".07" stroke="${g.color}" stroke-opacity=".3"/>`);
  }
  for (const t of s.tables) parts.push(`<rect x="${t.x}" y="${t.y}" width="${CARD_W}" height="${cardHeight(t, s)}" rx="8" fill="#161a22" stroke="#2a3040"/><text x="${t.x + 12}" y="${t.y + 28}" fill="#cfd6e4" font-family="monospace" font-size="15">${t.name}</text>`);
  const hues = [200, 140, 30, 280, 340, 60, 170, 0, 240, 100];
  let k = 0;
  for (const r of routes.values()) {
    const d = r.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="hsl(${hues[k++ % hues.length]} 70% 62%)" stroke-width="2"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

describe('router', () => {
  it('goes around a card in the way', () => {
    const routes = routeEdges({
      cards: [
        { id: 'a', x: 0, y: 0, w: 100, h: 100 },
        { id: 'b', x: 400, y: 0, w: 100, h: 100 },
        { id: 'wall', x: 200, y: -200, w: 100, h: 400 },
      ],
      edges: [{ id: 'e', net: 'n', src: { card: 'a', y: 50 }, dst: { card: 'b', y: 50 } }],
    });
    const r = routes.get('e')!;
    expect(r.srcSide).toBe('R');
    expect(r.dstSide).toBe('L');
    for (const p of r.points) expect(p.x > 200 && p.x < 300 && p.y > -200 && p.y < 200).toBe(false);
  });

  it('separates lines that share a corridor', () => {
    const routes = routeEdges({
      cards: [
        { id: 'a', x: 0, y: 0, w: 100, h: 200 },
        { id: 'b', x: 300, y: 0, w: 100, h: 200 },
      ],
      edges: [
        { id: 'e1', net: 'n1', src: { card: 'a', y: 20 }, dst: { card: 'b', y: 180 } },
        { id: 'e2', net: 'n2', src: { card: 'a', y: 180 }, dst: { card: 'b', y: 20 } },
        { id: 'e3', net: 'n3', src: { card: 'a', y: 100 }, dst: { card: 'b', y: 140 } },
      ],
    });
    const xs = [...routes.values()].map((r) => r.points.find((p, i) => i && r.points[i - 1].x === p.x)!.x);
    expect(new Set(xs).size).toBe(3);
  });

  it('links cards side by side through the narrow gap between them', () => {
    for (const gap of [8, 20, 43, 50]) {
      for (const [srcY, dstY] of [[139, 185], [20, 185], [150, 150]]) {
        const routes = routeEdges({
          cards: [
            { id: 'a', x: 0, y: 0, w: 288, h: 186, region: 'g' },
            { id: 'b', x: 288 + gap, y: 124, w: 288, h: 108, region: 'g' },
          ],
          regions: [{ id: 'g', x: -28, y: -56, w: 576 + gap + 56, h: 316 }],
          edges: [{ id: 'e', net: 'n', src: { card: 'a', y: srcY }, dst: { card: 'b', y: dstY } }],
        });
        const r = routes.get('e')!;
        expect([r.srcSide, r.dstSide]).toEqual(['R', 'L']);
        expect(r.points.length).toBe(srcY === dstY ? 2 : 4);
        for (const p of r.points) expect(p.x >= 288 && p.x <= 288 + gap).toBe(true);
      }
    }
  });

  it('gives each line its own lane in a narrow gap', () => {
    const routes = routeEdges({
      cards: [
        { id: 'a', x: 0, y: 0, w: 288, h: 212 },
        { id: 'b', x: 308, y: 124, w: 288, h: 108 },
      ],
      edges: [
        { id: 'e1', net: 'n1', src: { card: 'a', y: 139 }, dst: { card: 'b', y: 185 } },
        { id: 'e2', net: 'n2', src: { card: 'a', y: 165 }, dst: { card: 'b', y: 211 } },
      ],
    });
    const lane = (id: string) => routes.get(id)!.points[1].x;
    expect(lane('e1')).not.toBe(lane('e2'));
    expect(countRouteCrossings(routes)).toBe(0);
  });

  it('gives lines to the same column lanes of their own, meeting only on its stub', () => {
    const routes = routeEdges({
      cards: [
        { id: 't', x: 0, y: 0, w: 100, h: 60 },
        { id: 'a', x: 200, y: 200, w: 200, h: 100 },
        { id: 'b', x: 500, y: 200, w: 200, h: 100 },
        { id: 'c', x: 800, y: 200, w: 200, h: 100 },
      ],
      edges: ['a', 'b', 'c'].map((k) => ({ id: k, net: 't:id', src: { card: k, y: 250 }, dst: { card: 't', y: 30 } })),
    });
    // lines touch only within the stub out of the column (x 100 to 130), where they part
    const all = [...routes.values()];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        for (const [a1, a2, a3, a4] of segsOf(all[i]))
          for (const [b1, b2, b3, b4] of segsOf(all[j])) {
            const shared = (p: number, q: number, r: number, s: number) => Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s)) > 0;
            if (a2 === a4 && b2 === b4 && a2 === b2 && shared(a1, a3, b1, b3)) expect(Math.min(Math.max(a1, a3), Math.max(b1, b3))).toBeLessThanOrEqual(130);
            if (a1 === a3 && b1 === b3 && a1 === b1 && shared(a2, a4, b2, b4)) expect(a1).toBeLessThanOrEqual(130);
          }
    expect(countRouteCrossings(routes)).toBe(0);
  });
});

describe('routing a schema', () => {
  it('starts lines from different columns at their own points on a far-zoom block, and keeps lines to one column together', () => {
    const s = parseSql(`
      create table b (id int primary key);
      create table c (id int primary key);
      create table a (id int primary key, b_id int references b(id), c_id int references c(id));
      create table d (id int primary key, b_id int references b(id));
    `).schema;
    const at = { a: [0, 0], b: [600, -200], c: [600, 300], d: [0, 400] } as Record<string, number[]>;
    for (const t of s.tables) [t.x, t.y] = at[t.name];
    const name = new Map(s.tables.map((t) => [t.id, t.name]));
    const rel = (from: string, to: string) => s.relations.find((r) => name.get(r.from.table) === from && name.get(r.to.table) === to)!.id;
    const routes = routeSchema(s, 'compact');
    const first = (id: string) => routes.get(id)!.points[0];
    const last = (id: string) => routes.get(id)!.points.at(-1)!;
    expect(first(rel('a', 'b'))).not.toEqual(first(rel('a', 'c')));
    // the line going up leaves higher
    expect(first(rel('a', 'b')).y).toBeLessThan(first(rel('a', 'c')).y);
    expect(last(rel('a', 'b'))).toEqual(last(rel('d', 'b')));
  });
});

describe.runIf(existsSync(REF))('router on the reference schema', () => {
  it('routes the arranged schema without cutting through cards', async () => {
    const s = parseSql(readFileSync(REF, 'utf8')).schema;
    const g = suggestGroups(s);
    s.groups = g.groups;
    for (const t of s.tables) t.groupId = g.assignment.get(t.id);
    const pos = await autoLayout(s, { direction: 'RIGHT' });
    for (const t of s.tables) Object.assign(t, pos.get(t.id));
    const t0 = performance.now();
    const routes = routeSchema(s, 'full');
    const ms = performance.now() - t0;
    const net = new Map(s.relations.map((r) => [r.id, `${r.to.table}:${r.to.columns[0]}`]));
    const hits = cardHits(s, routes);
    const shared = overlaps(routes, net, process.env.DEBUG_ROUTES ? console.log : undefined);
    const bends = [...routes.values()].reduce((n, r) => n + r.points.length - 2, 0);
    console.log(`routed ${routes.size} lines in ${ms.toFixed(1)} ms · bends ${bends} · overlaps ${shared} · card hits ${hits.length}`);
    if (process.env.DEBUG_ROUTES) {
      mkdirSync('.cache/playwright-mcp', { recursive: true });
      writeFileSync('.cache/playwright-mcp/routes-ref.svg', toSvg(s, routes));
    }
    expect(hits).toEqual([]);
    expect(shared).toBe(0);
  });

  it('keeps lines away from a dragged group in shape', async () => {
    const s = parseSql(readFileSync(REF, 'utf8')).schema;
    const g = suggestGroups(s);
    s.groups = g.groups;
    for (const t of s.tables) t.groupId = g.assignment.get(t.id);
    const pos = await autoLayout(s, { direction: 'RIGHT', mode: 'flow' });
    for (const t of s.tables) Object.assign(t, pos.get(t.id));
    const byId = new Map(s.tables.map((t) => [t.id, t]));
    // directions of the segments: lanes may shift by a few px, but no new detour
    const shape = (r: Route) => r.points.slice(1).map((p, i) => (p.x === r.points[i].x ? (p.y > r.points[i].y ? 'S' : 'N') : p.x > r.points[i].x ? 'E' : 'W')).join('');
    let checked = 0;
    const changed: string[] = [];
    for (const group of s.groups) {
      const moved = s.tables.filter((t) => t.groupId === group.id);
      const f = regionFrame(s, group.id, 'full')!;
      const close = (id: string) => {
        const t = byId.get(id)!;
        return t.groupId === group.id || (t.x - 200 < f.x + f.w && t.x + CARD_W + 200 > f.x && t.y - 200 < f.y + f.h && t.y + cardHeight(t, s) + 200 > f.y);
      };
      const before = routeSchema(s, 'full');
      for (const [dx, dy] of [[2, -3], [-4, 5], [6, 2], [-2, -6], [9, 9], [-9, 4]]) {
        for (const t of moved) Object.assign(t, { x: t.x + dx, y: t.y + dy });
        const after = routeSchema(s, 'full');
        for (const t of moved) Object.assign(t, { x: t.x - dx, y: t.y - dy });
        for (const r of s.relations) {
          if (close(r.from.table) || close(r.to.table)) continue;
          checked++;
          if (shape(before.get(r.id)!) !== shape(after.get(r.id)!)) changed.push(`${byId.get(r.from.table)!.name} -> ${byId.get(r.to.table)!.name} moving ${group.name} by ${dx},${dy}`);
        }
      }
    }
    console.log(`far lines: ${changed.length} / ${checked} changed shape`);
    expect(checked).toBeGreaterThan(300);
    // a far line can still follow a moved one that it runs next to, but rarely
    expect(changed.length, changed.join('\n')).toBeLessThanOrEqual(4);
  });

  it('stays fast enough to re-route while dragging on a large schema', async () => {
    // 6 copies of the reference schema side by side, linked to each other through their hub tables
    const base = parseSql(readFileSync(REF, 'utf8')).schema;
    const s: Schema = { ...base, tables: [], relations: [], groups: [] };
    for (let k = 0; k < 6; k++) {
      const suffix = `_${k}`;
      for (const t of base.tables) s.tables.push({ ...t, id: t.id + suffix, columns: t.columns.map((c) => ({ ...c, id: c.id + suffix })), groupId: undefined });
      for (const r of base.relations)
        s.relations.push({ ...r, id: r.id + suffix, from: { table: r.from.table + suffix, columns: r.from.columns.map((c) => c + suffix) }, to: { table: r.to.table + suffix, columns: r.to.columns.map((c) => c + suffix) } });
    }
    const g = suggestGroups(s);
    s.groups = g.groups;
    for (const t of s.tables) t.groupId = g.assignment.get(t.id);
    const pos = await autoLayout(s, { direction: 'RIGHT' });
    for (const t of s.tables) Object.assign(t, pos.get(t.id));
    routeSchema(s, 'full');
    const t0 = performance.now();
    const routes = routeSchema(s, 'full');
    const ms = performance.now() - t0;
    console.log(`${s.tables.length} tables / ${routes.size} lines routed in ${ms.toFixed(1)} ms · card hits ${cardHits(s, routes).length}`);
    expect(cardHits(s, routes)).toEqual([]);
  });
});
