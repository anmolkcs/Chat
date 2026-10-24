// Chat · Hack Club AI — static, no build step.
// Chats live in this browser (IndexedDB, with a localStorage fallback). The API key
// lives in localStorage only if "Remember key" is on, otherwise in sessionStorage.
"use strict";

// ---------------------------------------------------------------- constants
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const MAX_REQUEST_BYTES = 9 * 1024 * 1024; // Worker caps at 10 MB
const IMG_MAX_EDGE = 1536;
const IMG_TARGET_BYTES = 1_200_000; // data-URL length target per image
const PDF_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 6;
const STALL_MS = 180_000; // no bytes for 3 min -> interrupted
const RETURN_GRACE_MS = 8_000; // after coming back from background, wait this long for bytes
const MODELS_TTL = 6 * 3600_000;
const CONTINUE_PROMPT = "Your previous reply was cut off. Continue exactly where it stopped, starting with the very next characters. Do not repeat anything you already wrote and do not add any preamble.";
const DATA_IMG_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const DATA_PDF_RE = /^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/;
const STATUSES = new Set(["streaming", "interrupted", "stopped", "error", "length"]);

// ---------------------------------------------------------------- tiny helpers
const $ = (s, r = document) => r.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}
const ls = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = el("textarea", { class: "hidden" }); ta.value = t; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); return ok;
  }
}
const shortModel = (id) => (id || "").split("/").pop();

// ---------------------------------------------------------------- settings
const settings = Object.assign(
  { apiKey: "", rememberKey: true, baseUrl: "", systemPrompt: "", model: DEFAULT_MODEL, theme: "system", wakeLock: true, temperature: "", maxTokens: "" },
  (() => { const s = ls.get("settings", {}); return s && typeof s === "object" && !Array.isArray(s) ? s : {}; })()
);
if (typeof settings.model !== "string" || !settings.model) settings.model = DEFAULT_MODEL;
if (!settings.rememberKey) { try { settings.apiKey = sessionStorage.getItem("apiKey") || ""; } catch { settings.apiKey = ""; } }
function saveSettings() {
  const copy = { ...settings };
  if (!settings.rememberKey) {
    delete copy.apiKey;
    try { sessionStorage.setItem("apiKey", settings.apiKey); } catch {}
  } else { try { sessionStorage.removeItem("apiKey"); } catch {} }
  if (!ls.set("settings", copy)) toast("Couldn't save settings (storage full?)");
}
const base = () => (settings.baseUrl || "").replace(/\/+$/, "");
const ready = () => !!(settings.apiKey && base());

// ---------------------------------------------------------------- storage (IndexedDB, fallback localStorage)
const db = {
  h: null,
  async open() {
    if (!("indexedDB" in window)) return null;
    return new Promise((res) => {
      let req;
      try { req = indexedDB.open("hc-chat", 1); } catch { return res(null); }
      req.onupgradeneeded = () => req.result.createObjectStore("chats", { keyPath: "id" });
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onblocked = () => res(null);
    });
  },
  tx(mode, fn) {
    return new Promise((res, rej) => {
      const t = this.h.transaction("chats", mode); const s = t.objectStore("chats");
      const out = fn(s);
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("aborted"));
    });
  },
  async all() {
    if (!this.h) return ls.get("chats", []);
    return this.tx("readonly", (s) => s.getAll());
  },
  async put(chat) {
    if (!this.h) { if (!ls.set("chats", chats)) throw new Error("QuotaExceededError"); return; }
    return this.tx("readwrite", (s) => s.put(chat));
  },
  async del(id) {
    if (!this.h) { ls.set("chats", chats); return; }
    return this.tx("readwrite", (s) => s.delete(id));
  },
  async clear() {
    if (!this.h) { ls.del("chats"); return; }
    return this.tx("readwrite", (s) => s.clear());
  },
};

let chats = [];
let currentId = ls.get("currentId", null);
let storageWarned = false;
const current = () => chats.find((c) => c.id === currentId) || null;

function cleanChat(c) {
  // Validates/normalises a chat loaded from storage or an import. Returns null if unusable.
  if (!c || typeof c !== "object" || !Array.isArray(c.messages)) return null;
  const out = {
    id: typeof c.id === "string" && c.id.length <= 100 ? c.id : uid(),
    title: typeof c.title === "string" ? c.title.slice(0, 200) : "Chat",
    updated: Number.isFinite(c.updated) ? c.updated : Date.now(),
    messages: [],
  };
  for (const m of c.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const msg = { id: typeof m.id === "string" ? m.id : uid(), role: m.role, content: typeof m.content === "string" ? m.content : "" };
    if (typeof m.reasoning === "string" && m.reasoning) msg.reasoning = m.reasoning;
    if (typeof m.model === "string") msg.model = m.model.slice(0, 200);
    if (typeof m.error === "string") msg.error = m.error.slice(0, 2000);
    if (STATUSES.has(m.status)) msg.status = m.status === "streaming" ? "interrupted" : m.status;
    if (Array.isArray(m.attachments)) {
      msg.attachments = m.attachments.filter((a) => a && ((a.kind === "image" && DATA_IMG_RE.test(a.dataUrl)) || (a.kind === "pdf" && DATA_PDF_RE.test(a.dataUrl))))
        .map((a) => ({ kind: a.kind, name: typeof a.name === "string" ? a.name.slice(0, 200) : a.kind, dataUrl: a.dataUrl }));
      if (!msg.attachments.length) delete msg.attachments;
    }
    if (Array.isArray(m.images)) {
      msg.images = m.images.filter((u) => typeof u === "string" && DATA_IMG_RE.test(u));
      if (!msg.images.length) delete msg.images;
    }
    if (Array.isArray(m.annotations)) msg.annotations = m.annotations;
    out.messages.push(msg);
  }
  return out;
}

