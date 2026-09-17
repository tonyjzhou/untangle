const $ = (id) => document.getElementById(id);
let currentId = null;
let generatedGoal = "";
let isEditing = false;
let streamingActive = false;

// Reference docs: uploaded file contents (in-memory) + server-local vault path.
let attachedDocs = [];
let vaultPath = "";
let vaultFiles = [];
const DOCS_PER_FILE_LIMIT = 20000;
const DOCS_TOTAL_LIMIT = 400000;

const LLM_PRESETS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyPlaceholder: "sk-... (blank = offline mode)",
    hint: "Key stays in your browser (localStorage). No key = offline template plan. Get a key at platform.openai.com.",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyPlaceholder: "AIza... from Google AI Studio (blank = offline mode)",
    hint: "Paste a Gemini API key from Google AI Studio (aistudio.google.com). Uses Gemini's OpenAI-compatible endpoint — no backend change needed.",
  },
  ollama: {
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
    keyPlaceholder: "ollama (any value works)",
    hint: "Local Ollama needs no real key — type anything (e.g. 'ollama'). Run `ollama serve` + `ollama pull llama3.1` first.",
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    model: "",
    keyPlaceholder: "sk-... (blank = offline mode)",
    hint: "Any OpenAI-compatible API (OpenRouter, vLLM, LM Studio, ...). Base URL + /chat/completions must accept {model, messages}.",
  },
};

function inferProvider(baseUrl, model) {
  const b = (baseUrl || "").toLowerCase();
  if (b.includes("generativelanguage.googleapis.com")) return "gemini";
  if (b.includes("localhost:11434") || b.includes("127.0.0.1:11434")) return "ollama";
  if (!b || b.includes("api.openai.com")) {
    // Empty = OpenAI defaults, unless the model is clearly a Gemini one.
    if ((model || "").toLowerCase().startsWith("gemini")) return "gemini";
    return "openai";
  }
  return "custom";
}

function applyProvider(name, opts) {
  opts = opts || {};
  const p = LLM_PRESETS[name] || LLM_PRESETS.custom;
  if (opts.fill !== false && name !== "custom") {
    $("baseUrl").value = p.baseUrl;
    $("model").value = p.model;
    try {
      localStorage.setItem("planner.baseUrl", p.baseUrl);
      localStorage.setItem("planner.model", p.model);
    } catch (_) {}
  }
  $("baseUrl").placeholder = p.baseUrl || "https://.../v1";
  $("model").placeholder = p.model || "model-id";
  $("apiKey").placeholder = p.keyPlaceholder;
  if ($("providerHint")) $("providerHint").textContent = p.hint;
  try { localStorage.setItem("planner.provider", name); } catch (_) {}
}

const store = {
  get provider() { return localStorage.getItem("planner.provider") || ""; },
  get baseUrl() { return localStorage.getItem("planner.baseUrl") || ""; },
  get model() { return localStorage.getItem("planner.model") || ""; },
  get apiKey() { return localStorage.getItem("planner.apiKey") || ""; },
};

// Unsaved draft backup so a refresh never wipes typed ideas.
function persistDraft() {
  try {
    localStorage.setItem("planner.draftIdea", $("idea").value || "");
    // Backup the plan text too — covers the window before first autosave.
    localStorage.setItem("planner.draftPlan", $("planMd").value || "");
    localStorage.setItem("planner.draftGoal", generatedGoal || "");
    if (currentId) localStorage.setItem("planner.currentId", currentId);
  } catch (_) { /* storage full/blocked — server save still works */ }
}

let autosaveTimerId = null;
async function savePlan(opts) {
  opts = opts || {};
  const plan_markdown = $("planMd").value || "";
  const raw_idea = $("idea").value || "";
  if (!plan_markdown.trim() && !raw_idea.trim()) return null;
  const payload = {
    title: generatedGoal || smartTruncate(raw_idea.split("\n")[0], 220) || "Untitled",
    raw_idea,
    plan_markdown,
  };
  let res;
  if (currentId) {
    res = await fetch(`/api/plans/${currentId}`, {method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)});
  } else {
    res = await fetch("/api/plans", {method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)});
  }
  if (!res.ok) throw new Error(`Save failed (${res.status})`);
  const saved = await res.json();
  currentId = saved.id;
  generatedGoal = saved.title;
  try { localStorage.setItem("planner.currentId", currentId); } catch (_) {}
  persistDraft();
  $("generatedTitle").textContent = saved.title;
  await refreshList();
  return saved;
}

function scheduleAutosave() {
  clearTimeout(autosaveTimerId);
  autosaveTimerId = setTimeout(async () => {
    if (streamingActive) return;
    if (!$("planMd").value.trim() && !$("idea").value.trim()) return;
    try { await savePlan({silent: true}); } catch (_) { /* keep local draft; next edit retries */ }
  }, 800);
}

