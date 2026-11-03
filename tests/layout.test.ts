import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSql } from '../src/sql/parser';
import { suggestGroups } from '../src/layout/cluster';
import { autoLayout, autoLayoutDetailed, searchLayouts, type Strategy } from '../src/layout/auto';
import { CARD_W, cardHeight, countCrossings } from '../src/layout/geometry';
import { routedCrossings } from '../src/layout/routing';
import type { Schema } from '../src/model/types';

// private reference schema, not in the repo: SCHEMA_DIR=/path/to/dir with schema-v15.sql
const REF = `${process.env.SCHEMA_DIR ?? '.missing'}/schema-v15.sql`;

function grouped(): Schema {
  const s = parseSql(readFileSync(REF, 'utf8')).schema;
  const g = suggestGroups(s);
  s.groups = g.groups;
  for (const t of s.tables) t.groupId = g.assignment.get(t.id);
  return s;
}

function apply(s: Schema, pos: Map<string, { x: number; y: number }>) {
  for (const t of s.tables) Object.assign(t, pos.get(t.id));
}

function overlaps(s: Schema): number {
  let n = 0;
  for (let i = 0; i < s.tables.length; i++)
    for (let j = i + 1; j < s.tables.length; j++) {
      const a = s.tables[i];
      const b = s.tables[j];
      if (a.x < b.x + CARD_W && b.x < a.x + CARD_W && a.y < b.y + cardHeight(b, s) && b.y < a.y + cardHeight(a, s)) n++;
    }
  return n;
}

const bounds = (s: Schema) => {
  const xs = s.tables.map((t) => t.x);
  const ys = s.tables.map((t) => t.y);
  const w = Math.max(...xs) + CARD_W - Math.min(...xs);
  const h = Math.max(...s.tables.map((t) => t.y + cardHeight(t, s))) - Math.min(...ys);
  return { w, h };
};

describe.runIf(existsSync(REF))('auto-layout on the reference schema', () => {
  it('compares strategies', async () => {
    for (const only of ['compound', 'islands-down', 'islands-right', 'islands-stress'] as Strategy[]) {
      const s = grouped();
      const r = await autoLayoutDetailed(s, { direction: 'RIGHT', only });
      apply(s, r.pos);
      const b = bounds(s);
      console.log(only.padEnd(15), 'crossings', String(r.crossings).padStart(3), 'size', Math.round(b.w), 'x', Math.round(b.h), 'overlaps', overlaps(s));
    }
  });

  it('produces a non-overlapping, reasonably square layout', async () => {
    const s = grouped();
    const r = await autoLayoutDetailed(s, { direction: 'RIGHT' });
    apply(s, r.pos);
    const b = bounds(s);
    console.log('picked', r.strategy);
    console.log('groups', s.groups.map((g) => `${g.name}:${s.tables.filter((t) => t.groupId === g.id).length}`).join(' '));
    console.log('crossings', countCrossings(s), 'size', Math.round(b.w), 'x', Math.round(b.h), 'overlaps', overlaps(s));
    expect(overlaps(s)).toBe(0);
  });

  it('never adds crossings to the current drawing', async () => {
    const s = grouped();
    apply(s, await autoLayout(s, { direction: 'RIGHT' }));
    // a hand-made tweak: swap two groups' places
    const [a, b] = s.groups.map((g) => s.tables.filter((t) => t.groupId === g.id));
    const da = { x: b[0].x - a[0].x, y: b[0].y - a[0].y };
    for (const t of a) Object.assign(t, { x: t.x + da.x, y: t.y + da.y });
    for (const t of b) Object.assign(t, { x: t.x - da.x, y: t.y - da.y });
    const before = routedCrossings(s);
    apply(s, await autoLayout(s, { direction: 'RIGHT' }));
    expect(routedCrossings(s)).toBeLessThanOrEqual(before);
    expect(overlaps(s)).toBe(0);
  });

  it('keeps locked tables exactly where they are', async () => {
    const s = grouped();
    apply(s, await autoLayout(s, { direction: 'RIGHT' }));
    const t = s.tables.find((x) => x.name === 'outputs')!;
    t.locked = true;
    t.x = -2000;
    t.y = 1500;
    apply(s, await autoLayout(s, { direction: 'RIGHT' }));
    expect(t.x).toBe(-2000);
    expect(t.y).toBe(1500);
    expect(overlaps(s)).toBe(0);
  });
});