const dirty = new Set();
let persistTimer = null;
function persist(chat, now = false) {
  if (chat) dirty.add(chat.id);
  ls.set("currentId", currentId);
  if (now) return flushPersist();
  if (!persistTimer) persistTimer = setTimeout(flushPersist, 400); // throttle, not debounce: keeps saving during long streams
}
async function flushPersist() {
  clearTimeout(persistTimer); persistTimer = null;
  const ids = [...dirty]; dirty.clear();
  writeMirror();
  for (const id of ids) {
    const c = chats.find((x) => x.id === id);
    try { if (c) await db.put(c); } catch (e) {
      if (!storageWarned) { storageWarned = true; toast("Storage is full. Export and delete old chats in Settings.", 6000); }
    }
  }
}

// In-flight mirror: a small synchronous copy of the reply being generated, so a
// tab that is killed mid-write still has the latest partial text on reload.
function writeMirror(status) {
  if (!run) return;
  const c = chats.find((x) => x.id === run.chatId); const m = c?.messages.find((x) => x.id === run.msgId);
  if (!m) return;
  ls.set("inflight", { chatId: c.id, msgId: m.id, content: m.content, reasoning: m.reasoning || "", status: status || "streaming" });
}

async function loadChats() {
  db.h = await db.open();
  let list = [];
  try { list = await db.all(); } catch { list = []; }
  // one-time migration from the old localStorage format
  const legacy = ls.get("chats", null);
  if (db.h && Array.isArray(legacy) && legacy.length) {
    for (const c of legacy) { const cc = cleanChat(c); if (cc && !list.some((x) => x.id === cc.id)) { list.push(cc); try { await db.put(cc); } catch {} } }
    ls.del("chats");
  }
  chats = (Array.isArray(list) ? list : []).map(cleanChat).filter(Boolean);
  // Recover anything that was mid-generation when the page died.
  const mirror = ls.get("inflight", null);
  for (const c of chats) {
    let changed = false;
    for (const m of c.messages) {
      if (mirror && mirror.chatId === c.id && mirror.msgId === m.id) {
        if (typeof mirror.content === "string" && mirror.content.length > m.content.length) m.content = mirror.content;
        if (typeof mirror.reasoning === "string" && mirror.reasoning.length > (m.reasoning || "").length) m.reasoning = mirror.reasoning;
        if (!m.status || m.status === "streaming") m.status = "interrupted";
        changed = true;
      }
    }
    if (changed) dirty.add(c.id);
  }
  ls.del("inflight");
  if (!current()) currentId = null;
  await flushPersist();
  try { navigator.storage?.persist?.(); } catch {}
}

// ---------------------------------------------------------------- markdown (sanitised)
const PURIFY_CFG = {
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "frame", "object", "embed", "svg", "math", "video", "audio", "source", "link", "meta", "base"],
  FORBID_ATTR: ["style", "id", "name", "srcset", "formaction"],
  ALLOW_DATA_ATTR: false,
};
let mdReady = false;
function initMarkdown() {
  if (mdReady || !window.marked || !window.DOMPurify) return;
  marked.use({ gfm: true, breaks: true });
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute("href");
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    } else if (node.tagName === "IMG") {
      // Remote images could leak chat content via the URL (prompt injection), so only inline images render.
      const src = node.getAttribute("src") || "";
      if (!src.startsWith("data:image/")) { node.removeAttribute("src"); node.setAttribute("alt", "[remote image blocked]"); }
    }
  });
  if (window.hljs) hljs.configure({ ignoreUnescapedHTML: true });
  mdReady = true;
}
function md(text) {
  initMarkdown();
  if (!mdReady) { const d = el("div"); d.textContent = text || ""; return d.innerHTML; }
  return DOMPurify.sanitize(marked.parse(text || ""), PURIFY_CFG);
}
function enhanceCode(root, highlight) {
  root.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!pre.querySelector(".copy")) {
      const b = el("button", { type: "button", class: "copy", text: "Copy" });
      b.onclick = async () => { await copyText(code ? code.textContent : pre.textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); };
      pre.append(b);
    }
    if (highlight && code && window.hljs && code.textContent.length < 60000 && !code.dataset.hl) {
      try { hljs.highlightElement(code); } catch {}
      code.dataset.hl = "1";
    }
  });
}