$("idea").addEventListener("input", () => { persistDraft(); });
// Provider-aware LLM settings init. Existing users have no stored provider,
// so infer it from their saved baseUrl/model (Gemini URLs -> gemini, etc.).
$("baseUrl").value = store.baseUrl;
$("model").value = store.model;
$("apiKey").value = store.apiKey;
(function initProvider() {
  const sel = $("provider");
  if (!sel) return;
  let name = store.provider;
  if (!name || !LLM_PRESETS[name]) name = inferProvider(store.baseUrl, store.model);
  sel.value = name;
  applyProvider(name, {fill: false});
  // First run with no saved values: fill preset defaults so
  // "Gemini 3.8 flash" works with one click.
  if (!store.baseUrl && !store.model) applyProvider(name);
  sel.addEventListener("change", () => applyProvider(sel.value));
})();
for (const [id, key] of [["baseUrl","planner.baseUrl"],["model","planner.model"],["apiKey","planner.apiKey"]]) {
  $(id).addEventListener("input", (e) => {
    try { localStorage.setItem(key, e.target.value.trim()); } catch (_) {}
    // Manual URL/model edits that no longer match the selected preset
    // flip the dropdown to Custom so the UI never lies about the provider.
    const sel = $("provider");
    if (sel && (id === "baseUrl" || id === "model")) {
      const cur = inferProvider($("baseUrl").value.trim(), $("model").value.trim());
      if (sel.value !== "custom" && cur !== sel.value) {
        sel.value = "custom";
        applyProvider("custom", {fill: false});
      }
    }
  });
}

function showResult(visible) {
  $("resultSection").classList.toggle("hidden", !visible);
  $("main").classList.toggle("has-result", visible);
  if (visible) {
    $("ideaRecapText").textContent = $("idea").value;
  }
}

