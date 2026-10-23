// Hack Club AI Chat — static, no build step. Keys and chats live in localStorage.
const $ = (s) => document.querySelector(s);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
let settings = store.get("settings", { apiKey: "", baseUrl: "", systemPrompt: "", model: DEFAULT_MODEL });
let chats = store.get("chats", []); // [{id,title,messages:[{role,content}],updated}]
let currentId = store.get("currentId", null);
let controller = null;

marked.setOptions({ breaks: true, gfm: true });
const render = (md) => DOMPurify.sanitize(marked.parse(md || ""));

function base() { return (settings.baseUrl || "").replace(/\/+$/, ""); }
function saveChats() { store.set("chats", chats); store.set("currentId", currentId); }
function current() { return chats.find((c) => c.id === currentId); }
function setStatus(t) { $("#status").textContent = t || ""; }

// ---------- models ----------
async function loadModels() {
  const sel = $("#model");
  const fill = (ids) => {
    sel.innerHTML = "";
    ids.forEach((id) => { const o = document.createElement("option"); o.value = o.textContent = id; sel.appendChild(o); });
    if (!ids.includes(settings.model)) { const o = document.createElement("option"); o.value = o.textContent = settings.model; sel.prepend(o); }
    sel.value = settings.model;
  };
  fill([settings.model]);
  if (!base()) return;
  try {
    const r = await fetch(base() + "/models", { headers: authHeaders() });
    const j = await r.json();
    const ids = (j.data || [])
      .filter((m) => (m.architecture?.output_modalities || ["text"]).includes("text") && !m.id.endsWith(":batch"))
      .map((m) => m.id).sort();
    if (ids.length) fill(ids);
  } catch { /* keep default */ }
}
$("#model").onchange = (e) => { settings.model = e.target.value; store.set("settings", settings); };

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (settings.apiKey) h.Authorization = "Bearer " + settings.apiKey;
  return h;
}

// ---------- sidebar ----------
function renderList() {
  const list = $("#chatList");
  list.innerHTML = "";
  [...chats].sort((a, b) => b.updated - a.updated).forEach((c) => {
    const d = document.createElement("div");
    d.className = "chatItem" + (c.id === currentId ? " active" : "");
    d.innerHTML = `<span></span><button class="del" title="Delete">✕</button>`;
    d.querySelector("span").textContent = c.title || "New chat";
    d.onclick = () => { currentId = c.id; saveChats(); renderAll(); $("#sidebar").classList.remove("open"); };
    d.querySelector(".del").onclick = (e) => {
      e.stopPropagation();
      chats = chats.filter((x) => x.id !== c.id);
      if (currentId === c.id) currentId = null;
      saveChats(); renderAll();
    };
    list.appendChild(d);
  });
}

// ---------- messages ----------
function addCopyButtons(el) {
  el.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy")) return;
    const b = document.createElement("button");
    b.className = "copy"; b.type = "button"; b.textContent = "Copy";
    b.onclick = () => { navigator.clipboard.writeText(pre.querySelector("code")?.innerText || pre.innerText); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); };
    pre.appendChild(b);
    const code = pre.querySelector("code"); if (code && window.hljs) hljs.highlightElement(code);
  });
}

function bubble(role, content, reasoning) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  const b = document.createElement("div");
  b.className = "bubble";
  fillBubble(b, role, content, reasoning);
  wrap.appendChild(b);
  $("#messages").appendChild(wrap);
  return b;
}

function fillBubble(b, role, content, reasoning) {
  if (role === "user") { b.textContent = content; return; }
  let html = "";
  if (reasoning) html += `<details class="think"><summary>Thinking</summary>${render(reasoning)}</details>`;
  html += render(content);
  b.innerHTML = html;
  addCopyButtons(b);
}

function renderMessages() {
  const box = $("#messages");
  box.innerHTML = "";
  const c = current();
  if (!c || !c.messages.length) {
    box.innerHTML = `<div id="empty"><h1>Hack Club AI Chat</h1><p>${base() ? "Pick a model and say hi." : "Open ⚙ Settings to add your API key and relay URL."} Your key and chats stay in this browser.</p></div>`;
    return;
  }
  c.messages.forEach((m) => bubble(m.role, m.content, m.reasoning));
  box.scrollTop = box.scrollHeight;
}

