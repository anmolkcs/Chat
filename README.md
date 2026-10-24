# Chat

A fast, no-build chat app for [Hack Club AI](https://docs.ai.hackclub.com), hosted on GitHub Pages. Built mobile-first (works great as an iPhone home-screen app).

**Live:** https://anmolkcs.github.io/Chat/

## Features

- Streaming replies, Markdown, code highlighting, copy buttons
- Searchable model picker from the live `/models` list, with badges: 👁 sees images · 🎨 makes images · 🧠 reasoning
- **Images in:** attach, paste or drag images (auto-resized and compressed in the browser) for vision models
- **PDFs in:** attach a PDF (up to 5 MB) to any model
- **Images out:** pick an image model (e.g. Nano Banana), choose an aspect ratio, tap an image to download it or "Edit with AI"
- Collapsible "Thoughts" for reasoning models
- Chats saved in your browser (IndexedDB): search, rename, delete, export/import as JSON
- Edit your last message, Regenerate, Stop
- **Survives iOS backgrounding:** the partial reply is saved continuously. If Safari cuts the stream, the reply is clearly marked *Interrupted* with **Continue** and **Retry** buttons. Nothing is ever re-sent automatically. The screen is kept awake while generating (optional).
- Light/dark/system theme, temperature, max tokens, system prompt, usage stats

## Why there's a Worker

Hack Club AI only allows browser (CORS) requests from its own sites, so a GitHub Pages app can't call it directly. `worker/worker.js` is a small Cloudflare Worker that adds CORS for `https://anmolkcs.github.io` only. It is not an open proxy: it only forwards `POST /chat/completions`, `GET /models` and `GET /stats`, every chat request must carry the user's own Hack Club AI key (per the [rules](https://docs.ai.hackclub.com/guide/rules.html)), bodies are capped at 10 MB, and only the `Authorization` and `Content-Type` headers are passed through.

### Set up or update the Worker (free, about 2 minutes)

1. Sign in at https://dash.cloudflare.com, then go to **Workers & Pages** → **Create** → **Create Worker**, name it `hcai-relay`, and click **Deploy** (if it's new).
2. Click **Edit code**, replace everything with the contents of `worker/worker.js`, then click **Deploy**.
3. Copy the worker URL (like `https://hcai-relay.<you>.workers.dev`).

### Use the app

Open the live page, then **⚙︎ Settings**:

- **API key:** from https://ai.hackclub.com/dashboard
- **API base URL:** `https://hcai-relay.<you>.workers.dev/proxy/v1` (pasting just the worker URL works too)

Your key and chats are stored only in this browser. Untick "Remember key" to keep the key only for the current tab.

## Security notes

- All model output is rendered through DOMPurify; links open in a new tab with `rel="noopener noreferrer"`; remote images in replies are blocked (they could leak chat content).
- A Content-Security-Policy allows scripts only from this site (libraries are vendored in `vendor/`) and network calls only to `*.workers.dev` and `ai.hackclub.com`. If you move the Worker to a custom domain, add it to `connect-src` in `index.html`.

## Run locally

Any static server works, for example `python3 -m http.server`, then open http://localhost:8000. The Worker only allows the GitHub Pages origin, so local testing needs your own relay or a mock.
