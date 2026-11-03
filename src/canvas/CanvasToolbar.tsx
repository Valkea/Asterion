import { Panel } from '@xyflow/react';
import { Boxes, ChevronDown, Focus, LayoutGrid, Loader2, Lock, LockOpen, Magnet, Route, Waypoints, Workflow, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FlowPackIcon } from '../panels/TopBar';
import { usePath } from '../store/derived';
import { useStore } from '../store/store';

/** Two-way choice: both options visible, the current one raised. */
function Choice<T extends string>({ value, options, onChange, disabled }: { value: T; options: { id: T; label: React.ReactNode; title?: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className={`segmented ct-choice ${disabled ? 'is-disabled' : ''}`} role="radiogroup">
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? 'is-on' : ''} title={o.title} disabled={disabled} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ArrangeMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const busy = useStore((s) => s.layoutBusy);
  const direction = useStore((s) => s.direction);
  const arrangeMode = useStore((s) => s.arrangeMode);
  const flowCompact = useStore((s) => s.flowCompact);
  const hasGroups = useStore((s) => s.schema.groups.length > 0);
  // arranging by group tries several orientations and keeps the cleanest, so the direction has no say
  const directionIgnored = arrangeMode === 'groups' && hasGroups;
  const st = useStore.getState;
  useEffect(() => {
    if (!open) return;
    const click = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', click, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', click, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="menu split" ref={ref}>
      <button className="tb-btn" title="Auto-layout (L) with the settings in the menu beside it; locked tables stay put" disabled={busy} onClick={() => void st().runAutoLayout()}>
        {busy ? <Loader2 size={15} className="spin" /> : <LayoutGrid size={15} />}
        <span className="tb-label">Arrange</span>
      </button>
      <button className={`tb-btn tb-mini ${open ? 'is-on' : ''}`} title="How to arrange" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu-pop ct-pop" role="dialog" aria-label="Arrange settings">
          <div className="ct-row">
            <span className="ct-key">Strategy</span>
            <Choice
              value={arrangeMode}
              onChange={(v) => st().set({ arrangeMode: v })}
              options={[
                { id: 'groups', label: <><Boxes size={13} /> By group</>, title: 'Islands per domain, fewest crossings' },
                { id: 'flow', label: <><Workflow size={13} /> By dependency</>, title: 'Referenced tables first, groups as bands' },
              ]}
            />
          </div>
          <div className="ct-row">
            <span className="ct-key">Direction</span>
            <Choice
              value={direction}
              disabled={directionIgnored}
              onChange={(v) => st().set({ direction: v })}
              options={[
                { id: 'RIGHT', label: '→ Left to right' },
                { id: 'DOWN', label: '↓ Top to bottom' },
              ]}
            />
          </div>
          {directionIgnored && <div className="ct-note">By group picks the cleanest direction itself.</div>}
          {arrangeMode === 'flow' && (
            <div className="ct-row">
              <span className="ct-key">Columns</span>
              <Choice
                value={flowCompact ? 'compact' : 'aligned'}
                onChange={(v) => st().set({ flowCompact: v === 'compact' })}
                options={[
                  { id: 'aligned', label: <><FlowPackIcon compact={false} direction={direction} size={13} /> Aligned</>, title: 'Cards line up with their links, fewer crossings' },
                  { id: 'compact', label: <><FlowPackIcon compact direction={direction} size={13} /> Compact</>, title: 'Smaller drawing, more crossings' },
                ]}
              />
            </div>
          )}
          <button className="btn sm primary ct-run" disabled={busy} onClick={() => { setOpen(false); void st().runAutoLayout(); }}>
            <LayoutGrid size={13} /> Arrange now <small>L</small>
          </button>
        </div>
      )}
    </div>
  );
}

/** Shown while the layout search started by Arrange runs: click to keep the drawing as it is now. */
function LayoutSearchPill() {
  const searching = useStore((s) => s.layoutSearch);
  if (!searching) return null;
  return (
    <button
      className="tb-btn ct-search"
      title="Looking for a cleaner arrangement; the tables move by themselves when one is found. Click to stop here, ⌘Z to undo the whole Arrange."
      aria-label="Stop looking for a cleaner arrangement"
      onClick={() => useStore.getState().stopLayoutSearch()}
    >
      <Loader2 size={14} className="spin" />
      <span className="tb-label">Searching…</span>
      <X size={12} />
    </button>
  );
}

