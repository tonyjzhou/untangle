const $ = (id) => document.getElementById(id);
let currentId = null;
let generatedGoal = "";

const store = {
  get baseUrl() { return localStorage.getItem("planner.baseUrl") || ""; },
  get model() { return localStorage.getItem("planner.model") || ""; },
  get apiKey() { return localStorage.getItem("planner.apiKey") || ""; },
};

// init settings
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

function renderPreview(md) {
  let html = md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^- \[ \] (.*)$/gm, '<li><input type="checkbox" disabled> $1</li>')
    .replace(/^- \[x\] (.*)$/gm, '<li><input type="checkbox" checked disabled> $1</li>')
    .replace(/^- (.*)$/gm, "<li>$1</li>");
  $("preview").innerHTML = html;
}

$("planMd").addEventListener("input", (e) => renderPreview(e.target.value));

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
  $("generatedTitle").textContent = p.title;
  $("idea").value = p.raw_idea || "";
  $("planMd").value = p.plan_markdown || "";
  renderPreview(p.plan_markdown || "");
  $("sourceBadge").classList.add("hidden");
  showResult(true);
  refreshList();
}

function resetToDump() {
  if (abortCtrl) abortCtrl.abort();
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
  showResult(false);
  $("idea").focus();
  refreshList();
}

$("newBtn").onclick = resetToDump;

let statusTimerId = null;
let statusStartedAt = 0;
let abortCtrl = null;
let streamingActive = false;

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
  if (busy) $("preview").classList.add("streaming");
  else {
    $("preview").classList.remove("streaming");
    $("resultSection").classList.remove("regenerating", "streaming-active");
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
        generatedGoal = (ev.goal || idea.split("\n")[0]).slice(0, 80);
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
          generatedGoal = ev.goal.slice(0, 80);
          $("generatedTitle").textContent = generatedGoal;
        }
        $("refineInput").value = "";
        $("refineInput").placeholder = "Anything else to tweak?";
      }
      else if (ev.type === "error") throw new Error(ev.error);
    }, signal);
    if (!accumulated.trim()) throw new Error("Empty response from AI.");
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
  const payload = {
    title: generatedGoal || $("idea").value.split("\n")[0].slice(0, 80) || "Untitled",
    raw_idea: $("idea").value,
    plan_markdown: $("planMd").value,
  };
  let res;
  if (currentId) {
    res = await fetch(`/api/plans/${currentId}`, {method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)});
  } else {
    res = await fetch("/api/plans", {method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)});
  }
  const saved = await res.json();
  currentId = saved.id;
  generatedGoal = saved.title;
  $("generatedTitle").textContent = saved.title;
  await refreshList();
};

$("deleteBtn").onclick = async () => {
  if (!currentId || !confirm("Delete this plan?")) return;
  await fetch(`/api/plans/${currentId}`, {method: "DELETE"});
  resetToDump();
};

// toggle checkboxes in the markdown editor by clicking preview
$("preview").addEventListener("click", (e) => {
  if (e.target.tagName !== "INPUT" || e.target.type !== "checkbox") return;
  const items = [...$("preview").querySelectorAll("li")];
  const idx = items.indexOf(e.target.closest("li"));
  const lines = $("planMd").value.split("\n");
  let liCount = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[[ x]\]/.test(lines[i])) {
      liCount++;
      if (liCount === idx) {
        lines[i] = lines[i].includes("- [ ]")
          ? lines[i].replace("- [ ]", "- [x]")
          : lines[i].replace("- [x]", "- [ ]");
        break;
      }
    }
  }
  $("planMd").value = lines.join("\n");
  renderPreview($("planMd").value);
});

showResult(false);
refreshList();
$("idea").focus();
