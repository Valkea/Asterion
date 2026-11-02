// Lane separation for routed lines. Segments that run through the same free
// channel and overlap are spread into parallel lanes, ordered so that their
// bends don't cross each other, and centred in narrow channels. Segments of the
// same net on the same line stay merged (a shared trunk reads as a fork).

import type { Box, Pt, Route, RouterEdge } from './router';

const GAP = 10; // preferred distance between lanes
const MIN_GAP = 4;
const PAD = 12; // minimum distance from a card
const WIDE = 220; // channels wider than this keep the line where it was
const EDGE_PAD = 30; // …but at least this far from the cards
const BEND_ROOM = 10; // minimum length of an inner segment
const STUB_ROOM = 30; // keep in sync with router STUB
const FRAME_ROOM = 18; // don't run along a region frame closer than this
const TIGHT = 4; // in a gap between facing cards too narrow for the room above: all that's kept

interface Seg {
  route: Route;
  net: string;
  k: number; // segment between points k and k+1
  c: number; // coordinate on the nudged axis
  a: number; // range start along the segment
  b: number; // range end
  lo: number; // free channel (cards only)
  hi: number;
  fixed: boolean;
  dirA: number; // where the line goes at the start/end of the range: -1/1 on the nudged axis, 0 = port
  dirB: number;
}

interface Item {
  segs: Seg[];
  c: number;
  a: number;
  b: number;
  lo: number;
  hi: number;
  fixed: boolean;
  dirA: number;
  dirB: number;
  /** every end of every member (forks of a shared trunk included): [position, direction] */
  ends: [number, number][];
  key: string;
}

export function nudge(routes: Map<string, Route>, cards: Box[], edges: RouterEdge[], regions: Box[] = []) {
  const netOf = new Map(edges.map((e) => [e.id, e.net]));
  pass(routes, cards, regions, netOf, 'x');
  pass(routes, cards, regions, netOf, 'y');
}

function pass(routes: Map<string, Route>, cards: Box[], regions: Box[], netOf: Map<string, string>, axis: 'x' | 'y') {
  const other = axis === 'x' ? 'y' : 'x';
  const segs: Seg[] = [];
  for (const [id, route] of routes) {
    const p = route.points;
    for (let k = 0; k < p.length - 1; k++) {
      const s = p[k], t = p[k + 1];
      if (s[axis] !== t[axis] || s[other] === t[other]) continue;
      const fixed = k === 0 || k === p.length - 2;
      const a = Math.min(s[other], t[other]);
      const b = Math.max(s[other], t[other]);
      const atStart = s[other] < t[other];
      const nbA = atStart ? p[k - 1] : p[k + 2];
      const nbB = atStart ? p[k + 2] : p[k - 1];
      const dir = (nb: Pt | undefined) => (nb ? Math.sign(nb[axis] - s[axis]) : 0);
      const [lo, hi] = channel(cards, axis, s[axis], a, b);
      segs.push({ route, net: netOf.get(id) ?? id, k, c: s[axis], a, b, lo, hi, fixed, dirA: dir(nbA), dirB: dir(nbB) });
    }
  }

  // merge same-net segments sharing a line into one item
  const items: Item[] = [];
  for (const s of segs) {
    const it = items.find((i) => !i.fixed && !s.fixed && i.segs[0].net === s.net && i.c === s.c && s.a <= i.b && i.a <= s.b);
    if (it) {
      it.segs.push(s);
      it.ends.push([s.a, s.dirA], [s.b, s.dirB]);
      if (s.a < it.a) [it.a, it.dirA] = [s.a, s.dirA];
      if (s.b > it.b) [it.b, it.dirB] = [s.b, s.dirB];
      it.lo = Math.max(it.lo, s.lo);
      it.hi = Math.min(it.hi, s.hi);
    } else {
      items.push({ segs: [s], c: s.c, a: s.a, b: s.b, lo: s.lo, hi: s.hi, fixed: s.fixed, dirA: s.dirA, dirB: s.dirB, ends: [[s.a, s.dirA], [s.b, s.dirB]], key: `${s.net}|${s.k}|${s.c}` });
    }
  }

  // conflict groups: same channel, overlapping ranges
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.fixed && B.fixed) continue;
      if (A.b < B.a - GAP || B.b < A.a - GAP) continue;
      if (A.c < B.lo || A.c > B.hi || B.c < A.lo || B.c > A.hi) continue;
      parent[find(i)] = find(j);
    }
  const groups = new Map<number, Item[]>();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(it);
  });

  for (const group of groups.values()) {
    if (group.every((g) => g.fixed)) continue;
    group.sort(compare);
    place(group, axis, regions);
  }
}

/** Free interval around coordinate `c` on `axis`, for a segment spanning [a, b] on the other axis. */
function channel(cards: Box[], axis: 'x' | 'y', c: number, a: number, b: number): [number, number] {
  let lo = -Infinity, hi = Infinity;
  for (const r of cards) {
    const r0 = axis === 'x' ? r.y : r.x;
    const r1 = axis === 'x' ? r.y + r.h : r.x + r.w;
    if (r1 <= a || r0 >= b) continue;
    const c0 = axis === 'x' ? r.x : r.y;
    const c1 = axis === 'x' ? r.x + r.w : r.y + r.h;
    if (c1 <= c) lo = Math.max(lo, c1);
    else if (c0 >= c) hi = Math.min(hi, c0);
  }
  return [lo, hi];
}

