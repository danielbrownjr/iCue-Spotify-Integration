import { normalizePlayback } from "./spotify.mjs";
import { queueSnapshot } from "./queue-jump.mjs";

// API budgets are enforced here, not in the browser (which can have multiple tiles).
export const ACTIVE_PLAYBACK_TTL_MS = 15000;
export const IDLE_PLAYBACK_TTL_MS = 30000;
export const QUEUE_TTL_MS = 60000;

export function createStateReader(request, { now = () => Date.now() } = {}) {
  const newCache = () => ({
    value: null, expires: 0, observedAt: 0, pending: null,
    generation: 0, trackUri: null
  });
  const playbackCache = newCache();
  const queueCache = newCache();

  function expire(cache) {
    cache.generation++;
    cache.expires = 0;
    // An in-flight read from before a mutation cannot repopulate fresh cache.
    cache.pending = null;
  }

  function cached(cache, lifetime, read, trackUri = null) {
    if (now() < cache.expires) return Promise.resolve(cache.value);
    if (cache.pending) return cache.pending;
    const generation = cache.generation;
    let pending;
    pending = Promise.resolve().then(read).then((value) => {
      if (generation === cache.generation) {
        const receivedAt = now();
        cache.value = value;
        cache.observedAt = receivedAt;
        cache.expires = receivedAt + (typeof lifetime === "function" ? lifetime(value) : lifetime);
        cache.trackUri = trackUri;
      }
      return value;
    }).finally(() => {
      if (cache.pending === pending) cache.pending = null;
    });
    cache.pending = pending;
    return pending;
  }

  async function readState() {
    const playback = await cached(playbackCache,
      (value) => value?.is_playing ? ACTIVE_PLAYBACK_TTL_MS : IDLE_PLAYBACK_TTL_MS,
      () => request("/me/player"));
    const currentUri = playback?.item?.uri ?? null;
    // A track change invalidates the queue immediately, rather than displaying
    // the previous song's upcoming list for up to a minute.
    if (queueCache.expires > 0 && queueCache.trackUri !== currentUri) expire(queueCache);
    let queue, queueError = null;
    try {
      queue = await cached(queueCache, QUEUE_TTL_MS, () => request("/me/player/queue"), currentUri);
    } catch (error) {
      queueError = error.message;
      queue = queueCache.value;
    }
    const state = normalizePlayback(playback, queue);
    if (state.playing && state.track && Number.isFinite(state.progressMs)) {
      const elapsed = Math.max(0, now() - playbackCache.observedAt);
      const duration = state.track.durationMs;
      state.progressMs = duration > 0
        ? Math.min(duration, state.progressMs + elapsed) : state.progressMs + elapsed;
    }
    state.queueError = queueError;
    // Queue jumps always revalidate fresh reads. Never issue a snapshot if a
    // queue fetch failed, even if old cached queue content is still visible.
    state.queueSnapshot = queueError ? null : queueSnapshot(playback, queue);
    return state;
  }

  return {
    readState,
    invalidate() {
      expire(playbackCache);
      expire(queueCache);
    }
  };
}