/** Shown while a join path is lit, in every view: reopens the Join paths panel, or clears the path. */
function JoinPathPill() {
  const res = usePath();
  const { a, b } = useStore((s) => s.path);
  const tables = useStore((s) => s.schema.tables);
  if (!res?.rels) return null;
  const name = (id?: string) => tables.find((t) => t.id === id)?.name;
  const st = useStore.getState;
  return (
    <div className="ct-group ct-path" aria-label="Join path">
      <button className="tb-btn is-on" title={`Join path ${name(a)} → ${name(b)}: click to open the Join paths panel`} onClick={() => st().set({ sidebar: 'paths' })}>
        <Route size={15} />
        <span className="tb-label">
          {name(a)} → {name(b)}
        </span>
      </button>
      <button className="tb-btn tb-mini" title="Clear the join path" aria-label="Clear the join path" onClick={() => st().set({ path: {} })}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Portal thresholds the toolbar steps through, like the lens reach: 1 to 5 inbound foreign keys. */
const nextThreshold = (t: number) => (t % 5) + 1;

/**
 * Top-left canvas tools: everything that depends on the current view.
 * Layout (moves tables, undoable) on the left, view tools (what is drawn) on the right.
 */
export function CanvasToolbar({ moveLocked, onMoveLocked, snap, onSnap }: { moveLocked: boolean; onMoveLocked: (v: boolean) => void; snap: boolean; onSnap: () => void }) {
  const view = useStore((s) => s.schema.view ?? 'atlas');
  const focus = useStore((s) => s.focus);
  const portals = useStore((s) => s.portals);
  const hubThreshold = useStore((s) => s.hubThreshold);
  const st = useStore.getState;
  const layout = view !== 'constellation';
  return (
    <Panel position="top-left" className="canvas-tools nopan nodrag nowheel">
      {layout && (
        <div className="ct-group" aria-label="Layout">
          <button
            className={`tb-btn move-lock ${moveLocked ? 'is-locked' : ''}`}
            onClick={() => onMoveLocked(!moveLocked)}
            title={moveLocked ? 'Moving is locked: click to move tables and notes' : 'Moving is unlocked: click to lock tables and notes in place'}
            aria-label={moveLocked ? 'Unlock moving' : 'Lock moving'}
          >
            {moveLocked ? <Lock size={15} /> : <LockOpen size={15} />}
          </button>
          <ArrangeMenu />
          <LayoutSearchPill />
          <button
            className={`tb-btn ${snap ? 'is-on' : ''}`}
            onClick={onSnap}
            title={snap ? 'Snapping to the grid: click to place tables, groups and notes freely' : 'Snap to grid: click so tables, groups and notes line up on the grid as you drag them'}
            aria-label={snap ? 'Turn off snap to grid' : 'Snap to grid'}
            aria-pressed={snap}
          >
            <Magnet size={15} />
          </button>
        </div>
      )}
      <div className="ct-group" aria-label="View tools">
        <div className="split">
          {layout ? (
            <button className={`tb-btn ${focus.enabled ? 'is-on' : ''}`} title="Focus lens (F): fade tables beyond N hops of the selected table, or the hovered one" onClick={() => st().set({ focus: { ...focus, enabled: !focus.enabled } })}>
              <Focus size={15} />
              <span className="tb-label">Lens</span>
            </button>
          ) : (
            <span className="tb-btn is-on is-static" title="Focus lens: always on here, tables beyond N hops of the selected or hovered star fade">
              <Focus size={15} />
              <span className="tb-label">Lens</span>
            </span>
          )}
          {(focus.enabled || !layout) && (
            <button className="tb-btn tb-mini" title={`Lens reach: ${focus.hops} hop${focus.hops > 1 ? 's' : ''} (click for ${(focus.hops % 5) + 1})`} onClick={() => st().set({ focus: { ...focus, hops: (focus.hops % 5) + 1 } })}>
              {focus.hops}
            </button>
          )}
        </div>
        {view === 'atlas' && (
          <button className={`tb-btn ${portals ? 'is-on' : ''}`} title={`Portals: references to busy tables (≥${hubThreshold} inbound foreign keys) become chips wearing the table's mark instead of long lines. Set a table to always or never in its inspector.`} onClick={() => st().set({ portals: !portals })}>
            <Waypoints size={15} />
            <span className="tb-label">Portals</span>
          </button>
        )}
        {view === 'atlas' && portals && (
          <button className="tb-btn tb-mini" title={`Portal threshold: tables with ${hubThreshold}+ inbound foreign keys become hubs (click for ${nextThreshold(hubThreshold)})`} onClick={() => st().set({ hubThreshold: nextThreshold(hubThreshold) })}>
            ≥{hubThreshold}
          </button>
        )}
      </div>
      <JoinPathPill />
    </Panel>
  );
}
