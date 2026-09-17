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


# Reference-docs ingestion (Obsidian vault / notes folder / uploads).
# Two supply routes, often combined:
# 1. Uploaded files — browser reads .md/.txt and sends [{name, content}].
# 2. Server-local folder — UI sends docsPath, server scans + reads it
#    (works because the app runs locally via `make dev`).
DOCS_ALLOWED_EXTS = {".md", ".markdown", ".txt"}
DOCS_SKIP_DIRS = {".git", ".obsidian", ".trash", "node_modules", "__pycache__", ".venv", "venv", ".DS_Store"}


def _env_int(name: str, default: int) -> int:
    try:
        raw = os.environ.get(name)
        return int(str(raw).strip()) if raw and str(raw).strip() else default
    except (TypeError, ValueError):
        return default


# Reference-docs budgets. Defaults are sized for modern 128k+ context models
# (~4 chars/token): 400k chars ≈ 100k tokens, leaving headroom for the system
# prompt + answer. Override with env vars; the total also auto-scales with the
# requested model (see _docs_total_budget). Files on disk are *scanned* in
# batches up to DOCS_MAX_FILES — every file is considered for relevance, and
# only the most relevant slice that fits the budget is sent to the LLM.
DOCS_MAX_FILES = _env_int("DOCS_MAX_FILES", 5000)
DOCS_MAX_CHARS_PER_FILE = _env_int("DOCS_MAX_CHARS_PER_FILE", 20000)
DOCS_SCAN_BATCH = _env_int("DOCS_SCAN_BATCH", 500)
DOCS_ENV_TOTAL_CHARS = _env_int("DOCS_MAX_TOTAL_CHARS", 0)  # 0 = not set, use model default


def _docs_total_budget(model: str = "") -> int:
    """Context budget (chars) shared by uploads + vault for one request."""
    if DOCS_ENV_TOTAL_CHARS > 0:
        return DOCS_ENV_TOTAL_CHARS
    m = (model or "").lower()
    if any(k in m for k in ("2m", "1m", "1000k", "1.5m")):
        return 900000
    # Modern Gemini Flash/Pro models ship a 1M-token window but the model
    # id (e.g. gemini-3.8-flash) carries no explicit size hint.
    if "gemini" in m:
        return 900000
    if "200k" in m:
        return 600000
    if "128k" in m:
        return 400000
    if "64k" in m:
        return 200000
    if "32k" in m:
        return 100000
    if any(k in m for k in ("8k", "4k", "gpt-3", "3.5")):
        return 24000
    return 400000


_DOCS_STOPWORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "have", "has",
    "are", "was", "were", "will", "would", "could", "should", "about",
    "into", "your", "you", "our", "their", "they", "them", "then",
    "than", "also", "just", "like", "get", "got", "make", "made",
    "more", "most", "some", "such", "when", "what", "which", "who",
    "how", "why", "not", "but", "all", "any", "can", "its",
})


def _doc_tokens(text: str) -> set:
    words = re.findall(r"[a-z0-9]{3,}", (text or "").lower())
    return {w for w in words if w not in _DOCS_STOPWORDS}


def _relevance_score(query_tokens: set, rel_path: str, head: str) -> int:
    """Keyword-overlap score: filename matches weigh 3x (cheap, bounded)."""
    if not query_tokens:
        return 0
    name_hit = len(query_tokens & _doc_tokens(rel_path.replace("/", " ").replace("-", " ")))
    head_hit = len(query_tokens & _doc_tokens(head))
    return 3 * name_hit + head_hit


def _is_allowed_doc(path: Path) -> bool:
    if path.suffix.lower() not in DOCS_ALLOWED_EXTS:
        return False
    return not any(part in DOCS_SKIP_DIRS for part in path.parts)


