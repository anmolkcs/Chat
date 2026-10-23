# Chat

A fast, no-build chat app for [Hack Club AI](https://docs.ai.hackclub.com), hosted on GitHub Pages.

**Live:** https://anmolkcs.github.io/Chat/

- Streaming replies, Markdown + code highlighting, copy buttons
- Model picker (live list from `/models`), collapsible "thinking" for reasoning models
- Multiple chats saved in your browser, system prompt, stop button
- Works on phone and desktop

## Why there's a Worker

Hack Club AI only allows browser (CORS) requests from its own sites, so a GitHub Pages app can't call it directly. `worker/worker.js` is a tiny Cloudflare Worker that adds CORS for `https://anmolkcs.github.io` only. It is not an open proxy: every chat request must carry the user's own Hack Club AI key, per the [rules](https://docs.ai.hackclub.com/guide/rules.html).

### Set up the Worker (free, ~2 min)

1. Sign in at https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker** → name it `hcai-relay` → **Deploy**.
2. Click **Edit code**, replace everything with the contents of `worker/worker.js`, then **Deploy**.
3. Copy the worker URL (like `https://hcai-relay.<you>.workers.dev`).

### Use the app

Open the live page → **⚙ Settings**:

- **API key:** from https://ai.hackclub.com/dashboard
- **API base URL:** `https://hcai-relay.<you>.workers.dev/proxy/v1`

Your key and chats are stored only in your browser's localStorage.

## Run locally

Any static server works, e.g. `python3 -m http.server`, then open http://localhost:8000.