// ---------------------------------------------------------------- models
let models = ls.get("modelsCache", null);
if (!models || !Array.isArray(models.list)) models = { at: 0, list: [] };
const caps = (id) => models.list.find((m) => m.id === id) || null;
const canSee = (id) => { const c = caps(id); return c ? c.in.includes("image") : true; };
const makesImages = (id) => { const c = caps(id); return !!c && c.out.includes("image"); };
function badgesFor(m) {
  const b = [];
  if (m.in.includes("image")) b.push("👁");
  if (m.out.includes("image")) b.push("🎨");
  if (m.reason) b.push("🧠");
  return b.join("");
}
async function loadModels(force = false) {
  if (!base()) return;
  if (!force && models.list.length && Date.now() - models.at < MODELS_TTL) return;
  try {
    const r = await fetch(base() + "/models"); // public endpoint, no key sent
    if (!r.ok) return;
    const j = await r.json();
    const list = (Array.isArray(j.data) ? j.data : [])
      .filter((m) => m && typeof m.id === "string" && !m.id.endsWith(":batch"))
      .map((m) => ({
        id: m.id, name: typeof m.name === "string" ? m.name : m.id,
        in: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : ["text"],
        out: Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities : ["text"],
        reason: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("reasoning"),
        ctx: m.context_length || 0,
        free: /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0),
      }))
      // chat-capable only: must output text or images, nothing we can't show (embeddings, audio)
      .filter((m) => (m.out.includes("text") || m.out.includes("image")) && !m.out.includes("embeddings") && !m.out.includes("audio"))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (list.length) { models = { at: Date.now(), list }; ls.set("modelsCache", models); updateModelUI(); }
  } catch { /* offline: keep cache */ }
}
function updateModelUI() {
  const c = caps(settings.model);
  $("#modelName").textContent = c ? c.name.replace(/^[^:]+:\s*/, "") : shortModel(settings.model);
  $("#modelBadges").textContent = c ? badgesFor(c) : "";
  $("#imgOpts").classList.toggle("hidden", !makesImages(settings.model));
  updateHint();
}
let modelFilter = "all";
function renderModelList() {
  const q = $("#modelSearch").value.trim().toLowerCase();
  const box = $("#modelList"); box.textContent = "";
  let list = models.list.length ? models.list : [{ id: settings.model, name: settings.model, in: [], out: [], reason: false }];
  list = list.filter((m) => {
    if (modelFilter === "vision" && !m.in.includes("image")) return false;
    if (modelFilter === "image" && !m.out.includes("image")) return false;
    if (modelFilter === "reason" && !m.reason) return false;
    if (modelFilter === "free" && !m.free) return false;
    return !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
  });
  const frag = document.createDocumentFragment();
  for (const m of list.slice(0, 400)) {
    frag.append(el("button", {
      type: "button", class: "mrow" + (m.id === settings.model ? " on" : ""),
      onclick: () => { settings.model = m.id; saveSettings(); updateModelUI(); $("#modelDlg").close(); },
    }, el("span", { class: "n", text: `${m.name} ${badgesFor(m)}` }), el("span", { class: "i", text: m.id })));
  }
  if (!list.length) frag.append(el("p", { class: "muted", text: "No models match." }));
  box.append(frag);
}

// ---------------------------------------------------------------- sidebar
function openSidebar(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").classList.toggle("hidden", !open);
}
function renderList() {
  const list = $("#chatList"); list.textContent = "";
  const q = $("#chatSearch").value.trim().toLowerCase();
  const sorted = [...chats].sort((a, b) => b.updated - a.updated)
    .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
  const day = 864e5, now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let lastGroup = "";
  for (const c of sorted) {
    const g = c.updated >= today ? "Today" : c.updated >= today - day ? "Yesterday" : c.updated >= today - 7 * day ? "Previous 7 days" : "Older";
    if (g !== lastGroup) { list.append(el("div", { class: "group", text: g })); lastGroup = g; }
    const busy = run && run.chatId === c.id;
    list.append(el("div", { class: "chatItem" + (c.id === currentId ? " active" : "") },
      busy ? el("span", { class: "dot", title: "Generating" }) : null,
      el("button", { type: "button", class: "open", text: c.title || "New chat", onclick: () => { switchChat(c.id); openSidebar(false); } }),
      el("button", { type: "button", class: "act", title: "Rename", "aria-label": "Rename chat", text: "✎", onclick: () => renameChat(c) }),
      el("button", { type: "button", class: "act", title: "Delete", "aria-label": "Delete chat", text: "🗑", onclick: () => deleteChat(c) }),
    ));
  }
  if (!sorted.length) list.append(el("p", { class: "muted group", text: q ? "No matches" : "No chats yet" }));
}
function switchChat(id) { currentId = id; ls.set("currentId", currentId); renderAll(); }
function renameChat(c) {
  const t = prompt("Rename chat", c.title);
  if (t == null) return;
  c.title = t.trim().slice(0, 200) || c.title; persist(c); renderList();
}
async function deleteChat(c) {
  if (!confirm(`Delete “${c.title || "this chat"}”?`)) return;
  if (run && run.chatId === c.id) stopRun("user");
  chats = chats.filter((x) => x.id !== c.id);
  if (currentId === c.id) currentId = null;
  try { await db.del(c.id); } catch {}
  ls.set("currentId", currentId); renderAll();
}

// ---------------------------------------------------------------- messages
const msgEls = new Map();
function renderMessages() {
  const box = $("#messages"); box.textContent = ""; msgEls.clear();
  const c = current();
  if (!c || !c.messages.length) {
    box.append(el("div", { id: "empty" },
      el("h1", { text: "Hack Club AI Chat" }),
      el("p", { text: ready() ? "Ask anything, or attach an image or PDF." : "Add your API key and Worker URL to get started. Your key and chats stay in this browser." }),
      ready() ? null : el("button", { type: "button", class: "primary", text: "Open settings", onclick: openSettings })));
    return;
  }
  c.messages.forEach((m) => box.append(msgNode(c, m)));
  box.scrollTop = box.scrollHeight;
}
function isLast(c, m) { return c.messages[c.messages.length - 1] === m; }
function lastUser(c) { for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === "user") return c.messages[i]; return null; }