function smartTruncate(text, limit) {
  limit = limit || 220;
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  let cut = clean.lastIndexOf(" ", limit);
  if (cut < limit / 2) cut = limit;
  return clean.slice(0, cut).replace(/[,;:—\-–\s]+$/, "") + "…";
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s) {
  return escHtml(s)
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function parseEffortPriority(text) {
  const m = text.match(/`?\[([SML])\/([Pp][123])\]`?/);
  if (!m) return {clean: text.trim(), effort: null, priority: null};
  return {
    clean: text.replace(m[0], "").replace(/\s{2,}/g, " ").trim(),
    effort: m[1].toUpperCase(),
    priority: m[2].toUpperCase(),
  };
}

function pillHtml(effort, priority) {
  let out = "";
  if (effort) out += `<span class="pill effort-${effort.toLowerCase()}" title="Effort: ${effort}">${effort}</span>`;
  if (priority) out += `<span class="pill pri-${priority.toLowerCase()}" title="Priority: ${priority}">${priority}</span>`;
  return out;
}

window.toggleAllPhases = function(open) {
  document.querySelectorAll("#preview details.phase-card, #preview details.mini-card").forEach((d) => {
    // Keep "Do next" always visible — it's a div, not a details, so untouched.
    d.open = !!open;
  });
};

function renderPreview(md) {
  const raw = String(md || "");
  if (!raw.trim()) {
    $("preview").innerHTML = "";
    return;
  }
  const lines = raw.split("\n");
  let goal = "";
  const sections = [];
  let current = null;
  let checkIdx = 0;

  const pushSection = (kind, title) => {
    current = {kind, title: (title || "").trim(), items: []};
    sections.push(current);
  };

  for (let line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^##\s+Plan/i.test(t)) continue;
    let gm = t.match(/\*\*Goal:\*\*\s*(.*)/);
    if (gm) {
      goal = gm[1].replace(/\*\*/g, "").trim();
      continue;
    }
    let hm = t.match(/^###\s+(.*)/);
    if (hm) {
      const title = hm[1].trim();
      const low = title.toLowerCase();
      if (/^phase\b/.test(low) || /^phase\s*\d/i.test(title)) pushSection("phase", title);
      else if (low.includes("success")) pushSection("success", "Success criteria");
      else if (low.includes("risk")) pushSection("risks", "Risks");
      else if (low.includes("do next") || low.includes("today") || low.includes("next")) pushSection("next", "Do next");
      else pushSection("generic", title);
      continue;
    }
    let cm = t.match(/^- \[[ xX]\]\s*(.*)$/);
    if (cm) {
      const checked = /^- \[[xX]\]/.test(t);
      if (!current) pushSection("generic", "");
      const parsed = parseEffortPriority(cm[1]);
      current.items.push({type: "check", text: parsed.clean, effort: parsed.effort, priority: parsed.priority, checked, idx: checkIdx++});
      continue;
    }
    let bm = t.match(/^- (.*)$/);
    if (bm) {
      if (!current) pushSection("generic", "");
      current.items.push({type: "bullet", text: bm[1].trim()});
      continue;
    }
    // Fallback paragraph (e.g. streaming partial line)
    if (!current) pushSection("generic", "");
    current.items.push({type: "para", text: t});
  }

  const totalChecks = sections.flatMap((s) => s.items).filter((i) => i.type === "check").length;
  const doneChecks = sections.flatMap((s) => s.items).filter((i) => i.type === "check" && i.checked).length;
  const pct = totalChecks ? Math.round((doneChecks / totalChecks) * 100) : 0;
  const phaseSections = sections.filter((s) => s.kind === "phase");

  let html = "";
  html += `<div class="roadmap-head">
    <div class="roadmap-title">✨ Your roadmap</div>
    <div class="roadmap-sub">${phaseSections.length} phase${phaseSections.length === 1 ? "" : "s"} · ${doneChecks} of ${totalChecks} done</div>
    <div class="roadmap-bar"><i style="width:${pct}%"></i></div>
    <div class="roadmap-toggles">
      <button type="button" onclick="toggleAllPhases(true)">Expand all</button>
      <button type="button" onclick="toggleAllPhases(false)">Collapse</button>
    </div>
  </div>`;

  if (goal) {
    html += `<div class="goal-card"><span class="goal-emoji">🎯</span><span>${inlineMd(goal)}</span></div>`;
  }

  const phaseEmoji = ["🛠️", "⚙️", "🚀", "🔁", "🌱", "✨"];
  let phaseCount = 0;
  for (const s of sections) {
    if (s.kind === "phase") {
      phaseCount++;
      const numMatch = s.title.match(/phase\s*(\d+)/i);
      const num = numMatch ? numMatch[1] : String(phaseCount);
      const name = s.title.replace(/^phase\s*\d+\s*[:\-–.]?\s*/i, "").trim() || s.title;
      const checks = s.items.filter((i) => i.type === "check");
      const done = checks.filter((i) => i.checked).length;
      const ppct = checks.length ? Math.round((done / checks.length) * 100) : 0;
      const emoji = phaseEmoji[(phaseCount - 1) % phaseEmoji.length];
      html += `<details class="phase-card">`;
      html += `<summary><span class="phase-num">${escHtml(num)}</span>
        <span class="phase-main"><span class="phase-name">${emoji} ${inlineMd(name)}</span>
        <span class="phase-meta">${done}/${checks.length} done</span></span>
        <span class="phase-bar"><i style="width:${ppct}%"></i></span>
        <span class="chev" aria-hidden="true">▾</span></summary>`;
      html += `<ul class="steps">`;
      for (const it of s.items) {
        if (it.type === "check") {
          html += `<li class="step${it.checked ? " done" : ""}"><label><input type="checkbox" data-check="${it.idx}"${it.checked ? " checked" : ""}> <span class="step-text">${inlineMd(it.text)}</span> ${pillHtml(it.effort, it.priority)}</label></li>`;
        } else if (it.type === "bullet") {
          html += `<li class="bullet">${inlineMd(it.text)}</li>`;
        } else {
          html += `<li class="para">${inlineMd(it.text)}</li>`;
        }
      }
      html += `</ul></details>`;
    } else if (s.kind === "success") {
      const checks = s.items.filter((i) => i.type === "check");
      const done = checks.filter((i) => i.checked).length;
      html += `<details class="mini-card success"><summary><span class="mini-emoji">✅</span> <b>Success criteria</b> <span class="mini-meta">${done}/${checks.length}</span> <span class="chev" aria-hidden="true">▾</span></summary><ul class="steps">`;
      for (const it of s.items) {
        if (it.type === "check") html += `<li class="step${it.checked ? " done" : ""}"><label><input type="checkbox" data-check="${it.idx}"${it.checked ? " checked" : ""}> <span class="step-text">${inlineMd(it.text)}</span> ${pillHtml(it.effort, it.priority)}</label></li>`;
        else html += `<li class="bullet">${inlineMd(it.text)}</li>`;
      }
      html += `</ul></details>`;
    } else if (s.kind === "risks") {
      html += `<details class="mini-card risks"><summary><span class="mini-emoji">⚠️</span> <b>Risks</b> <span class="mini-meta">${s.items.length}</span> <span class="chev" aria-hidden="true">▾</span></summary><ul class="risks-list">`;
      for (const it of s.items) html += `<li>${inlineMd(it.text)}</li>`;
      html += `</ul></details>`;
    } else if (s.kind === "next") {
      html += `<div class="next-card"><div class="next-head"><span>⚡</span> <b>Do next — today</b></div><ul class="steps">`;
      for (const it of s.items) {
        if (it.type === "check") html += `<li class="step${it.checked ? " done" : ""}"><label><input type="checkbox" data-check="${it.idx}"${it.checked ? " checked" : ""}> <span class="step-text">${inlineMd(it.text)}</span> ${pillHtml(it.effort, it.priority)}</label></li>`;
        else html += `<li class="bullet">${inlineMd(it.text)}</li>`;
      }
      html += `</ul></div>`;
    } else {
      if (!s.title && s.items.length === 0) continue;
      if (s.title) html += `<div class="generic-card"><b>${inlineMd(s.title)}</b><ul class="steps">`;
      else html += `<div class="generic-card"><ul class="steps">`;
      for (const it of s.items) {
        if (it.type === "check") html += `<li class="step${it.checked ? " done" : ""}"><label><input type="checkbox" data-check="${it.idx}"${it.checked ? " checked" : ""}> <span class="step-text">${inlineMd(it.text)}</span> ${pillHtml(it.effort, it.priority)}</label></li>`;
        else html += `<li class="bullet">${inlineMd(it.text)}</li>`;
      }
      html += `</ul></div>`;
    }
  }

  if (!sections.length && !goal) {
    // Extremely early stream chunk — fall back to plain text so something shows.
    html += `<div class="generic-card">${inlineMd(raw.slice(0, 500))}</div>`;
  }

  $("preview").innerHTML = html;
}

function setEditMode(on) {
  isEditing = on;
  $("preview").classList.toggle("hidden", on);
  $("planMd").classList.toggle("hidden", !on);
  const btn = $("editToggleBtn");
  if (btn) {
    btn.textContent = on ? "Done" : "✏️ Edit Markdown";
    btn.disabled = streamingActive;
  }
  if (on) $("planMd").focus();
}

$("editToggleBtn").onclick = () => setEditMode(!isEditing);
$("preview").addEventListener("dblclick", () => {
  if (!streamingActive) setEditMode(true);
});

$("planMd").addEventListener("input", (e) => {
  renderPreview(e.target.value);
  persistDraft();
  scheduleAutosave();
});

async function refreshList() {
  const res = await fetch("/api/plans");
  const plans = await res.json();
  const list = $("planList");
  list.innerHTML = "";
  for (const p of plans) {
    const div = document.createElement("div");
    div.className = "plan-item" + (p.id === currentId ? " active" : "");
    div.innerHTML = `<b></b><small></small>`;
    div.querySelector("b").textContent = p.title;
    div.querySelector("small").textContent = new Date(p.updated).toLocaleString();
    div.onclick = () => loadPlan(p.id);
    list.appendChild(div);
  }
  if (!plans.length) list.innerHTML = '<p style="color:var(--muted);font-size:13px">No plans yet. Dump an idea →</p>';
}

async function loadPlan(id) {
  if (abortCtrl) abortCtrl.abort();
  const res = await fetch(`/api/plans/${id}`);
  const p = await res.json();
  currentId = p.id;
  generatedGoal = p.title;
  try { localStorage.setItem("planner.currentId", p.id); } catch (_) {}
  $("generatedTitle").textContent = p.title;
  $("idea").value = p.raw_idea || "";
  $("planMd").value = p.plan_markdown || "";
  persistDraft();
  renderPreview(p.plan_markdown || "");
  setEditMode(false);
  $("sourceBadge").classList.add("hidden");
  showResult(true);
  refreshList();
}

function resetToDump() {
  if (abortCtrl) abortCtrl.abort();
  clearTimeout(autosaveTimerId);
  currentId = null;
  generatedGoal = "";
  $("idea").value = "";
  $("planMd").value = "";
  $("preview").innerHTML = "";
  $("generatedTitle").textContent = "";
  $("sourceBadge").classList.add("hidden");
  $("warning").classList.add("hidden");
  if ($("status")) $("status").classList.add("hidden");
  if ($("refineInput")) $("refineInput").value = "";
  setEditMode(false);
  showResult(false);
  try {
    localStorage.removeItem("planner.currentId");
    localStorage.removeItem("planner.draftPlan");
    localStorage.removeItem("planner.draftGoal");
    persistDraft();
  } catch (_) {}
  $("idea").focus();
  refreshList();
}

$("newBtn").onclick = resetToDump;

let statusTimerId = null;
let statusStartedAt = 0;
let statusBase = "Working…";
let lastProgressAt = 0;
let abortCtrl = null;
let watchdogId = null;
let autoStopped = false;

function setBusy(busy, label) {
  // Only block (re)generation + refine. Keep Save / Delete / New / sidebar
  // clickable so the screen never feels frozen. A Stop button aborts.
  for (const id of ["generateBtn", "regenerateBtn", "refineBtn"]) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
  if ($("refineInput")) $("refineInput").disabled = busy;
  streamingActive = busy;
  const btn = $("generateBtn");
  if (btn) btn.textContent = busy ? (label || "Generating…") : "✨ Generate concrete steps";
  const regen = $("regenerateBtn");
  if (regen) regen.textContent = busy ? (label || "Working…") : "↻ Regenerate";
  const cancel = $("cancelBtn");
  if (cancel) cancel.classList.toggle("hidden", !busy);
  if ($("planMd")) $("planMd").readOnly = busy;
  const editBtn = $("editToggleBtn");
  if (editBtn) editBtn.disabled = busy;
  if (busy) {
    // Streaming always shows the clean rendered plan, never raw Markdown.
    if (isEditing) setEditMode(false);
    $("preview").classList.add("streaming");
  }
  else {
    $("preview").classList.remove("streaming");
    $("resultSection").classList.remove("regenerating", "streaming-active");
    if (editBtn) editBtn.disabled = false;
  }
}

function showSkeleton() {
  $("preview").innerHTML =
    '<div class="skeleton"><span style="width:60%"></span><span></span><span style="width:85%"></span><span style="width:70%"></span><span></span><span style="width:50%"></span></div>';
}

function setStatus(message) {
  $("status").classList.remove("hidden");
  statusBase = message;
  lastProgressAt = Date.now();
  $("statusText").textContent = message;
  if ($("statusChars")) $("statusChars").textContent = "";
  statusStartedAt = Date.now();
  $("statusTimer").textContent = "0.0s";
  clearInterval(statusTimerId);
  statusTimerId = setInterval(() => {
    $("statusTimer").textContent = ((Date.now() - statusStartedAt) / 1000).toFixed(1) + "s";
    // Stall hint: if nothing arrived for 30s, say so and point at Stop.
    // The stream can wedge server-side (no terminator); the user should know
    // that stopping keeps whatever is already on screen.
    if (streamingActive && Date.now() - lastProgressAt > 30000) {
      $("statusText").textContent = statusBase + " (still waiting — Stop keeps what's shown)";
    } else {
      $("statusText").textContent = statusBase;
    }
  }, 100);
}

function updateStatus(message, chars) {
  statusBase = message;
  $("statusText").textContent = message;
  if ($("statusChars") && typeof chars === "number") {
    $("statusChars").textContent = chars + " chars";
    lastProgressAt = Date.now();
  }
}

function clearStatus() {
  clearInterval(statusTimerId);
  $("status").classList.add("hidden");
}

function llmPayload(extra) {
  const sel = $("provider");
  const preset = (sel && LLM_PRESETS[sel.value]) || LLM_PRESETS.openai;
  return {
    apiKey: $("apiKey").value.trim(),
    baseUrl: $("baseUrl").value.trim() || preset.baseUrl,
    model: $("model").value.trim() || preset.model,
    docs: attachedDocs,
    docsPath: vaultPath,
    ...extra,
  };
}

function hasDocs() {
  return attachedDocs.length > 0 || (vaultPath && vaultFiles.length > 0) || (vaultPath && $("docsPath") && $("docsPath").value.trim());
}

function hasApiKey() {
  return ($("apiKey") && $("apiKey").value.trim().length > 0);
}

// Point the user at the exact place to configure the LLM: the sidebar
// ⚙️ LLM settings. Opens the collapsible, flashes it, and focuses the key.
window.openLlmSettings = function() {
  const box = document.getElementById("llmSettings");
  if (box) {
    box.open = true;
    box.classList.remove("flash");
    void box.offsetWidth; // restart the flash animation
    box.classList.add("flash");
    try { box.scrollIntoView({behavior: "smooth", block: "nearest"}); } catch (_) {}
    setTimeout(() => box.classList.remove("flash"), 2600);
  }
  const key = $("apiKey");
  if (key) {
    try { setTimeout(() => key.focus({preventScroll: true}), 400); } catch (_) {}
  }
};

function renderDocsChips() {
  const wrap = $("docsChips");
  const status = $("docsStatus");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const d of attachedDocs) {
    const s = document.createElement("span");
    s.className = "doc-chip";
    s.title = `${d.name} (${(d.content || "").length} chars)`;
    s.textContent = `📄 ${d.name}`;
    wrap.appendChild(s);
  }
  for (const f of vaultFiles.slice(0, 20)) {
    const s = document.createElement("span");
    s.className = "doc-chip vault";
    s.title = `${f.name} (${f.chars} chars)`;
    s.textContent = `🗂 ${f.name}`;
    wrap.appendChild(s);
  }
  if (vaultFiles.length > 20) {
    const s = document.createElement("span");
    s.className = "doc-chip vault";
    s.textContent = `+${vaultFiles.length - 20} more`;
    wrap.appendChild(s);
  }
  if (status) {
    const parts = [];
    if (attachedDocs.length) parts.push(`${attachedDocs.length} file(s) attached`);
    if (vaultFiles.length) parts.push(`${vaultFiles.length} vault file(s)`);
    else if (vaultPath) parts.push(`vault: ${vaultPath} (not scanned yet — hit Scan)`);
    status.textContent = parts.length
      ? `Using ${parts.join(" + ")} as background. Leave the idea empty to extract the best idea from them.`
      : "";
  }
}

async function handleDocsFiles(input) {
  const files = Array.from(input.files || []).filter((f) => /\.(md|markdown|txt)$/i.test(f.name) || f.type.startsWith("text/"));
  let total = attachedDocs.reduce((n, d) => n + (d.content || "").length, 0);
  for (const f of files) {
    let text = "";
    try { text = await f.text(); } catch (_) { continue; }
    text = (text || "").trim();
    if (!text) continue;
    if (text.length > DOCS_PER_FILE_LIMIT) text = text.slice(0, DOCS_PER_FILE_LIMIT) + "\n[…truncated…]";
    if (total + text.length > DOCS_TOTAL_LIMIT) {
      const remaining = DOCS_TOTAL_LIMIT - total;
      if (remaining > 500) {
        attachedDocs.push({name: f.name, content: text.slice(0, remaining) + "\n[…truncated at budget…]"});
      }
      alert(`Docs budget reached (~${Math.round(DOCS_TOTAL_LIMIT / 1000)}k chars) — extra content was truncated.`);
      break;
    }
    attachedDocs = attachedDocs.filter((d) => d.name !== f.name);
    attachedDocs.push({name: f.name, content: text});
    total += text.length;
    if (attachedDocs.length >= 5000) break;
  }
  input.value = "";
  renderDocsChips();
}

async function scanVault(silent) {
  const pathInput = $("docsPath");
  const path = (pathInput ? pathInput.value : vaultPath || "").trim();
  if (!path) {
    if (!silent) alert("Enter a local folder path first (e.g. your Obsidian vault).");
    return;
  }
  vaultPath = path;
  try { localStorage.setItem("planner.docsPath", path); } catch (_) {}
  if ($("docsStatus")) $("docsStatus").textContent = "Scanning folder…";
  try {
    const res = await fetch("/api/docs/scan", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({
      path,
      query: $("idea") ? $("idea").value : "",
      model: $("model") ? $("model").value.trim() : "",
    })});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`);
    vaultPath = data.path || path;
    vaultFiles = data.files || [];
    if (pathInput && data.path) pathInput.value = data.path;
    renderDocsChips();
    if ($("docsStatus")) {
      const found = data.total_files ?? vaultFiles.length;
      const used = vaultFiles.length;
      const budgetK = Math.round((data.budget || DOCS_TOTAL_LIMIT) / 1000);
      const batches = data.batches || 1;
      if (data.truncated) {
        $("docsStatus").textContent += ` (scanned ${found} file(s) in ${batches} batch(es) — using top ${used} within ~${budgetK}k chars, most relevant first)`;
      } else {
        $("docsStatus").textContent += ` (scanned ${found} file(s), all fit in the ~${budgetK}k char budget)`;
      }
    }
  } catch (e) {
    vaultFiles = [];
    renderDocsChips();
    if ($("docsStatus")) $("docsStatus").textContent = `Couldn't read that folder: ${e.message}`;
  }
}

