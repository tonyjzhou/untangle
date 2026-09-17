# untangle

Dump a messy idea, get a concrete plan.

`untangle` turns a raw braindump into a phased, checkable plan — 7–15 steps small enough to do in one sitting (≤2h), each tagged with effort (`S/M/L`) and priority (`P1/P2/P3`), plus success criteria, risks, and next 3 actions. Plans are saved as Markdown and editable with live preview.

## How it works

1. Paste your idea dump into the textarea
2. Click **Generate concrete steps**
3. Edit the Markdown, toggle checkboxes, Save

Two generation modes:
- **AI mode** — provide any OpenAI-compatible API key + base URL + model (key stays in browser `localStorage`, or set `OPENAI_API_KEY` env var server-side)
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

- `OPENAI_API_KEY` — server-side default key
- `OPENAI_BASE_URL` — default `https://api.openai.com/v1`
- `OPENAI_MODEL` — default `gpt-4o-mini`
- `PORT` — default `5001`

Or per-request from the UI sidebar (⚙️ LLM settings) — stored only in your browser.

## API

- `POST /api/generate` `{idea, apiKey?, baseUrl?, model?}` → `{plan, markdown, source}`
- `GET /api/plans` → list `{id, title, created, updated}`
- `POST /api/plans` `{title, raw_idea, plan_markdown}` → saved plan
- `GET /api/plans/<id>` → `{id, title, raw_idea, plan_markdown, ...}`
- `PUT /api/plans/<id>` → update
- `DELETE /api/plans/<id>` → delete

Plans are stored as Markdown files in `plans/` with frontmatter (`title`, `created`, `updated`).

## Stack

Flask + vanilla JS, no build step. Single dependency: `flask`.
