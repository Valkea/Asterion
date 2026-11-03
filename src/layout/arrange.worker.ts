// Background search for a cleaner arrangement, started after Arrange: posts each
// arrangement clearly cleaner than the last, then 'done'. The page cancels it by
// terminating the worker.

import type { Schema } from '../model/types';
import { searchLayouts, type ArrangeMode, type Direction } from './auto';

export interface SearchRequest {
  schema: Schema;
  direction: Direction;
  mode: ArrangeMode;
  compact: boolean;
  hidden: string[];
  seed: number;
}

export type SearchMessage = { type: 'better'; pos: [string, number, number][]; crossings: number } | { type: 'done' };

/** Longest the search may run… */
const SEARCH_MS = 40000;
/** …and how long it keeps going without finding anything cleaner (once every start has had its turn). */
const STALE_MS = 9000;

const post = (m: SearchMessage) => self.postMessage(m);

// elkjs, once loaded in a worker, sets self.onmessage for its own protocol: listen beside it
// (it ignores messages without a `cmd`)
self.addEventListener('message', async (e: MessageEvent<SearchRequest>) => {
  const { schema, direction, mode, compact, hidden, seed } = e.data;
  await searchLayouts(
    schema,
    { direction, mode, compact, hiddenRelations: new Set(hidden) },
    {
      deadline: performance.now() + SEARCH_MS,
      staleMs: STALE_MS,
      seed,
      onBetter: ({ pos, crossings }) => post({ type: 'better', pos: [...pos].map(([id, p]) => [id, p.x, p.y]), crossings }),
    },
  );
  post({ type: 'done' });
});