function clearDocs() {
  attachedDocs = [];
  vaultPath = "";
  vaultFiles = [];
  if ($("docsPath")) $("docsPath").value = "";
  try { localStorage.removeItem("planner.docsPath"); } catch (_) {}
  renderDocsChips();
}

// POST an SSE endpoint and dispatch parsed `data:` events.
async function streamSSE(url, payload, onEvent, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json", "Accept": "text/event-stream"},
    body: JSON.stringify(payload),
    signal,
  });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    // Non-stream response (e.g. 400 JSON error).
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const dispatch = (raw) => {
    for (const chunk of raw.split("\n\n")) {
      const line = chunk.trim();
      if (!line.startsWith("data:")) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch (_) { /* ignore partial JSON */ }
    }
  };
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    const idx = buf.lastIndexOf("\n\n");
    if (idx !== -1) {
      dispatch(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) dispatch(buf);
}

function showWarning(text) {
  if (!text) return;
  $("warning").textContent = text;
  $("warning").classList.remove("hidden");
}

function goalFromMarkdown(md, fallback) {
  const m = String(md || "").match(/\*\*Goal:\*\*\s*(.+)/);
  const line = ((m && m[1]) || fallback || "Partial plan").trim().split("\n")[0];
  return smartTruncate(line, 220);
}

