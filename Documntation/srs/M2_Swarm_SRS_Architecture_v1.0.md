# M2 Swarm
## Software Requirements Specification (SRS) & System Architecture
### Greenfield Standalone Product — Ollama-Based Synthetic Audience Simulation

**Version:** 1.0  
**Status:** Proposed / Development Baseline  
**Date:** 2026-10-04  
**Product:** M2 Swarm  
**Relationship to M2:** Independent standalone service in V1; future optional integration with M2 content approval workflow  
**Primary Model Gateway:** Ollama API  
**Motto:** *Media moves, minds follow.*

---

# 1. Document Purpose

This document defines the software requirements, user stories, architecture, data model, APIs, simulation model, agent model, security controls, observability, deployment model, and implementation boundaries for **M2 Swarm**.

M2 Swarm is a standalone synthetic-audience simulation system. An operator submits a piece of content, selects or generates a synthetic audience, runs a simulation, and receives structured reactions from multiple AI-powered personas before any real-world publication occurs.

The initial product is deliberately independent from the existing M2 campaign/execution product. M2 Swarm V1 does **not** publish content, control devices, log into social-media platforms, scrape real users, or perform actions on external platforms.

Its core purpose is:

> **Insert content → simulate diverse synthetic audience reactions → inspect individual responses → analyze patterns → revise content if needed.**

The system uses **Ollama** as the model gateway so models can run locally or on controlled infrastructure. The architecture keeps the model layer and social-simulation engine replaceable.

---

# 2. Product Vision

M2 Swarm is a pre-publication content laboratory.

Before an organization publishes a message, post, announcement, campaign concept, statement, visual caption, or other content, the content can be exposed to a configurable population of synthetic personas.

Each persona is treated as an independent simulated participant with:

- identity attributes,
- interests,
- communication style,
- topic familiarity,
- baseline attitudes,
- behavioral tendencies,
- engagement tendency,
- memory within a simulation,
- optional relationships to other synthetic personas,
- and an assigned model configuration.

The system records each synthetic participant's reaction and produces both:

1. **Individual reactions** — what each persona says or does.
2. **Aggregate analysis** — recurring interpretations, objections, questions, misunderstandings, sentiment, engagement patterns, disagreement, and uncertainty.

M2 Swarm must never present synthetic reactions as a scientifically representative measurement of a real population unless separately validated against appropriate real-world data.

---

# 3. Product Principles

M2 Swarm shall follow these principles.

## 3.1 Synthetic, not real-person impersonation

Personas are synthetic simulation constructs. The system must not require cloning or impersonating identifiable real people.

## 3.2 Simulation, not certainty

The product reports simulated responses, not guaranteed predictions of human behavior.

Preferred wording:

- "63% of this simulated cohort reacted negatively."
- "Interpretation disagreement was high."
- "This synthetic cohort identified three recurring objections."

Avoid:

- "63% of the public will reject this message."
- "This post will definitely go viral."
- "These are the real views of this demographic."

## 3.3 Local-first AI

The default model path uses Ollama so the operator may run models locally or on organization-controlled servers.

## 3.4 Model independence

The swarm engine shall not contain model-specific business logic. Models are accessed through a model adapter.

## 3.5 Reproducibility

Where supported, the system should store generation parameters, prompts, model identifiers, model version/tag, persona state, simulation settings, random seeds, and output schemas so a run can be reproduced or audited.

## 3.6 Structured outputs first

Agent results should be machine-readable JSON validated against schemas rather than relying only on free-form text.

## 3.7 Human interpretation required

Simulation output is decision support. Final decisions remain with the human operator.

---

# 4. Scope

## 4.1 V1 In Scope

M2 Swarm V1 shall support:

- manual content input,
- content title and optional context,
- optional source/platform label,
- creation of synthetic persona sets,
- manual persona creation,
- AI-assisted persona generation,
- reusable persona libraries,
- configurable swarm size,
- Ollama model configuration,
- independent agent reactions,
- structured agent output,
- concurrent simulation execution,
- per-agent status,
- per-agent responses,
- aggregate sentiment and reaction analysis,
- recurring-question extraction,
- objection extraction,
- misunderstanding-risk analysis,
- engagement-intent analysis,
- disagreement analysis,
- simulation-run history,
- rerunning a simulation,
- comparing runs,
- exporting simulation results to JSON/CSV,
- audit logging,
- local deployment using Docker Compose.

## 4.2 V1 Out of Scope

V1 shall not:

- publish content to social media,
- operate phones,
- execute M2 macros,
- create or operate fake external social-media accounts,
- scrape real user profiles automatically,
- infer sensitive traits about identifiable real people,
- claim statistical population representativeness,
- create real social-media engagement,
- automatically change live campaigns,
- automatically publish content based on swarm results,
- use OASIS as a mandatory runtime dependency,
- require cloud LLM APIs.

## 4.3 Future Scope

Future versions may add:

- multi-round persona-to-persona discussion,
- synthetic social graphs,
- feed/recommendation simulation,
- dynamic opinion change,
- OASIS simulation adapter,
- graph-based community formation,
- scenario branching,
- multimodal input,
- image/video interpretation,
- multiple Ollama model pools,
- model benchmarking,
- calibrated prediction against approved aggregate outcome datasets,
- optional integration with M2 content approval,
- experiment comparison,
- simulation templates by topic,
- organization-specific synthetic cohorts.

---

# 5. Definitions

| Term | Definition |
|---|---|
| **Content Item** | The text or other approved input being evaluated. |
| **Persona** | A synthetic description of a simulated audience member. |
| **Agent** | A runtime persona instance with model, memory, rules, and state. |
| **Cohort** | A selected group of personas used in a simulation. |
| **Simulation Run** | One execution of content against a selected cohort and configuration. |
| **Reaction** | Structured output produced by an agent after exposure to content. |
| **Round** | One step of a simulation. V1 uses one independent-reaction round by default. |
| **Swarm** | The complete set of simulated agents participating in a run. |
| **Analyzer** | Service that aggregates and summarizes agent outputs. |
| **Ollama Gateway** | Adapter that communicates with the Ollama HTTP API. |
| **Model Profile** | Saved Ollama model name and generation settings. |
| **Simulation Engine** | Runtime that schedules agents and manages their state. |
| **OASIS Adapter** | Future optional integration with the OASIS social simulation framework. |