function msgNode(c, m) {
  const wrap = el("div", { class: "msg " + m.role, "data-id": m.id });
  fillMsg(wrap, c, m);
  msgEls.set(m.id, wrap);
  return wrap;
}
function fillMsg(wrap, c, m) {
  wrap.textContent = "";
  const busyHere = run && run.msgId === m.id;
  if (m.role === "user") {
    if (m.attachments?.length) {
      wrap.append(el("div", { class: "atts" }, m.attachments.map((a) => a.kind === "image"
        ? el("img", { src: a.dataUrl, alt: a.name || "image", onclick: () => openViewer(a.dataUrl) })
        : el("span", { class: "pdfchip", text: "📄 " + (a.name || "document.pdf") }))));
    }
    if (m.content) wrap.append(el("div", { class: "bubble", text: m.content }));
    const meta = el("div", { class: "meta" },
      el("button", { type: "button", text: "Copy", onclick: () => copyText(m.content).then(() => toast("Copied")) }));
    if (!run && m === lastUser(c)) meta.append(el("button", { type: "button", text: "Edit", onclick: () => editUser(c, m) }));
    wrap.append(meta);
    return;
  }
  const bubble = el("div", { class: "bubble" });
  if (m.reasoning) {
    const d = el("details", { class: "think" }, el("summary", { text: busyHere && !m.content ? "Thinking…" : "Thoughts" }));
    if (busyHere && !m.content) d.open = true;
    const inner = el("div"); inner.innerHTML = md(m.reasoning); d.append(inner);
    inner.querySelectorAll("img:not([src])").forEach((i) => i.remove());
    bubble.append(d);
  }
  const body = el("div"); body.innerHTML = md(m.content); bubble.append(body);
  bubble.querySelectorAll("img:not([src])").forEach((i) => i.replaceWith(el("span", { class: "muted", text: "[remote image blocked]" })));
  if (m.images?.length) bubble.append(el("div", { class: "gen" }, m.images.map((u) => el("img", { src: u, alt: "Generated image", onclick: () => openViewer(u) }))));
  if (busyHere) body.classList.add("cursor");
  enhanceCode(bubble, !busyHere);
  wrap.append(bubble);

  // status banner: a partial reply must never look complete
  if (!busyHere && m.status && m.status !== "streaming") {
    const hasText = !!m.content;
    const canContinue = hasText && !makesImages(m.model || settings.model);
    const text = {
      interrupted: hasText ? "Interrupted — this reply is incomplete." : "Interrupted before the reply started.",
      stopped: "Stopped — this reply is incomplete.",
      length: "Hit the length limit — the reply is cut off.",
      error: "Error" + (m.error ? ": " + m.error : ""),
    }[m.status] || "Incomplete";
    wrap.append(el("div", { class: "banner " + (m.status === "error" ? "err" : "warn") },
      el("span", { class: "txt", text: text }),
      canContinue && !run ? el("button", { type: "button", text: "Continue", onclick: () => continueMsg(c, m) }) : null,
      !run ? el("button", { type: "button", text: "Retry", onclick: () => retryMsg(c, m) }) : null));
  }
  if (!busyHere) {
    const meta = el("div", { class: "meta" },
      m.model ? el("span", { class: "model", text: shortModel(m.model) }) : null,
      m.content ? el("button", { type: "button", text: "Copy", onclick: () => copyText(m.content).then(() => toast("Copied")) }) : null,
      !run && !m.status && isLast(c, m) ? el("button", { type: "button", text: "Regenerate", onclick: () => retryMsg(c, m) }) : null);
    wrap.append(meta);
  }
}
function refreshMsg(c, m) {
  const w = msgEls.get(m.id);
  if (w && c.id === currentId) fillMsg(w, c, m);
}
function renderAll() { renderList(); renderMessages(); updateBusyUI(); }
function nearBottom() { const b = $("#messages"); return b.scrollHeight - b.scrollTop - b.clientHeight < 140; }

