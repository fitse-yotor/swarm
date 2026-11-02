# M2 Swarm — Lattice

Case intelligence, knowledge graph and multi-agent simulation platform. Specs live in `Documntation/srs/`;
the original UI/UX prototype is `Documntation/ui:ux/case-intelligence-platform.html`.

```
swarm/
  backend/     FastAPI + Celery · PostgreSQL/pgvector · Neo4j · Docling · spaCy · fastembed · Ollama (local LLM)
  frontend/    React + TypeScript (Vite) · Sigma.js + Graphology · React Flow
  docker-compose.yml   postgres (pgvector), neo4j, redis, api, worker
```

**Every model runs locally. No hosted AI API is called.**

| Job | Local component |
|---|---|
| Entity & relation extraction | spaCy `en_core_web_sm` (NER + dependency parsing) by default; `EXTRACTION_PROVIDER=ollama` uses the LLM instead (better relations, minutes per chunk on CPU) |
| Embeddings | fastembed `BAAI/bge-small-en-v1.5` (ONNX) into pgvector |
| GraphRAG answers, agent personas, simulated posts, report narrative, chat | Ollama, `gemma4` by default (`OLLAMA_MODEL`) |

If Ollama is not running, every LLM feature degrades to a labelled fallback: retrieval-only answers, template personas and posts,
templated report narrative, and chat answers assembled from stored data.

## The five stages (all built)

| Stage | What it does | Main page |
|---|---|---|
| 1. Graph build | Upload → parse (Docling/pypdf) → chunk → embed → extract → resolve → verify quotes → Neo4j version → communities → review → approve | `/cases/:id/graph` |
| 2. Environment setup | Graph actors become agents. Each has a persona, a stance toward a focus issue, activity, influence and interests, plus a social network. Edited in a **React Flow** canvas. | `/cases/:id/environments/:envId` |
| 3. Simulation | Built-in agent-based engine `lattice-abm/1`, run as a Celery job. Two simulated platforms (microblog + forum), an OASIS-style action space (post, comment, repost, like, dislike, follow) and bounded-confidence opinion dynamics. Seeded and reproducible. The most influential agents' posts are written by the local LLM. | `/cases/:id/simulations/:simId` |
| 4. Reports | Findings computed from the run (stance, polarization, coalitions, movers, top posts) plus GraphRAG source evidence. The LLM writes only the summary, interpretation and watch points. Each section is tagged *computed*, *generated*, *evidence* or *edited*. Edit, approve, export Markdown. | `/cases/:id/reports/:repId` |
| 5. Deep interaction | Streaming chat with the report agent (cites `[§section]` and `[S#]`), with any simulated agent in character (grounded in its persona, graph facts and own posts), or with the graph (GraphRAG). | `/cases/:id/interaction/:convId` |

Every job (graph build, environment, simulation, report) has the same machinery: progress, stage, logs, cancel and retry, through `ProcessingJob` and `services/jobrunner.py`.

**About the simulation engine.** `lattice-abm/1` is a self-contained engine written for this project, not MiroFish or OASIS. It follows the same ideas (agents from a knowledge graph, dual platforms, an action space, LLM-written content), but opinion change comes from a stated bounded-confidence model rather than from LLM agents reasoning each turn. That keeps runs fast and reproducible on a CPU. A full OASIS adapter could replace `simulation.Engine` behind the same job and API.

## The UI

The original Lattice interface from the UI/UX prototype:
- **Left sidebar:** Workspace, Stage 1 · Graph, and Stages 2–5 (Environments, Simulations, Reports, Conversations).
- **Top bar:** breadcrumbs with a case switcher.
- **Graph explorer:** filters on the left, a Sigma.js canvas with shaped nodes, and an inspector on the right.
- **Stage 2–5 pages:** a canvas or feed beside numbered step cards and a system log. They have a Graph/Split/Workbench toggle and a 1–5 step indicator.
- Dark and light themes.

## Research cases (`cases/`)