// Safety net: never let a run look wedged forever client-side. The server
// enforces its own stall/deadline bounds, but if they ever fail (proxy
// buffering, dropped SSE without close), auto-stop and keep the partial.
function startWatchdog() {
  clearTimeout(watchdogId);
  autoStopped = false;
  watchdogId = setTimeout(() => {
    if (streamingActive && abortCtrl) {
      autoStopped = true;
      abortCtrl.abort();
    }
  }, 240000);
}

function clearWatchdog() {
  clearTimeout(watchdogId);
  watchdogId = null;
}

async function generate() {
  if (streamingActive) return;
  const idea = $("idea").value.trim();
  // Frontend-side hint only (the server may still have an env key) — the
  // authoritative offline signal is `source === "local"` on the done event.
  // Used just to keep the streaming label honest instead of claiming "AI".
  const offlineLikely = !hasApiKey();
  // Docs count as input too: empty idea + docs = extract mode.
  if (idea.length < 5 && !hasDocs()) { alert("Dump a bit more detail first — or attach reference docs."); return; }
  if (idea.length < 5 && hasDocs() && !vaultFiles.length && vaultPath && $("docsPath") && $("docsPath").value.trim()) {
    await scanVault(true);
  }
  $("warning").classList.add("hidden");
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;
  setBusy(true, "Generating…");
  startWatchdog();
  showResult(true);
  $("resultSection").scrollIntoView({behavior: "smooth", block: "start"});

  // Keep the old plan on screen until the new one actually arrives.
  // Blank-screen + locked buttons is what felt "frozen".
  const previous = $("planMd").value;
  const isRegen = previous.trim().length > 0;
  if (isRegen) {
    setStatus("Regenerating — old plan stays until the new one streams in…");
    $("resultSection").classList.add("regenerating");
    $("generatedTitle").textContent = (generatedGoal || "Your plan") + " — regenerating…";
  } else {
    setStatus("Starting…");
    $("generatedTitle").textContent = "Drafting your plan…";
    $("planMd").value = "";
    showSkeleton();
  }
  let accumulated = "";
  let gotFirstDelta = false;
  const streamingLabel = () => {
    if (isRegen) return offlineLikely ? "Offline template streaming in…" : "New plan streaming in…";
    return offlineLikely ? "Building offline template — streaming…" : "AI is drafting your plan — streaming…";
  };
  const markStreaming = () => {
    if (!gotFirstDelta) {
      gotFirstDelta = true;
      $("resultSection").classList.add("streaming-active");
      if (isRegen) updateStatus(streamingLabel(), 0);
    }
  };
  try {
    await streamSSE("/api/generate/stream", llmPayload({idea}), (ev) => {
      if (ev.type === "status") updateStatus(ev.message, accumulated.length || undefined);
      else if (ev.type === "delta") {
        markStreaming();
        accumulated += ev.text || "";
        $("planMd").value = accumulated;
        renderPreview(accumulated);
        updateStatus(streamingLabel(), accumulated.length);
      }
      else if (ev.type === "done") {
        accumulated = ev.markdown || accumulated;
        generatedGoal = smartTruncate(ev.goal || idea.split("\n")[0] || "Plan from reference docs", 220);
        $("generatedTitle").textContent = generatedGoal;
        $("planMd").value = accumulated;
        renderPreview(accumulated);
        const badge = $("sourceBadge");
        badge.classList.remove("hidden");
        const docsSuffix = (ev.docs_sources && ev.docs_sources.length) ? ` · 📚 ${ev.docs_sources.length} doc(s)` : "";
        const isOffline = ev.source !== "llm";
        badge.textContent = !isOffline
          ? (ev.truncated ? `✨ AI-generated (partial — stream stalled)${docsSuffix}` : `✨ AI-generated${docsSuffix}`)
          : `📦 Offline template (add API key for AI)${docsSuffix}`;
        const warnBox = $("warning");
        warnBox.classList.add("hidden");
        warnBox.innerHTML = "";
        const notes = [];
        if (ev.docs_sources && ev.docs_sources.length) {
          notes.push(`Grounded in: ${ev.docs_sources.slice(0, 8).join(", ")}${ev.docs_sources.length > 8 ? ` +${ev.docs_sources.length - 8} more` : ""}`);
        }
        if (ev.warning) notes.push(ev.warning);
        if (isOffline) {
          // Helpful pointer: offline template is generic — show exactly where
          // to configure the LLM so the next run is a real AI plan.
          const grounded = notes.length ? `<div class="warn-line">${escHtml(notes.join("\n"))}</div>` : "";
          warnBox.innerHTML =
            `<div class="warn-title">You're in <b>offline mode</b> — no API key set. This is a generic template plan, not AI.</div>` +
            grounded +
            `<div class="warn-line">To get an AI plan grounded in your docs:</div>` +
            `<ol class="warn-steps"><li>Open <b>⚙️ LLM settings</b> in the left sidebar</li>` +
            `<li>Paste your <b>API key</b> (Base URL + Model are prefilled for OpenAI; any OpenAI-compatible API works)</li>` +
            `<li>Hit <b>↻ Regenerate</b></li></ol>` +
            `<div class="warn-actions"><button type="button" class="warn-cta" onclick="openLlmSettings()">Open LLM settings</button>` +
            `<span class="hint">Key stays in your browser (localStorage).</span></div>`;
          warnBox.classList.remove("hidden");
          const settingsBox = document.getElementById("llmSettings");
          if (settingsBox && !settingsBox.open) settingsBox.open = true;
        } else if (notes.length) {
          warnBox.textContent = notes.join("\n");
          warnBox.classList.remove("hidden");
        }
      }
      else if (ev.type === "error") throw new Error(ev.error);
    }, signal);
    if (!accumulated.trim()) throw new Error("Empty response from AI.");
    // Auto-save so a refresh never loses a generated idea.
    persistDraft();
    try {
      await savePlan({silent: true});
    } catch (saveErr) {
      console.warn("Autosave failed, kept local draft:", saveErr);
    }
  } catch (e) {
    if (e.name === "AbortError" || (abortCtrl && abortCtrl.signal.aborted)) {
      // Restore whatever was on screen before the aborted run.
      if (isRegen && !gotFirstDelta) {
        $("planMd").value = previous;
        renderPreview(previous);
        $("generatedTitle").textContent = generatedGoal || "Your plan";
      } else if (accumulated.trim()) {
        // Keep the partial output on screen with a real title/badge instead
        // of leaving it stuck on "Drafting your plan…".
        generatedGoal = goalFromMarkdown(accumulated, idea.split("\n")[0]);
        $("generatedTitle").textContent = generatedGoal;
        const badge = $("sourceBadge");
        badge.classList.remove("hidden");
        badge.textContent = "⏸ Partial (stopped) — kept what's shown";
        persistDraft();
        showWarning(autoStopped
          ? "Stopped automatically after 4 min with no finish from the AI — kept the partial output. Regenerate to retry."
          : "Stopped — kept the partial output shown above.");
      }
      setStatus("Stopped.");
      setTimeout(clearStatus, 1200);
    } else {
      if (!isRegen || !gotFirstDelta) $("generatedTitle").textContent = generatedGoal || "Generation failed";
      else $("generatedTitle").textContent = generatedGoal || "Your plan";
      alert("Generation failed: " + e.message);
    }
  } finally {
    clearWatchdog();
    abortCtrl = null;
    setBusy(false);
    if ($("statusText").textContent !== "Stopped.") clearStatus();
  }
}