def read_docs_dir(dirpath: str, query: str = "", budget=None, per_file_cap=None, max_files=None) -> dict:
    """Scan a server-local folder for readable docs.

    Every matching file (up to max_files) is *considered*: files are read in
    batches, scored against `query`, and the most relevant slice fitting
    `budget` chars is returned as `combined`. A 5000-file vault works — the
    plan is grounded in the most relevant subset. `total_files` is how many
    files were found; `files` is the included subset.
    """
    base = Path(dirpath).expanduser()
    if not str(dirpath).strip():
        raise ValueError("No folder path given.")
    if not base.exists():
        raise ValueError(f"Folder not found: {dirpath}")
    if not base.is_dir():
        raise ValueError(f"Not a folder: {dirpath}")
    per_file = per_file_cap or DOCS_MAX_CHARS_PER_FILE
    total_budget = budget or _docs_total_budget("")
    cap_files = max_files or DOCS_MAX_FILES
    found = []
    for ext in ("*.md", "*.markdown", "*.txt"):
        found.extend(base.rglob(ext))
    found = sorted({p for p in found if p.is_file() and _is_allowed_doc(p)})
    total_found = len(found)
    capped = found[:cap_files]
    discovery_capped = total_found > len(capped)
    q_tokens = _doc_tokens(query) if query and query.strip() else set()
    candidates = []
    batch_size = max(1, DOCS_SCAN_BATCH)
    for i in range(0, len(capped), batch_size):
        for p in capped[i:i + batch_size]:
            try:
                text = p.read_text(encoding="utf-8", errors="replace").strip()
            except Exception:
                continue
            if not text:
                continue
            cut = False
            if len(text) > per_file:
                text = text[:per_file] + "\n[…truncated…]"
                cut = True
            rel = str(p.relative_to(base))
            score = _relevance_score(q_tokens, rel, text[:8000])
            candidates.append({"name": rel, "text": text, "score": score, "cut": cut})
    candidates.sort(key=lambda c: (-c["score"], c["name"]))
    files_out = []
    combined_parts = []
    total_chars = 0
    truncated = discovery_capped or any(c["cut"] for c in candidates)
    for c in candidates:
        if total_chars + len(c["text"]) > total_budget:
            remaining = total_budget - total_chars
            if remaining > 500:
                combined_parts.append(f"--- {c['name']} ---\n{c['text'][:remaining]}\n[…vault truncated at budget…]")
                files_out.append({"name": c["name"], "chars": len(c["text"]), "score": c["score"]})
            truncated = True
            total_chars = total_budget
            break
        combined_parts.append(f"--- {c['name']} ---\n{c['text']}")
        files_out.append({"name": c["name"], "chars": len(c["text"]), "score": c["score"]})
        total_chars += len(c["text"])
    if len(candidates) > len(files_out):
        truncated = True
    batches = (len(capped) + batch_size - 1) // batch_size if capped else 0
    return {
        "path": str(base.resolve()),
        "files": files_out,
        "total_files": total_found,
        "total_chars": total_chars,
        "truncated": truncated,
        "combined": "\n\n".join(combined_parts),
        "batches": batches,
        "budget": total_budget,
        "query_ranked": bool(q_tokens),
    }


def normalize_uploaded_docs(docs, budget=None, per_file_cap=None, max_files=None) -> list:
    """Validate + cap client-uploaded [{name, content}] payloads."""
    total_budget = budget or _docs_total_budget("")
    per_file = per_file_cap or DOCS_MAX_CHARS_PER_FILE
    cap_files = max_files or DOCS_MAX_FILES
    clean = []
    total = 0
    for d in (docs or [])[:cap_files]:
        if not isinstance(d, dict):
            continue
        name = str(d.get("name") or "untitled.md")[:120]
        content = str(d.get("content") or "").strip()
        if not content:
            continue
        if len(content) > per_file:
            content = content[:per_file] + "\n[…truncated…]"
        if total + len(content) > total_budget:
            remaining = total_budget - total
            if remaining > 500:
                clean.append({"name": name, "content": content[:remaining] + "\n[…truncated at budget…]"})
            break
        clean.append({"name": name, "content": content})
        total += len(content)
    return clean