---

# 6. Actors and Roles

## 6.1 Operator

Primary user who creates content tests, selects personas, starts simulations, and reviews results.

## 6.2 Analyst

User who focuses on detailed interpretation, comparisons, exported data, and historical simulation analysis.

## 6.3 Administrator

User who manages:

- model configurations,
- Ollama endpoints,
- concurrency,
- persona templates,
- users,
- permissions,
- retention settings,
- system health.

## 6.4 System Services

Internal actors:

- API service,
- simulation worker,
- Ollama gateway,
- persona service,
- analyzer,
- persistence service,
- queue,
- audit logger.

---

# 7. Primary User Journey

```text
Operator
   |
   v
Create Content Test
   |
   +--> paste content
   +--> enter context
   +--> choose source/platform label
   |
   v
Choose Audience
   |
   +--> existing cohort
   +--> generate synthetic personas
   +--> manually select personas
   |
   v
Configure Simulation
   |
   +--> model
   +--> number of agents
   +--> temperature / options
   +--> concurrency
   |
   v
Run Swarm
   |
   v
Agent Reactions
   |
   +--> viewed / ignored
   +--> interpretation
   +--> sentiment
   +--> likely response
   +--> questions
   +--> objections
   +--> engagement intent
   +--> misunderstanding risk
   |
   v
Aggregate Analysis
   |
   +--> themes
   +--> disagreement
   +--> risks
   +--> common questions
   +--> notable reactions
   |
   v
Human Review
   |
   +--> revise content
   +--> duplicate and rerun
   +--> export
   +--> compare simulations
```

---

# 8. User Stories

## Epic A — Content Testing

### US-A1 — Create a content test

**As an operator**, I want to paste content into M2 Swarm so that I can evaluate it before publication.

**Acceptance Criteria**

- Content body is required.
- Title is optional.
- Context is optional.
- Platform/source label is optional.
- The system stores the content item before simulation.
- Content versions are immutable once attached to a completed simulation.

### US-A2 — Add context

**As an operator**, I want to provide background context so that personas interpret the content within the intended situation.

**Acceptance Criteria**

- Context may include purpose, target environment, assumptions, and topic background.
- Context is clearly separated from the content being tested.
- Context is passed to agents as simulation context, not quoted as part of the public post.

### US-A3 — Duplicate and revise

**As an operator**, I want to duplicate a tested content item, modify it, and rerun the swarm so that I can compare revisions.

**Acceptance Criteria**

- Original simulation remains immutable.
- A new content version is created.
- The UI may show the parent version.
- Comparison can show changes in aggregate response.

---

## Epic B — Persona Management

### US-B1 — Generate a synthetic cohort

**As an operator**, I want the system to generate a diverse synthetic cohort so that I do not need to manually define every persona.

**Acceptance Criteria**

- Operator specifies cohort size.
- Operator may provide cohort description and constraints.
- Generated personas receive unique IDs.
- Generated personas are validated against the persona schema.
- Personas are marked as synthetic.
- Duplicate personas should be detected or flagged.

### US-B2 — Create a persona manually

**As an analyst**, I want to define a persona manually so that I can test a specific synthetic perspective.

**Acceptance Criteria**

Persona may define:

- age band,
- occupation category,
- interests,
- topic familiarity,
- communication style,
- baseline attitude,
- media-use tendency,
- skepticism tendency,
- engagement tendency,
- optional notes.

No field requires identifying a real individual.

### US-B3 — Save persona libraries

**As an analyst**, I want to save reusable persona libraries so that repeated tests can use the same cohort.

### US-B4 — Inspect persona details

**As an operator**, I want to inspect the persona profile associated with each response so that I understand why different simulated participants reacted differently.

---

## Epic C — Model Configuration

### US-C1 — Configure Ollama

**As an administrator**, I want to register an Ollama endpoint so that M2 Swarm can run local models.

**Acceptance Criteria**

- Default URL may be `http://ollama:11434` in Docker.
- Endpoint health can be tested.
- Model list may be refreshed from Ollama where supported.
- Secrets, if introduced through a proxy, are not exposed to normal users.

### US-C2 — Create a model profile

**As an administrator**, I want to save model settings so that runs use controlled configurations.

A model profile may include:

- model name,
- temperature,
- top_p,
- context size where applicable,
- keep_alive,
- timeout,
- maximum concurrent requests,
- output schema version.

### US-C3 — Select a model per run

**As an operator**, I want to select an approved model profile so that I can compare different local models.

---

## Epic D — Swarm Execution

### US-D1 — Start a simulation

**As an operator**, I want to start a swarm run against selected personas so that I can hear independent synthetic reactions.

### US-D2 — Run agents concurrently

**As the system**, I want to process independent agents concurrently so that swarm runs complete efficiently without overwhelming Ollama.

### US-D3 — Track progress

**As an operator**, I want live progress so that I know how many persona reactions are pending, running, completed, or failed.

### US-D4 — Retry failed agents

**As an operator**, I want failed agent executions to be retryable without repeating successful responses.

### US-D5 — Cancel a running simulation

**As an operator**, I want to cancel an active run.

Cancellation shall:

- stop scheduling new agent calls,
- allow configurable handling of in-flight calls,
- preserve completed results,
- mark remaining agents canceled.

---

## Epic E — Reaction Review

### US-E1 — Read every response

**As an operator**, I want to read each persona's reaction individually.

### US-E2 — Filter reactions

**As an analyst**, I want to filter responses by:

- sentiment,
- engagement intent,
- misunderstanding risk,
- persona group,
- model,
- completion status.

### US-E3 — See structured reasoning summary

**As an operator**, I want each reaction to explain its interpretation, likely response, questions, and objections without exposing hidden model chain-of-thought.

The product shall store concise model-generated explanations, not private reasoning traces.

---

## Epic F — Aggregate Analysis