async function refine() {
  if (streamingActive) return;
  const instruction = $("refineInput").value.trim();
  if (instruction.length < 3) { alert("Tell the AI what to change first."); return; }
  if ($("planMd").value.trim().length < 10) { alert("Generate a plan first."); return; }
  $("warning").classList.add("hidden");
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;
  setBusy(true, "Refining…");
  startWatchdog();
  setStatus("Refining plan — original stays until the revision streams in…");
  $("resultSection").classList.add("regenerating");
  let accumulated = "";
  let gotFirstDelta = false;
  const previous = $("planMd").value;
  try {
    await streamSSE("/api/refine/stream", llmPayload({
      idea: $("idea").value,
      plan_markdown: previous,
      instruction,
    }), (ev) => {
      if (ev.type === "status") updateStatus(ev.message, accumulated.length || undefined);
      else if (ev.type === "delta") {
        if (!gotFirstDelta) {
          gotFirstDelta = true;
          accumulated = "";
          $("resultSection").classList.add("streaming-active");
        }
        accumulated += ev.text || "";
        $("planMd").value = accumulated;
        renderPreview(accumulated);
        updateStatus("Revision streaming in…", accumulated.length);
      }
      else if (ev.type === "done") {
        accumulated = ev.markdown || accumulated;
        $("planMd").value = accumulated;
        renderPreview(accumulated);
        if (ev.goal) {
          generatedGoal = smartTruncate(ev.goal, 220);
          $("generatedTitle").textContent = generatedGoal;
        }
        $("refineInput").value = "";
        $("refineInput").placeholder = "Anything else to tweak?";
        if (ev.warning) showWarning(ev.warning);
        else if (ev.truncated) showWarning("The stream stalled — kept the partial revision shown above.");
      }
      else if (ev.type === "error") throw new Error(ev.error);
    }, signal);
    if (!accumulated.trim()) throw new Error("Empty response from AI.");
    // Auto-save the revision so a refresh keeps it.
    persistDraft();
    try {
      await savePlan({silent: true});
    } catch (saveErr) {
      console.warn("Autosave failed, kept local draft:", saveErr);
    }
  } catch (e) {
    if (e.name === "AbortError" || (abortCtrl && abortCtrl.signal.aborted)) {
      if (!gotFirstDelta) {
        $("planMd").value = previous;
        renderPreview(previous);
      } else if (autoStopped) {
        showWarning("Stopped automatically after 4 min with no finish from the AI — kept the partial revision. Send your instruction again to retry.");
      }
      setStatus("Stopped.");
      setTimeout(clearStatus, 1200);
      clearWatchdog();
      abortCtrl = null;
      setBusy(false);
      return;
    }
    $("planMd").value = previous;
    renderPreview(previous);
    if (/api key/i.test(e.message || "")) {
      const warnBox = $("warning");
      warnBox.innerHTML =
        `<div class="warn-title">Refine needs an API key — offline mode can't rewrite plans.</div>` +
        `<div class="warn-line">Open <b>⚙️ LLM settings</b> in the left sidebar, paste your key, then Send again.</div>` +
        `<div class="warn-actions"><button type="button" class="warn-cta" onclick="openLlmSettings()">Open LLM settings</button></div>`;
      warnBox.classList.remove("hidden");
      window.openLlmSettings();
    } else {
      alert("Refine failed: " + e.message);
    }
  } finally {
    clearWatchdog();
    abortCtrl = null;
    setBusy(false);
    clearStatus();
  }
}

