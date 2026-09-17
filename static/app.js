const $ = (id) => document.getElementById(id);
let currentId = null;
let generatedGoal = "";
let isEditing = false;
let streamingActive = false;

const store = {
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
$("baseUrl").value = store.baseUrl;
$("model").value = store.model;
$("apiKey").value = store.apiKey;
for (const [id, key] of [["baseUrl","planner.baseUrl"],["model","planner.model"],["apiKey","planner.apiKey"]]) {
  $(id).addEventListener("input", (e) => localStorage.setItem(key, e.target.value.trim()));
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
let abortCtrl = null;

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
  $("statusText").textContent = message;
  if ($("statusChars")) $("statusChars").textContent = "";
  statusStartedAt = Date.now();
  $("statusTimer").textContent = "0.0s";
  clearInterval(statusTimerId);
  statusTimerId = setInterval(() => {
    $("statusTimer").textContent = ((Date.now() - statusStartedAt) / 1000).toFixed(1) + "s";
  }, 100);
}

function updateStatus(message, chars) {
  $("statusText").textContent = message;
  if ($("statusChars") && typeof chars === "number") $("statusChars").textContent = chars + " chars";
}

function clearStatus() {
  clearInterval(statusTimerId);
  $("status").classList.add("hidden");
}

function llmPayload(extra) {
  return {
    apiKey: $("apiKey").value.trim(),
    baseUrl: $("baseUrl").value.trim() || "https://api.openai.com/v1",
    model: $("model").value.trim() || "gpt-4o-mini",
    ...extra,
  };
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

async function generate() {
  if (streamingActive) return;
  const idea = $("idea").value.trim();
  if (idea.length < 5) { alert("Dump a bit more detail first."); return; }
  $("warning").classList.add("hidden");
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;
  setBusy(true, "Generating…");
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
  const markStreaming = () => {
    if (!gotFirstDelta) {
      gotFirstDelta = true;
      $("resultSection").classList.add("streaming-active");
      if (isRegen) updateStatus("New plan streaming in…", 0);
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
        updateStatus(isRegen ? "New plan streaming in…" : "AI is drafting your plan — streaming…", accumulated.length);
      }
      else if (ev.type === "done") {
        accumulated = ev.markdown || accumulated;
        generatedGoal = smartTruncate(ev.goal || idea.split("\n")[0], 220);
        $("generatedTitle").textContent = generatedGoal;
        $("planMd").value = accumulated;
        renderPreview(accumulated);
        const badge = $("sourceBadge");
        badge.classList.remove("hidden");
        badge.textContent = ev.source === "llm" ? "✨ AI-generated" : "📦 Offline template (add API key for AI)";
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
      }
      setStatus("Stopped.");
      setTimeout(clearStatus, 1200);
    } else {
      if (!isRegen || !gotFirstDelta) $("generatedTitle").textContent = generatedGoal || "Generation failed";
      else $("generatedTitle").textContent = generatedGoal || "Your plan";
      alert("Generation failed: " + e.message);
    }
  } finally {
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
      }
      setStatus("Stopped.");
      setTimeout(clearStatus, 1200);
      abortCtrl = null;
      setBusy(false);
      return;
    }
    $("planMd").value = previous;
    renderPreview(previous);
    alert("Refine failed: " + e.message);
  } finally {
    abortCtrl = null;
    setBusy(false);
    clearStatus();
  }
}

$("generateBtn").onclick = generate;
$("regenerateBtn").onclick = generate;
$("refineBtn").onclick = refine;
$("cancelBtn").onclick = () => { if (abortCtrl) abortCtrl.abort(); };
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