### US-F1 — Aggregate sentiment

**As an analyst**, I want to see how the simulated cohort distributed across reaction classes.

### US-F2 — Find recurring objections

**As an analyst**, I want the system to group semantically similar objections.

### US-F3 — Find recurring questions

**As an analyst**, I want to know what questions repeatedly arise.

### US-F4 — Identify misunderstanding

**As an operator**, I want to see which aspects of content were frequently misunderstood.

### US-F5 — Measure disagreement

**As an analyst**, I want a disagreement score so that I can distinguish consensus from polarization.

### US-F6 — Inspect uncertainty

**As an analyst**, I want the system to show uncertainty and data-quality warnings.

---

## Epic G — Comparison and Export

### US-G1 — Compare content versions

**As an operator**, I want to compare two simulation runs.

### US-G2 — Export results

**As an analyst**, I want to export:

- run metadata,
- persona definitions,
- structured reactions,
- aggregate metrics,
- analyzer findings.

Formats:

- JSON,
- CSV for flat reaction data.

### US-G3 — Preserve simulation history

**As an operator**, I want to review previous runs and configurations.

---

## Epic H — Administration and Audit

### US-H1 — Audit model use

**As an administrator**, I want every run to record which model and settings were used.

### US-H2 — Inspect failures

**As an administrator**, I want to view Ollama timeouts, schema failures, worker failures, and invalid responses.

### US-H3 — Configure retention

**As an administrator**, I want configurable retention rules for content, personas, reactions, and logs.

---

# 9. Functional Requirements

## FR-001 Content Creation

The API shall create a content item with:

- `id`
- `title`
- `body`
- `context`
- `source_label`
- `language`
- `created_by`
- `created_at`
- `parent_content_id`
- `version`

## FR-002 Persona Schema

Each persona shall contain at minimum:

- `persona_id`
- `display_name`
- `synthetic = true`
- `summary`
- `interests`
- `topic_familiarity`
- `communication_style`
- `baseline_attitude`
- `engagement_tendency`
- `skepticism_tendency`

Optional dimensions may include:

- age band,
- occupation category,
- preferred content style,
- social-media-use level,
- risk tolerance,
- information-seeking style.

## FR-003 Persona Generation

The persona generator shall use a dedicated structured-output prompt and produce persona objects matching a JSON schema.

The generator shall not automatically generate replicas of named real individuals.

## FR-004 Cohort Definition

A cohort shall store:

- cohort ID,
- name,
- description,
- persona IDs,
- generation method,
- creation metadata.

## FR-005 Simulation Creation

A simulation shall reference:

- one immutable content version,
- one cohort snapshot,
- one model profile,
- one simulation configuration.

## FR-006 Simulation State Machine

```text
DRAFT
  |
  v
QUEUED
  |
  v
RUNNING
  | \
  |  \--> CANCELING --> CANCELED
  |
  +--> ANALYZING
          |
          +--> COMPLETED
          |
          +--> COMPLETED_WITH_ERRORS

RUNNING --> FAILED
ANALYZING --> FAILED
```

## FR-007 Agent Instance

For every persona selected for a run, the system shall create a run-specific agent instance.

Agent state includes:

- agent_run_id,
- persona snapshot,
- model profile,
- simulation ID,
- state,
- memory,
- reaction ID,
- error code,
- started/finished timestamps.

## FR-008 Independent V1 Reactions

In V1, personas shall react independently.

A persona must not see another persona's response unless a future multi-round mode is explicitly enabled.

## FR-009 Ollama Chat Request

The Ollama adapter shall support calling the Ollama chat endpoint.

The adapter should support:

- model name,
- messages,
- structured output schema,
- non-streaming execution for machine parsing,
- model options,
- keep-alive,
- timeout handling.

## FR-010 Structured Reaction Output

A reaction shall validate against this logical schema:

```json
{
  "reaction_class": "positive | neutral | skeptical | negative | mixed",
  "interpretation": "string",
  "likely_public_response": "string",
  "questions": ["string"],
  "objections": ["string"],
  "positive_points": ["string"],
  "misunderstanding_risk": 0.0,
  "engagement_likelihood": 0.0,
  "share_likelihood": 0.0,
  "confidence": 0.0,
  "would_ignore": false,
  "reason_summary": "string"
}
```

All numeric probability-like fields are simulation scores in the range `[0,1]`; they are not real-world probabilities unless separately calibrated.

## FR-011 Schema Validation

All Ollama structured responses shall be validated by Pydantic.

Invalid responses shall:

1. be recorded,
2. optionally receive a bounded repair/retry attempt,
3. fail cleanly if still invalid.

## FR-012 Concurrency Control

The simulation worker shall enforce:

- global maximum concurrent Ollama requests,
- per-model maximum concurrent requests,
- per-run concurrency limits.

## FR-013 Timeout Handling

Each model call shall have a configurable timeout.

Timeout shall produce a stable error code such as:

`OLLAMA_REQUEST_TIMEOUT`.

## FR-014 Retry Policy

Retries shall be bounded.

Example default:

- maximum model-call attempts: 2,
- retry on timeout/connectivity/transient 5xx,
- retry on malformed structured output once,
- do not retry indefinitely.

## FR-015 Progress

Simulation progress shall expose:

- total agents,
- queued,
- running,
- completed,
- failed,
- canceled,
- percent complete.

## FR-016 Aggregate Metrics

The analyzer shall calculate deterministic metrics directly from structured results before requesting any LLM-generated narrative summary.

Metrics should include:

- reaction-class distribution,
- mean engagement score,
- median engagement score,
- mean misunderstanding score,
- high-risk misunderstanding count,
- ignore count,
- high-disagreement indicators,
- completion/error rate.

## FR-017 Theme Clustering

V1 may use either:

- embedding-based clustering,
- deterministic text normalization plus similarity,
- or a dedicated LLM analyzer.

The analysis source must be recorded.

## FR-018 Analyzer Summary

A separate analysis call may summarize:

- dominant interpretations,
- repeated questions,
- repeated objections,
- notable edge cases,
- potential ambiguity,
- areas of persona disagreement.