// ---------------------------------------------------------------- attachments
let pending = [];
function renderPending() {
  const box = $("#attachments"); box.textContent = "";
  box.classList.toggle("hidden", !pending.length);
  pending.forEach((a, i) => box.append(el("div", { class: "att" },
    a.kind === "image" ? el("img", { src: a.dataUrl, alt: a.name }) : el("span", { class: "pdfchip", text: "📄 " + a.name }),
    el("button", { type: "button", class: "x", "aria-label": "Remove", text: "✕", onclick: () => { pending.splice(i, 1); renderPending(); } }))));
  updateSendBtn(); updateHint();
}
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Couldn't read that image")); i.src = src; });
}
async function compressImage(src) {
  const img = await loadImg(src);
  let w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error("Empty image");
  let scale = Math.min(1, IMG_MAX_EDGE / Math.max(w, h));
  for (let attempt = 0; attempt < 4; attempt++) {
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(img, 0, 0, cw, ch);
    for (const q of [0.85, 0.75, 0.62]) {
      const out = cv.toDataURL("image/jpeg", q);
      if (out.length <= IMG_TARGET_BYTES) return out;
    }
    scale *= 0.7;
  }
  throw new Error("Image is too large even after compressing");
}
const readDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
async function addFiles(files) {
  for (const f of files) {
    if (pending.length >= MAX_ATTACHMENTS) { toast(`Up to ${MAX_ATTACHMENTS} attachments per message`); break; }
    try {
      if (f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)) {
        const url = URL.createObjectURL(f);
        try { pending.push({ kind: "image", name: f.name || "image.jpg", dataUrl: await compressImage(url) }); }
        finally { URL.revokeObjectURL(url); }
      } else if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        if (f.size > PDF_MAX_BYTES) { toast("PDFs up to 5 MB, please"); continue; }
        const d = await readDataUrl(f);
        const fixed = String(d).replace(/^data:[^;]*;base64,/, "data:application/pdf;base64,");
        if (!DATA_PDF_RE.test(fixed)) throw new Error("Couldn't read that PDF");
        pending.push({ kind: "pdf", name: f.name || "document.pdf", dataUrl: fixed });
      } else toast("Only images and PDFs can be attached");
    } catch (e) { toast(e.message || "Couldn't add that file"); }
  }
  renderPending();
}
function updateHint() {
  const h = $("#hint");
  if (pending.some((a) => a.kind === "image") && !canSee(settings.model)) h.textContent = "This model can't see images — pick one marked 👁.";
  else if (makesImages(settings.model)) h.textContent = "🎨 This model makes images. Attach one to edit it.";
  else h.textContent = "";
}

// ---------------------------------------------------------------- building the request
function partsFor(m, vision) {
  if (!m.attachments?.length) return m.content;
  const parts = [];
  if (m.content) parts.push({ type: "text", text: m.content });
  for (const a of m.attachments) {
    if (a.omit) continue;
    if (a.kind === "image") parts.push(vision ? { type: "image_url", image_url: { url: a.dataUrl } } : { type: "text", text: "[An image was attached, but this model can't see images.]" });
    else if (a.kind === "pdf") parts.push({ type: "file", file: { filename: a.name || "document.pdf", file_data: a.dataUrl } });
  }
  if (!parts.length) parts.push({ type: "text", text: "(attachment)" });
  return parts;
}
function buildMessages(c, uptoIdx, includeTarget, model) {
  const vision = canSee(model);
  const out = [];
  if (settings.systemPrompt.trim()) out.push({ role: "system", content: settings.systemPrompt });
  const msgs = c.messages.slice(0, includeTarget ? uptoIdx + 1 : uptoIdx);
  // shallow copies so we can drop old attachments if the request is too big
  const work = msgs.map((m) => ({ ...m, attachments: m.attachments?.map((a) => ({ ...a })) }));
  const build = () => work.flatMap((m) => {
    if (m.role === "user") return [{ role: "user", content: partsFor(m, vision) }];
    const text = m.content || (m.images?.length ? "[I generated an image.]" : "");
    if (!text) return []; // failed/empty replies are not context
    const a = { role: "assistant", content: text };
    if (m.annotations) a.annotations = m.annotations;
    return [a];
  });
  let body = [...out, ...build()];
  let size = JSON.stringify(body).length;
  for (const m of work) { // drop attachments oldest-first until it fits
    if (size <= MAX_REQUEST_BYTES) break;
    if (!m.attachments) continue;
    for (const a of m.attachments) a.omit = true;
    m.content = (m.content ? m.content + "\n" : "") + "[earlier attachment omitted to keep the request small]";
    body = [...out, ...build()]; size = JSON.stringify(body).length;
  }
  if (size > MAX_REQUEST_BYTES) throw new Error("This message is too large to send. Remove an attachment or start a new chat.");
  return body;
}

// ---------------------------------------------------------------- generation
let run = null; // { chatId, msgId, controller, stopReason, stopMsg, lastActivity, hiddenAt, returnedAt, wake }
function updateBusyUI() {
  const busy = !!run;
  $("#send").classList.toggle("hidden", busy);
  $("#stop").classList.toggle("hidden", !busy);
  updateSendBtn();
}
function updateSendBtn() { $("#send").disabled = !!run || (!$("#input").value.trim() && !pending.length); }

function stopRun(reason, msg) {
  if (!run) return;
  run.stopReason = reason; run.stopMsg = msg;
  try { run.controller.abort(); } catch {}
}

async function acquireWake() {
  if (!run || !settings.wakeLock || !("wakeLock" in navigator) || document.hidden) return;
  try { run.wake = await navigator.wakeLock.request("screen"); } catch {}
}
function releaseWake() { try { run?.wake?.release(); } catch {} }