describe.runIf(existsSync(REF))('flow arrangement on the reference schema', () => {
  it('compact columns give a smaller drawing than aligned ones', async () => {
    for (const direction of ['RIGHT', 'DOWN'] as const) {
      const area = async (compact: boolean) => {
        const s = grouped();
        apply(s, (await autoLayoutDetailed(s, { direction, mode: 'flow', compact })).pos);
        expect(overlaps(s)).toBe(0);
        const b = bounds(s);
        console.log(`flow ${direction} ${compact ? 'compact' : 'aligned'}`, Math.round(b.w), 'x', Math.round(b.h));
        return b.w * b.h;
      };
      expect(await area(true)).toBeLessThanOrEqual(await area(false));
    }
  }, 15000);

  it('puts every referenced table in an earlier column, without overlaps', async () => {
    for (const direction of ['RIGHT', 'DOWN'] as const) {
      const s = grouped();
      const r = await autoLayoutDetailed(s, { direction, mode: 'flow' });
      apply(s, r.pos);
      expect(r.strategy).toBe('flow');
      expect(overlaps(s)).toBe(0);
      const byId = new Map(s.tables.map((t) => [t.id, t]));
      for (const rel of s.relations) {
        if (rel.from.table === rel.to.table) continue;
        const child = byId.get(rel.from.table)!, parent = byId.get(rel.to.table)!;
        if (direction === 'RIGHT') expect(parent.x).toBeLessThanOrEqual(child.x);
        else expect(parent.y).toBeLessThanOrEqual(child.y);
      }
      const b = bounds(s);
      console.log('flow', direction, 'crossings', r.crossings, 'size', Math.round(b.w), 'x', Math.round(b.h));
    }
  });
});

/** Closest gap between two tables side by side (rows overlap) and between two stacked ones (columns overlap). */
function closest(s: Schema, skip: (a: Schema['tables'][number], b: Schema['tables'][number]) => boolean = () => false) {
  let side = Infinity, stack = Infinity;
  for (const a of s.tables)
    for (const b of s.tables) {
      if (a === b || skip(a, b)) continue;
      if (a.y < b.y + cardHeight(b, s) && b.y < a.y + cardHeight(a, s) && b.x >= a.x) side = Math.min(side, b.x - a.x - CARD_W);
      if (a.x < b.x + CARD_W && b.x < a.x + CARD_W && b.y >= a.y) stack = Math.min(stack, b.y - a.y - cardHeight(a, s));
    }
  return { side, stack };
}

describe('auto-layout spacing', () => {
  const sample = () => {
    const s = parseSql(readFileSync('src/sample.sql', 'utf8')).schema;
    const g = suggestGroups(s);
    s.groups = g.groups;
    for (const t of s.tables) t.groupId = g.assignment.get(t.id);
    return s;
  };

  it('leaves room between tables, even when they were placed close together', async () => {
    for (const mode of ['groups', 'flow'] as const) {
      const s = sample();
      apply(s, await autoLayout(s, { direction: 'RIGHT', mode }));
      // squeeze two tables side by side and one under them, then arrange again
      const [a, b, c] = s.tables;
      Object.assign(b, { x: a.x + CARD_W + 20, y: a.y + 40 });
      Object.assign(c, { x: a.x + 10, y: a.y + cardHeight(a, s) + 12 });
      apply(s, await autoLayout(s, { direction: 'RIGHT', mode }));
      const { side, stack } = closest(s);
      expect(side).toBeGreaterThanOrEqual(44);
      expect(stack).toBeGreaterThanOrEqual(30);
    }
  }, 30000);

  it('leaves locked tables as close as they were put', async () => {
    const s = sample();
    apply(s, await autoLayout(s, { direction: 'RIGHT' }));
    const [a, b] = s.tables;
    Object.assign(b, { x: a.x + CARD_W + 20, y: a.y, locked: true });
    a.locked = true;
    apply(s, await autoLayout(s, { direction: 'RIGHT' }));
    expect(b.x - a.x - CARD_W).toBe(20);
    const both = (x: Schema['tables'][number], y: Schema['tables'][number]) => !!x.locked && !!y.locked;
    expect(closest(s, both).side).toBeGreaterThanOrEqual(44);
    expect(closest(s, both).stack).toBeGreaterThanOrEqual(30);
  }, 30000);

  it('keeps searching from the applied drawing, only ever reporting cleaner ones', async () => {
    for (const mode of ['groups', 'flow'] as const) {
      const s = sample();
      // a poor start: tables dealt onto a grid in file order
      s.tables.forEach((t, i) => Object.assign(t, { x: (i % 5) * 500, y: Math.floor(i / 5) * 600 }));
      const start = routedCrossings(s, new Set(), 'full');
      const found: number[] = [];
      let last = s;
      const t0 = performance.now();
      await searchLayouts(s, { direction: 'RIGHT', mode }, {
        deadline: t0 + 8000,
        staleMs: 4000,
        seed: 3,
        onBetter: ({ pos, crossings }) => {
          found.push(crossings);
          last = { ...s, tables: s.tables.map((t) => ({ ...t, ...pos.get(t.id) })) };
          expect(routedCrossings(last, new Set(), 'full')).toBe(crossings);
        },
      });
      expect(performance.now() - t0).toBeLessThan(8000 + 4000); // a round may finish after the deadline
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((n, i) => n <= (i ? found[i - 1] : start))).toBe(true);
      const { side, stack } = closest(last);
      expect(side).toBeGreaterThanOrEqual(44);
      expect(stack).toBeGreaterThanOrEqual(30);
    }
  }, 30000);
});