$("generateBtn").onclick = generate;
$("regenerateBtn").onclick = generate;
$("refineBtn").onclick = refine;
$("cancelBtn").onclick = () => { if (abortCtrl) abortCtrl.abort(); };
if ($("docsFiles")) $("docsFiles").addEventListener("change", (e) => handleDocsFiles(e.target));
if ($("docsScanBtn")) $("docsScanBtn").onclick = () => scanVault(false);
if ($("docsClearBtn")) $("docsClearBtn").onclick = clearDocs;
if ($("docsPath")) $("docsPath").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); scanVault(false); }
});
if ($("docsPath")) $("docsPath").addEventListener("change", () => {
  // Path edited manually — stale scan results no longer apply.
  vaultFiles = [];
  vaultPath = $("docsPath").value.trim();
  try {
    if (vaultPath) localStorage.setItem("planner.docsPath", vaultPath);
    else localStorage.removeItem("planner.docsPath");
  } catch (_) {}
  renderDocsChips();
});
$("refineInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); refine(); }
});

$("saveBtn").onclick = async () => {
  const btn = $("saveBtn");
  const original = btn.textContent;
  try {
    await savePlan();
    btn.textContent = "✓ Saved";
  } catch (e) {
    alert("Save failed: " + e.message);
    return;
  } finally {
    setTimeout(() => { btn.textContent = original; }, 1500);
  }
};

