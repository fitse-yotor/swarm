"""Set up and run the scenario simulations for the three research cases.

    backend/.venv/bin/python cases/create_simulations.py [--rounds 12] [--llm-posts 1] [--no-run]

For each case: build the graph from its seed (if the case does not exist yet), create one
environment per test scenario (real actors context-only, synthetic personas imported from the
case document, a stated focus issue and a scenario push), then run every scenario and generate
its report. Runs execute one after another on the Celery worker; with a local CPU LLM each run
takes a few minutes, so the whole set can take an hour. Re-running skips what already exists.
"""
import argparse
import sys
import time
from pathlib import Path

import httpx
from pypdf import PdfReader

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import create_eth_sea_case as sea  # noqa: E402

TIG_PDF = HERE / "ETH-TIG-001_Tigray_War_and_Aftermath.pdf"
SEC_PDF = HERE / "ETH-SEC-002_Ethiopia_Military_Capability_and_Regional_Alignments.pdf"


def pdf_text(p: Path) -> str:
    return "\n".join(page.extract_text() for page in PdfReader(str(p)).pages)


CASES = [
    {
        "title": sea.CASE["title"], "seed": None,  # built by create_eth_sea_case.py
        "persona_text": lambda: sea.section(sea.STUDY, "## 6.", "## 7."),
        "focus": "Ethiopian sea access through a commercial port agreement",
        "scenarios": [
            ("Commercial corridor agreement", 0.6, sea.SCENARIO),
            ("Diplomatic deadlock", -0.4, "Hypothetical: talks between Ethiopia and its coastal neighbours stall; no access "
             "agreement is reached and public statements harden on all sides."),
            ("Regional integration", 0.5, "Hypothetical: several Horn of Africa states agree to jointly develop multiple ports, "
             "rail links and shared customs corridors open to all."),
            ("Information disorder", -0.3, "Hypothetical: a misleading quote claiming Ethiopia threatened force over sea access "
             "spreads online for a day before fact-checkers show it was fabricated."),
        ],
    },
    {
        "title": "The Tigray War (2020-2022) and the Post-Pretoria Period (ETH-TIG-001)", "seed": TIG_PDF,
        "question": ("How did the war in Tigray unfold between November 2020 and November 2022, how did the federal government, "
                     "the TPLF, Eritrea and international bodies present it, and how has implementation of the Pretoria "
                     "agreement developed since?"),
        "tags": ["ethiopia", "tigray", "tplf", "pretoria agreement", "eritrea", "african union"],
        "persona_text": lambda: pdf_text(TIG_PDF),
        "focus": "The federal government's handling of the war and the Pretoria peace process",
        "scenarios": [
            ("Pretoria implementation advances", 0.5, "Hypothetical: disarmament and the return of displaced people progress on "
             "schedule and are verified by African Union monitors."),
            ("Deadlock over legal status", -0.4, "Hypothetical: talks on the TPLF's legal registration collapse and each side "
             "accuses the other of violating the Pretoria agreement."),
            ("Border escalation risk", -0.6, "Hypothetical: unverified reports of troop movements near the Eritrean border spread "
             "online while officials call for restraint."),
            ("Information disorder", -0.3, "Hypothetical: an unverified casualty figure attributed to an anonymous source spreads "
             "widely before any confirmation."),
        ],
    },
    {
        "title": "Ethiopia's Military Capability and Regional Alignments (ETH-SEC-002)", "seed": SEC_PDF,
        "question": ("What military capabilities has Ethiopia publicly acquired or developed since 2018, and how have its "
                     "relationships with Eritrea, Somalia, Egypt, Türkiye, Saudi Arabia, the UAE and Israel shifted around the "
                     "Red Sea, the GERD and Somaliland?"),
        "tags": ["ethiopia", "horn of africa", "red sea", "egypt", "eritrea", "somalia", "turkiye", "gerd"],
        "persona_text": lambda: pdf_text(SEC_PDF),
        "focus": "Ethiopia's military build-up and sea-access push as a stabilising force",
        "scenarios": [
            ("Red Sea access talks resume", 0.3, "Hypothetical: Ethiopia and a coastal state open formal talks on a commercial "
             "corridor with no military provisions."),
            ("GERD negotiations restart", 0.4, "Hypothetical: Ethiopia, Egypt and Sudan announce a new round of talks on filling "
             "and operating the Grand Ethiopian Renaissance Dam."),
            ("Recognition cascade", -0.3, "Hypothetical: a second state signals it may recognise Somaliland, drawing protests "
             "from Somalia and its partners."),
            ("Capability misinformation", -0.4, "Hypothetical: a false claim about a new weapons delivery to Ethiopia circulates "
             "and is later debunked."),
        ],
    },
]


def wait_job(c: httpx.Client, job_id: str, label: str, quiet: bool = False) -> dict:
    while True:
        try:
            j = c.get(f"/jobs/{job_id}").json()
        except httpx.TransportError:  # API restarting or busy: keep waiting, the job runs on the worker regardless
            time.sleep(5)
            continue
        if j["status"] in ("done", "failed", "cancelled"):
            if not quiet:
                print(f"    {label}: {j['status']}" + (f" — {j['error']}" if j.get("error") else ""), flush=True)
            return j
        time.sleep(2)


