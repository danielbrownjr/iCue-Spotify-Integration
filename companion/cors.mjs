// iCUE on Windows sends file://; ordinary file-based browsers may send null.
export function allowWidgetOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== "null" && origin !== "file://" && origin !== "http://127.0.0.1:8765") return false;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Widget-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return true;
}

