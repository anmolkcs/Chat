// Cloudflare Worker: lets the GitHub Pages app call Hack Club AI from the browser.
// Hack Club's API only allows CORS from its own sites, so this adds CORS for your page.
// It is NOT an open proxy: every request must carry the caller's own Hack Club API key,
// and only your GitHub Pages origin is allowed.

const UPSTREAM = "https://ai.hackclub.com";
const ALLOWED_ORIGINS = ["https://anmolkcs.github.io"];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    if (!ALLOWED_ORIGINS.includes(origin)) return new Response("Forbidden origin", { status: 403 });
    if (!url.pathname.startsWith("/proxy/v1/")) return new Response("Not found", { status: 404, headers: cors(origin) });
    if (!request.headers.get("Authorization") && url.pathname !== "/proxy/v1/models") {
      return new Response(JSON.stringify({ error: "Bring your own Hack Club AI key" }), { status: 401, headers: { ...cors(origin), "Content-Type": "application/json" } });
    }

    const headers = new Headers();
    for (const h of ["Authorization", "Content-Type"]) {
      const v = request.headers.get(h); if (v) headers.set(h, v);
    }
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : request.body,
    });

    const out = new Headers(upstream.headers);
    Object.entries(cors(origin)).forEach(([k, v]) => out.set(k, v));
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