function renderAll() { renderList(); renderMessages(); }

// ---------- sending ----------
function nearBottom() { const b = $("#messages"); return b.scrollHeight - b.scrollTop - b.clientHeight < 120; }

async function send(text) {
  if (!settings.apiKey || !base()) { openSettings(); return; }
  let c = current();
  if (!c) {
    c = { id: crypto.randomUUID(), title: text.slice(0, 40), messages: [], updated: Date.now() };
    chats.push(c); currentId = c.id;
  }
  if (!c.messages.length) $("#messages").innerHTML = "";
  c.messages.push({ role: "user", content: text });
  c.updated = Date.now(); saveChats(); renderList();
  bubble("user", text);

  const out = bubble("assistant", "");
  out.classList.add("cursor");
  $("#messages").scrollTop = $("#messages").scrollHeight;

  const payload = [];
  if (settings.systemPrompt) payload.push({ role: "system", content: settings.systemPrompt });
  c.messages.forEach((m) => payload.push({ role: m.role, content: m.content }));

  controller = new AbortController();
  toggleBusy(true);
  let content = "", reasoning = "";
  try {
    const r = await fetch(base() + "/chat/completions", {
      method: "POST", headers: authHeaders(), signal: controller.signal,
      body: JSON.stringify({ model: settings.model, messages: payload, stream: true }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); msg += ": " + (j.error?.message || j.error || JSON.stringify(j)); } catch {}
      throw new Error(msg);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", last = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta || {};
          if (d.content) content += d.content;
          if (d.reasoning) reasoning += d.reasoning;
          if (j.error) throw new Error(j.error.message || "Stream error");
        } catch (e) { if (e.message && !e.message.includes("JSON")) throw e; }
      }
      const now = performance.now();
      if (now - last > 50) {
        const stick = nearBottom();
        fillBubble(out, "assistant", content, reasoning);
        if (stick) $("#messages").scrollTop = $("#messages").scrollHeight;
        last = now;
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      out.parentElement.className = "msg error";
      content = content || ("⚠️ " + (e.message === "Failed to fetch" ? "Couldn't reach the API. Check the relay URL in Settings." : e.message));
    }
  } finally {
    out.classList.remove("cursor");
    fillBubble(out, "assistant", content, reasoning);
    if (content && !out.parentElement.classList.contains("error")) {
      c.messages.push({ role: "assistant", content, reasoning: reasoning || undefined });
    }
    c.updated = Date.now(); saveChats();
    toggleBusy(false); controller = null;
  }
}

function toggleBusy(b) {
  $("#send").classList.toggle("hidden", b);
  $("#stop").classList.toggle("hidden", !b);
  setStatus(b ? "Generating…" : "");
}

$("#stop").onclick = () => controller?.abort();

const input = $("#input");
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer:fine)").matches) { e.preventDefault(); $("#composer").requestSubmit(); }
});
$("#composer").onsubmit = (e) => {
  e.preventDefault();
  const t = input.value.trim();
  if (!t || controller) return;
  input.value = ""; input.style.height = "auto";
  send(t);
};

// ---------- settings ----------
function openSettings() {
  $("#apiKey").value = settings.apiKey;
  $("#baseUrl").value = settings.baseUrl;
  $("#systemPrompt").value = settings.systemPrompt;
  $("#settings").showModal();
}
$("#openSettings").onclick = openSettings;
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue !== "save") return;
  settings.apiKey = $("#apiKey").value.trim();
  settings.baseUrl = $("#baseUrl").value.trim();
  settings.systemPrompt = $("#systemPrompt").value;
  store.set("settings", settings);
  loadModels(); renderMessages();
});
$("#clearAll").onclick = () => {
  if (!confirm("Delete every chat?")) return;
  chats = []; currentId = null; saveChats(); renderAll(); $("#settings").close();
};

$("#newChat").onclick = () => { currentId = null; saveChats(); renderAll(); input.focus(); $("#sidebar").classList.remove("open"); };
$("#toggleSidebar").onclick = () => $("#sidebar").classList.toggle("open");

renderAll();
loadModels();
if (!settings.apiKey || !base()) openSettings();