/** Order lanes so that the bends at their ends don't cut across each other. */
function compare(A: Item, B: Item): number {
  // ends level with each other but leaving in opposite directions: the wrong order would make them overlap
  for (const [pa, da] of A.ends) for (const [pb, db] of B.ends) if (pa === pb && da && db && da !== db) return da - db;
  if (A.a !== B.a) {
    const inner = A.a > B.a ? A : B;
    if (inner.dirA) return (inner === A ? 1 : -1) * inner.dirA;
  }
  if (A.b !== B.b) {
    const inner = A.b < B.b ? A : B;
    if (inner.dirB) return (inner === A ? 1 : -1) * inner.dirB;
  }
  return A.c - B.c || (A.key < B.key ? -1 : 1);
}

function place(group: Item[], axis: 'x' | 'y', regions: Box[]) {
  const n = group.length;
  const bounds = group.map((it) => {
    const b = routeBounds(it, axis, PAD, STUB_ROOM, BEND_ROOM);
    // a lane between facing cards (see the router) can't keep the usual room: lanes still get apart
    return b[0] > b[1] && it.hi - it.lo < 2 * STUB_ROOM ? routeBounds(it, axis, TIGHT, TIGHT, TIGHT) : b;
  });
  let width = Infinity;
  for (const it of group) width = Math.min(width, it.hi - it.lo);
  const gap = n > 1 ? Math.max(MIN_GAP, Math.min(GAP, (width - 2 * PAD) / n)) : GAP;
  const target = group.map((it) => {
    if (it.fixed) return it.c;
    if (it.hi - it.lo <= WIDE) return (it.lo + it.hi) / 2;
    return Math.min(Math.max(it.c, it.lo + EDGE_PAD), it.hi - EDGE_PAD);
  });
  const weight = group.map((it) => (it.fixed ? 1e6 : 1));
  const shifted = target.map((t, i) => t - i * gap);
  const iso = isotonic(shifted, weight);
  let prev = -Infinity;
  group.forEach((it, i) => {
    if (it.fixed) {
      prev = it.c;
      return;
    }
    const [lo, hi] = bounds[i];
    let v = iso[i] + i * gap;
    v = Math.min(Math.max(v, lo), hi);
    if (lo > hi) v = it.c;
    else {
      v = offFrames(v, it, axis, regions, lo, hi);
      // stepping off a frame may land on the previous lane
      if (v < prev + gap && prev + gap <= hi) v = prev + gap;
    }
    v = Math.round(v * 2) / 2;
    prev = v;
    for (const s of it.segs) {
      s.route.points[s.k][axis] = v;
      s.route.points[s.k + 1][axis] = v;
    }
    it.c = v;
  });
}

/** A line running right along a region frame reads as part of the frame: step off it. */
function offFrames(v: number, it: Item, axis: 'x' | 'y', regions: Box[], lo: number, hi: number): number {
  for (const r of regions) {
    const r0 = axis === 'x' ? r.y : r.x;
    const r1 = axis === 'x' ? r.y + r.h : r.x + r.w;
    if (r1 <= it.a || r0 >= it.b) continue;
    for (const border of axis === 'x' ? [r.x, r.x + r.w] : [r.y, r.y + r.h]) {
      if (Math.abs(v - border) >= FRAME_ROOM) continue;
      const away = v >= border ? border + FRAME_ROOM : border - FRAME_ROOM;
      const other = v >= border ? border - FRAME_ROOM : border + FRAME_ROOM;
      if (away >= lo && away <= hi) v = away;
      else if (other >= lo && other <= hi) v = other;
    }
  }
  return v;
}

/** Hard limits for an item: stay in its channel, and don't flip or squash neighbouring segments of its own line. */
function routeBounds(it: Item, axis: 'x' | 'y', pad: number, stubRoom: number, bendRoom: number): [number, number] {
  let lo = it.lo + pad, hi = it.hi - pad;
  for (const s of it.segs) {
    const p = s.route.points;
    const c = p[s.k][axis];
    for (const [nb, isEnd] of [
      [p[s.k - 1], s.k - 1 === 0],
      [p[s.k + 2], s.k + 2 === p.length - 1],
    ] as [Pt | undefined, boolean][]) {
      if (!nb) continue;
      const room = isEnd ? stubRoom : bendRoom;
      if (nb[axis] < c) lo = Math.max(lo, nb[axis] + room);
      else if (nb[axis] > c) hi = Math.min(hi, nb[axis] - room);
    }
  }
  return [lo, hi];
}

/** Weighted isotonic regression (non-decreasing), pool-adjacent-violators. */
function isotonic(v: number[], w: number[]): number[] {
  const val: number[] = [], wt: number[] = [], cnt: number[] = [];
  for (let i = 0; i < v.length; i++) {
    val.push(v[i]);
    wt.push(w[i]);
    cnt.push(1);
    while (val.length > 1 && val[val.length - 2] > val[val.length - 1]) {
      const w2 = wt.pop()!, v2 = val.pop()!, c2 = cnt.pop()!;
      const w1 = wt[wt.length - 1], v1 = val[val.length - 1];
      val[val.length - 1] = (v1 * w1 + v2 * w2) / (w1 + w2);
      wt[wt.length - 1] = w1 + w2;
      cnt[cnt.length - 1] += c2;
    }
  }
  const out: number[] = [];
  val.forEach((x, i) => {
    for (let k = 0; k < cnt[i]; k++) out.push(x);
  });
  return out;
}
