"""Create the fictional case ETH-GER-003 (Tamsa Reservoir operating rules) in a running M2 Swarm instance.

    backend/.venv/bin/python cases/create_gerar_case.py [--approve] [--run] [--ai] [--rounds 12]

Steps (each is skipped if it already exists, so the script can be re-run):
  1. create the case and upload the four source documents (all fictional);
  2. build the knowledge graph;
  3. with --approve: approve what the extractor found and approve the graph version. Approval takes the first snapshot and
     starts the reaction hypotheses. Without it, review and approve the graph yourself in the Review queue;
  4. create one environment per scenario (real actors context-only, synthetic personas imported from personas.txt);
  5. with --run: start a simulation for each scenario (--ai uses the AI-agent engine: slow).
Nothing is fetched from the internet; everything comes from the files next to this script.
"""
import argparse
import json
import time
from pathlib import Path

import httpx

PACK = Path(__file__).resolve().parent / "ETH-GER-003_Tamsa_Reservoir_Rules"
CASE = {
    "title": "Tamsa Reservoir Operating Rules (ETH-GER-003, fictional)",
    "research_question": "How might the actors around the Tamsa Reservoir respond to a proposed seasonal release protocol, and which scenarios harden or soften their positions?",
    "objective": "Fictional test case: exercise graph building, review, reactions, environments, simulation and the timeline.",
    "scope_type": "organization", "tags": ["ethiopia", "water", "fictional", "test"], "visibility": "Team",
}


def wait(c: httpx.Client, job_id: str, label: str) -> dict:
    while True:
        try:
            j = c.get(f"/jobs/{job_id}").json()
        except httpx.TransportError:
            time.sleep(4)
            continue
        if j["status"] in ("done", "failed", "cancelled"):
            print(f"  {label}: {j['status']}" + (f" — {j['error']}" if j.get("error") else ""))
            return j
        time.sleep(1.5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--email", default="analyst@lattice.demo")
    ap.add_argument("--password", default="demo1234")
    ap.add_argument("--approve", action="store_true", help="approve the extracted graph (starts reaction generation)")
    ap.add_argument("--run", action="store_true", help="run a simulation for every scenario")
    ap.add_argument("--ai", action="store_true", help="use the AI-agent engine for the runs (needs Ollama; slow)")
    ap.add_argument("--rounds", type=int, default=12)
    a = ap.parse_args()
    c = httpx.Client(base_url=f"{a.api}/api/v1", timeout=180)
    c.headers["Authorization"] = "Bearer " + c.post("/auth/login", json={"email": a.email, "password": a.password}).json()["access_token"]
    spec = json.loads((PACK / "scenarios.json").read_text(encoding="utf-8"))

    case = next((x for x in c.get("/cases").json() if x["title"] == CASE["title"]), None)
    if case:
        print("case exists:", case["id"])
    else:
        case = c.post("/cases", json=CASE).json()
        print("created case", case["id"])
        files = [("files", (p.name, p.read_bytes(), "text/markdown" if p.suffix == ".md" else "text/plain")) for p in sorted((PACK / "sources").iterdir())]
        r = c.post(f"/cases/{case['id']}/documents", files=files)
        r.raise_for_status()
        print("  uploaded", [p[1][0] for p in files])
        wait(c, c.post(f"/cases/{case['id']}/graph/build", json={}).json()["id"], "graph build")

    g = c.get(f"/cases/{case['id']}/graph").json()
    v = g["version"]
    print(f"  graph {v['label']} ({v['status']}): {len(g['nodes'])} entities, {len(g['edges'])} relationships")
    if a.approve and v["status"] == "draft":
        pending_n = [n["id"] for n in g["nodes"] if n["status"] == "pending"]
        pending_e = [e["id"] for e in g["edges"] if e["status"] == "pending" and e["evidence_ids"]]
        r = c.post(f"/cases/{case['id']}/graph/versions/{v['id']}/bulk-status", json={"node_ids": pending_n, "edge_ids": pending_e, "status": "approved"}).json()
        print(f"  approved {len(pending_n)} entities and {len(pending_e)} evidenced relationships ({r.get('skipped_unsupported', 0)} skipped)")
        ap_r = c.post(f"/cases/{case['id']}/graph/versions/{v['id']}/approve").json()
        print("  graph approved; reaction run started:", ap_r.get("reaction_run_id"), "| snapshot:", ap_r.get("snapshot_id"))
    elif v["status"] == "draft":
        print("  NOT approved yet: open the Review queue, approve entities and relationships, then press Approve on the graph.")

    envs = {e["name"]: e for e in c.get(f"/cases/{case['id']}/environments").json()}
    base = None
    for i, sc in enumerate(spec["scenarios"]):
        if sc["name"] in envs:
            env = envs[sc["name"]]
        elif i == 0:
            env = c.post(f"/cases/{case['id']}/environments", json={"name": sc["name"], "scenario": sc["text"], "config": {
                "rounds": a.rounds, "llm_personas": 0, "real_actors_context_only": True, "focus_label": spec["focus"], "scenario_shock": sc["shock"],
                "knowledge_notes": spec["knowledge_notes"], "agent_mode": "ai" if a.ai else "rules"}}).json()
            wait(c, env["job_id"], f"environment '{sc['name']}'")
            r = c.post(f"/environments/{env['id']}/personas", json={"text": (PACK / "personas.txt").read_text(encoding="utf-8")}).json()
            print(f"  imported {r.get('imported')} synthetic personas; skipped {len(r.get('skipped', []))}")
            env = c.get(f"/environments/{env['id']}").json()
        else:
            dup = c.post(f"/environments/{base['id']}/duplicate").json()
            env = c.patch(f"/environments/{dup['id']}", json={"revision": dup["revision"], "name": sc["name"], "scenario": sc["text"],
                                                              "config": {"scenario_shock": sc["shock"]}}).json()
            print(f"  scenario environment: {sc['name']} (push {sc['shock']:+.1f})")
        base = base or env
        if a.run and not [s for s in c.get(f"/cases/{case['id']}/simulations").json() if s["environment_id"] == env["id"]]:
            if env["status"] == "ready":
                c.post(f"/environments/{env['id']}/approve")
            s = c.post(f"/environments/{env['id']}/simulations", json={"name": f"{sc['name']} · {a.rounds} rounds", "rounds": a.rounds,
                                                                      "agent_mode": "ai" if a.ai else "rules"}).json()
            print(f"    started run '{s['name']}'")
    print(f"\nOpen: http://localhost:5173/cases/{case['id']}")


if __name__ == "__main__":
    main()