## FR-019 Result Warnings

Every report shall display a notice that:

- the cohort is synthetic,
- results are model-dependent,
- outputs are not population polling,
- small cohorts have high uncertainty,
- persona definitions affect results.

## FR-020 Comparison

The system shall compare two completed runs when compatible.

Comparison may show:

- sentiment shift,
- engagement shift,
- misunderstanding shift,
- recurring objections added/removed,
- question themes added/removed.

---

# 10. Non-Functional Requirements

## NFR-001 Deployment

The complete V1 application shall be deployable via Docker Compose.

## NFR-002 Local AI

The system shall operate without an external LLM API when Ollama and a suitable local model are available.

## NFR-003 Scalability

Initial target:

- 10–200 agents per run on a single-node deployment.

Architecture target:

- 1,000+ agent runs using distributed workers in future versions.

## NFR-004 Performance

The API itself shall remain responsive while simulations execute asynchronously.

## NFR-005 Reliability

Completed agent reactions shall be persisted immediately rather than only after the entire simulation finishes.

## NFR-006 Recoverability

A worker restart shall not lose completed reactions.

Stale `RUNNING` agent jobs must be recoverable or marked for retry.

## NFR-007 Data Integrity

Content snapshot, persona snapshot, model profile, and simulation configuration must be immutable after a run starts.

## NFR-008 Observability

Every model request shall emit operational metadata:

- request ID,
- simulation ID,
- agent ID,
- model,
- latency,
- status,
- retry count,
- error code.

Prompt/content bodies should not be written to ordinary application logs.

## NFR-009 Security

Access to simulation history shall be role-controlled.

## NFR-010 Privacy

The system should support fully on-premise deployment.

## NFR-011 Maintainability

Model adapters and simulation-engine adapters must implement stable interfaces.

## NFR-012 Testability

Persona prompt construction, schema validation, simulation state changes, aggregation, retries, and model adapters must be unit-testable without running a real model.

---

# 11. High-Level Architecture

```text
                       +---------------------+
                       |    React Web UI     |
                       +----------+----------+
                                  |
                                  | HTTPS / REST
                                  v
                       +---------------------+
                       |    FastAPI API      |
                       |  Auth + CRUD + Run  |
                       +----+-----------+----+
                            |           |
                      DB    |           | Queue Jobs
                            v           v
                 +---------------+   +------------------+
                 |  PostgreSQL   |   | Redis / Queue    |
                 +---------------+   +--------+---------+
                                             |
                                             v
                                  +----------------------+
                                  | Simulation Workers   |
                                  | Swarm Orchestrator   |
                                  +-----+-----------+----+
                                        |           |
                           persona load |           | model calls
                                        v           v
                                +-------------+  +----------------+
                                | Agent Engine |  | Ollama Gateway |
                                +------+------+  +--------+-------+
                                       |                  |
                                       |                  | HTTP
                                       |                  v
                                       |         +-----------------+
                                       |         |     Ollama      |
                                       |         | Local LLM Host  |
                                       |         +-----------------+
                                       |
                                       v
                              +----------------+
                              | Reaction Store |
                              +-------+--------+
                                      |
                                      v
                             +------------------+
                             | Analysis Engine  |
                             +--------+---------+
                                      |
                                      v
                             +------------------+
                             | Simulation Report|
                             +------------------+
```

---

# 12. Recommended Technology Stack

## Frontend

- React
- Vite
- TypeScript preferred
- React Query or equivalent for server state
- lightweight chart library
- WebSocket or Server-Sent Events for progress updates

## Backend API

- Python 3.12+
- FastAPI
- Pydantic v2
- SQLAlchemy 2.x
- Alembic

## Persistence

- PostgreSQL
- optional pgvector in later phase

## Queue

Recommended V1:

- Redis
- Celery, Dramatiq, RQ, or Arq

Preferred for async Python simplicity:

- **Arq** or **Dramatiq**

Celery is acceptable if the team already knows it.

## AI Runtime

- Ollama
- local or private-network deployment

## Simulation Engine

V1:

- custom Python orchestrator,
- asyncio-based bounded concurrency,
- database-backed job state.

Future:

- `OasisSimulationAdapter`,
- distributed worker scheduler,
- Ray if scale requires it.

---

# 13. Architectural Decision: Ollama as Model Gateway

M2 Swarm shall treat Ollama as a model runtime, not as the swarm itself.

```text
Synthetic Agent
   |
   | persona + memory + content + rules
   v
Prompt Builder
   |
   v
Ollama Adapter
   |
   v
Selected Local Model
   |
   v
Structured JSON Response
```

This distinction is important.

The **agent** is:

```text
Agent =
    Persona
  + Runtime State
  + Memory
  + Behavior Rules
  + Prompt Policy
  + Model Profile
  + Output Schema
```

The **LLM** is only one dependency inside the agent.

---

# 14. Ollama Integration

## 14.1 Default Endpoint

Development:

```text
http://localhost:11434
```

Docker service-to-service:

```text
http://ollama:11434
```

Configuration:

```text
OLLAMA_BASE_URL=http://ollama:11434
```

## 14.2 Chat Endpoint

Primary interaction:

```text
POST /api/chat
```

Example logical request:

```json
{
  "model": "configured-model-name",
  "messages": [
    {
      "role": "system",
      "content": "persona/system policy"
    },
    {
      "role": "user",
      "content": "content and task"
    }
  ],
  "stream": false,
  "format": {
    "type": "object",
    "properties": {}
  },
  "options": {
    "temperature": 0.8
  },
  "keep_alive": "10m"
}
```

The production implementation shall generate the `format` JSON schema from the Pydantic reaction model.

## 14.3 Python Client Abstraction

```python
class ModelGateway(Protocol):
    async def chat_structured(
        self,
        *,
        model_profile: ModelProfile,
        messages: list[Message],
        output_schema: type[BaseModel],
    ) -> BaseModel:
        ...
```

Implementation:

```python
class OllamaModelGateway(ModelGateway):
    ...
```

No simulation-domain service may call Ollama directly.

## 14.4 Model Health

The system shall expose internal checks for:

