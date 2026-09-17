"""Idea-to-plan web app: dump an idea, get concrete steps, save as Markdown."""
import json
import os
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

BASE_DIR = Path(__file__).parent
PLANS_DIR = BASE_DIR / "plans"
PLANS_DIR.mkdir(exist_ok=True)
(PLANS_DIR / ".gitkeep").touch(exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug[:50] or "untitled"


def plan_path(plan_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_-]", "", plan_id)[:80]
    return PLANS_DIR / f"{safe}.md"


def parse_plan_file(path: Path) -> dict:
    text = path.read_text()
    meta = {"id": path.stem, "title": path.stem, "raw_idea": "", "plan_markdown": text}
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            front = text[3:end]
            body = text[end + 3 :].lstrip("\n")
            for line in front.splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip().strip('"')
            # Split body into raw idea + plan
            if "## Raw Idea" in body and "## Plan" in body:
                raw_part = body.split("## Raw Idea", 1)[1].split("## Plan", 1)
                meta["raw_idea"] = raw_part[0].strip()
                meta["plan_markdown"] = "## Plan\n" + raw_part[1].strip() if len(raw_part) > 1 else body
            else:
                meta["plan_markdown"] = body
    st = path.stat()
    meta["created"] = meta.get("created", datetime.fromtimestamp(st.st_ctime, tz=timezone.utc).isoformat())
    meta["updated"] = meta.get("updated", datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat())
    return meta


def write_plan_file(plan_id: str, title: str, raw_idea: str, plan_markdown: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    path = plan_path(plan_id)
    created = now
    if path.exists():
        try:
            created = parse_plan_file(path).get("created", now)
        except Exception:
            pass
    safe_title = title.replace('"', "'")
    content = f"""---
title: "{safe_title}"
created: {created}
updated: {now}
---

## Raw Idea

{raw_idea.strip()}

{plan_markdown.strip()}
"""
    path.write_text(content)
    return parse_plan_file(path)


SYSTEM_PROMPT = """You are a pragmatic planning assistant. The user dumps a raw, messy idea.
Turn it into a concrete, actionable plan.

Rules:
- Infer a clear 1-sentence goal even if the idea is vague. Ask nothing; make best guess.
- The goal MUST be one complete, self-contained sentence, max 18 words (it is shown as the plan title, never truncated mid-sentence).
- Break into 3-5 phases/milestones, each with concrete steps (not vague advice).
- Each step must be small enough to do in one sitting (<=2h). Start each step with a verb. Keep each step under 18 words.
- Include for each step: checkbox, effort estimate (S/M/L), and priority (P1/P2/P3).
- End with: Success criteria (3 measurable checks), Risks (2-3), and Next 3 immediate actions.
- Keep total steps between 7 and 15. Be specific to THIS idea, no generic filler.

Return JSON only with this shape:
{"goal": "...", "phases": [{"name": "...", "steps": [{"text": "...", "effort": "S|M|L", "priority": "P1|P2|P3"}]}], "success_criteria": ["..."], "risks": ["..."], "next_actions": ["...", "...", "..."]}
"""


def json_to_markdown(data: dict) -> str:
    lines = ["## Plan", "", f"**Goal:** {data.get('goal', '')}", ""]
    for i, phase in enumerate(data.get("phases", []), 1):
        lines.append(f"### Phase {i}: {phase.get('name', '')}")
        for s in phase.get("steps", []):
            lines.append(f"- [ ] {s.get('text','')} `[{s.get('effort','M')}/{s.get('priority','P2')}]`")
        lines.append("")
    if data.get("success_criteria"):
        lines.append("### Success criteria")
        lines.extend(f"- [ ] {c}" for c in data["success_criteria"])
        lines.append("")
    if data.get("risks"):
        lines.append("### Risks")
        lines.extend(f"- {r}" for r in data["risks"])
        lines.append("")
    if data.get("next_actions"):
        lines.append("### Do next (today)")
        lines.extend(f"- [ ] {a}" for a in data["next_actions"])
    return "\n".join(lines).strip() + "\n"


def local_fallback_plan(idea: str) -> dict:
    """Offline rule-based plan so the app works without an API key."""
    first_line = (idea.strip().splitlines() or ["Untitled goal"])[0][:120]
    return {
        "goal": first_line,
        "phases": [
            {"name": "Clarify", "steps": [
                {"text": f"Write a 1-sentence definition of done for: {first_line}", "effort": "S", "priority": "P1"},
                {"text": "List 3 must-have outcomes and 3 explicit non-goals", "effort": "S", "priority": "P1"},
                {"text": "Identify the audience/user and how you'll validate with them", "effort": "M", "priority": "P2"},
            ]},
            {"name": "Break down", "steps": [
                {"text": "Split the work into chunks doable in under 2 hours each", "effort": "M", "priority": "P1"},
                {"text": "Order chunks by riskiest-first and mark dependencies", "effort": "S", "priority": "P2"},
                {"text": "Time-block the first 3 chunks on your calendar", "effort": "S", "priority": "P1"},
            ]},
            {"name": "Execute", "steps": [
                {"text": "Complete the smallest shippable slice end-to-end", "effort": "M", "priority": "P1"},
                {"text": "Get feedback from one real person and note 3 fixes", "effort": "M", "priority": "P1"},
                {"text": "Iterate once, then ship/share the result", "effort": "L", "priority": "P2"},
            ]},
        ],
        "success_criteria": ["Definition of done is written down", "Smallest slice is shipped", "One person gave feedback"],
        "risks": ["Scope creep — idea too vague", "No validation with real users", "Steps too big to finish"],
        "next_actions": ["Write definition of done (15 min)", "List first 3 chunks under 2h each", "Time-block chunk #1 for today"],
    }


REFINE_SYSTEM_PROMPT = """You are a pragmatic planning assistant revising an existing plan.
The user has a raw idea, a current plan in Markdown, and a follow-up instruction
(e.g. "make phase 2 cheaper", "add timelines", "focus on solo founder").

Rules:
- Apply the instruction while keeping what still works. Preserve checkbox lines
  ("- [ ]" / "- [x]") including their checked state unless the step itself changes.
- Keep the same Markdown shape as the current plan: ## Plan, **Goal:** line,
  ### Phase N: ... sections with "- [ ] Step `[S|M|L/P1|P2|P3]`" lines,
  then ### Success criteria, ### Risks, ### Do next (today).
- Keep total steps between 7 and 15. Start each step with a verb. Be specific.
- Return Markdown only, no JSON, no code fences, no commentary.
"""

STREAM_SYSTEM_PROMPT = """You are a pragmatic planning assistant. The user dumps a raw, messy idea.
Turn it into a concrete, actionable plan. Output Markdown ONLY (no JSON, no code fences).

Exact shape:
## Plan

**Goal:** <one complete self-contained sentence, max 18 words — this is shown as the plan title>

### Phase 1: <name>
- [ ] <step starting with a verb, under 18 words> `[S|M|L/P1|P2|P3]`
... (3-5 phases, 7-15 steps total, each step doable in <=2h)

### Success criteria
- [ ] <3 measurable checks>

### Risks
- <2-3 risks>

### Do next (today)
- [ ] <3 immediate actions>
"""


def call_llm(idea: str, api_key: str, base_url: str, model: str) -> dict:
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Idea dump:\n{idea}"},
        ],
        "temperature": 0.7,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode())
    content = body["choices"][0]["message"]["content"]
    return json.loads(content)


