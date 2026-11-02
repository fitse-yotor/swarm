# ETH-GER-003 — Tamsa Reservoir Operating Rules (FICTIONAL test case)

A self-contained case for testing M2 Swarm end to end. It is set in the Ethiopian highlands, but **every organisation, person, place and
event is invented**, so nothing here attributes a position to a real government, institution or person. Persona comments are synthetic
archetypes, never opinion data.

| File | What it is |
|---|---|
| `sources/01…04` | Four source documents to upload (briefing, technical report, press digest, stakeholder statements). Key facts are written as plain "X supports / opposes / funds / regulates / operates Y" sentences so the extractor can type the relationships. |
| `personas.txt` | 14 synthetic personas in the import format (stance −0.6 … +0.7, four topics). |
| `scenarios.json` | The focus issue, background notes for the AI-agent engine, and four scenarios with their push (−1 … +1). |
| `../create_gerar_case.py` | Builds all of it through the API. |

## Fastest way (script)

With the API and frontend running (and `CELERY_EAGER=true` on the API, or a Celery worker):

```bash
backend/.venv/bin/python cases/create_gerar_case.py --approve --run --rounds 12
```

`--approve` approves the extracted graph and the version (this takes the first snapshot and starts the reaction hypotheses),
`--run` starts one simulation per scenario, `--ai` uses the AI-agent engine instead of the fast rules engine (needs Ollama; slow).
Without `--approve` it stops at a draft graph so you can review it yourself. Re-running skips what already exists.

**Install the spaCy model first** (`backend/.venv/bin/python -m spacy download en_core_web_sm`). Without it the fallback extractor
finds only low-confidence co-occurrence links and no typed relationships, so the graph, reactions and environments will be thin.

## By hand in the app (what the script does)

1. **New case.** Sidebar → Cases → *Create case*. Title "Tamsa Reservoir Operating Rules", paste the research question from
   `create_gerar_case.py`, scope *Organization*. Upload the four files in `sources/`, keep all entity types ticked, *Start Building*.
2. **Review and approve.** Open *Review queue*. Approve entities and relationships (relationships need a source passage to be
   approved), then *Approve* the graph version in the Graph explorer. This starts the reaction run and the first snapshot.
3. **New environment.** Sidebar → Environments → *New environment*. Name it after the scenario, paste the scenario text, set the
   push slider, set the focus issue "The Tamsa Release Protocol for the Tamsa Reservoir", leave *real actors context-only* on.
   Optional: put the `knowledge_notes` text in "Extra background for AI agents".
4. **Personas.** In the environment, *Import synthetic personas* and paste `personas.txt` (expect 14 imported, 0 skipped).
   Open an agent to adjust its **Behaviour** (preset, action mix, how it answers comments).
5. **More scenarios.** Use *Duplicate* on the environment, then change the name, scenario text and push for each row in
   `scenarios.json`. Same population, different news.
6. **Approve and launch.** *Approve* the environment, then *Launch* a simulation. Choose *Rules + templates* for seconds, or
   *AI agents* for model-written actions.

## What to look for

- **Graph:** about 15 organisations and people; relationships such as `OPPOSES` (Hydropower Company → Release Protocol),
  `SUPPORTS` (Irrigation Council, Federal Water Ministry), `FUNDS` (Development Bank → Monitoring System), `REGULATES`
  (Regional Water Bureau → Reservoir), `OPERATES` (Hydropower Company → Reservoir).
- **Reactions:** hypotheses for the main actors, each labelled *AI-generated hypothesis*; in demo mode also labelled as rule-based.
- **Simulation:** the farmers' group and the hydropower side start on opposite sides; "Dry-season shortfall" should push the mean
  stance down and raise polarisation, "Protocol adopted with monitoring" should push it up. Compare runs in *Compare*.
- **Dynamic graph:** snapshots at approval, simulation start, checkpoints and completion; compare the first and last snapshot and
  confirm the research layer shows no change while the simulation layer does.
- **Trigger a persona:** make SIM09 (outage-worried customer) comment on a hydropower engineer's post and read the author's response.
