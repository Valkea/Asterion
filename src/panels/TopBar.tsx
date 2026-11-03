import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Code2,
  Download,
  FileUp,
  FolderOpen,
  Image,
  Link2,
  Map as MapIcon,
  Orbit,
  Redo2,
  Ruler,
  Search,
  ShieldCheck,
  Undo2,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ViewMode } from '../model/types';
import { generateSql } from '../sql/generator';
import { useStore } from '../store/store';
import { download, slug } from '../util/files';
import { Promises } from './Promises';
import { useActions } from './useActions';

export const VIEWS: { id: ViewMode; label: string; icon: typeof MapIcon; hint: string }[] = [
  { id: 'atlas', label: 'Atlas', icon: MapIcon, hint: 'Domains as regions, semantic zoom (1)' },
  { id: 'blueprint', label: 'Blueprint', icon: Ruler, hint: 'Classic full-detail ERD (2)' },
  { id: 'constellation', label: 'Constellation', icon: Orbit, hint: 'Explore as a graph; click a star to centre it, click the centre to edit (3)' },
];

function Menu({ label, icon, children, className = '' }: { label: string; icon: React.ReactNode; children: (close: () => void) => React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // pointerdown + capture: also fires for taps, before the canvas can swallow them
    window.addEventListener('pointerdown', h, true);
    return () => window.removeEventListener('pointerdown', h, true);
  }, [open]);
  return (
    <div className={`menu ${className}`} ref={ref}>
      <button className={`tb-btn ${open ? 'is-on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}
        {label && <span className="tb-label">{label}</span>}
      </button>
      {open && <div className="menu-pop">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Always-visible reminder that the schema never leaves this device; click for how it works. */
function LocalBadge({ align = 'left' }: { align?: 'left' | 'right' }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  const exportSql = () => {
    const schema = useStore.getState().schema;
    download(`${slug(schema.name)}.sql`, generateSql(schema, { embedLayout: true }), 'application/sql');
  };
  return (
    <div className={`local ${align === 'right' ? 'local-right' : ''}`} ref={ref}>
      <button className={`local-badge ${online ? '' : 'is-offline'} ${open ? 'is-open' : ''}`} aria-expanded={open} title="Where your data lives" onClick={() => setOpen(!open)}>
        {online ? <ShieldCheck size={13} /> : <WifiOff size={13} />}
        <span className="tb-label">{online ? 'Local only' : 'Offline'}</span>
      </button>
      {open && (
        <div className="local-pop" role="dialog" aria-label="Where your data lives">
          <div className="local-pop-head">
            {online ? <ShieldCheck size={16} /> : <WifiOff size={16} />}
            <span>{online ? 'Your schema stays on this device' : 'You are offline: everything still works'}</span>
          </div>
          <Promises className="local-pop-list" />
          <div className="local-pop-foot">
            <button className="btn sm primary" onClick={exportSql}>
              <Download size={13} /> Export SQL + layout now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Brand() {
  return (
    <button className="brand" title="New schema: back to the start page (⌘Z or the browser's Back brings this one back)" onClick={() => useStore.getState().startOver()}>
      <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
        <circle cx="10" cy="11" r="3.2" fill="#7c9cff" />
        <circle cx="22" cy="9" r="2.4" fill="#5eead4" />
        <circle cx="20" cy="22" r="3.6" fill="#f0abfc" />
        <path d="M10 11 L22 9 M10 11 L20 22 M22 9 L20 22" stroke="currentColor" strokeOpacity=".5" strokeWidth="1.2" />
      </svg>
      <span>Dedal</span>
    </button>
  );
}

export function TopBar({ onPalette }: { onPalette: () => void }) {
  const schema = useStore((s) => s.schema);
  const view = schema.view ?? 'atlas';
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const st = useStore.getState;
  const { share, openFile, exportSql, exportImage } = useActions();

  const exportMenu = (
    <Menu label="Export" icon={<><Download size={15} className="tb-file-wide" /><FolderOpen size={15} className="tb-file-narrow" /></>}>
      {(close) => (
        <>
          {/* on a narrow phone Open folds in here, at the same spot */}
          <button className="tb-file-narrow" onClick={() => { close(); void openFile(); }}>
            <FileUp size={14} /> Open a .sql file
          </button>
          <div className="menu-sep tb-file-narrow">Export</div>
          <button onClick={() => { exportSql(true); close(); }}>
            <Download size={14} /> SQL + layout <small>re-opens with positions</small>
          </button>
          <button onClick={() => { exportSql(false); close(); }}>
            <Code2 size={14} /> Plain SQL
          </button>
          <button onClick={() => { close(); void exportImage(); }}>
            <Image size={14} /> PNG image
          </button>
        </>
      )}
    </Menu>
  );

  return (
    <header className="topbar">
      <Brand />
      <input
        className="schema-name"
          size={Math.max(4, schema.name.length)}
        value={schema.name}
        onChange={(e) => st().commit((d) => void (d.name = e.target.value), 'schema-name')}
        spellCheck={false}
        aria-label="Schema name"
      />
      <div className="tb-group tb-file">
        <button
          className="tb-btn tb-file-wide"
          title="Open a .sql file"
          onClick={() => void openFile()}
        >
          <FileUp size={15} />
          <span className="tb-label">Open</span>
        </button>
        {exportMenu}
      </div>
      <div className="tb-group">
        <button className="tb-btn" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => st().undo()}>
          <Undo2 size={15} />
        </button>
        <button className="tb-btn" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => st().redo()}>
          <Redo2 size={15} />
        </button>
      </div>
      <span className="grow" />
      <div className="segmented" role="tablist">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'is-on' : ''} title={v.hint} onClick={() => st().setView(v.id)}>
            <v.icon size={15} />
            <span className="tb-label-view">{v.label}</span>
          </button>
        ))}
      </div>
      <span className="grow" />
      <button className="tb-btn" title="Command palette (⌘K)" onClick={onPalette}>
        <Search size={15} />
      </button>
      <div className="tb-group">
        <LocalBadge align="right" />
        <button className="tb-btn primary" title="Copy a link that contains the whole schema: whoever opens it gets the schema, no server involved. Bookmark the page to save your work." onClick={share}>
          <Link2 size={15} />
          <span className="tb-label">Share</span>
        </button>
      </div>
    </header>
  );
}

/** Packed or aligned columns, drawn along the way cards stack in the current direction. */
export function FlowPackIcon({ compact, direction, size }: { compact: boolean; direction: 'RIGHT' | 'DOWN'; size: number }) {
  const Icon = direction === 'RIGHT' ? (compact ? AlignStartHorizontal : AlignCenterHorizontal) : compact ? AlignStartVertical : AlignCenterVertical;
  return <Icon size={size} />;
}