def ensure_case(c: httpx.Client, spec: dict) -> dict:
    case = next((x for x in c.get("/cases").json() if x["title"] == spec["title"]), None)
    if case:
        print(f"case exists: {spec['title']}", flush=True)
        return case
    if spec["seed"] is None:
        sys.exit(f"Run create_eth_sea_case.py first to create '{spec['title']}'.")
    case = c.post("/cases", json={"title": spec["title"], "research_question": spec["question"], "objective": spec["question"],
                                  "scope_type": "country", "tags": spec["tags"], "visibility": "Team"}).json()
    print(f"case created: {spec['title']}", flush=True)
    with open(spec["seed"], "rb") as f:
        c.post(f"/cases/{case['id']}/documents", files=[("files", (spec["seed"].name, f.read(), "application/pdf"))])
    job = c.post(f"/cases/{case['id']}/graph/build", json={}).json()
    wait_job(c, job["id"], "graph build")
    return case


def ensure_envs(c: httpx.Client, spec: dict, case: dict) -> list[dict]:
    existing = {e["name"]: e for e in c.get(f"/cases/{case['id']}/environments").json()}
    base_name, base_shock, base_text = spec["scenarios"][0]
    base = existing.get(base_name)
    if not base:
        base = c.post(f"/cases/{case['id']}/environments", json={"name": base_name, "scenario": base_text, "config": {
            "rounds": 24, "llm_personas": 0, "llm_posts_per_round": 1, "real_actors_context_only": True,
            "focus_label": spec["focus"], "scenario_shock": base_shock}}).json()
        wait_job(c, base["job_id"], f"environment '{base_name}'")
    base = c.get(f"/environments/{base['id']}").json()
    if not any(a.get("synthetic") for a in base["agents"]):
        r = c.post(f"/environments/{base['id']}/personas", json={"text": spec["persona_text"]()}).json()
        print(f"    imported {r['imported']} synthetic personas into '{base_name}'", flush=True)
        base = c.get(f"/environments/{base['id']}").json()
    if base["config"].get("scenario_shock") != base_shock or base["config"].get("focus_name") != spec["focus"]:
        c.patch(f"/environments/{base['id']}", json={"revision": base["revision"], "config": {"scenario_shock": base_shock,
                                                                                            "real_actors_context_only": True}})
        base = c.get(f"/environments/{base['id']}").json()
    envs = [base]
    for name, shock, text in spec["scenarios"][1:]:
        env = existing.get(name)
        if not env:
            dup = c.post(f"/environments/{base['id']}/duplicate").json()
            c.patch(f"/environments/{dup['id']}", json={"revision": dup["revision"], "name": name, "scenario": text,
                                                         "config": {"scenario_shock": shock}})
            env = dup
            print(f"    scenario environment: {name} (push {shock:+.1f})", flush=True)
        envs.append(c.get(f"/environments/{env['id']}").json())
    return envs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--rounds", type=int, default=12)
    ap.add_argument("--llm-posts", type=int, default=1)
    ap.add_argument("--no-run", action="store_true", help="only create cases and environments")
    a = ap.parse_args()
    c = httpx.Client(base_url=f"{a.api}/api/v1", timeout=180)
    c.headers["Authorization"] = "Bearer " + c.post("/auth/login", json={"email": "analyst@lattice.demo",
                                                                        "password": "demo1234"}).json()["access_token"]
    queue = []
    for spec in CASES:
        case = ensure_case(c, spec)
        for env in ensure_envs(c, spec, case):
            sims = [s for s in c.get(f"/cases/{case['id']}/simulations").json() if s["environment_id"] == env["id"]]
            if not a.no_run and not sims:
                sims = [c.post(f"/environments/{env['id']}/simulations", json={
                    "name": f"{env['name']} · {a.rounds} rounds", "rounds": a.rounds, "llm_posts_per_round": a.llm_posts}).json()]
            # Existing runs still get waited on and reported, so a re-run finishes an interrupted batch.
            queue += [(case, env, sim) for sim in sims if not a.no_run and sim["status"] != "failed"]
        print(f"  open: http://localhost:5173/cases/{case['id']}/simulations", flush=True)
    print(f"\n{len(queue)} simulation runs to finish and report; they run one after another.", flush=True)
    for case, env, sim in queue:
        j = wait_job(c, sim["job_id"], f"run '{sim['name']}'")
        if j["status"] == "done" and c.get(f"/simulations/{sim['id']}").json()["report_count"] == 0:
            st = c.get(f"/simulations/{sim['id']}").json()["stats"]
            print(f"      mean stance {st['stance_start']:+.2f} -> {st['stance_end']:+.2f}, polarization "
                  f"{st['polarization_start']:.2f} -> {st['polarization_end']:.2f}, {st['llm_posts']} LLM posts", flush=True)
            rep = c.post(f"/simulations/{sim['id']}/reports").json()
            wait_job(c, rep["job_id"], "report")
    print("\nAll scenario runs finished.", flush=True)


if __name__ == "__main__":
    main()
