import { ReactFlowProvider, useReactFlow, useStore as useFlowStore } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { Canvas, overviewSelector } from './canvas/Canvas';
import { decodeSchema, encodeSchema, readHash } from './share/codec';
import { CommandPalette } from './panels/CommandPalette';
import { Inspector } from './panels/Inspector';
import { Sidebar, SidebarRail } from './panels/Sidebar';
import { SqlPane } from './panels/SqlPane';
import { TopBar } from './panels/TopBar';
import { Welcome } from './panels/Welcome';
import { PhoneNotice } from './panels/PhoneNotice';
import { useStore } from './store/store';
import { isTyping } from './util/files';

/** Keep the URL hash in sync with the schema — the hash never leaves the browser. */
function useUrlSync() {
  const lastWritten = useRef<string>('');
  useEffect(() => {
    const st = useStore.getState();
    const loadFromHash = () => {
      const packed = readHash();
      if (!packed) {
        if (window.location.hash.length > 1) st.set({ linkError: 'The link has no schema in it (nothing after #s=).' });
        if (!useStore.getState().schema.tables.length) st.set({ welcome: true });
        return;
      }
      if (packed === lastWritten.current) return;
      try {
        const schema = decodeSchema(packed);
        lastWritten.current = packed;
        st.set({ linkError: null });
        useStore.getState().load(schema);
        document.title = `${schema.name} · Dedal`;
      } catch (e) {
        console.error(e);
        st.set({
          welcome: true,
          linkError: `This link could not be read — it looks cut off (${packed.length.toLocaleString()} characters after #s=). Chat and e-mail apps sometimes truncate long links; sharing the .sql file (Export → SQL + layout) always works.`,
        });
      }
    };

    // write the current schema into the address bar
    let timer = 0;
    let pending = false;
    const flush = () => {
      window.clearTimeout(timer);
      if (!pending) return;
      pending = false;
      const schema = useStore.getState().schema;
      if (!schema.tables.length && !schema.notes.length) {
        // started over: clear the address bar, as a new history entry so Back returns to the previous schema
        if (window.location.hash) window.history.pushState(null, '', window.location.pathname + window.location.search);
        lastWritten.current = '';
        document.title = 'Dedal';
        return;
      }
      document.title = `${schema.name} · Dedal`;
      const packed = encodeSchema(schema);
      if (packed === lastWritten.current) return;
      lastWritten.current = packed;
      window.history.replaceState(null, '', `#s=${packed}`);
    };
    // flush right away when the page loses focus (e.g. clicking the address bar to copy it)
    const onHide = () => flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();

    loadFromHash();
    window.addEventListener('hashchange', loadFromHash);
    window.addEventListener('blur', onHide);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    const unsub = useStore.subscribe((s, prev) => {
      if (s.schema === prev.schema) return;
      pending = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, 250);
    });
    return () => {
      window.removeEventListener('hashchange', loadFromHash);
      window.removeEventListener('blur', onHide);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
    };
  }, []);
}

function Shell() {
  const welcome = useStore((s) => s.welcome);
  const sqlOpen = useStore((s) => s.sqlOpen);
  const theme = useStore((s) => s.theme);
  const toasts = useStore((s) => s.toasts);
  const [palette, setPalette] = useState(false);
  const [drag, setDrag] = useState(false);
  const rf = useReactFlow();
  useUrlSync();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // frame the drawing after loads
  const fitRequest = useStore((s) => s.fitRequest);
  useEffect(() => {
    if (!fitRequest) return;
    const t = window.setTimeout(() => rf.fitView({ padding: 0.08, duration: 600, maxZoom: 1 }), 60);
    return () => window.clearTimeout(t);
  }, [fitRequest, rf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (isTyping(e)) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod || e.altKey) return;
      const center = () => {
        const c = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        return { x: c.x - 140, y: c.y - 60 };
      };
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          st.deleteSelection();
          break;
        case 'Escape':
          st.set({ selection: null, path: {}, starFocus: null });
          break;
        case '1':
          st.setView('atlas');
          break;
        case '2':
          st.setView('blueprint');
          break;
        case '3':
          st.setView('constellation');
          break;
        case 'f':
          st.set({ focus: { ...st.focus, enabled: !st.focus.enabled } });
          break;
        case 'l':
          void st.runAutoLayout();
          break;
        case 's':
          st.set({ sqlOpen: !st.sqlOpen });
          break;
        case 't':
          st.addTable(center());
          break;
        case 'n':
          st.addNote(center());
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf]);

  return (
    <div
      className={`app ${drag ? 'is-dropping' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (!f) return;
        const st = useStore.getState();
        if (st.sidebar === 'diff' && st.schema.tables.length) {
          const err = st.loadCompareBase(await f.text(), f.name);
          if (err) st.toast(err, 'err');
        } else await st.importSql(await f.text(), f.name);
      }}
    >
      <TopBar onPalette={() => setPalette(true)} />
      <PhoneNotice />
      <div className="main">
        <SidebarRail />
        <Sidebar />
        <div className="stage">
          <Canvas />
          <Inspector />
          {welcome && <Welcome />}
          <LegendHint />
          <div className="toasts">
            {toasts.map((t) => (
              <div key={t.id} className={`toast toast-${t.tone}`}>
                {t.text}
              </div>
            ))}
          </div>
        </div>
        {sqlOpen && <SqlPane />}
      </div>
      {drag && (
        <div className="dropzone">
          {useStore.getState().sidebar === 'diff' && useStore.getState().schema.tables.length ? 'Drop a .sql file to compare with it' : 'Drop a .sql file to open it'}
        </div>
      )}
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

/** What the canvas gestures do in the current view. */
function LegendHint() {
  const view = useStore((s) => s.schema.view ?? 'atlas');
  const hasGroups = useStore((s) => s.schema.groups.length > 0);
  const farZoom = useFlowStore(overviewSelector);
  const hints =
    view === 'constellation'
      ? ['Click a star: centre it', 'Click the centre star or double-click a star: open its table']
      : view === 'atlas' && farZoom && hasGroups
        ? ['Double-click a group: zoom into it', 'Double-click canvas: new table']
        : ['Double-click canvas: new table', 'Drag a column dot onto another: foreign key'];
  return (
    <div className="legend-hint">
      {hints.map((h) => (
        <span key={h}>{h}</span>
      ))}
      <span>⌘K: commands</span>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}
