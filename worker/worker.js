// Cloudflare Worker relay for the Chat app on GitHub Pages.
//
// Hack Club AI only allows browser (CORS) requests from its own sites, so the
// page at https://anmolkcs.github.io/Chat/ talks to this Worker instead.
//
// This is deliberately NOT an open proxy:
//   * only the allowed Origin(s) get CORS headers; other browser origins are refused
//   * only the few API endpoints the app uses are forwarded (path + method allowlist)
//   * chat and stats calls must carry the caller's OWN Hack Club AI key (Bearer)
//   * only Authorization + Content-Type are forwarded upstream; no cookies, no IPs
//   * request bodies are capped (default 10 MB) and must be JSON
//   * upstream response headers are filtered (no Set-Cookie etc.)
//
// Note: a non-browser client can fake an Origin header. That's fine here because
// every billable request still needs the caller's own Hack Club key, so the
// Worker never gives anyone access they don't already have (Hack Club rule #3).
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> your worker -> Edit code ->
// paste this whole file -> Deploy. App setting "API base URL" stays
// https://<your-worker>.workers.dev/proxy/v1

const UPSTREAM = "https://ai.hackclub.com";
const ALLOWED_ORIGINS = ["https://anmolkcs.github.io"];
const MAX_BODY_BYTES = 10 * 1024 * 1024; // images/PDFs are compressed client-side

// path -> allowed methods (besides OPTIONS). Everything else is 404.
const ROUTES = {
  "/proxy/v1/chat/completions": { methods: ["POST"], auth: true },
  "/proxy/v1/models": { methods: ["GET"], auth: false },
  "/proxy/v1/stats": { methods: ["GET"], auth: true },
};

const PASS_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(status, obj, origin) {
  const h = { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" };
  if (origin) Object.assign(h, corsHeaders(origin));
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const route = Object.prototype.hasOwnProperty.call(ROUTES, path) ? ROUTES[path] : null;

    if (!allowed) return json(403, { error: "Forbidden origin" });

    // CORS preflight: only for known routes and methods.
    if (request.method === "OPTIONS") {
      const want = (request.headers.get("Access-Control-Request-Method") || "").toUpperCase();
      if (!route || (want && !route.methods.includes(want))) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!route) return json(404, { error: "Not found" }, origin);
    if (!route.methods.includes(request.method)) return json(405, { error: "Method not allowed" }, origin);

    const auth = request.headers.get("Authorization") || "";
    const authOk = /^Bearer [\x21-\x7E]{8,512}$/.test(auth);
    if (route.auth && !authOk) {
      return json(401, { error: "Bring your own Hack Club AI key (Settings → API key)." }, origin);
    }

    const headers = new Headers();
    if (authOk) headers.set("Authorization", auth);

    let body;
    if (request.method === "POST") {
      const ct = (request.headers.get("Content-Type") || "").toLowerCase();
      if (!ct.startsWith("application/json")) return json(415, { error: "Content-Type must be application/json" }, origin);
      const len = Number(request.headers.get("Content-Length") || 0);
      if (len > MAX_BODY_BYTES) return json(413, { error: "Request too large (max 10 MB). Remove some attachments or start a new chat." }, origin);
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return json(413, { error: "Request too large (max 10 MB)." }, origin);
      headers.set("Content-Type", "application/json");
    }

    let upstream;
    try {
      // Query strings are not forwarded; none of the allowed endpoints need one.
      upstream = await fetch(UPSTREAM + path, { method: request.method, headers, body, redirect: "manual" });
    } catch {
      return json(502, { error: "Couldn't reach Hack Club AI. Try again in a moment." }, origin);
    }

    const out = new Headers(corsHeaders(origin));
    for (const h of PASS_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