$("deleteBtn").onclick = async () => {
  if (!currentId || !confirm("Delete this plan?")) return;
  await fetch(`/api/plans/${currentId}`, {method: "DELETE"});
  resetToDump();
};

// toggle checkboxes by clicking them in the clean rendered plan
$("preview").addEventListener("click", (e) => {
  if (e.target.tagName !== "INPUT" || e.target.type !== "checkbox") return;
  const targetIdx = parseInt(e.target.dataset.check, 10);
  if (Number.isNaN(targetIdx)) return;
  const lines = $("planMd").value.split("\n");
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[[ xX]\]/.test(lines[i])) {
      seen++;
      if (seen === targetIdx) {
        lines[i] = lines[i].includes("- [ ]")
          ? lines[i].replace("- [ ]", "- [x]")
          : lines[i].replace(/- \[[xX]\]/, "- [ ]");
        break;
      }
    }
  }
  $("planMd").value = lines.join("\n");
  renderPreview($("planMd").value);
  persistDraft();
  scheduleAutosave();
});

async function boot() {
  showResult(false);
  setEditMode(false);
  // Restore vault path before anything else so generate() can use it.
  try {
    const savedPath = localStorage.getItem("planner.docsPath") || "";
    if (savedPath && $("docsPath")) {
      $("docsPath").value = savedPath;
      vaultPath = savedPath;
      scanVault(true);
    }
  } catch (_) {}
  renderDocsChips();
  await refreshList();
  // Restore last-open plan or unsaved draft so refresh never loses ideas.
  let restoredId = null;
  try { restoredId = localStorage.getItem("planner.currentId") || null; } catch (_) {}
  if (restoredId) {
    try {
      await loadPlan(restoredId);
      return;
    } catch (_) {
      try { localStorage.removeItem("planner.currentId"); } catch (_) {}
    }
  }
  try {
    const draftIdea = localStorage.getItem("planner.draftIdea") || "";
    const draftPlan = localStorage.getItem("planner.draftPlan") || "";
    const draftGoal = localStorage.getItem("planner.draftGoal") || "";
    if (draftIdea.trim() || draftPlan.trim()) {
      $("idea").value = draftIdea;
      $("planMd").value = draftPlan;
      generatedGoal = draftGoal;
      if (draftPlan.trim()) {
        $("generatedTitle").textContent = draftGoal || "Unsaved draft";
        renderPreview(draftPlan);
        showResult(true);
      }
    }
  } catch (_) {}
  $("idea").focus();
}
boot();
