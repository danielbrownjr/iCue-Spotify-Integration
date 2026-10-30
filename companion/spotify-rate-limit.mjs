// Safely classify Spotify 429 responses without copying upstream bodies or credentials to UI/logs.
const MAX_BACKOFF_SECONDS = 7 * 24 * 60 * 60;

export async function parseSpotifyRateLimit(response) {
  const header = response.headers.get("retry-after");
  let retryAfterSeconds = null;
  // Spotify documents seconds. Reject invalid/unbounded values rather than overflowing timestamps.
  if (header !== null && /^\d+$/.test(header.trim())) {
    const parsed = Number(header.trim());
    if (Number.isSafeInteger(parsed)) {
      retryAfterSeconds = Math.max(1, Math.min(parsed, MAX_BACKOFF_SECONDS));
    }
  }
  let reason = null;
  try {
    const payload = await response.json();
    // Whitelist the documented reason instead of relaying untrusted upstream text.
    if (payload?.error?.reason === "QUOTA_EXCEEDED") reason = "QUOTA_EXCEEDED";
  } catch {
    // Spotify may return an empty or non-JSON 429; keep the status and retry header.
  }
  return {
    reason,
    retryAfterSeconds,
    // Respect Spotify's header; for quota failures with no header, slow down conservatively.
    backoffSeconds: retryAfterSeconds ?? (reason === "QUOTA_EXCEEDED" ? 300 : 10)
  };
}

export function spotifyRateLimitError(details, remainingSeconds) {
  const cause = details?.reason === "QUOTA_EXCEEDED"
    ? "Spotify Development Mode API quota exceeded (QUOTA_EXCEEDED)"
    : "Spotify returned HTTP 429 (reason not specified)";
  const seconds = Math.max(1, Math.ceil(remainingSeconds));
  return Object.assign(new Error(cause + "; retry in about " + seconds + "s"), { status: 429 });
}
