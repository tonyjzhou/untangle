# untangle

Dump a messy idea, get a concrete plan.

`untangle` turns a raw braindump into a phased, checkable plan — 7–15 steps small enough to do in one sitting (≤2h), each tagged with effort (`S/M/L`) and priority (`P1/P2/P3`), plus success criteria, risks, and next 3 actions. Plans are saved as Markdown and editable with live preview.

## How it works

1. Paste your idea dump into the textarea (or leave it empty if your notes hold the idea)
2. Optionally attach reference docs: 📎 upload `.md` / `.txt` files, or enter a local folder path (e.g. an Obsidian vault) and hit **Scan**
3. Click **Generate concrete steps**
4. Edit the Markdown, toggle checkboxes, Save

With reference docs attached, the AI grounds the plan in your notes — preferring their details and terminology. With an empty idea + docs, it switches to extract mode: it surfaces the best executable idea lurking in your docs and plans that.

Two generation modes:
- **AI mode** — paste a Gemini API key + pick a `gemini-*` model (key stays in browser `localStorage`, or set `GEMINI_API_KEY` env var server-side)
- **Offline mode** — no key needed, uses a built-in rule-based template so the app works out of the box

## Quickstart

```bash
make dev
# open http://localhost:5001
```

Manual:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PORT=5001 .venv/bin/python app.py
```

Env vars (optional):

- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — server-side default key
- `GEMINI_MODEL` — default `gemini-3.8-flash`
- `PORT` — default `5001`

Or per-request from the UI sidebar (⚙️ LLM settings) — stored only in your browser.

### Get a Gemini key

1. Go to Google AI Studio (`aistudio.google.com`) → **Get API key**.
2. Paste the `AIza...` key into ⚙️ **LLM settings** → Generate.
   The key stays in `localStorage`; server-side you can instead set
   `GEMINI_API_KEY` in `.env`.

Gemini is called through its OpenAI-compatible `/chat/completions` endpoint
(including streaming) — the app also sizes the reference-docs budget to
Gemini's 1M-token window (~900k chars).

## API

- `POST /api/generate` `{idea, docs?, docsPath?, apiKey?, baseUrl?, model?}` → `{plan, markdown, source, docs_sources?}`
- `POST /api/generate/stream` (SSE) same input → `status` / `delta` / `done` events, plan streams in live so Regenerate never sits silent
- `POST /api/refine` `{idea, plan_markdown, instruction, docs?, docsPath?, apiKey?, baseUrl?, model?}` → `{markdown, goal, source}` (needs API key)
- `POST /api/refine/stream` (SSE) same input → live-refines the plan from a follow-up prompt
- `POST /api/docs/scan` `{path, query?, model?}` → `{path, files: [{name, chars, score}], total_files, total_chars, truncated, batches, budget, query_ranked}` (scans a server-local folder for `.md` / `.markdown` / `.txt`, skips `.git`, `.obsidian`, `node_modules`, etc.; scans up to 5000 files in batches and grounds the plan in the most relevant slice within a model-sized context budget, default ~400k chars, larger for 200k/1M models)
- `GET /api/plans` → list `{id, title, created, updated}`
- `POST /api/plans` `{title, raw_idea, plan_markdown}` → saved plan
- `GET /api/plans/<id>` → `{id, title, raw_idea, plan_markdown, ...}`
- `PUT /api/plans/<id>` → update
- `DELETE /api/plans/<id>` → delete

Plans are stored as Markdown files in `plans/` with frontmatter (`title`, `created`, `updated`).

## Stack

Flask + vanilla JS, no build step. Single dependency: `flask`.