- Ollama reachable,
- model available,
- generation test successful,
- schema response valid.

## 14.5 Model Selection

M2 Swarm shall not require one specific Ollama model.

The administrator may approve model profiles.

Example categories:

- fast persona model,
- high-quality persona model,
- analyzer model,
- persona-generation model.

A single physical model may serve all categories initially.

---

# 15. Persona Architecture

## 15.1 Persona Object

Example:

```json
{
  "persona_id": "per_01J...",
  "display_name": "Persona 17",
  "synthetic": true,
  "summary": "A skeptical small-business operator with moderate familiarity with the topic.",
  "age_band": "35-44",
  "occupation_category": "small_business",
  "interests": ["business", "local affairs"],
  "topic_familiarity": "medium",
  "communication_style": "direct",
  "baseline_attitude": "skeptical",
  "media_use_level": "high",
  "engagement_tendency": 0.65,
  "skepticism_tendency": 0.8,
  "information_seeking_style": "evidence_first",
  "custom_traits": {}
}
```

## 15.2 Persona Validation

Rules:

- synthetic must always be true,
- display name should not imply the persona is a real registered user,
- no password/account credential fields,
- no external social account tokens,
- persona generation should favor meaningful behavioral diversity over cosmetic diversity.

## 15.3 Persona Snapshots

When a simulation starts, persona definitions are copied into immutable run snapshots.

Editing the persona library later must not change historical runs.

---

# 16. Agent Architecture

## 16.1 Runtime State

```text
AgentRuntime
├── agent_run_id
├── persona_snapshot
├── model_profile_snapshot
├── simulation_context
├── memory[]
├── current_round
├── state
├── last_error
└── reaction
```

## 16.2 Prompt Layers

The prompt builder should create four logical layers:

### Layer 1 — System behavior

Defines that the model is a synthetic participant inside a simulation.

### Layer 2 — Persona

Injects only the selected persona snapshot.

### Layer 3 — Scenario context

Provides test context.

### Layer 4 — Content and task

Provides the actual content and requests a structured reaction.

Example:

```text
SYSTEM:
You are a synthetic participant in an audience-response simulation.
Remain consistent with the supplied persona.
Do not claim to be a real person.
Return only data matching the required schema.

PERSONA:
...

SCENARIO:
...

CONTENT TO EVALUATE:
...

TASK:
Interpret this content from the persona's perspective.
Provide the requested structured response.
```

## 16.3 No Hidden Chain-of-Thought Storage

The application shall not request or store hidden chain-of-thought.

It may request concise fields such as:

- `reason_summary`,
- `interpretation`,
- `objections`.

---

# 17. Simulation Orchestrator

## 17.1 Responsibilities

The orchestrator shall:

1. freeze content snapshot,
2. freeze cohort/persona snapshots,
3. freeze model profile,
4. create agent-run rows,
5. enqueue agent work,
6. enforce concurrency,
7. receive structured reactions,
8. persist each reaction,
9. update progress,
10. transition to analysis,
11. create aggregate report.

## 17.2 V1 Algorithm

```python
simulation = create_run(content, cohort, model_profile)

for persona in cohort:
    create_agent_job(simulation, persona)

run_jobs_with_bounded_concurrency()

for job in completed_jobs:
    persist_reaction(job)

metrics = calculate_deterministic_metrics(reactions)
themes = analyze_reaction_themes(reactions)
report = create_report(metrics, themes)

complete_simulation(report)
```

## 17.3 Concurrency

Example default:

```text
MAX_GLOBAL_OLLAMA_CONCURRENCY=8
MAX_RUN_CONCURRENCY=8
```

These must be configurable because safe concurrency depends on:

- GPU VRAM,
- CPU/RAM,
- model size,
- quantization,
- context size.

## 17.4 Backpressure

If 200 personas are queued and concurrency is 8:

```text
200 queued
   |
   v
8 active calls
   |
   +--> each completion releases one slot
   |
   v
next queued agent starts
```

The API shall never start 200 unrestricted simultaneous Ollama requests.

---

# 18. Multi-Round Architecture — Future V2

V1 intentionally uses independent reactions.

V2 may add:

```text
Round 0
  Seed Content
      |
Round 1
  Initial reactions
      |
Round 2
  Selected personas see selected reactions
      |
Round 3
  Replies / attitude change / amplification
      |
Final
  Network + narrative analysis
```

New future concepts:

- social graph,
- follow relationships,
- feed exposure,
- recommendation engine,
- reply graph,
- opinion state,
- interaction budget,
- simulation clock.

The V1 domain model should reserve `round_number` on reactions/events so schema migration remains simple.

---

# 19. Optional OASIS Adapter — Future

OASIS is not required for V1.

The architecture should expose:

```python
class SimulationEngine(Protocol):
    async def execute(self, run_id: str) -> SimulationResult:
        ...
```

Implementations:

```text
IndependentReactionEngine    <-- V1 default
OasisSimulationEngine        <-- future
```

The OASIS adapter can later support:

- Twitter-like synthetic environments,
- Reddit-like synthetic environments,
- agent graphs,
- simulated social actions,
- recommendation systems,
- simulation clocks,
- multi-round interactions.

This prevents M2 Swarm from coupling its product API to one external simulation framework.

---

# 20. Analyzer Architecture

The analyzer has two stages.

## Stage 1 — Deterministic Analyzer

Uses normal Python/statistics.

Produces:

- counts,
- percentages within the synthetic cohort,
- averages,
- medians,
- distributions,
- threshold counts,
- completion rate.

## Stage 2 — Semantic Analyzer

Uses:

- embeddings and clustering, or
- Ollama structured analysis.

Produces:

- repeated objections,
- common interpretations,
- question clusters,
- ambiguity themes,
- notable minority reactions.

The report shall label model-generated analysis separately from deterministic metrics.

---

# 21. Proposed Database Model

## `users`

```text
id
email
password_hash
role
is_active
created_at
```

## `content_items`

```text
id
title
body
context
source_label
language
version
parent_content_id
created_by
created_at
```

## `personas`

```text
id
display_name
synthetic
profile_json
schema_version
created_by
created_at
updated_at
```