| File | What it is |
|---|---|
| `ETH_Sea_Access_Case_Study.md` | Case ETH-SEA-001 (Ethiopia's quest for sea access) with 20 synthetic personas |
| `create_eth_sea_case.py` | Builds ETH-SEA-001 in a running instance: documented sources → graph; personas → environment |
| `ETH-TIG-001_Tigray_War_and_Aftermath.pdf` | Research-backed test case: Tigray war 2020-2022 and the post-Pretoria period, 15 synthetic personas |
| `ETH-SEC-002_Ethiopia_Military_Capability_and_Regional_Alignments.pdf` | Test case: Ethiopia's capabilities and alignments with Eritrea, Somalia, Egypt, Türkiye, Saudi Arabia, UAE, Israel |
| `build_case_pdfs.py` | Regenerates the two PDFs (`backend/.venv/bin/python cases/build_case_pdfs.py`) |
| `create_simulations.py` | Creates the TIG and SEC cases from their PDFs and four scenario environments per case (all three cases), then runs every scenario and generates its report |

**Synthetic personas and real actors.** Environments default to *real actors are context-only*: people, parties and governments
from the graph shape the scenario but never get posts or chat replies written in their name. Populate a run by importing
synthetic personas (Environment → *Import synthetic personas*), pasting lines such as
`SIM01 — label (country; viewpoint) [stance +0.6]: "comment" [simulation topic T01]`. Every imported agent carries a permanent
SYNTHETIC label in the network, feed, report and chat.

**Scenario push.** Each environment's scenario carries a direction toward the focus issue (`scenario_shock`, −1…+1). When it
is injected, every posting agent hears it: open agents shift with it, committed opponents entrench. Comparing the four scenario
runs of a case shows how the same population reacts to favourable versus unfavourable news. Simulated outcomes are not forecasts.

**Case builder.** *Create case* opens the console: drop reality seeds, write the simulation requirement, *Start Building*. The
build page shows the knowledge graph assembling live in 3D (Three.js via `3d-force-graph`, bundled locally, no CDN), then
hands over to the final graph.

## Simulation engines

| Engine | What decides and writes each action | Speed |
|---|---|---|
| **Rules + templates** (default) | Seeded rules pick who acts and what; stance moves by a bounded-confidence formula; text comes from templates, with a few posts per round written by the local model | seconds |
| **AI agents** | The local model (`OLLAMA_AGENT_MODEL`, default `OLLAMA_MODEL`) decides and writes every action. Each acting agent is given the Ethiopia / Horn of Africa briefing (`backend/app/knowledge/ethiopia_geopolitics.md` plus per-environment notes), its persona and graph facts, the case-document passages most relevant to its feed (pgvector), the breaking news and its feed, and returns an action, text, new stance (max 0.35 per turn) and a one-sentence reason shown in the feed | ~45-90 s per turn on CPU |

Choose the engine in *Start simulation*. In AI mode the rules only decide who gets a turn each round (agents that have not acted yet get priority); a failed model call skips the turn rather than faking it. Edit the briefing file to change what every agent knows, or add case-specific facts under *Extra background for AI agents* in the environment config. A smaller model (e.g. set `OLLAMA_AGENT_MODEL`) makes AI runs several times faster.

## Graph and simulation interaction

- **Sidebar:** icons only (hover for a description). Case icons (graph, review, documents, stages 2-5) appear only while a case is open; create a case from the Dashboard or Cases page.
- **Graph explorer:** a full-width canvas with a right-hand icon rail (Inspector, Filters, Sources, View options). Click an icon to open its panel; click a source to drill into the entities it supports. Toggle **2D / 3D**. Clicking a node isolates it: only that node and its direct connections stay, until you click another node or press *show all*.
- **Reaction graphs** (simulation page, *Reaction graph · 3D*): the whole run (who reacted to whom), one persona (what it posted and who reacted), or one post's cascade (comments, reposts, likes, replies to replies).
- **Trigger a persona** (simulation card *Trigger a persona*): make a synthetic persona post, comment, repost, like or dislike inside a finished run, optionally letting the others react (rule-based by stance closeness). Events are labelled `analyst-trigger` / `reaction-model`.
- **Reports** list every persona's actions (posts, comments, reposts, likes) and the reactions under the most-engaged posts.

## Run it locally

```bash
# 0. Local LLM (optional but recommended)
ollama serve & ollama pull gemma4

# 1. Infrastructure (set PG_PORT if 5432 is taken; match it in backend/.env DATABASE_URL)
docker compose up -d postgres neo4j redis

# 2. Backend (Python 3.12)
cd backend
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e '.[dev]'   # add ,docling on Linux / Apple Silicon
.venv/bin/python -m spacy download en_core_web_sm
cp .env.example .env
.venv/bin/python -m app.seed    # schema + demo users + 2 fictional cases, builds their graphs (--reset to start over)
.venv/bin/uvicorn app.main:app --port 8000
.venv/bin/celery -A app.workers.celery_app worker --pool=solo    # or CELERY_EAGER=true to run jobs inside the API

# 3. Frontend
cd ../frontend && npm install && npm run dev     # http://localhost:5173 (proxies /api to :8000)
```

Sign in with any demo account (password `demo1234`): `analyst@lattice.demo` (Lead analyst), `reviewer@lattice.demo`,
`lena@lattice.demo` (Analyst), `viewer@lattice.demo`, `admin@lattice.demo`. API docs: http://localhost:8000/docs.
`GET /api/v1/system/status` reports which local models are active.

In containers: `docker compose up --build`. The API and worker reach Ollama on the host via `host.docker.internal`.

## Tests
```bash
cd backend && EMBEDDING_PROVIDER=hash .venv/bin/python -m pytest      # parsing, chunking, quotes, resolution, uploads, spaCy relations, simulation determinism, GraphRAG citation checks
cd frontend && npm run typecheck && npm run build
```

## Known limitations / next steps
- **CPU-only LLM speed:** on an Intel CPU, `gemma4` writes about 6 tokens/s. A persona or post takes 15–40 s, and a report narrative or chat reply 20–120 s. Keep `llm_personas` and `llm_posts_per_round` small, or use a smaller model (`OLLAMA_MODEL`).
- **spaCy extraction** finds typed relations only where the grammar is explicit (subject–verb–object, "X of Y", "X, chair of Y"). Other entity pairs in a sentence get a low-confidence `CO_OCCURS_WITH` edge for review. Agents' stances therefore often start neutral unless the graph has SUPPORTS/OPPOSES edges or an LLM persona assigns one.
- **Docling on Intel Macs:** torch has no current macOS x86_64 wheels, so PDFs fall back to pypdf with a warning. Use the worker container (Linux) for Docling.
- No Alembic migrations yet: new tables are created at API start (`create_all`); column changes need a migration before any shared database.
- Original files live on local disk (`STORAGE_DIR`); swap `services/storage.py` for S3/MinIO in deployment.
- No malware scanning, OCR, SSO/MFA or undo. Job progress is polled, not pushed (SSE/WebSocket would be the next step).