def call_llm_markdown(messages: list, api_key: str, base_url: str, model: str, timeout: int = 60) -> str:
    """Non-streaming Markdown-mode call (used by refine + stream fallback)."""
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {"model": model, "messages": messages, "temperature": 0.7}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode())
    content = body["choices"][0]["message"]["content"] or ""
    return content.strip().strip("`").strip()


def iter_llm_markdown_stream(messages: list, api_key: str, base_url: str, model: str, timeout: int = 90):
    """Yield text deltas from an OpenAI-compatible streaming chat completion."""
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {"model": model, "messages": messages, "temperature": 0.7, "stream": True}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        buf = b""
        while True:
            # Small reads = lower time-to-first-token. read() returns up to
            # n bytes as soon as any arrive, so 256 surfaces deltas faster
            # than waiting to fill a 1-4KB buffer.
            chunk = resp.read(256)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                try:
                    delta = obj["choices"][0]["delta"].get("content", "")
                except Exception:
                    delta = ""
                if delta:
                    yield delta


def smart_truncate(text: str, limit: int = 220) -> str:
    """Truncate at a word boundary with an ellipsis — never cut mid-word."""
    text = " ".join(text.strip().split())
    if len(text) <= limit:
        return text
    cut = text.rfind(" ", 0, limit)
    if cut < limit // 2:
        cut = limit
    return text[:cut].rstrip(" ,;:—-") + "…"


