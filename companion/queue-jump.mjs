import { createHash } from "node:crypto";

export const MAX_QUEUE_JUMP = 5;

export function queueJumpError(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

function queueEntries(queue) {
  return Array.isArray(queue?.queue) ? queue.queue : [];
}

function queueUri(item) {
  return typeof item?.uri === "string" ? item.uri : null;
}

// Fingerprint the currently playing track and the next five queued entries.
// Avoid binding the tail: Spotify may add recommendations to it at any time.
export function queueSnapshot(playback, queue) {
  if (!playback?.device?.id || !playback?.is_playing || !queueUri(playback.item)) return null;
  const next = queueEntries(queue);
  if (!next.length) return null;
  const uris = next.slice(0, MAX_QUEUE_JUMP).map(queueUri);
  if (uris.some((uri) => !uri)) return null;
  return createHash("sha256").update(JSON.stringify([
    playback.device.id, queueUri(playback.item), uris
  ])).digest("base64url");
}

function ensureActive(playback, deviceId) {
  if (!playback?.device?.id || !playback.is_playing || !queueUri(playback.item))
    throw queueJumpError("Start playback on an active Spotify device before jumping.");
  if (deviceId && playback.device.id !== deviceId)
    throw queueJumpError("Spotify playback moved to another device; stopped jumping.");
}

// Do not act on an ambiguous repeated URI. Spotify has no queue-item ID, so
// an identical URI at two positions cannot be distinguished safely.
function ensureUnique(uris) {
  if (new Set(uris).size !== uris.length)
    throw queueJumpError("Repeated tracks make this jump ambiguous. Use Next manually.");
}

export async function performQueueJump(
  selection,
  request,
  { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  if (!selection || !Number.isInteger(selection.index) ||
      selection.index < 0 || selection.index >= MAX_QUEUE_JUMP ||
      typeof selection.snapshot !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(selection.snapshot))
    throw queueJumpError("Select one of the first five queue entries from the current widget.", 400);

  // Fresh reads, deliberately bypassing the companion's polling caches.
  const initialPlayback = await request("/me/player");
  const initialQueue = await request("/me/player/queue");
  ensureActive(initialPlayback);
  if (selection.snapshot !== queueSnapshot(initialPlayback, initialQueue))
    throw queueJumpError("The queue changed since the widget displayed it. Try again.");
  const initialEntries = queueEntries(initialQueue);
  if (initialEntries.length <= selection.index)
    throw queueJumpError("That queued song is no longer available.");
  const expected = [
    queueUri(initialPlayback.item),
    ...initialEntries.slice(0, selection.index + 1).map(queueUri)
  ];
  if (expected.some((uri) => !uri) || initialEntries.slice(0, selection.index + 1)
      .some((item) => item.type !== "track"))
    throw queueJumpError("Only available songs can be selected for queue jumping.");
  ensureUnique(expected);

  // Retain the full queue suffix observed at the start. Spotify may append
  // new recommendations later; appended entries are fine, but removing or
  // reordering already queued entries makes the operation unsafe to continue.
  const observedSuffix = initialEntries.map(queueUri);
  const deviceId = initialPlayback.device.id;
  let playback = initialPlayback;
  let queue = initialQueue;
  for (let step = 0; step <= selection.index; step++) {
    // Check both the current item and the as-yet-unconsumed ordered prefix.
    ensureActive(playback, deviceId);
    if (queueUri(playback.item) !== expected[step])
      throw queueJumpError("Spotify playback changed; stopped before another skip.");
    const remaining = observedSuffix.slice(step);
    const upcoming = queueEntries(queue).slice(0, remaining.length).map(queueUri);
    if (upcoming.length !== remaining.length ||
        upcoming.some((uri, i) => uri !== remaining[i]))
      throw queueJumpError("Spotify reordered the upcoming songs; stopped jumping.");

    // Exactly one write at a time. Spotify does not guarantee ordering for
    // multiple playback commands sent without checking the resulting state.
    await request("/me/player/next", "POST");

    let confirmed = false;
    let sawExpectedTrack = false;
    let sawUnexpectedQueue = false;
    for (const delay of [300, 450, 650, 900, 1200]) {
      await wait(delay);
      playback = await request("/me/player");
      queue = await request("/me/player/queue");
      ensureActive(playback, deviceId);
      const now = queueUri(playback.item);
      if (now !== expected[step] && now !== expected[step + 1])
        throw queueJumpError("Spotify switched tracks unexpectedly; stopped jumping.");
      if (now !== expected[step + 1]) continue;
      sawExpectedTrack = true;
      const following = observedSuffix.slice(step + 1);
      const currentUpcoming = queueEntries(queue).slice(0, following.length).map(queueUri);
      if (currentUpcoming.length !== following.length ||
          currentUpcoming.some((uri, i) => uri !== following[i])) {
        // Playback and queue endpoints can reflect the same accepted Next
        // at different times. Do not issue ANOTHER Next until both agree.
        // Persistent mismatch still stops safely after bounded polling.
        sawUnexpectedQueue = true;
        continue;
      }
      confirmed = true;
      break;
    }
    if (!confirmed) {
      if (sawExpectedTrack && sawUnexpectedQueue)
        throw queueJumpError("Spotify did not confirm the remaining queue after " +
          (step + 1) + " skip(s); stopped before another skip.");
      throw queueJumpError("Spotify did not confirm the skip in time after " +
        (step + 1) + " command(s). Check playback before retrying.");
    }
  }
  return { ok: true, skipped: selection.index + 1 };
}
