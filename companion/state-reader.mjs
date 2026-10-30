import { normalizePlayback } from "./spotify.mjs";
import { queueSnapshot } from "./queue-jump.mjs";

// Shared across all local widget clients; a forced browser refresh cannot
// bypass these successful-read TTLs. Mutations explicitly invalidate them.
export const ACTIVE_PLAYBACK_TTL_MS = 15000;
export const IDLE_PLAYBACK_TTL_MS = 30000;
export const QUEUE_TTL_MS = 60000;
export const FAILURE_RETRY_MS = 15000;

export function createStateReader(request, { now = () => Date.now() } = {}) {
  const newCache = () => ({ entry: null, error: null, expires: 0, pending: null, generation: 0, key: null });
  const playbackCache = newCache();
  const queueCache = newCache();
  let revision = 0;

  function expire(cache) {
    cache.generation++;
    cache.expires = 0;
    cache.error = null;
    cache.pending = null;
  }

  function cached(cache, lifetime, read) {
    if (now() < cache.expires) {
      return cache.error ? Promise.reject(cache.error) : Promise.resolve(cache.entry);
    }
    if (cache.pending) return cache.pending;
    const generation = cache.generation;
    const key = cache.key;
    let pending;
    pending = Promise.resolve().then(read).then((value) => {
      const entry = { value, observedAt: now(), key };
      if (generation === cache.generation) {
        cache.entry = entry;
        cache.error = null;
        cache.expires = entry.observedAt + (typeof lifetime === "function" ? lifetime(value) : lifetime);
      }
      return entry;
    }, (error) => {
      // Spotify 429s have their own shared Retry-After gate in the server.
      // Other failed reads also need a budget, rather than retrying on every
      // local request when several tiles or an old widget poll frequently.
      if (generation === cache.generation && error.status !== 429) {
        cache.error = error;
        cache.expires = now() + FAILURE_RETRY_MS;
      }
      throw error;
    }).finally(() => {
      if (cache.pending === pending) cache.pending = null;
    });
    cache.pending = pending;
    return pending;
  }

  async function readState() {
    for (;;) {
      const started = revision;
      let observation;
      try {
        observation = await cached(playbackCache,
          (value) => value?.is_playing ? ACTIVE_PLAYBACK_TTL_MS : IDLE_PLAYBACK_TTL_MS,
          () => request("/me/player"));
      } catch (error) {
        if (started !== revision) continue;
        throw error;
      }
      // Invalidated requests must not return stale bodies to their waiting
      // callers, nor invalidate a queue belonging to a newer observation.
      if (started !== revision || observation !== playbackCache.entry) continue;
      const playback = observation.value;
      const identity = JSON.stringify([playback?.device?.id ?? null, playback?.item?.uri ?? null]);
      if (queueCache.key !== identity) {
        expire(queueCache);
        queueCache.key = identity;
      }
      let queue, queueError = null;
      try {
        queue = (await cached(queueCache, QUEUE_TTL_MS, () => request("/me/player/queue"))).value;
      } catch (error) {
        if (started !== revision || observation !== playbackCache.entry) continue;
        // Even the first queue-only 429 must reach the HTTP client as 429,
        // rather than reporting LIVE with an unusable queue and no cooldown.
        if (error.status === 429) throw error;
        queueError = error.message;
        queue = queueCache.entry?.key === identity ? queueCache.entry.value : null;
      }
      if (started !== revision || observation !== playbackCache.entry) continue;
      const state = normalizePlayback(playback, queue);
      if (state.playing && state.track && Number.isFinite(state.progressMs)) {
        const elapsed = Math.max(0, now() - observation.observedAt);
        const duration = state.track.durationMs;
        state.progressMs = duration > 0
          ? Math.min(duration, state.progressMs + elapsed) : state.progressMs + elapsed;
      }
      state.queueError = queueError;
      state.queueSnapshot = queueError ? null : queueSnapshot(playback, queue);
      return state;
    }
  }

  return {
    readState,
    invalidate() {
      revision++;
      expire(playbackCache);
      expire(queueCache);
    }
  };
}
