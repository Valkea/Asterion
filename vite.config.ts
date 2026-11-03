import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Production builds only. The page may load its own files and nothing else: the
// browser itself refuses any request to another host, so "nothing leaves your
// machine" is enforced, not just promised. (Inline styles: React `style` props.)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Offline support without a dependency: emit `sw.js` that pre-caches every
 * built file (including the lazily loaded ones such as the layout engine), plus
 * a web manifest so the app can be installed.
 */
function offline(): Plugin {
  return {
    name: 'odbe-offline',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'manifest', href: './manifest.webmanifest' }, injectTo: 'head' },
    ],
    generateBundle(_, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(
          {
            name: 'Dedal',
            short_name: 'Dedal',
            description: 'PostgreSQL schema designer that runs entirely in your browser, offline.',
            start_url: './',
            scope: './',
            display: 'standalone',
            background_color: '#0a0c11',
            theme_color: '#0a0c11',
            icons: [{ src: './favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
          },
          null,
          2,
        ),
      });
      const files = [...new Set(['./', './favicon.svg', ...Object.keys(bundle).map((f) => `./${f}`)])]; // the bundle includes the manifest; addAll rejects duplicates
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorker(version, files) });
    },
  };
}

const serviceWorker = (version: string, files: string[]) => `// Generated at build time: caches the whole app so it works with no network.
const CACHE = 'odbe-${version}';
const FILES = ${JSON.stringify(files, null, 2)};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('odbe-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // the page itself: network first, so a plain refresh always gets the latest release;
  // the cached shell only when offline (or the network hangs)
  if (req.mode === 'navigate') {
    e.respondWith(
      Promise.race([fetch(req), new Promise((_, no) => setTimeout(no, 4000))])
        .then((r) => (r.ok ? r : Promise.reject(r)))
        .catch(() => caches.match('./', { ignoreSearch: true, ignoreVary: true }).then((r) => r || fetch(req))),
    );
    return;
  }
  // ignoreVary: hosts often send "Vary: Origin", and module scripts carry an Origin header the precache requests didn't
  e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((r) => r || fetch(req)));
});
`;

export default defineConfig({
  // relative base: the build works from any static host or sub-path (GitHub Pages, a file share…)
  base: './',
  plugins: [react(), offline()],
  build: {
    // elkjs is ~1.5 MB but only loaded the first time you click Arrange
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          flow: ['@xyflow/react'],
          codemirror: ['codemirror', '@codemirror/lang-sql', '@codemirror/lint', '@codemirror/view', '@codemirror/state', '@codemirror/language'],
          graph: ['graphology', 'graphology-communities-louvain', 'd3-force'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as never);