## `cohorts`

```text
id
name
description
created_by
created_at
```

## `cohort_personas`

```text
cohort_id
persona_id
```

## `model_profiles`

```text
id
name
provider              # OLLAMA in V1
base_url
model_name
options_json
max_concurrency
timeout_seconds
enabled
created_at
```

## `simulations`

```text
id
name
content_id
content_snapshot_json
cohort_snapshot_json
model_profile_snapshot_json
state
config_json
total_agents
completed_agents
failed_agents
canceled_agents
created_by
created_at
started_at
completed_at
```

## `agent_runs`

```text
id
simulation_id
persona_id
persona_snapshot_json
state
round_number
attempt_count
error_code
error_message_safe
started_at
completed_at
```

## `reactions`

```text
id
simulation_id
agent_run_id
persona_id
round_number
reaction_class
interpretation
likely_public_response
questions_json
objections_json
positive_points_json
misunderstanding_risk
engagement_likelihood
share_likelihood
confidence
would_ignore
reason_summary
raw_structured_json
created_at
```

## `simulation_reports`

```text
id
simulation_id
metrics_json
themes_json
warnings_json
narrative_summary
analyzer_model_snapshot_json
created_at
```

## `simulation_events`

```text
id
simulation_id
agent_run_id
event_type
severity
metadata_json
created_at
```

## `audit_events`

```text
id
actor_user_id
action
entity_type
entity_id
metadata_json
created_at
```

---

# 22. API Design

Base path:

```text
/api/v1
```

## Content

```text
POST   /content
GET    /content
GET    /content/{id}
POST   /content/{id}/duplicate
```

## Personas

```text
POST   /personas
GET    /personas
GET    /personas/{id}
PATCH  /personas/{id}
DELETE /personas/{id}

POST   /personas/generate
```

## Cohorts

```text
POST   /cohorts
GET    /cohorts
GET    /cohorts/{id}
PATCH  /cohorts/{id}
DELETE /cohorts/{id}
```

## Model Profiles

```text
POST   /admin/model-profiles
GET    /admin/model-profiles
PATCH  /admin/model-profiles/{id}
POST   /admin/model-profiles/{id}/test
```

## Simulations

```text
POST   /simulations
GET    /simulations
GET    /simulations/{id}

POST   /simulations/{id}/start
POST   /simulations/{id}/cancel
POST   /simulations/{id}/retry-failed

GET    /simulations/{id}/progress
GET    /simulations/{id}/reactions
GET    /simulations/{id}/report

POST   /simulations/compare
```

## Export

```text
GET /simulations/{id}/export.json
GET /simulations/{id}/reactions.csv
```

## System

```text
GET /health
GET /ready
GET /admin/ollama/health
GET /admin/ollama/models
```

---

# 23. API Examples

## Create Simulation

```json
POST /api/v1/simulations
{
  "name": "Post Test 001",
  "content_id": "cnt_123",
  "cohort_id": "coh_456",
  "model_profile_id": "mdl_789",
  "config": {
    "mode": "independent_reaction",
    "max_concurrency": 8
  }
}
```

Response:

```json
{
  "id": "sim_001",
  "state": "DRAFT",
  "total_agents": 50
}
```

## Start Simulation

```text
POST /api/v1/simulations/sim_001/start
```

Response:

```json
{
  "id": "sim_001",
  "state": "QUEUED"
}
```

## Progress

```json
{
  "simulation_id": "sim_001",
  "state": "RUNNING",
  "total": 50,
  "queued": 18,
  "running": 8,
  "completed": 22,
  "failed": 2,
  "canceled": 0,
  "percent_complete": 48.0
}
```

---

# 24. UI Requirements

## 24.1 Main Navigation

```text
Dashboard
New Simulation
Simulations
Personas
Cohorts
Comparisons
Administration
```

## 24.2 New Simulation Wizard

### Step 1 — Content

Fields:

- title,
- content body,
- context,
- optional source/platform.

### Step 2 — Audience

Options:

- choose existing cohort,
- generate new cohort,
- manually select personas.

### Step 3 — Model

Show:

- approved model profile,
- model name,
- expected local runtime status.

### Step 4 — Run

Show:

- number of personas,
- estimated request count,
- selected concurrency,
- clear "Run Swarm" action.

## 24.3 Live Run Screen

Show:

```text
Simulation: Post Test 001

Completed   31 / 50
Running      8
Queued       9
Failed       2

[progress bar]

Recent reactions
--------------------------------
Persona 17   skeptical    complete
Persona 18   neutral      complete
Persona 19   --           running
```

## 24.4 Results Dashboard

Required sections:

- synthetic cohort notice,
- reaction distribution,
- interpretation summary,
- engagement scores,
- misunderstanding-risk distribution,
- common objections,
- common questions,
- disagreement indicators,
- notable reactions,
- individual persona response list,
- failures.

## 24.5 Individual Reaction Card

```text
Persona 17
Small-business profile | skeptical | topic familiarity: medium

Reaction: Skeptical

Interpretation:
...

Likely response:
...

Questions:
- ...
- ...

Objections:
- ...

Engagement score: 0.64
Misunderstanding risk: 0.21
Confidence: 0.71
```

---

# 25. Error Model

Stable error codes should include:

```text
OLLAMA_UNREACHABLE
OLLAMA_MODEL_NOT_FOUND
OLLAMA_REQUEST_TIMEOUT
OLLAMA_GENERATION_FAILED
OLLAMA_INVALID_RESPONSE

STRUCTURED_OUTPUT_INVALID
STRUCTURED_OUTPUT_REPAIR_FAILED

PERSONA_INVALID
COHORT_EMPTY
CONTENT_EMPTY

SIMULATION_ALREADY_STARTED
SIMULATION_NOT_RUNNING
SIMULATION_CANCELED

WORKER_FAILURE
ANALYSIS_FAILED
DATABASE_ERROR
```

Raw internal exception strings must not be sent directly to normal users.

---

# 26. Logging and Observability

## 26.1 Event Types

