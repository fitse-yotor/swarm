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

## Reactions, one evolving graph, snapshots and a timeline

Four kinds of content are kept apart, and every graph item says which it is (`layer` + `provenance`):

| Layer | Provenance | What it is |
|---|---|---|
| research | `sourced` | Approved entities and relationships with their source passages. Only approved items ever appear. |
| reaction | `generated_hypothesis` | Possible actor responses generated from the approved graph. Never a verified statement. |
| simulation | `simulation_generated` | Synthetic agents, their simulated relationships and statements. |
| snapshot | n/a | An immutable copy of all three layers at a moment (SHA-256 `content_hash`, verified on read). |

**Automatic reactions** (`services/reaction_gen.py`). Approving a graph version creates a snapshot and starts a reaction run in the
background. Actors are chosen from the approved graph by structure (relationships, closeness to the case issue, evidence, match with
the case question), not one per node. Each reaction stores the actor, trigger, connected entities, evidence ids, reasoning,
confidence, assumptions labelled `evidence_supported` / `model_inferred` / `synthetic`, warnings, and the provider and template
version that produced it. Output is validated against a typed schema and against the actor's own context (unknown ids dropped, a
quotation must appear in the linked evidence). Re-running creates a new run; earlier runs and the analyst's review status are kept.
With no language model configured the generator is a rule set that reads relationship types. It is stored as mode `demo-rules`
and labelled **demo output, not AI analysis** everywhere. Reviewing: `generated → reviewed → selected | excluded`, edits are recorded.
Selected reactions are attached to their agents as `hypotheses` when an environment is built (never as `facts`).

**One evolving graph** (`services/dynamic_graph.py`). The simulation layer is a pure fold over append-only `graph_events`
(`STATEMENT_PUBLISHED`, `RESPONDED_TO`, `REACTED_TO_EVENT`, `POSITION_CHANGED`, `RELATIONSHIP_FORMED/STRENGTHENED/WEAKENED`,
`ALLIANCE_FORMED`), each with run, step, actors, affected node/edge ids, before/after values, the triggering simulation action and
the dynamic graph version it created. The "current graph" is a projection (approved research + reactions + the fold), a snapshot is
the same projection frozen, and a simulation has no code path that writes to the research layer. A retried run opens a new
`attempt`; the old attempt's events and snapshots stay as history. Snapshots are taken when a graph is approved, after reactions
are generated, at simulation start, every `snapshot_every` rounds (environment config, default 6), at completion, and on demand.

**Simulation boundary.** The built-in engine reports through `Recorder` (`dynamic_graph.py`); an external engine (for example an
OASIS adapter) posts typed events to `POST /simulations/{id}/graph-events`, which validates them against the run's agents and
applies them all-or-nothing. Nothing in the graph UI knows how a simulation runs. No external engine is bundled.

| Endpoint | Purpose |
|---|---|
| `POST /cases/{id}/reaction-runs` · `GET …/reaction-runs` · `GET /reaction-runs/{id}` | Generate (new run each time), list, check progress |
| `GET /cases/{id}/reactions` (filters, `limit`/`offset`) · `GET /reactions/{id}` | Browse; one reaction with its evidence and basis |
| `PATCH /reactions/{id}` · `POST /cases/{id}/reactions/bulk` | Edit, review, select, exclude |
| `GET /cases/{id}/dynamic-graph` (`snapshot_id`, `upto_seq`, `simulation_id`, `layers`, `statements`) | The live graph, or the graph at a snapshot or event |
| `GET /cases/{id}/graph-entity/{node}` | Reactions and simulation events for one entity |
| `GET/POST /cases/{id}/snapshots` · `GET /snapshots/{id}` · `GET …/snapshots/compare?a=&b=live` | Snapshots (append-only) and per-layer diff |
| `GET /cases/{id}/timeline` · `GET /simulations/{id}/graph-events` · `POST …/graph-events` · `GET /graph-events/{id}` | Timeline, events, ingestion |

UI: **Reactions** (`/cases/:id/reactions`) and **Dynamic graph** (`/cases/:id/dynamic`) in the sidebar. New tables (`reaction_runs`,
`reactions`, `graph_events`, `graph_snapshots`) are created at API start like the rest of the schema; there are no Alembic migrations yet.

## Agent behaviour and reactions

(Behaviour profiles and triggered replies for simulated agents; not the same as the generated reaction hypotheses above.)

Every agent has a **behaviour profile** (Environment → click an agent → *Behaviour*): a preset (Balanced, Broadcaster, Commenter,
Debater, Amplifier, Lurker) plus sliders for how much it posts, comments, reposts, likes, dislikes and follows, how often it
answers a comment on its own post, and *how* it answers (replies to anyone / rebuts disagreement and nods at agreement / likes
agreement and rarely answers disagreement / never answers). Defaults come from the agent's kind and stance (institutions and
governments broadcast; strongly opinionated people debate). The simulation engine uses these instead of one global action table,
and an agent that has been commented on answers first, as its profile decides (`behavior.py`).

**Trigger a persona** (simulation page): pick a post, make a persona comment on it, and the *post's author* decides what to do
(reply, like, or let it pass) from its own profile and the stance gap to the commenter. The other personas then react from their
profiles. Every decision comes back with its reason, e.g. "Debater, answers 100% of comments: disagrees and rebuts (stance gap
1.63 ≥ ε 0.6)". Triggered rows are labelled `analyst-trigger` / `reaction-model`.

