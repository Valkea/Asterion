import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  useStore as useFlowStore,
  useStoreApi,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowState,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adjacency, hopDistances } from '../analysis/graph';
import { CARD_W, cardHeight, type Detail } from '../layout/geometry';
import { forceLayoutPositions, orbitPositions, starRadius } from '../layout/constellation';
import { regionFrame, routeSchema } from '../layout/routing';
import { uid } from '../model/ids';
import type { Schema } from '../model/types';
import { canonicalType, isSerial } from '../sql/pg';
import { lensEnabled, useDiff, useHidden, useHubs, useIssues, useLens, usePath } from '../store/derived';
import { CornerUpLeft, Lock, Map as MapIcon, X } from 'lucide-react';
import { useStore, type Hub } from '../store/store';
import { useIsPhone } from '../util/phone';
import { ArcEdge, BundleEdge, NoteLinkEdge, RelationEdge } from './edges/RelationEdge';
import { NoteNode } from './nodes/NoteNode';
import { RegionNode } from './nodes/RegionNode';
import { RingsNode, StarNode } from './nodes/StarNode';
import { TableNode } from './nodes/TableNode';
import { CanvasToolbar } from './CanvasToolbar';

const nodeTypes = { table: TableNode, region: RegionNode, note: NoteNode, star: StarNode, rings: RingsNode };
const edgeTypes = { relation: RelationEdge, arc: ArcEdge, notelink: NoteLinkEdge, bundle: BundleEdge };

const detailSelector = (s: ReactFlowState): Detail => (s.transform[2] < 0.42 ? 'compact' : s.transform[2] < 0.75 ? 'keys' : 'full');
/** Below this zoom, Atlas shows groups instead of tables. */
const OVERVIEW_ZOOM = 0.2;
export const overviewSelector = (s: ReactFlowState) => s.transform[2] < OVERVIEW_ZOOM;

type Pos = { x: number; y: number };