async function generate(c, m, { cont = false } = {}) {
  if (run) { toast("Wait for the current reply, or stop it"); return; }
  const idx = c.messages.indexOf(m);
  const model = m.model || settings.model;
  let messages;
  try {
    messages = buildMessages(c, idx, cont, model);
    if (cont) messages.push({ role: "user", content: CONTINUE_PROMPT });
  } catch (e) {
    m.status = "error"; m.error = e.message; persist(c, true); refreshMsg(c, m); return;
  }
  const baseContent = cont ? m.content : "";
  const baseReasoning = cont ? (m.reasoning || "") : "";
  if (!cont) { m.content = ""; delete m.reasoning; delete m.images; delete m.annotations; }
  m.status = "streaming"; delete m.error; m.model = model;

  run = { chatId: c.id, msgId: m.id, controller: new AbortController(), stopReason: null, lastActivity: Date.now(), hiddenAt: 0, returnedAt: 0 };
  acquireWake();
  updateBusyUI(); renderList();
  if (c.id === currentId) { refreshMsg(c, m); refreshOthers(c); $("#messages").scrollTop = $("#messages").scrollHeight; }
  persist(c, true);

  const body = { model, messages, stream: true };
  const t = parseFloat(settings.temperature); if (Number.isFinite(t)) body.temperature = Math.min(2, Math.max(0, t));
  const mt = parseInt(settings.maxTokens, 10); if (mt > 0) body.max_tokens = mt;
  if (makesImages(model)) {
    body.modalities = ["image", "text"];
    const ar = $("#aspect").value; if (ar) body.image_config = { aspect_ratio: ar };
  }

  let content = "", reasoning = "", finish = null, gotDone = false, received = false;
  const images = [];
  let paintQueued = false;
  const paint = () => {
    if (paintQueued) return; paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (c.id !== currentId) return;
      const stick = nearBottom(); refreshMsg(c, m);
      if (stick) $("#messages").scrollTop = $("#messages").scrollHeight;
    });
  };
  const sync = () => {
    m.content = baseContent + content;
    if (reasoning) m.reasoning = baseReasoning + reasoning;
    if (images.length) m.images = [...(cont ? m.images || [] : []), ...images];
  };

  try {
    const r = await fetch(base() + "/chat/completions", {
      method: "POST", signal: run.controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.apiKey },
      body: JSON.stringify(body),
    });
    run.lastActivity = Date.now();
    if (!r.ok) throw new Error(await httpError(r));
    if (!r.body) throw new Error("Empty response");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const handleLine = (line) => {
      const l = line.replace(/\r$/, "");
      if (!l.startsWith("data:")) return; // ignore SSE comments like ": OPENROUTER PROCESSING"
      const data = l.slice(5).trim();
      if (!data) return;
      if (data === "[DONE]") { gotDone = true; return; }
      let j; try { j = JSON.parse(data); } catch { return; }
      if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message || "Stream error");
      const ch = j.choices?.[0]; if (!ch) return;
      const d = ch.delta || ch.message || {};
      if (typeof d.content === "string") content += d.content;
      const rs = typeof d.reasoning === "string" ? d.reasoning : typeof d.reasoning_content === "string" ? d.reasoning_content : "";
      if (rs) reasoning += rs;
      if (Array.isArray(d.images)) for (const im of d.images) { const u = im?.image_url?.url; if (typeof u === "string" && DATA_IMG_RE.test(u)) images.push(u); }
      if (Array.isArray(d.annotations)) m.annotations = d.annotations;
      if (ch.finish_reason) finish = ch.finish_reason;
      received = true;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      run.lastActivity = Date.now();
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) handleLine(line);
      sync(); paint(); persist(c);
    }
    buf += dec.decode();
    if (buf) handleLine(buf);
    sync();
    if (!gotDone && !finish) { m.status = "interrupted"; }
    else if (finish === "length") m.status = "length";
    else if (finish === "error") { m.status = "error"; m.error = "The model stopped with an error."; }
    else if (!m.content && !m.images?.length && !received) { m.status = "error"; m.error = "Empty reply."; }
    else delete m.status;
  } catch (e) {
    sync();
    if (e.name === "AbortError") {
      m.status = run.stopReason === "user" ? "stopped" : "interrupted";
      if (run.stopMsg) m.error = run.stopMsg;
    } else if (/load failed|failed to fetch|network/i.test(e.message || "") && (received || run.hiddenAt)) {
      m.status = "interrupted"; // connection dropped (typically iOS backgrounding)
    } else {
      m.status = "error";
      m.error = /load failed|failed to fetch|networkerror/i.test(e.message || "") ? "Couldn't reach the relay. Check your connection and the Worker URL in Settings." : (e.message || "Something went wrong");
    }
  } finally {
    releaseWake();
    run = null;
    ls.del("inflight");
    c.updated = Date.now();
    await flushPersist(); persist(c, true);
    updateBusyUI(); renderList();
    if (c.id === currentId) { refreshMsg(c, m); refreshOthers(c); }
  }
}
function refreshOthers(c) { // re-draw action buttons (Edit/Retry visibility depends on run state)
  for (const m of c.messages) refreshMsg(c, m);
}
async function httpError(r) {
  let detail = "";
  try { const txt = await r.text(); try { const j = JSON.parse(txt); detail = typeof j.error === "string" ? j.error : j.error?.message || j.message || ""; } catch { detail = txt.slice(0, 200); } } catch {}
  const hint = { 401: "Your API key was rejected. Check it in Settings.", 402: "You've hit today's spending limit ($3/day, resets 00:00 UTC).", 403: "Request blocked (origin not allowed, or account issue).", 404: "Relay endpoint not found — check the Worker URL ends with /proxy/v1, and redeploy the Worker.", 413: "Request too large. Remove an attachment or start a new chat.", 429: `Rate limited. Try again in ${r.headers.get("Retry-After") || "a few"} seconds.` }[r.status];
  return [`HTTP ${r.status}`, hint, detail && detail !== hint ? detail : ""].filter(Boolean).join(" — ");
}