**Reaction graph → On the graph** draws the original actor network (agents and their ally / opponent relations from the knowledge
graph) with posts, comments, reposts and likes on top. Focus on the most engaged threads, one thread, or one persona. *Camp*
colours by final stance and *Cluster* pulls supporters, neutrals and opponents into separate groups. The graph build page has the
same *Cluster* control (by entity type while building, by detected community once finished).

The 3D graph, cluster layout and build animation are implemented in this repository. They were **not** copied from MiroFish, which
is AGPL-3.0: using its code would put this project under the same licence.

## Graph and simulation interaction

- **Sidebar:** icons only (hover for a description). Case icons (graph, review, documents, stages 2-5) appear only while a case is open; create a case from the Dashboard or Cases page.
- **Graph explorer:** a full-width canvas with a right-hand icon rail (Inspector, Filters, Sources, View options). Click an icon to open its panel; click a source to drill into the entities it supports. Toggle **2D / 3D**. Clicking a node isolates it: only that node and its direct connections stay, until you click another node or press *show all*.
- **Reaction graphs** (simulation page, *Reaction graph · 3D*): the whole run (who reacted to whom), one persona (what it posted and who reacted), or one post's cascade (comments, reposts, likes, replies to replies).
- **Trigger a persona** (simulation card *Trigger a persona*): make a synthetic persona post, comment, repost, like or dislike inside a finished run, optionally letting the others react (rule-based by stance closeness). Events are labelled `analyst-trigger` / `reaction-model`.
- **Reports** list every persona's actions (posts, comments, reposts, likes) and the reactions under the most-engaged posts.

## Administration

Users with the `admin.access` permission (the Administrator role) get a shield icon in the sidebar that opens `/admin`:

- **Users:** add users (with a password you choose or a generated temporary one shown once), edit name, email and role,
  suspend or reactivate, reset passwords, and delete accounts that own no cases (suspend those instead).
- **Roles:** the five built-in roles plus custom ones, as a permission matrix. Built-in roles keep their names; the
  Administrator role always holds every permission. A role in use cannot be deleted; renaming a role moves its users with it.
- **Activity:** the workspace audit log, filterable by kind (sign-ins, administration, cases, graph, simulation and reports),
  person and free text, with paging.
- **Settings:** workspace name, default case visibility, session length, minimum password length, and the defaults new
  environments start from (rounds, LLM personas and posts per round, real actors context-only). A System panel shows live health
  for PostgreSQL, Neo4j, the job queue and the local LLM, plus model and storage details.

Every user also has **My account** (`/account`, from the avatar): change display name and password, switch theme, sign out,
and see recent sign-ins and account changes.

The API refuses changes that would leave the workspace without an active administrator, and administrators cannot suspend,
delete or demote themselves. Every change is written to the audit log (`admin.*` actions). Roles and settings live in the new
`roles` and `tenant_settings` tables, created at API start; an existing workspace gets the built-in roles on first use.

## Phones and tablets

Below 720 px the sidebar becomes a bottom tab bar and the top bar shows the logo, the case switcher, the page title and your
avatar (account, theme and sign-out live on `/account`). Tables that hold actions (such as users) turn into cards, metric strips
and forms collapse to fewer columns, and stage pages (environments, simulations, reports) stack the canvas above the workbench.

## When a service is down

If Neo4j is unreachable, graph endpoints answer **503** with a readable message and the UI shows "Graph database unavailable"
with a retry button instead of an error. Report chat still answers from the stored report. `GET /api/v1/system/status`
includes up/down flags for each service; details are on the admin Settings page.

The sign-in page lists the seeded demo accounts from the API (`GET /api/v1/auth/demo-accounts`) only while
`DEMO_ACCOUNTS=true` (the default for local development). Set it to `false` on any shared instance.

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
cd backend && EMBEDDING_PROVIDER=hash .venv/bin/python -m pytest      # parsing, chunking, quotes, resolution, uploads, spaCy relations, simulation determinism, GraphRAG citation checks; admin API tests need PostgreSQL
cd frontend && npm run typecheck && npm run build
```

## Known limitations / next steps
- **CPU-only LLM speed:** on an Intel CPU, `gemma4` writes about 6 tokens/s. A persona or post takes 15–40 s, and a report narrative or chat reply 20–120 s. Keep `llm_personas` and `llm_posts_per_round` small, or use a smaller model (`OLLAMA_MODEL`).
- **spaCy extraction** finds typed relations only where the grammar is explicit (subject–verb–object, "X of Y", "X, chair of Y"). Other entity pairs in a sentence get a low-confidence `CO_OCCURS_WITH` edge for review. Agents' stances therefore often start neutral unless the graph has SUPPORTS/OPPOSES edges or an LLM persona assigns one.
- **Docling on Intel Macs:** torch has no current macOS x86_64 wheels, so PDFs fall back to pypdf with a warning. Use the worker container (Linux) for Docling.
- No Alembic migrations yet: new tables are created at API start (`create_all`); column changes need a migration before any shared database.
- Original files live on local disk (`STORAGE_DIR`); swap `services/storage.py` for S3/MinIO in deployment.
- No malware scanning, OCR, SSO/MFA or undo. Job progress is polled, not pushed (SSE/WebSocket would be the next step).