def get_docs_context(data: dict) -> tuple:
    """Return (context_block, sources, vault_error) from uploads and/or a server folder.

    Uploads and vault share one model-sized budget; explicit uploads win.
    """
    model = ""
    idea_q = ""
    instr_q = ""
    if isinstance(data, dict):
        model = str(data.get("model") or "")
        idea_q = str(data.get("idea") or "")
        instr_q = str(data.get("instruction") or "")
    budget = _docs_total_budget(model)
    query = f"{idea_q}\n{instr_q}".strip()
    uploaded = normalize_uploaded_docs(data.get("docs") if isinstance(data, dict) else None, budget=budget)
    used = sum(len(d["content"]) for d in uploaded)
    docs_path = (data.get("docsPath") or data.get("docs_path") or "").strip() if isinstance(data, dict) else ""
    vault = None
    vault_error = None
    vault_skipped = False
    if docs_path:
        remaining = max(0, budget - used)
        if remaining < 500 and uploaded:
            vault_skipped = True
        else:
            try:
                vault = read_docs_dir(docs_path, query=query, budget=remaining)
            except Exception as e:
                vault_error = str(e)
    parts = []
    sources = []
    for d in uploaded:
        parts.append(f"--- {d['name']} (uploaded) ---\n{d['content']}")
        sources.append(d["name"])
    if vault and vault["combined"]:
        parts.append(f"--- vault: {vault['path']} ---\n{vault['combined']}")
        sources.extend(f["name"] for f in vault["files"])
    if vault_skipped:
        parts.append(f"[vault '{docs_path}' skipped: uploaded docs already fill the ~{budget // 1000}k char context budget]")
    if vault_error:
        parts.append(f"[vault read failed for '{docs_path}': {vault_error}]")
    context = "\n\n".join(parts).strip()
    return context, sources, vault_error


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


DOCS_SYSTEM_EXTRA = """
Reference docs: the user attached their own notes (vault / uploaded files).
Treat them as the primary source of truth — ground the plan in their details,
prefer their terminology, and never invent facts that contradict them.
When a phase or step draws directly from a doc, you may name the file
(e.g. "per garden-notes.md"). Be specific to THESE docs, no generic filler.
"""

DOCS_EXTRACT_EXTRA = """
No idea dump was given — extract mode: scan the reference docs, surface the
2-3 most promising executable ideas lurking in them, pick the single best one
(concrete, scoped, high-leverage), and build the whole plan for it.
Make the Goal reflect the extracted idea, not a generic summary.
"""

DOCS_REFINE_EXTRA = """
Reference docs are attached below. Keep the revision consistent with them and
use them to resolve ambiguities instead of guessing.
"""