// watchdog: catches streams that silently died (iOS background, network change)
setInterval(() => {
  if (!run || document.hidden) return;
  const now = Date.now();
  if (run.returnedAt && now - run.returnedAt > RETURN_GRACE_MS && run.lastActivity < run.returnedAt) {
    stopRun("interrupted", "The connection was lost while the app was in the background.");
  } else if (now - run.lastActivity > STALL_MS) {
    stopRun("interrupted", "No response for 3 minutes.");
  }
}, 2000);
document.addEventListener("visibilitychange", () => {
  if (!run) return;
  if (document.hidden) { run.hiddenAt = Date.now(); flushPersist(); }
  else { if (run.hiddenAt && Date.now() - run.hiddenAt > 2000) run.returnedAt = Date.now(); acquireWake(); }
});
window.addEventListener("pagehide", () => { if (run) { writeMirror("interrupted"); flushPersist(); } });
window.addEventListener("pageshow", (e) => { if (e.persisted && run) run.returnedAt = Date.now(); });
window.addEventListener("offline", () => { if (run) stopRun("interrupted", "You went offline."); });

// ---------------------------------------------------------------- actions
async function onSend() {
  const text = $("#input").value.trim();
  if ((!text && !pending.length) || run) return;
  if (!ready()) { openSettings(); return; }
  if (pending.some((a) => a.kind === "image") && !canSee(settings.model)) { toast("This model can't see images — pick one marked 👁"); return; }
  let c = current();
  if (!c) {
    c = { id: uid(), title: (text || pending[0]?.name || "New chat").replace(/\s+/g, " ").slice(0, 60), messages: [], updated: Date.now() };
    chats.push(c); currentId = c.id;
  }
  const user = { id: uid(), role: "user", content: text };
  if (pending.length) user.attachments = pending;
  const asst = { id: uid(), role: "assistant", content: "", model: settings.model, status: "streaming" };
  c.messages.push(user, asst); c.updated = Date.now();
  pending = []; renderPending();
  $("#input").value = ""; autoGrow();
  persist(c, true);
  renderAll();
  generate(c, asst);
}
function confirmTruncate(c, m) {
  const after = c.messages.length - 1 - c.messages.indexOf(m);
  return after <= 0 || confirm("This removes the messages after it. Continue?");
}
function retryMsg(c, m) {
  if (run) return;
  if (!confirmTruncate(c, m)) return;
  c.messages.splice(c.messages.indexOf(m) + 1);
  m.model = settings.model;
  generate(c, m);
}
function continueMsg(c, m) {
  if (run) return;
  if (!confirmTruncate(c, m)) return;
  c.messages.splice(c.messages.indexOf(m) + 1);
  generate(c, m, { cont: true });
}
function editUser(c, m) {
  if (run) return;
  if ($("#input").value.trim() && !confirm("Replace what you're typing?")) return;
  c.messages.splice(c.messages.indexOf(m));
  $("#input").value = m.content; autoGrow();
  pending = m.attachments ? [...m.attachments] : []; renderPending();
  persist(c, true); renderMessages(); $("#input").focus();
}

