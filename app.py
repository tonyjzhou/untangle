"""Idea-to-plan web app: dump an idea, get concrete steps, save as Markdown."""
import json
import os
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

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
- Break into 3-5 phases/milestones, each with concrete steps (not vague advice).
- Each step must be small enough to do in one sitting (<=2h). Start each step with a verb.
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


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5001)), debug=True)
