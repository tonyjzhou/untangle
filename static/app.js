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
  currentId = null;
  generatedGoal = "";
  $("idea").value = "";
  $("planMd").value = "";
  $("preview").innerHTML = "";
  $("generatedTitle").textContent = "";
  $("sourceBadge").classList.add("hidden");
  $("warning").classList.add("hidden");
  showResult(false);
  $("idea").focus();
  refreshList();
}

$("newBtn").onclick = resetToDump;

async function generate() {
  const idea = $("idea").value.trim();
  if (idea.length < 5) { alert("Dump a bit more detail first."); return; }
  const btn = $("generateBtn");
  btn.disabled = true;
  btn.textContent = "Generating...";
  $("warning").classList.add("hidden");
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        idea,
        apiKey: $("apiKey").value.trim(),
        baseUrl: $("baseUrl").value.trim() || "https://api.openai.com/v1",
        model: $("model").value.trim() || "gpt-4o-mini",
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    generatedGoal = (data.plan?.goal || idea.split("\n")[0]).slice(0, 80);
    $("generatedTitle").textContent = generatedGoal;
    $("planMd").value = data.markdown;
    renderPreview(data.markdown);
    const badge = $("sourceBadge");
    badge.classList.remove("hidden");
    badge.textContent = data.source === "llm" ? "✨ AI-generated" : "📦 Offline template (add API key for AI)";
    if (data.warning) {
      $("warning").textContent = data.warning;
      $("warning").classList.remove("hidden");
    }
    showResult(true);
    $("resultSection").scrollIntoView({behavior: "smooth"});
  } catch (e) {
    alert("Generation failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Generate concrete steps";
  }
}

$("generateBtn").onclick = generate;
$("regenerateBtn").onclick = generate;

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