// ---------------------------------------------------------------- image viewer
let viewerSrc = "";
function openViewer(src) { viewerSrc = src; $("#viewerImg").src = src; $("#viewer").showModal(); }
$("#viewerDownload").onclick = () => {
  const ext = (viewerSrc.match(/^data:image\/(\w+)/) || [, "png"])[1].replace("jpeg", "jpg");
  const a = el("a", { href: viewerSrc, download: `image-${Date.now()}.${ext}` }); document.body.append(a); a.click(); a.remove();
};
$("#viewerEdit").onclick = async () => {
  if (pending.length >= MAX_ATTACHMENTS) return toast("Too many attachments");
  try { pending.push({ kind: "image", name: "image.jpg", dataUrl: await compressImage(viewerSrc) }); renderPending(); $("#viewer").close(); $("#input").focus(); toast("Image attached — describe the change"); }
  catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- settings dialog
function openSettings() {
  $("#apiKey").value = settings.apiKey;
  $("#rememberKey").checked = !!settings.rememberKey;
  $("#baseUrl").value = settings.baseUrl;
  $("#systemPrompt").value = settings.systemPrompt;
  $("#temperature").value = settings.temperature;
  $("#maxTokens").value = settings.maxTokens;
  $("#theme").value = settings.theme;
  $("#wakeLock").checked = !!settings.wakeLock;
  $("#statsOut").textContent = "";
  storageInfo();
  if (!$("#settings").open) $("#settings").showModal();
}
function normaliseBase(v) {
  v = v.trim(); if (!v) return "";
  let u; try { u = new URL(v); } catch { throw new Error("API base URL isn't a valid URL"); }
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("API base URL must start with https://");
  if (!local && !u.hostname.endsWith(".workers.dev") && u.hostname !== "ai.hackclub.com") throw new Error("Use your *.workers.dev Worker URL (this page's security policy only allows those).");
  if (u.username || u.password || u.search || u.hash) throw new Error("API base URL shouldn't contain a login, ? or #");
  let p = u.pathname.replace(/\/+$/, "");
  if (!p) p = "/proxy/v1"; // pasted the bare worker URL
  return u.origin + p;
}
$("#saveSettings").onclick = () => {
  let b;
  try { b = normaliseBase($("#baseUrl").value); } catch (e) { toast(e.message, 4000); return; }
  settings.apiKey = $("#apiKey").value.trim().replace(/^Bearer\s+/i, "");
  settings.rememberKey = $("#rememberKey").checked;
  const oldBase = settings.baseUrl;
  settings.baseUrl = b;
  settings.systemPrompt = $("#systemPrompt").value;
  settings.temperature = $("#temperature").value.trim();
  settings.maxTokens = $("#maxTokens").value.trim();
  settings.theme = $("#theme").value;
  settings.wakeLock = $("#wakeLock").checked;
  saveSettings(); applyTheme();
  $("#settings").close();
  loadModels(oldBase !== b); renderMessages(); toast("Saved");
};
$("#showStats").onclick = async () => {
  const out = $("#statsOut");
  if (!ready()) { out.textContent = "Add your key and Worker URL first."; return; }
  out.textContent = "Loading…";
  try {
    const r = await fetch(base() + "/stats", { headers: { Authorization: "Bearer " + settings.apiKey } });
    if (!r.ok) throw new Error(await httpError(r));
    const j = await r.json(); const n = (x) => Number(x || 0).toLocaleString();
    out.textContent = `Requests: ${n(j.totalRequests)} · Tokens: ${n(j.totalTokens)} (prompt ${n(j.totalPromptTokens)}, completion ${n(j.totalCompletionTokens)})`;
  } catch (e) { out.textContent = e.message || "Couldn't load usage"; }
};
async function storageInfo() {
  const s = $("#storageInfo");
  try {
    const e = await navigator.storage?.estimate?.();
    s.textContent = `${chats.length} chats` + (e?.usage != null ? ` · ${(e.usage / 1048576).toFixed(1)} MB used` : "") + (db.h ? "" : " · (fallback storage, ~5 MB limit)");
  } catch { s.textContent = `${chats.length} chats`; }
}
$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "hc-chat", version: 1, exportedAt: new Date().toISOString(), chats }, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `chats-${new Date().toISOString().slice(0, 10)}.json` }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (f.size > 80 * 1024 * 1024) return toast("That file is too big");
  try {
    const j = JSON.parse(await f.text());
    const arr = Array.isArray(j) ? j : j?.chats;
    if (!Array.isArray(arr)) throw new Error();
    let n = 0;
    for (const raw of arr) {
      const c = cleanChat(raw); if (!c) continue;
      if (chats.some((x) => x.id === c.id)) c.id = uid();
      chats.push(c); dirty.add(c.id); n++;
    }
    await flushPersist(); renderAll(); storageInfo(); toast(`Imported ${n} chat${n === 1 ? "" : "s"}`);
  } catch { toast("That doesn't look like a chat export"); }
};
$("#clearAll").onclick = async () => {
  if (!confirm("Delete every chat? This can't be undone.")) return;
  if (run) stopRun("user");
  chats = []; currentId = null;
  try { await db.clear(); } catch {}
  ls.set("currentId", null); renderAll(); storageInfo(); $("#settings").close();
};
function applyTheme() {
  const t = settings.theme;
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
}

// ---------------------------------------------------------------- wiring
const input = $("#input");
function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; updateSendBtn(); }
input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer:fine)").matches) { e.preventDefault(); onSend(); }
});
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$("#composer").addEventListener("submit", (e) => { e.preventDefault(); onSend(); });
$("#stop").onclick = () => stopRun("user");
$("#attachBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; addFiles(f); };
const main = $("main");
main.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); $("#composer").classList.add("drag"); } });
main.addEventListener("dragleave", (e) => { if (e.target === main || !main.contains(e.relatedTarget)) $("#composer").classList.remove("drag"); });
main.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); $("#composer").classList.remove("drag"); addFiles([...e.dataTransfer.files]); } });

const newChat = () => { currentId = null; ls.set("currentId", null); pending = []; renderPending(); renderAll(); openSidebar(false); input.focus(); };
$("#newChat").onclick = newChat;
$("#newChatTop").onclick = newChat;
$("#toggleSidebar").onclick = () => openSidebar(!$("#sidebar").classList.contains("open"));
$("#scrim").onclick = () => openSidebar(false);
$("#chatSearch").addEventListener("input", renderList);
$("#openSettings").onclick = () => { openSidebar(false); openSettings(); };
$("#modelBtn").onclick = () => { $("#modelSearch").value = ""; renderModelList(); $("#modelDlg").showModal(); loadModels(); };
$("#modelSearch").addEventListener("input", renderModelList);
$("#modelFilters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  modelFilter = b.dataset.f;
  document.querySelectorAll("#modelFilters .chip").forEach((x) => x.classList.toggle("on", x === b));
  renderModelList();
});
document.querySelectorAll("dialog").forEach((d) => {
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); }); // tap backdrop / ✕ to close
});

// ---------------------------------------------------------------- boot
(async function boot() {
  applyTheme();
  updateModelUI();
  await loadChats();
  renderAll();
  loadModels();
  if (!ready()) openSettings();
})();