def extract_goal_from_markdown(markdown: str, fallback: str) -> str:
    m = re.search(r"\*\*Goal:\*\*\s*(.+)", markdown)
    if m:
        # Goal is a single Markdown line — keep the whole sentence,
        # only smart-truncating absurdly long goals at a word boundary.
        return smart_truncate(m.group(1).strip(), 220)
    first = (fallback.strip().splitlines() or ["Untitled"])[0]
    return smart_truncate(first, 220)


def sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/plans")
def list_plans():
    plans = []
    for p in sorted(PLANS_DIR.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
        if p.name == ".gitkeep":
            continue
        try:
            m = parse_plan_file(p)
            plans.append({"id": m["id"], "title": m["title"], "created": m.get("created"), "updated": m.get("updated")})
        except Exception:
            continue
    return jsonify(plans)


@app.post("/api/plans")
def create_plan():
    data = request.get_json(force=True)
    title = (data.get("title") or "Untitled").strip()
    raw_idea = data.get("raw_idea", "")
    plan_markdown = data.get("plan_markdown", "")
    plan_id = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{slugify(title)}"
    return jsonify(write_plan_file(plan_id, title, raw_idea, plan_markdown)), 201


@app.get("/api/plans/<plan_id>")
def get_plan(plan_id):
    path = plan_path(plan_id)
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    return jsonify(parse_plan_file(path))


@app.put("/api/plans/<plan_id>")
def update_plan(plan_id):
    path = plan_path(plan_id)
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    data = request.get_json(force=True)
    current = parse_plan_file(path)
    return jsonify(write_plan_file(
        plan_id,
        data.get("title", current["title"]),
        data.get("raw_idea", current["raw_idea"]),
        data.get("plan_markdown", current["plan_markdown"]),
    ))


@app.delete("/api/plans/<plan_id>")
def delete_plan(plan_id):
    path = plan_path(plan_id)
    if path.exists():
        path.unlink()
        return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


@app.post("/api/generate")
def generate():
    data = request.get_json(force=True)
    idea = (data.get("idea") or "").strip()
    if len(idea) < 5:
        return jsonify({"error": "Idea is too short — dump a bit more detail."}), 400
    api_key = (data.get("apiKey") or os.environ.get("OPENAI_API_KEY") or "").strip()
    base_url = (data.get("baseUrl") or os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").strip()
    model = (data.get("model") or os.environ.get("OPENAI_MODEL") or "gpt-4o-mini").strip()

    source = "local"
    try:
        if api_key:
            plan_json = call_llm(idea, api_key, base_url, model)
            source = "llm"
        else:
            plan_json = local_fallback_plan(idea)
    except Exception as e:
        # Graceful fallback: still return a usable plan
        plan_json = local_fallback_plan(idea)
        return jsonify({
            "plan": plan_json,
            "markdown": json_to_markdown(plan_json),
            "source": "local",
            "warning": f"LLM call failed, used offline plan instead: {e}",
        })
    return jsonify({"plan": plan_json, "markdown": json_to_markdown(plan_json), "source": source})


def _llm_config(data: dict):
    api_key = (data.get("apiKey") or os.environ.get("OPENAI_API_KEY") or "").strip()
    base_url = (data.get("baseUrl") or os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").strip()
    model = (data.get("model") or os.environ.get("OPENAI_MODEL") or "gpt-4o-mini").strip()
    return api_key, base_url, model


@app.post("/api/refine")
def refine():
    """Iteratively adjust an existing plan with a natural-language instruction."""
    data = request.get_json(force=True)
    idea = (data.get("idea") or "").strip()
    plan_markdown = (data.get("plan_markdown") or data.get("planMarkdown") or "").strip()
    instruction = (data.get("instruction") or "").strip()
    if len(instruction) < 3:
        return jsonify({"error": "Tell the AI what to change (e.g. 'make it cheaper')."}), 400
    if len(plan_markdown) < 10:
        return jsonify({"error": "No plan to refine yet — generate one first."}), 400
    api_key, base_url, model = _llm_config(data)
    if not api_key:
        return jsonify({
            "markdown": plan_markdown,
            "source": "local",
            "warning": "Refine needs an API key — offline mode can't rewrite plans. Add a key in LLM settings.",
        })
    messages = [
        {"role": "system", "content": REFINE_SYSTEM_PROMPT},
        {"role": "user", "content": f"Original idea:\n{idea}\n\nCurrent plan:\n{plan_markdown}\n\nChange request:\n{instruction}\n\nReturn the full revised plan as Markdown only."},
    ]
    try:
        markdown = call_llm_markdown(messages, api_key, base_url, model)
    except Exception as e:
        return jsonify({"error": f"LLM refine failed: {e}"}), 502
    goal = extract_goal_from_markdown(markdown, idea)
    return jsonify({"markdown": markdown, "goal": goal, "source": "llm"})


def _stream_markdown_response(messages_fn, idea: str, chunk_delay: float = 0.0):
    """Shared SSE streamer. messages_fn(api_key, base_url, model) -> messages or None for offline."""
    import time

    data = request.get_json(force=True)
    idea_val = (data.get("idea") or idea or "").strip()
    api_key, base_url, model = _llm_config(data)

    def gen():
        yield sse({"type": "status", "message": "Contacting AI…"})
        if not api_key:
            yield sse({"type": "status", "message": "No API key — building offline plan…"})
            md = json_to_markdown(local_fallback_plan(idea_val or "Untitled"))
            # Chunk the offline plan so the UI still streams instead of popping in.
            for i in range(0, len(md), 200):
                yield sse({"type": "delta", "text": md[i:i + 200]})
                time.sleep(0.02)
            yield sse({"type": "done", "markdown": md,
                       "goal": extract_goal_from_markdown(md, idea_val),
                       "source": "local"})
            return
        messages = messages_fn(data)
        yield sse({"type": "status", "message": "AI is drafting your plan — streaming…"})
        full = []
        try:
            for delta in iter_llm_markdown_stream(messages, api_key, base_url, model):
                full.append(delta)
                yield sse({"type": "delta", "text": delta})
        except Exception:
            # Streaming not supported by this provider — fall back to one-shot call.
            yield sse({"type": "status", "message": "Live stream unavailable — fetching full plan…"})
            try:
                full_text = call_llm_markdown(messages, api_key, base_url, model)
            except Exception as e:
                yield sse({"type": "error", "error": f"LLM call failed: {e}"})
                return
            yield sse({"type": "delta", "text": full_text})
            full = [full_text]
        markdown = "".join(full).strip()
        yield sse({"type": "done", "markdown": markdown,
                   "goal": extract_goal_from_markdown(markdown, idea_val),
                   "source": "llm"})

    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                             "Connection": "keep-alive"})


@app.post("/api/generate/stream")
def generate_stream():
    data = request.get_json(force=True, silent=True) or {}
    idea = (data.get("idea") or "").strip()
    if len(idea) < 5:
        return jsonify({"error": "Idea is too short — dump a bit more detail."}), 400

    def messages_fn(_data):
        return [
            {"role": "system", "content": STREAM_SYSTEM_PROMPT},
            {"role": "user", "content": f"Idea dump:\n{idea}"},
        ]

    return _stream_markdown_response(messages_fn, idea)


@app.post("/api/refine/stream")
def refine_stream():
    data = request.get_json(force=True, silent=True) or {}
    instruction = (data.get("instruction") or "").strip()
    plan_markdown = (data.get("plan_markdown") or data.get("planMarkdown") or "").strip()
    idea = (data.get("idea") or "").strip()
    if len(instruction) < 3:
        return jsonify({"error": "Tell the AI what to change."}), 400
    if len(plan_markdown) < 10:
        return jsonify({"error": "No plan to refine yet."}), 400
    api_key = (data.get("apiKey") or os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return jsonify({"error": "Refine needs an API key (offline mode can't rewrite plans)."}), 400

    def messages_fn(_data):
        return [
            {"role": "system", "content": REFINE_SYSTEM_PROMPT},
            {"role": "user", "content": (
                f"Original idea:\n{idea}\n\nCurrent plan:\n{plan_markdown}\n\n"
                f"Change request:\n{instruction}\n\nReturn the full revised plan as Markdown only."
            )},
        ]

    return _stream_markdown_response(messages_fn, idea)


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5001)), debug=True)