def build_generate_messages(idea: str, docs_context: str, stream: bool) -> list:
    """Build LLM messages for generate, with or without reference docs."""
    if stream:
        system = STREAM_SYSTEM_PROMPT
    else:
        system = SYSTEM_PROMPT
    user = f"Idea dump:\n{idea}" if idea.strip() else "(no idea dump — see reference docs)"
    if docs_context:
        system += DOCS_SYSTEM_EXTRA
        if not idea.strip():
            system += DOCS_EXTRACT_EXTRA
            user += ("\n\nTask: extract the best executable idea from the reference docs "
                     "below and plan it.\n")
        else:
            user += ("\n\nUse the reference docs below as background knowledge. "
                     "If the idea dump is vague, let the docs disambiguate it.\n")
        user += f"\nReference docs:\n{docs_context}"
    else:
        user = f"Idea dump:\n{idea}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def build_refine_messages(idea: str, plan_markdown: str, instruction: str, docs_context: str) -> list:
    system = REFINE_SYSTEM_PROMPT
    user = (f"Original idea:\n{idea}\n\nCurrent plan:\n{plan_markdown}\n\n"
            f"Change request:\n{instruction}\n\nReturn the full revised plan as Markdown only.")
    if docs_context:
        system += DOCS_REFINE_EXTRA
        user += f"\n\nReference docs:\n{docs_context}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def call_llm(idea: str, api_key: str, base_url: str, model: str, docs_context: str = "") -> dict:
    url = base_url.rstrip("/") + "/chat/completions"
    messages = build_generate_messages(idea, docs_context or "", stream=False)
    payload = {
        "model": model,
        "messages": messages,
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


# Streaming safety bounds. Some providers / relays never send [DONE] and never
# close the connection (keep-alive pings, wedged gateways, missing terminator
# after the last token) — the old code then streamed forever (seen at 293s+
# with a complete-looking plan already on screen, since content had arrived
# but the terminator never did). So the streamer enforces:
# - terminal-frame detection (finish_reason / done flags, not just [DONE])
# - an idle timeout (no content for a while -> raise, caller finishes partial)
# - a hard wall-clock deadline + a max-chars cap against runaway generation
STREAM_SOCKET_TIMEOUT = 15
STREAM_IDLE_TIMEOUT = 45
STREAM_HARD_DEADLINE = 170
STREAM_MAX_CHARS = 20000


class StreamStalled(TimeoutError):
    """Raised when a streaming response stalls or exceeds its deadline."""


def _extract_stream_delta(obj: dict) -> tuple:
    """Return (text, is_done) from one parsed SSE data frame.

    Handles provider variants: delta.content, message.content (some servers
    emit non-stream shapes on a stream), text, plus terminal signals via
    finish_reason or done flags (Ollama, vLLM, various gateways) — not just
    the literal [DONE] sentinel.
    """
    if not isinstance(obj, dict):
        return "", False
    choices = obj.get("choices") or []
    if not isinstance(choices, list) or not choices:
        # No choices: Ollama-style frames carry content at the top level
        # ({"message": {"content": ...}} or {"response": ...}); terminal only
        # if the provider says done explicitly.
        text = ""
        msg = obj.get("message")
        if isinstance(msg, dict):
            text = msg.get("content") or ""
        if not text:
            text = obj.get("response") or ""
        if not isinstance(text, str):
            text = ""
        return text, obj.get("done") is True
    choice = choices[0] or {}
    if not isinstance(choice, dict):
        return "", False
    text = ""
    delta = choice.get("delta")
    if isinstance(delta, dict):
        text = delta.get("content") or ""
    if not text:
        msg = choice.get("message")
        if isinstance(msg, dict):
            text = msg.get("content") or ""
    if not text:
        text = choice.get("text") or ""
    if not isinstance(text, str):
        text = ""
    done = bool(choice.get("finish_reason")) or choice.get("done") is True or obj.get("done") is True
    return text, done


def iter_llm_markdown_stream(messages: list, api_key: str, base_url: str, model: str, timeout: int = STREAM_SOCKET_TIMEOUT,
                             idle_timeout: int = STREAM_IDLE_TIMEOUT, deadline: int = STREAM_HARD_DEADLINE,
                             max_chars: int = STREAM_MAX_CHARS):
    """Yield text deltas from an OpenAI-compatible streaming chat completion.

    Raises StreamStalled instead of hanging forever when the provider stops
    sending content but keeps the connection alive.
    """
    import time

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
    start = time.monotonic()
    last_delta_at = start
    # Wake up regularly so stall/deadline checks run even when the server
    # trickles keep-alives slower than any single generous read timeout.
    sock_timeout = max(1, min(timeout, STREAM_SOCKET_TIMEOUT))
    with urllib.request.urlopen(req, timeout=sock_timeout) as resp:
        buf = b""
        chars = 0
        while True:
            if time.monotonic() - start > deadline:
                raise StreamStalled(f"stream exceeded {deadline}s deadline")
            # Checked every loop turn — including turns that only yield SSE
            # comments (: ping), blank lines, or content-less frames — so a
            # steady drip of nothing-content can never hold the stream open.
            if time.monotonic() - last_delta_at > idle_timeout:
                raise StreamStalled(f"no content for {idle_timeout}s — stream stalled")
            try:
                # Small reads = lower time-to-first-token. read() returns up to
                # n bytes as soon as any arrive, so 256 surfaces deltas faster
                # than waiting to fill a 1-4KB buffer.
                chunk = resp.read(256)
            except TimeoutError:
                # Silent socket (no bytes at all): only fatal when no *content*
                # arrived recently — keep-alives alone must not extend a stall.
                if time.monotonic() - last_delta_at > idle_timeout:
                    raise StreamStalled(f"no content for {idle_timeout}s — stream stalled")
                continue
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue  # SSE comments (: ping), event: lines, blanks
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                text, is_done = _extract_stream_delta(obj)
                if text:
                    chars += len(text)
                    last_delta_at = time.monotonic()
                    yield text
                    if chars >= max_chars:
                        return
                if is_done:
                    return


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


@app.post("/api/docs/scan")
def scan_docs():
    """Scan a server-local folder (e.g. Obsidian vault) for readable docs.

    Accepts optional `query` (or `idea`) + `model` so the relevance ranking
    and context budget match the upcoming generate call. `total_files` is all
    files found; `files` is the subset that fits the budget.
    """
    data = request.get_json(force=True, silent=True) or {}
    path = (data.get("path") or data.get("docsPath") or "").strip()
    if not path:
        return jsonify({"error": "Give a folder path to scan."}), 400
    query = (data.get("query") or data.get("idea") or "").strip()
    model = (data.get("model") or "").strip()
    try:
        result = read_docs_dir(path, query=query, budget=_docs_total_budget(model))
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({
        "path": result["path"],
        "files": result["files"],
        "total_files": result["total_files"],
        "total_chars": result["total_chars"],
        "truncated": result["truncated"],
        "batches": result["batches"],
        "budget": result["budget"],
        "query_ranked": result["query_ranked"],
    })


@app.post("/api/generate")
def generate():
    data = request.get_json(force=True)
    idea = (data.get("idea") or "").strip()
    docs_context, docs_sources, vault_error = get_docs_context(data)
    if len(idea) < 5 and not docs_context:
        return jsonify({"error": "Idea is too short — dump a bit more detail, or attach reference docs."}), 400
    api_key, base_url, model = _resolve_llm(data)

    source = "local"
    try:
        if api_key:
            plan_json = call_llm(idea, api_key, base_url, model, docs_context)
            source = "llm"
        else:
            plan_json = local_fallback_plan(idea or "Extract best idea from reference docs")
    except Exception as e:
        # Graceful fallback: still return a usable plan
        plan_json = local_fallback_plan(idea or "Extract best idea from reference docs")
        return jsonify({
            "plan": plan_json,
            "markdown": json_to_markdown(plan_json),
            "source": "local",
            "docs_sources": docs_sources,
            "warning": f"LLM call failed, used offline plan instead: {e}",
        })
    out: dict = {"plan": plan_json, "markdown": json_to_markdown(plan_json), "source": source}
    if docs_sources:
        out["docs_sources"] = docs_sources
        out["docs_count"] = len(docs_sources)
    if vault_error:
        out["warning"] = f"Reference folder could not be read ({vault_error}) — plan used the idea dump only."
    return jsonify(out)


GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
GEMINI_DEFAULT_MODEL = "gemini-3.8-flash"


def _env_first(*names: str) -> str:
    for n in names:
        v = (os.environ.get(n) or "").strip()
        if v:
            return v
    return ""


def _resolve_llm(data: dict) -> tuple:
    """Resolve (api_key, base_url, model) from request + env.

    Accepts per-request apiKey/baseUrl/model (browser localStorage) with
    server-side env fallbacks for both OpenAI and Gemini. Gemini works
    through its OpenAI-compatible endpoint, so no request-shape change is
    needed — just point baseUrl at generativelanguage + use a gemini-* model.
    """
    data = data or {}
    api_key = (str(data.get("apiKey") or "").strip()
               or _env_first("OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
                            "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"))
    base_url = (str(data.get("baseUrl") or "").strip()
                or _env_first("OPENAI_BASE_URL", "GEMINI_BASE_URL", "GEMINI_API_BASE", "LLM_BASE_URL"))
    model = (str(data.get("model") or "").strip()
             or _env_first("OPENAI_MODEL", "GEMINI_MODEL", "LLM_MODEL"))
    if not base_url:
        # Default endpoint follows the key that is actually configured:
        # a Gemini key alone should not default to api.openai.com.
        if _env_first("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY") and not _env_first("OPENAI_API_KEY"):
            base_url = GEMINI_BASE_URL
        else:
            base_url = "https://api.openai.com/v1"
    if not model:
        model = GEMINI_DEFAULT_MODEL if "generativelanguage.googleapis.com" in base_url else "gpt-4o-mini"
    return api_key.strip(), base_url.strip(), model.strip()


def _llm_config(data: dict):
    """Back-compat alias — all callers resolve via _resolve_llm."""
    return _resolve_llm(data)


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
            "warning": "Refine needs an API key — offline mode can't rewrite plans. Open ⚙️ LLM settings in the left sidebar and add a key.",
        })
    docs_context, docs_sources, _ = get_docs_context(data)
    messages = build_refine_messages(idea, plan_markdown, instruction, docs_context)
    try:
        markdown = call_llm_markdown(messages, api_key, base_url, model)
    except Exception as e:
        return jsonify({"error": f"LLM refine failed: {e}"}), 502
    goal = extract_goal_from_markdown(markdown, idea or "Refined plan")
    out: dict = {"markdown": markdown, "goal": goal, "source": "llm"}
    if docs_sources:
        out["docs_sources"] = docs_sources
    return jsonify(out)