```text
SIMULATION_CREATED
SIMULATION_QUEUED
SIMULATION_STARTED
SIMULATION_CANCELED
SIMULATION_COMPLETED
SIMULATION_FAILED

AGENT_QUEUED
AGENT_STARTED
AGENT_COMPLETED
AGENT_FAILED
AGENT_RETRIED

OLLAMA_REQUEST_STARTED
OLLAMA_REQUEST_COMPLETED
OLLAMA_REQUEST_FAILED

REACTION_SCHEMA_INVALID
ANALYSIS_STARTED
ANALYSIS_COMPLETED
ANALYSIS_FAILED
```

## 26.2 Metrics

Expose:

- simulations started/completed/failed,
- active workers,
- queue depth,
- Ollama calls,
- Ollama average latency,
- Ollama p95 latency,
- schema failure rate,
- agent completion rate,
- average run duration,
- requests per model.

## 26.3 Correlation

Every event should support:

```text
request_id
simulation_id
agent_run_id
persona_id
model_profile_id
```

---

# 27. Security Requirements

## 27.1 Authentication

V1 shall use authenticated operator accounts.

## 27.2 Authorization

Suggested roles:

```text
ADMIN
OPERATOR
ANALYST
VIEWER
```

## 27.3 Ollama Network Boundary

In production, Ollama should not be exposed publicly.

Preferred:

```text
Browser
   |
HTTPS
   v
M2 Swarm API
   |
private network
   v
Ollama
```

## 27.4 Prompt Injection Boundary

Content under test is untrusted input.

The agent system prompt must clearly separate:

- system instruction,
- persona,
- scenario context,
- content under analysis.

Content shall not be allowed to override system requirements or output schema.

## 27.5 Export

Exports shall require user authorization and produce audit events.

---

# 28. Data Governance

Each simulation report must identify:

- model,
- model profile,
- synthetic cohort,
- persona count,
- run date,
- simulation mode,
- warning that the cohort is synthetic.

The system shall avoid representing synthetic demographics as actual population statistics.

Historical result deletion should support administrative retention policies.

---

# 29. Scientific/Interpretation Guardrails

M2 Swarm is a simulation system, not a polling system.

## Required UI Notice

> Results describe the responses of a synthetic AI-generated cohort under the selected model, persona definitions, prompts, and simulation configuration. They should not be interpreted as measured public opinion or guaranteed real-world behavior.

## Required Report Fields

```text
Synthetic cohort size
Model used
Simulation mode
Completion rate
Failed agent count
Persona source
Run configuration
```

## Calibration Future

If real-world aggregate outcomes are ever used for calibration, the system must maintain separate:

```text
simulated_metric
observed_metric
calibration_version
calibration_dataset
```

M2 Swarm shall never silently rewrite simulated values into claimed real-world probabilities.

---

# 30. Deployment Architecture

## 30.1 Single-Node Development

```text
docker compose

+----------------+
| frontend       |
+----------------+

+----------------+
| api            |
+----------------+

+----------------+
| worker         |
+----------------+

+----------------+
| postgres       |
+----------------+

+----------------+
| redis          |
+----------------+

+----------------+
| ollama         |
| + local model  |
+----------------+
```

## 30.2 Production On-Premise

```text
                   Internal Users
                         |
                    HTTPS / TLS
                         |
                 +---------------+
                 | Reverse Proxy |
                 +-------+-------+
                         |
                 +-------v-------+
                 | M2 Swarm API  |
                 +-------+-------+
                         |
          +--------------+--------------+
          |                             |
    +-----v------+                +-----v------+
    | PostgreSQL |                | Redis      |
    +------------+                +-----+------+
                                         |
                           +-------------+-------------+
                           |             |             |
                       +---v---+     +---v---+     +---v---+
                       |Worker1|     |Worker2|     |WorkerN|
                       +---+---+     +---+---+     +---+---+
                           |             |             |
                           +-------------+-------------+
                                         |
                                  Private AI LAN
                                         |
                                  +------v------+
                                  | Ollama Host |
                                  | GPU Server  |
                                  +-------------+
```

---

# 31. Repository Structure

Recommended:

```text
m2-swarm/
├── apps/
│   ├── api/
│   │   ├── app/
│   │   │   ├── api/
│   │   │   ├── auth/
│   │   │   ├── content/
│   │   │   ├── personas/
│   │   │   ├── cohorts/
│   │   │   ├── simulations/
│   │   │   ├── analysis/
│   │   │   ├── models/
│   │   │   └── main.py
│   │   └── tests/
│   │
│   ├── worker/
│   │   ├── orchestrator/
│   │   ├── agents/
│   │   ├── prompts/
│   │   ├── analysis/
│   │   └── tasks/
│   │
│   └── web/
│       └── src/
│
├── packages/
│   ├── model_gateway/
│   │   ├── base.py
│   │   └── ollama.py
│   │
│   ├── simulation_engine/
│   │   ├── base.py
│   │   ├── independent.py
│   │   └── oasis_adapter.py        # future
│   │
│   └── schemas/
│
├── migrations/
├── docker/
├── docker-compose.yml
├── .env.example
└── README.md
```

---

# 32. Configuration

Example `.env`:

```text
APP_ENV=development

DATABASE_URL=postgresql+psycopg://m2swarm:m2swarm@postgres:5432/m2swarm
REDIS_URL=redis://redis:6379/0

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_DEFAULT_MODEL=<approved-local-model>

OLLAMA_REQUEST_TIMEOUT_SECONDS=120
OLLAMA_MAX_CONCURRENCY=8

SIMULATION_MAX_AGENTS=200
SIMULATION_DEFAULT_CONCURRENCY=8

LOG_LEVEL=INFO
```

---

# 33. Testing Strategy

## Unit Tests

Required for:

- persona schema,
- cohort creation,
- prompt construction,
- reaction schema,
- state transitions,
- aggregation,
- retry rules,
- concurrency limiter,
- report calculations.

## Integration Tests

Use fake Ollama server responses to test:

- valid structured response,
- timeout,
- malformed JSON,
- schema mismatch,
- HTTP failure,
- slow response.

## Ollama Integration Test