function useAnimatedPositions(target: Map<string, Pos> | null) {
  const [pos, setPos] = useState<Map<string, Pos> | null>(target);
  const cur = useRef<Map<string, Pos> | null>(target);
  useEffect(() => {
    if (!target) {
      cur.current = null;
      setPos(null);
      return;
    }
    const from = cur.current;
    if (!from) {
      cur.current = target;
      setPos(target);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      const next = new Map<string, Pos>();
      for (const [id, b] of target) {
        const a = from.get(id) ?? b;
        next.set(id, { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e });
      }
      cur.current = next;
      setPos(next);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return [pos, (id: string, p: Pos) => {
    const next = new Map(cur.current ?? []);
    next.set(id, p);
    cur.current = next;
    setPos(next);
  }] as const;
}

export function Canvas() {
  const schema = useStore((s) => s.schema);
  const exporting = useStore((s) => s.exporting);
  const liveSelection = useStore((s) => s.selection);
  // an image export shows the schema itself, not what is selected or hovered
  const selection = exporting ? null : liveSelection;
  const theme = useStore((s) => s.theme);
  const starFocus = useStore((s) => s.starFocus);
  const view = schema.view ?? 'atlas';
  const phone = useIsPhone();
  const moveLocked = useStore((s) => s.moveLocked);
  // first time the lock is on in this session: say where to unlock it
  const welcome = useStore((s) => s.welcome);
  const [lockHint, setLockHint] = useState(() => {
    try {
      return sessionStorage.getItem('odbe-lock-hint') !== '1';
    } catch {
      return true;
    }
  });
  const showLockHint = lockHint && moveLocked && !welcome && schema.tables.length > 0 && view !== 'constellation';
  useEffect(() => {
    if (!showLockHint) return;
    try {
      sessionStorage.setItem('odbe-lock-hint', '1');
    } catch {
      /* ignore */
    }
    const t = window.setTimeout(() => setLockHint(false), 9000);
    return () => window.clearTimeout(t);
  }, [showLockHint]);
  const setMoveLocked = (locked: boolean) => {
    useStore.getState().set({ moveLocked: locked });
    useStore.getState().toast(locked ? 'Moving locked: tables and notes stay put' : 'Moving unlocked: drag tables and notes · the lock button locks them again');
    setLockHint(false);
  };
  const [miniOpen, setMiniOpen] = useState(() => {
    try {
      return localStorage.getItem('odbe-minimap') !== 'off';
    } catch {
      return true;
    }
  });
  const toggleMini = () => {
    setMiniOpen(!miniOpen);
    try {
      localStorage.setItem('odbe-minimap', miniOpen ? 'off' : 'on');
    } catch {
      /* ignore */
    }
  };
  const [snap, setSnap] = useState(() => {
    try {
      return localStorage.getItem('odbe-snap') === 'on';
    } catch {
      return false;
    }
  });
  const toggleSnap = () => {
    setSnap(!snap);
    try {
      localStorage.setItem('odbe-snap', snap ? 'off' : 'on');
    } catch {
      /* ignore */
    }
  };
  // view-dependent tools top-left, the minimap bottom-left with the camera buttons along its bottom edge
  const mini = phone ? { w: 120, h: 90 } : { w: 200, h: 150 };
  const margin = phone ? 8 : 14;
  const MINI_ZOOM_W = 98; // four 24px buttons + borders, as rendered
  const zoomDetail = useFlowStore(detailSelector);
  // Atlas exports what the zoom shows (full cards, compact cards or the group overview), never the partial "+ n more" cards;
  // the other views export full cards
  const detail: Detail = view === 'blueprint' || (exporting && (view !== 'atlas' || zoomDetail === 'keys')) ? 'full' : zoomDetail;
  const farZoom = useFlowStore(overviewSelector);
  const overview = view === 'atlas' && farZoom && schema.groups.length > 0;
  const hidden = useHidden();
  const hubs = useHubs();
  const issues = useIssues();
  const diff = useDiff();
  const path = usePath();
  const rf = useReactFlow();
  const flowStore = useStoreApi();
  if (import.meta.env.DEV) (window as unknown as { __rf: typeof flowStore }).__rf = flowStore;
  const [liveHover, setHover] = useState<string | null>(null);
  const [liveHoverEdge, setHoverEdge] = useState<string | null>(null);
  const [liveHoverRegion, setHoverRegion] = useState<string | null>(null);
  const hover = exporting ? null : liveHover;
  const hoverEdge = exporting ? null : liveHoverEdge;
  const hoverRegion = exporting ? null : liveHoverRegion;
  // a hovered hub mark (badge, chip or stub) draws that hub's portal relations as ghost lines
  const [liveHubHover, setHubHover] = useState<string | null>(null);
  const hubHover = exporting ? null : liveHubHover;
  // The lens jumps to a hovered table at once, but holds on to the last one for a moment
  // while the pointer crosses the gap to the next, so it doesn't flash back in between.
  const [heldHover, setHeldHover] = useState<string | null>(null);
  useEffect(() => {
    if (hover) return setHeldHover(hover);
    const t = setTimeout(() => setHeldHover(null), 350);
    return () => clearTimeout(t);
  }, [hover]);
  const lensHover = hover ?? heldHover;
  const lens = useLens(lensHover);
  // with the lens on, the hover glow waits for the same settled table, so both change in one go
  const lensOn = useStore(lensEnabled);
  const focusHover = lensOn ? lensHover : hover;
  const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(new Map());

  // ---- constellation positions ----
  const starTarget = useMemo(() => {
    if (view !== 'constellation') return null;
    if (starFocus && schema.tables.some((t) => t.id === starFocus)) return orbitPositions(schema, starFocus).pos;
    return forceLayoutPositions(schema);
    // structure only: card positions don't matter here
  }, [view, starFocus, schema.tables.length, schema.relations.length, schema.groups, schema.tables.map((t) => t.groupId).join()]);
  const [starPos, setStarPos] = useAnimatedPositions(starTarget);
  const orbit = useMemo(() => (view === 'constellation' && starFocus ? orbitPositions(schema, starFocus) : null), [view, starFocus, schema]);

  const issueCount = useMemo(() => {
    const m = new Map<string, { errors: number; warnings: number; infos: number }>();
    for (const i of issues) {
      if (!i.tableId) continue;
      const c = m.get(i.tableId) ?? { errors: 0, warnings: 0, infos: 0 };
      if (i.severity === 'error') c.errors++;
      else if (i.severity === 'warning') c.warnings++;
      else c.infos++;
      m.set(i.tableId, c);
    }
    return m;
  }, [issues]);

  const flyTo = useCallback(
    (id: string) => {
      const t = useStore.getState().schema.tables.find((x) => x.id === id);
      if (!t) return;
      rf.setCenter(t.x + CARD_W / 2, t.y + cardHeight(t, useStore.getState().schema) / 2, { zoom: 1, duration: 700 });
      useStore.getState().select({ kind: 'table', id });
    },
    [rf],
  );

  // Going through a portal (or visiting a hub's referrers) leaves a way back to where you were.
  const [back, setBack] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => setBack(null), [view]);
  const visits = useRef(new Map<string, number>());
  const goThrough = useCallback(
    (hubId: string, fromId: string) => {
      const from = useStore.getState().schema.tables.find((t) => t.id === fromId);
      if (from) setBack({ id: from.id, name: from.name });
      setHubHover(null);
      flyTo(hubId);
    },
    [flyTo],
  );
  const hubsRef = useRef(hubs);
  hubsRef.current = hubs;
  const visitHub = useCallback(
    (hubId: string) => {
      const h = hubsRef.current.get(hubId);
      if (!h?.referrers.length) return;
      const i = (visits.current.get(hubId) ?? -1) + 1;
      visits.current.set(hubId, i % h.referrers.length);
      setBack({ id: h.id, name: h.name });
      setHubHover(null);
      flyTo(h.referrers[i % h.referrers.length]);
    },
    [flyTo],
  );

  // Orthogonal routes for every drawn relation (cards are obstacles, shared corridors become lanes).
  const routes = useMemo(
    () => (view === 'constellation' || overview ? null : routeSchema(schema, detail, hidden)),
    // positions, sizes and links only — selection and the like don't move lines
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, detail, hidden, overview, schema.tables, schema.relations, schema.groups],
  );

  // Overview: one block per group (ungrouped tables stand alone), one line per pair of blocks.
  const bundles = useMemo(() => {
    if (!overview) return null;
    const groupIds = new Set(schema.groups.map((g) => g.id));
    const byId = new Map(schema.tables.map((t) => [t.id, t]));
    const endOf = (tableId: string) => {
      const t = byId.get(tableId);
      return t?.groupId && groupIds.has(t.groupId) ? `region:${t.groupId}` : tableId;
    };
    const pairs = new Map<string, { a: string; b: string; ab: number; ba: number; fks: string[] }>();
    const linksOut = new Map<string, number>();
    for (const r of schema.relations) {
      const a = endOf(r.from.table), b = endOf(r.to.table);
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const p = pairs.get(key) ?? { a: a < b ? a : b, b: a < b ? b : a, ab: 0, ba: 0, fks: [] };
      if (p.a === a) p.ab++;
      else p.ba++;
      p.fks.push(`${byId.get(r.from.table)?.name} → ${byId.get(r.to.table)?.name}`);
      pairs.set(key, p);
      linksOut.set(a, (linksOut.get(a) ?? 0) + 1);
    }
    return { pairs: [...pairs.values()], linksOut };
  }, [overview, schema.groups, schema.tables, schema.relations]);

  const highlight = useMemo(() => {
    // tables "lit" by hover / selection / path
    const lit = new Set<string>();
    const focusId = focusHover ?? (selection?.kind === 'table' ? selection.id : null);
    if (focusId) {
      lit.add(focusId);
      for (const r of schema.relations) {
        if (r.from.table === focusId) lit.add(r.to.table);
        if (r.to.table === focusId) lit.add(r.from.table);
      }
    }
    return { lit, focusId };
  }, [focusHover, selection, schema.relations]);

  const nodes = useMemo<Node[]>(() => {
    const byGroup = new Map(schema.groups.map((g) => [g.id, g]));
    const out: Node[] = [];
    const isFaded = (id: string) => (path?.rels ? !path.tables.has(id) : lens ? !lens.has(id) : false);

    if (view === 'constellation') {
      const adj = adjacency(schema);
      const dist = starFocus ? hopDistances(schema, starFocus) : null;
      if (orbit) {
        const R = (orbit.radii[orbit.radii.length - 1] ?? 0) + 40;
        out.push({ id: '__rings', type: 'rings', position: { x: -R, y: -R }, data: { radii: orbit.radii, unreachable: orbit.unreachable }, draggable: false, selectable: false, zIndex: -1, width: R * 2, height: R * 2 });
      }
      // the lens centred on another star: the centre star stays in sight, showing how far it is even beyond the reach
      const lensCenter = selection?.kind === 'table' ? selection.id : lensHover;
      const awayFrom = lens && !path?.rels && starFocus && lensCenter && lensCenter !== starFocus && !lens.has(starFocus) ? lensCenter : null;
      for (const t of schema.tables) {
        const p = starPos?.get(t.id) ?? { x: 0, y: 0 };
        const far = !!awayFrom && t.id === starFocus;
        const r = starRadius(t.columns.length, adj.get(t.id)?.length ?? 0);
        const g = t.groupId ? byGroup.get(t.groupId) : undefined;
        out.push({
          id: t.id,
          type: 'star',
          position: { x: p.x - r, y: p.y - r },
          data: {
            table: t,
            r,
            color: t.color ?? g?.color ?? '#a5b4fc',
            faded: !far && (isFaded(t.id) || (!lens && !!highlight.focusId && (!orbit || !!hover) && !highlight.lit.has(t.id))),
            lit: highlight.lit.has(t.id) && !!highlight.focusId,
            focus: t.id === starFocus,
            hop: far ? (dist?.get(awayFrom!) ?? Infinity) : path?.rels ? undefined : lens?.get(t.id) || undefined,
            far,
            ring: dist?.get(t.id),
            diff: diff?.tableStatus.get(t.id),
          },
          selected: selection?.kind === 'table' && selection.id === t.id,
          // no width/height: React Flow only measures handles of nodes it sizes itself
          measured: measured.get(t.id),
        });
      }
      return out;
    }

    // regions (Atlas: tinted islands; Blueprint: dashed frames)
    for (const g of schema.groups) {
      const members = schema.tables.filter((t) => t.groupId === g.id);
      if (!members.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const t of members) {
        const h = measured.get(t.id)?.height ?? cardHeight(t, schema, detail);
        x0 = Math.min(x0, t.x);
        y0 = Math.min(y0, t.y);
        x1 = Math.max(x1, t.x + CARD_W);
        y1 = Math.max(y1, t.y + h);
      }
      const pad = 28;
      const top = detail === 'compact' ? 64 : 56;
      out.push({
        id: `region:${g.id}`,
        type: 'region',
        position: { x: x0 - pad, y: y0 - top },
        data: {
          name: g.name,
          color: g.color,
          count: members.length,
          locked: g.locked,
          width: x1 - x0 + pad * 2,
          height: y1 - y0 + top + pad,
          blueprint: view === 'blueprint',
          faded: members.every((m) => isFaded(m.id)),
          overview,
          links: bundles?.linksOut.get(`region:${g.id}`),
          dim: !!hoverRegion && hoverRegion !== `region:${g.id}` && !bundles?.pairs.some((p) => (p.a === hoverRegion && p.b === `region:${g.id}`) || (p.b === hoverRegion && p.a === `region:${g.id}`)),
        },
        // React Flow lifts selected nodes by 1000; cancel it so a selected group stays under its tables
        zIndex: selection?.kind === 'group' && selection.id === g.id ? -1001 : -1,
        draggable: !g.locked,
        selected: selection?.kind === 'group' && selection.id === g.id,
        // size through style only: React Flow measures handles just for nodes it sizes itself
        style: { width: x1 - x0 + pad * 2, height: y1 - y0 + top + pad },
        measured: measured.get(`region:${g.id}`),
      });
    }

    const fkCols = new Set<string>();
    for (const r of schema.relations) r.from.columns.forEach((c) => fkCols.add(c));
    const enumNames = new Set(schema.enums.map((e) => e.name));
    const portalsByTable = new Map<string, Map<string, Hub>>();
    for (const r of schema.relations) {
      const hub = hubs.get(r.to.table);
      if (!hub) continue;
      if (!portalsByTable.has(r.from.table)) portalsByTable.set(r.from.table, new Map());
      portalsByTable.get(r.from.table)!.set(r.from.columns[0], hub);
    }
    const removedCols = new Map<string, number>();
    if (diff) for (const d of diff.tables) if (d.current) removedCols.set(d.current.id, d.columns.filter((c) => c.kind === 'removed').length);

    for (const t of schema.tables) {
      const g = t.groupId ? byGroup.get(t.groupId) : undefined;
      out.push({
        id: t.id,
        type: 'table',
        position: { x: t.x, y: t.y },
        data: {
          table: t,
          schema,
          detail,
          groupColor: g?.color,
          fkCols,
          portals: portalsByTable.get(t.id) ?? new Map(),
          hub: hubs.get(t.id),
          enumNames,
          faded: isFaded(t.id),
          lit: !!path?.rels && path.tables.has(t.id),
          diff: diff?.tableStatus.get(t.id),
          colDiff: diff?.columnStatus,
          removedCols: removedCols.get(t.id),
          issues: issueCount.get(t.id),
          selectedColumn: selection?.kind === 'table' && selection.id === t.id ? selection.columnId : undefined,
          onPortal: goThrough,
          onHubVisit: visitHub,
          onHubHover: setHubHover,
        },
        selected: selection?.kind === 'table' && selection.id === t.id,
        draggable: !t.locked,
        hidden: overview && !!g,
        measured: measured.get(t.id),
      });
    }
    for (const n of schema.notes) {
      out.push({
        id: `note:${n.id}`,
        type: 'note',
        position: { x: n.x, y: n.y },
        data: { text: n.text, color: n.color, faded: !!(path?.rels || lens) && !(n.attachedTo && !isFaded(n.attachedTo)) },
        style: { width: n.w, height: n.h },
        measured: measured.get(`note:${n.id}`),
        selected: selection?.kind === 'note' && selection.id === n.id,
        zIndex: 5,
      });
    }
    return out;
  }, [schema, view, detail, selection, hidden, diff, issueCount, path, lens, lensHover, measured, goThrough, visitHub, hubs, starPos, starFocus, orbit, highlight, overview, bundles, hoverRegion]);
  // the move lock overrides each node's own draggable flag (which only reflects per-table locks)
  const shownNodes = useMemo(() => (moveLocked && view !== 'constellation' ? nodes.map((n) => (n.draggable === false ? n : { ...n, draggable: false })) : nodes), [nodes, moveLocked, view]);

  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(schema.tables.map((t) => [t.id, t]));
    const byGroup = new Map(schema.groups.map((g) => [g.id, g]));
    const out: Edge[] = [];
    const isFaded = (a: string, b: string) => (path?.rels ? false : lens ? !lens.has(a) || !lens.has(b) : false);

    if (view === 'constellation') {
      const seen = new Set<string>();
      for (const r of schema.relations) {
        if (r.from.table === r.to.table) continue;
        const key = [r.from.table, r.to.table].sort().join('|');
        const onPath = !!path?.relIds.has(r.id);
        if (seen.has(key) && !onPath) continue;
        seen.add(key);
        const from = byId.get(r.from.table);
        const g = from?.groupId ? byGroup.get(from.groupId) : undefined;
        // under the lens a link glows less the further it reaches from the centre (the farther of its two ends)
        const reach = lens && !path?.rels && lens.has(r.from.table) && lens.has(r.to.table) ? Math.max(lens.get(r.from.table)!, lens.get(r.to.table)!) || 1 : undefined;
        const lit = lens ? reach === 1 : !!highlight.focusId && (r.from.table === highlight.focusId || r.to.table === highlight.focusId);
        out.push({
          id: r.id,
          source: r.from.table,
          target: r.to.table,
          sourceHandle: 'c',
          targetHandle: 'c',
          type: 'arc',
          data: { lit, reach, faded: (path?.rels ? !onPath : isFaded(r.from.table, r.to.table)) || (!lens && !!highlight.focusId && (!starFocus || !!hover) && !lit), color: g?.color, path: onPath },
          selected: selection?.kind === 'relation' && selection.id === r.id,
        });
      }
      return out;
    }

    if (bundles) {
      const frame = (end: string) => {
        if (end.startsWith('region:')) return regionFrame(schema, end.slice(7), 'compact')!;
        const t = byId.get(end)!;
        return { x: t.x, y: t.y, w: CARD_W, h: cardHeight(t, schema, 'compact') };
      };
      const colorOf = (end: string) => (end.startsWith('region:') ? byGroup.get(end.slice(7))?.color : undefined);
      for (const p of bundles.pairs) {
        const lit = !!hoverRegion && (p.a === hoverRegion || p.b === hoverRegion);
        out.push({
          id: `bundle:${p.a}|${p.b}`,
          source: p.a,
          target: p.b,
          sourceHandle: p.a.startsWith('region:') ? 'c' : 'T-R',
          targetHandle: p.b.startsWith('region:') ? 'c' : 'T-L',
          type: 'bundle',
          selectable: false,
          // under the blocks (a line passing behind a group doesn't cut through it) unless highlighted
          zIndex: lit ? 2 : -2,
          data: { a: frame(p.a), b: frame(p.b), ab: p.ab, ba: p.ba, title: p.fks.join('\n'), color: colorOf(p.ab >= p.ba ? p.a : p.b), lit, dim: !!hoverRegion && !lit },
        });
      }
      return out;
    }

    for (const r of schema.relations) {
      // a portal relation is drawn only while its hub's mark is hovered, as a ghost line
      const ghost = hidden.has(r.id) ? hubs.get(r.to.table) : undefined;
      if (hidden.has(r.id) && (!ghost || ghost.id !== hubHover)) continue;
      const f = byId.get(r.from.table);
      const t = byId.get(r.to.table);
      if (!f || !t) continue;
      const fc = f.columns.find((c) => c.id === r.from.columns[0]);
      const tc = t.columns.find((c) => c.id === r.to.columns[0]);
      if (!fc || !tc) continue;
      const route = ghost ? undefined : routes?.get(r.id);
      const dx = t.x + CARD_W / 2 - (f.x + CARD_W / 2);
      const fs = route?.srcSide ?? (dx >= 0 ? 'R' : 'L');
      const ts = route?.dstSide ?? (dx >= 0 ? 'L' : 'R');
      const compact = detail === 'compact';
      const onPath = !!path?.relIds.has(r.id);
      const isHover = hoverEdge === r.id;
      const lit = isHover || (!!highlight.focusId && (r.from.table === highlight.focusId || r.to.table === highlight.focusId));
      const focused = !!highlight.focusId || !!hoverEdge;
      const g = f.groupId ? byGroup.get(f.groupId) : undefined;
      out.push({
        id: r.id,
        source: f.id,
        target: t.id,
        sourceHandle: compact ? `T-${fs}` : `${fc.id}-${fs}`,
        targetHandle: compact ? `T-${ts}` : `${tc.id}-${ts}`,
        type: 'relation',
        selected: selection?.kind === 'relation' && selection.id === r.id,
        data: {
          label: `${f.name}.${fc.name} → ${t.name}.${tc.name}`,
          onDelete: r.onDelete,
          childUnique: fc.unique || (fc.pk && f.columns.filter((c) => c.pk).length === 1),
          childNullable: r.from.columns.some((id) => f.columns.find((c) => c.id === id)?.nullable),
          faded: path?.rels ? !onPath : isFaded(f.id, t.id),
          dim: focused && !lit && !path?.rels && !(lens?.has(f.id) && lens.has(t.id)),
          lit: lit && !path?.rels,
          hover: isHover,
          points: route?.points,
          path: onPath,
          diff: diff?.relationStatus.get(r.id) === 'added' ? 'added' : undefined,
          color: ghost ? ghost.color : view === 'atlas' ? g?.color : undefined,
          blueprint: view === 'blueprint',
          ghost: !!ghost,
        },
        zIndex: onPath || lit || ghost ? 2 : 0,
        ...(ghost && { selectable: false, focusable: false }),
      });
    }
    for (const n of schema.notes) {
      if (!n.attachedTo || !byId.has(n.attachedTo)) continue;
      const t = byId.get(n.attachedTo)!;
      const side = t.x + CARD_W / 2 < n.x ? 'T-R' : 'T-L';
      out.push({ id: `nl:${n.id}`, source: `note:${n.id}`, sourceHandle: 'n', target: n.attachedTo, targetHandle: side, type: 'notelink', selectable: false, focusable: false });
    }
    return out;
  }, [schema, view, hidden, path, lens, selection, detail, diff, highlight, routes, hoverEdge, bundles, hoverRegion, hubs, hubHover]);

  // Handles move without the card changing size (detail level, view, column edits),
  // which React Flow's resize observer can't see — re-measure them explicitly.
  const updateNodeInternals = useUpdateNodeInternals();
  const handleShape = `${view}|${detail}|${overview}|${schema.groups.map((g) => g.id).join(',')}|${schema.tables.map((t) => `${t.id}:${t.columns.map((c) => c.id).join(',')}`).join('|')}`;
  useEffect(() => {
    const ids = [...schema.tables.map((t) => t.id), ...schema.groups.map((g) => `region:${g.id}`)];
    const raf = requestAnimationFrame(() => updateNodeInternals(ids));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleShape, updateNodeInternals]);

  // Constellation positions have nothing in common with card positions: reframe on entry/exit and after orbits settle.
  const isStars = view === 'constellation';
  const firstFrame = useRef(true);
  useEffect(() => {
    if (firstFrame.current) {
      firstFrame.current = false;
      return;
    }
    const t = window.setTimeout(() => rf.fitView({ padding: 0.12, duration: 500, maxZoom: 1 }), starFocus !== undefined && isStars ? 760 : 80);
    return () => window.clearTimeout(t);
  }, [isStars, starFocus, rf]);

  // ---- interactions ----
  // stars: a tap puts the table at the centre of the orbits, a second tap (or a tap on the centre star) opens its panel
  // (counted here rather than with dblclick, which touch browsers don't reliably fire). The star
  // starts sliding to the centre after the first tap, so the second one is matched by time and
  // screen position, whatever ends up under the pointer: another star, a link or the empty sky.
  const lastStarTap = useRef<{ id: string; at: number; x: number; y: number } | null>(null);
  const secondStarTap = useCallback((e: React.MouseEvent) => {
    const prev = lastStarTap.current;
    if (!prev || performance.now() - prev.at > 400 || Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 30) return false;
    lastStarTap.current = null;
    useStore.getState().select({ kind: 'table', id: prev.id });
    return true;
  }, []);
  const onStarTap = useCallback((e: React.MouseEvent, id: string) => {
    if (secondStarTap(e)) return;
    const st = useStore.getState();
    // the centre star doesn't move, so one tap is enough to open it
    if (st.starFocus === id) {
      st.select({ kind: 'table', id });
      return;
    }
    lastStarTap.current = { id, at: performance.now(), x: e.clientX, y: e.clientY };
    st.set({ starFocus: id });
    // an open table panel follows the new centre
    if (st.selection?.kind === 'table' && st.selection.id !== id) st.select({ kind: 'table', id });
  }, [secondStarTap]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const st = useStore.getState();
      const dims = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
      if (dims.length) {
        setMeasured((prev) => {
          const next = new Map(prev);
          for (const c of dims) if (c.type === 'dimensions' && c.dimensions) next.set(c.id, c.dimensions);
          return next;
        });
      }
      const moves = changes.filter((c) => c.type === 'position' && c.position);
      if (moves.length) {
        if (view === 'constellation') {
          for (const c of moves) {
            if (c.type !== 'position' || !c.position) continue;
            const n = nodes.find((x) => x.id === c.id);
            const r = ((n?.data as { r?: number })?.r ?? 0) as number;
            setStarPos(c.id, { x: c.position.x + r, y: c.position.y + r });
          }
          return;
        }
        // snap to the background grid so cards line up with the dots/lines and with each other
        const grid = view === 'blueprint' ? 24 : 22;
        const at = (v: number) => (snap ? Math.round(v / grid) * grid : Math.round(v));
        st.setTransient((d) => {
          for (const c of moves) {
            if (c.type !== 'position' || !c.position) continue;
            if (c.id.startsWith('region:')) {
              const gid = c.id.slice(7);
              const region = nodes.find((n) => n.id === c.id);
              if (!region) continue;
              let dx = c.position.x - region.position.x;
              let dy = c.position.y - region.position.y;
              if (snap) {
                // the group's top-left table lands on the grid; the others keep their offsets from it
                const members = d.tables.filter((t) => t.groupId === gid);
                const x0 = Math.min(...members.map((t) => t.x));
                const y0 = Math.min(...members.map((t) => t.y));
                dx = at(x0 + dx) - x0;
                dy = at(y0 + dy) - y0;
              }
              for (const t of d.tables) if (t.groupId === gid && !t.locked) {
                t.x = Math.round(t.x + dx);
                t.y = Math.round(t.y + dy);
              }
            } else if (c.id.startsWith('note:')) {
              const note = d.notes.find((n) => `note:${n.id}` === c.id);
              if (note) {
                note.x = at(c.position.x);
                note.y = at(c.position.y);
              }
            } else {
              const t = d.tables.find((x) => x.id === c.id);
              if (t) {
                t.x = at(c.position.x);
                t.y = at(c.position.y);
              }
            }
          }
        });
      }
    },
    [nodes, view, setStarPos, snap],
  );

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    const st = useStore.getState();
    const s = st.schema;
    const colId = (h: string) => h.replace(/-[LR]$/, '');
    let from = { table: c.source, col: colId(c.sourceHandle) };
    let to = { table: c.target, col: colId(c.targetHandle) };
    const col = (t: string, id: string) => s.tables.find((x) => x.id === t)?.columns.find((x) => x.id === id);
    const fc = col(from.table, from.col);
    const tc = col(to.table, to.col);
    if (!fc || !tc) return;
    // the referenced side should be the key; flip if the user dragged from the key
    const isKey = (x: typeof fc) => x.pk || x.unique;
    if (isKey(fc) && !isKey(tc)) [from, to] = [to, from];
    if (s.relations.some((r) => r.from.columns[0] === from.col && r.to.columns[0] === to.col)) return;
    st.commit((d: Schema) => {
      d.relations.push({ id: uid(), from: { table: from.table, columns: [from.col] }, to: { table: to.table, columns: [to.col] }, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
    });
    const f2 = col(from.table, from.col)!;
    const t2 = col(to.table, to.col)!;
    if (canonicalType(f2.type) !== canonicalType(t2.type) && !isSerial(f2.type)) st.toast(`Linked ${f2.name} → ${t2.name}, but types differ (${f2.type} vs ${t2.type})`, 'warn');
  }, []);

  const bg = view === 'blueprint' ? BackgroundVariant.Lines : BackgroundVariant.Dots;

  return (
    <div className={`canvas view-${view} detail-${detail}${exporting ? ' is-exporting' : ''}`} data-theme-canvas={theme}>
      <ReactFlow
        proOptions={{ hideAttribution: true }} // React Flow (MIT) is credited in the README
        nodes={shownNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={() => useStore.getState().checkpoint()}
        onNodeDragStop={() => useStore.setState((s) => ({ revision: s.revision + 1 }))}
        onNodeClick={(_, n) => {
          const st = useStore.getState();
          if (n.type === 'star') onStarTap(_, n.id);
          else if (n.id.startsWith('region:')) st.select({ kind: 'group', id: n.id.slice(7) });
          else if (n.id.startsWith('note:')) st.select({ kind: 'note', id: n.id.slice(5) });
          else if (n.type === 'table') {
            const target = (_.target as HTMLElement).closest('[data-col]') as HTMLElement | null;
            st.select({ kind: 'table', id: n.id, columnId: target?.dataset.col });
          }
        }}
        onNodeDoubleClick={(_, n) => {
          if (n.type === 'region' && overview) {
            const f = regionFrame(useStore.getState().schema, n.id.slice(7), 'compact');
            if (f) rf.fitBounds({ x: f.x, y: f.y, width: f.w, height: f.h }, { padding: 0.15, duration: 600 });
          }
        }}
        onEdgeClick={(ev, e) => !secondStarTap(ev) && !e.id.startsWith('nl:') && useStore.getState().select({ kind: 'relation', id: e.id })}
        onPaneClick={(ev) => !secondStarTap(ev) && useStore.getState().select(null)}
        onNodeMouseEnter={(_, n) => {
          if (n.type === 'table' || n.type === 'star') setHover(n.id);
          else if (n.type === 'region' && overview) setHoverRegion(n.id);
        }}
        onNodeMouseLeave={() => {
          setHover(null);
          setHoverRegion(null);
        }}
        onEdgeMouseEnter={(_, e) => e.type === 'relation' && setHoverEdge(e.id)}
        onEdgeMouseLeave={() => setHoverEdge(null)}
        onConnect={onConnect}
        onDoubleClick={(e) => {
          if (view === 'constellation') return;
          if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return;
          const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          useStore.getState().addTable({ x: p.x - CARD_W / 2, y: p.y - 24 });
        }}
        connectionMode={ConnectionMode.Loose}
        zoomOnDoubleClick={false}
        minZoom={0.08}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        nodesConnectable={view !== 'constellation'}
        elevateEdgesOnSelect
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        onlyRenderVisibleElements={false}
      >
        <Background variant={bg} gap={view === 'blueprint' ? 24 : 22} size={view === 'blueprint' ? 1 : 1.3} className="bg" />
        {view === 'blueprint' && <Background id="major" variant={BackgroundVariant.Lines} gap={120} className="bg-major" />}
        <CanvasToolbar moveLocked={moveLocked} onMoveLocked={setMoveLocked} snap={snap} onSnap={toggleSnap} />
        {miniOpen && (
          <MiniMap
            position="bottom-left"
            style={{ width: mini.w, height: mini.h, margin }}
            pannable
            zoomable
            nodeColor={(n) => {
              if (n.type === 'region') return (n.data as { overview?: boolean; color?: string }).overview ? (n.data as { color: string }).color : 'transparent';
              if (n.type === 'rings') return 'transparent';
              const d = n.data as { groupColor?: string; color?: string; table?: { color?: string } };
              return d.table?.color ?? d.groupColor ?? d.color ?? '#8892b0';
            }}
            nodeStrokeWidth={0}
            maskColor="var(--minimap-mask)"
          />
        )}
        {/* camera: zoom, fit and the minimap toggle, centred along the minimap's bottom edge while it is shown */}
        <Controls
          orientation="horizontal"
          showInteractive={false}
          fitViewOptions={{ padding: 0.15, maxZoom: 1, duration: 300 }}
          position="bottom-left"
          className="controls mini-zoom"
          style={
            miniOpen
              ? { margin: 0, marginLeft: margin + (mini.w - MINI_ZOOM_W) / 2, marginBottom: margin + 6 }
              : { margin }
          }
        >
          <ControlButton onClick={toggleMini} title={miniOpen ? 'Hide the minimap' : 'Show the minimap'} aria-label={miniOpen ? 'Hide the minimap' : 'Show the minimap'} className={miniOpen ? 'is-on' : ''}>
            <MapIcon size={14} />
          </ControlButton>
        </Controls>
      </ReactFlow>
      {back && view === 'atlas' && (
        <div className="back-pill" role="status">
          <button
            className="back-pill-go"
            title={`Fly back to ${back.name}`}
            onClick={() => {
              flyTo(back.id);
              setBack(null);
            }}
          >
            <CornerUpLeft size={14} />
            <span>
              Back to <b>{back.name}</b>
            </span>
          </button>
          <button className="icon-btn" title="Dismiss" onClick={() => setBack(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {showLockHint && (
        <div className="lock-hint" role="status">
          <Lock size={14} />
          <span>
            Tables are locked in place. Use the <b>lock button</b> at the top left to move them.
          </span>
          <button className="icon-btn" title="Got it" onClick={() => setLockHint(false)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