def _stream_markdown_response(messages_fn, idea: str, chunk_delay: float = 0.0):
    """Shared SSE streamer. messages_fn(api_key, base_url, model) -> messages or None for offline."""
    import time

    data = request.get_json(force=True)
    idea_val = (data.get("idea") or idea or "").strip()
    api_key, base_url, model = _llm_config(data)
    docs_context, docs_sources, _ = get_docs_context(data)

    def gen():
        yield sse({"type": "status", "message": "Contacting AI…"})
        if not api_key:
            yield sse({"type": "status", "message": "No API key — building offline plan…"})
            md = json_to_markdown(local_fallback_plan(idea_val or "Extract best idea from reference docs"))
            # Chunk the offline plan so the UI still streams instead of popping in.
            for i in range(0, len(md), 200):
                yield sse({"type": "delta", "text": md[i:i + 200]})
                time.sleep(0.02)
            done_offline: dict = {"type": "done", "markdown": md,
                       "goal": extract_goal_from_markdown(md, idea_val or "Reference docs"),
                       "source": "local"}
            if docs_sources:
                done_offline["docs_sources"] = docs_sources
                done_offline["warning"] = (
                    "Offline mode — no API key, so this is a generic template plan. "
                    "Your docs were scanned locally but NOT mined by AI."
                )
            yield sse(done_offline)
            return
        messages = messages_fn(data)
        if docs_context:
            yield sse({"type": "status", "message": f"AI is reading {len(docs_sources)} doc(s) + drafting your plan — streaming…"})
        else:
            yield sse({"type": "status", "message": "AI is drafting your plan — streaming…"})
        full = []
        warning = None
        truncated = False
        try:
            for delta in iter_llm_markdown_stream(messages, api_key, base_url, model):
                full.append(delta)
                yield sse({"type": "delta", "text": delta})
        except Exception as e:
            # Stream broke mid-flight (stall, deadline, dropped connection).
            # If content already arrived, finish with the partial plan instead
            # of hanging or throwing it away — the UI marks it as partial.
            if "".join(full).strip():
                truncated = True
                if isinstance(e, StreamStalled):
                    warning = (f"{e} — kept what arrived so far. "
                               "Regenerate to retry, or keep this partial plan.")
                else:
                    warning = ("Connection dropped mid-stream — kept what arrived so far. "
                               "Regenerate to retry, or keep this partial plan.")
                yield sse({"type": "status", "message": "Finishing with what arrived…"})
            else:
                # Nothing arrived — fall back to one-shot call.
                yield sse({"type": "status", "message": "Live stream unavailable — fetching full plan…"})
                try:
                    full_text = call_llm_markdown(messages, api_key, base_url, model)
                except Exception as e2:
                    yield sse({"type": "error", "error": f"LLM call failed: {e2}"})
                    return
                yield sse({"type": "delta", "text": full_text})
                full = [full_text]
        markdown = "".join(full).strip()
        if not markdown:
            yield sse({"type": "error", "error": "Empty response from AI."})
            return
        done_payload: dict = {"type": "done", "markdown": markdown,
                        "goal": extract_goal_from_markdown(markdown, idea_val or "Reference docs"),
                        "source": "llm"}
        if docs_sources:
            done_payload["docs_sources"] = docs_sources
        if warning:
            done_payload["warning"] = warning
        if truncated:
            done_payload["truncated"] = True
        yield sse(done_payload)

    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                             "Connection": "keep-alive"})


@app.post("/api/generate/stream")
def generate_stream():
    data = request.get_json(force=True, silent=True) or {}
    idea = (data.get("idea") or "").strip()
    docs_context, _, _ = get_docs_context(data)
    if len(idea) < 5 and not docs_context:
        return jsonify({"error": "Idea is too short — dump a bit more detail, or attach reference docs."}), 400

    def messages_fn(_data):
        ctx, _, _ = get_docs_context(_data)
        return build_generate_messages(idea, ctx, stream=True)

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
        return jsonify({"error": "Refine needs an API key (offline mode can't rewrite plans). Open ⚙️ LLM settings in the left sidebar and add a key."}), 400

    def messages_fn(_data):
        ctx, _, _ = get_docs_context(_data)
        return build_refine_messages(idea, plan_markdown, instruction, ctx)

    return _stream_markdown_response(messages_fn, idea)


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5001)), debug=True)