Optional test requiring running Ollama:

```text
content
  -> one synthetic persona
  -> Ollama
  -> validated Reaction model
```

## Load Tests

Test:

- 10 agents,
- 50 agents,
- 100 agents,
- 200 agents.

Measure:

- queue behavior,
- GPU pressure,
- timeout rate,
- latency,
- worker stability.

---

# 34. Acceptance Criteria for V1

M2 Swarm V1 is considered usable when:

1. An authenticated operator can paste content.
2. The operator can create or select at least 10 personas.
3. The operator can select an Ollama model profile.
4. The system can launch a 50-persona swarm.
5. Ollama calls are concurrency-limited.
6. Each persona response is stored independently.
7. Each successful response validates against the structured reaction schema.
8. Failed agents are visible and retryable.
9. The UI shows run progress.
10. The result page shows aggregate metrics.
11. The result page shows all individual responses.
12. The report clearly identifies the population as synthetic.
13. A revised content version can be rerun.
14. Two runs can be compared.
15. Results can be exported.
16. A service restart does not erase completed reactions.
17. Model/profile configuration is recorded for every run.

---

# 35. Development Phases

## Phase 0 — Technical Spike

Goal:

```text
1 content
10 personas
1 Ollama model
10 structured reactions
console output
```

Deliverables:

- Ollama adapter,
- reaction schema,
- persona schema,
- asyncio concurrency test.

## Phase 1 — Core Backend

Deliver:

- PostgreSQL schema,
- content CRUD,
- persona CRUD,
- cohort CRUD,
- model profiles,
- simulation lifecycle,
- worker queue,
- Ollama structured calls,
- reaction persistence.

## Phase 2 — Web UI

Deliver:

- new simulation wizard,
- persona browser,
- live progress,
- reaction cards,
- results dashboard.

## Phase 3 — Analysis

Deliver:

- deterministic statistics,
- objection grouping,
- question grouping,
- misunderstanding summary,
- narrative report.

## Phase 4 — Comparison & Operations

Deliver:

- run comparison,
- export,
- audit log,
- retries,
- health screen,
- model testing.

## Phase 5 — Advanced Swarm

Future:

- multi-round interaction,
- social graph,
- OASIS adapter,
- recommendation/feed simulation,
- opinion state changes.

---

# 36. Sprint 0 — Recommended Immediate Build

Before building the entire application, implement this vertical slice:

```text
POST /prototype/run
        |
        v
10 predefined persona JSON objects
        |
        v
asyncio.Semaphore(4)
        |
        v
Ollama /api/chat
        |
        v
Pydantic Reaction
        |
        v
save response JSON
        |
        v
simple aggregate counts
```

Success criteria:

- 10 independent valid responses,
- zero free-form parsing,
- clean failure when Ollama is unavailable,
- model can be changed by configuration,
- exact prompt/model/settings stored with the test output.

This prototype should be completed before adopting a full social simulation framework.

---

# 37. Key Architectural Decisions

## ADR-001 — M2 Swarm is standalone in V1

**Decision:** No dependency on the existing M2 backend.

**Reason:** Allows fast experimentation and independent scaling.

## ADR-002 — Ollama is the primary V1 model gateway

**Decision:** All agent model calls go through a `ModelGateway` abstraction with an Ollama implementation.

**Reason:** Local/on-premise deployment, model flexibility, controlled data boundary.

## ADR-003 — Custom independent-reaction engine first

**Decision:** Build the minimum simulation engine internally for V1.

**Reason:** V1 only needs independent persona reactions. A larger framework would add complexity before the core hypothesis is validated.

## ADR-004 — OASIS is optional future engine

**Decision:** Support a future adapter instead of coupling core services to OASIS.

**Reason:** OASIS is well suited to social graphs and multi-round simulated platforms, but V1 does not require those capabilities.

## ADR-005 — Structured output required

**Decision:** Agent responses are Pydantic-validated structured data.

**Reason:** Reliable analysis and comparison.

## ADR-006 — Deterministic analysis before AI narrative analysis

**Decision:** Counts and score summaries come from code.

**Reason:** Prevent unnecessary model reinterpretation of metrics.

---

# 38. Future Integration with M2

Once M2 Swarm is validated independently, integration may use a narrow API boundary:

```text
Existing M2
   |
   | submit approved draft candidate
   v
M2 Swarm
   |
   | simulation report
   v
Existing M2 human approval screen
```

Potential M2 workflow:

```text
Generate
   |
   v
Simulate in M2 Swarm
   |
   v
Human Review
   |
   +--> Revise -> Re-simulate
   |
   +--> Approve
          |
          v
      Existing M2
      Schedule/Execute
```

M2 Swarm shall never directly trigger M2 execution in the initial integration.

---

# 39. Reference Technology Notes

The design relies on two external technology assumptions:

## Ollama

Ollama exposes a local HTTP API including `/api/chat`. Current Ollama documentation supports structured outputs by passing JSON or a JSON Schema through the `format` field. This fits M2 Swarm's requirement that persona reactions be validated as structured application data.

## OASIS

OASIS is an open-source social simulation framework built around LLM-powered social agents. Its current architecture includes social-agent profiles, agent graphs, simulated social platforms, recommendation behavior, social actions, simulation time, persistent activity, and bounded LLM concurrency. These capabilities make it a strong candidate for a future M2 Swarm multi-round simulation adapter, but they are intentionally not required for V1.

---

# 40. Final Product Definition

**M2 Swarm V1** is:

> A standalone, local-first synthetic-audience simulation platform that accepts content, exposes it to multiple independent AI personas powered through Ollama, captures structured reactions, aggregates patterns, and gives a human analyst a transparent pre-publication report.

The first release optimizes for:

```text
SIMPLE
REPRODUCIBLE
LOCAL
STRUCTURED
AUDITABLE
MODEL-INDEPENDENT
```

The initial product should prove one thing extremely well:

> **Can a diverse synthetic cohort provide useful, repeatable perspectives on content before a human chooses to publish it?**

Only after that is proven should the product add social graphs, multi-round interactions, recommendation engines, or large-scale world simulation.
