"""Create case ETH-SEA-001 (Ethiopia's quest for sea access) in a running M2 Swarm instance.

    backend/.venv/bin/python cases/create_eth_sea_case.py [--api http://localhost:8000]

Documented material (case study minus the fictional comments, plus a sentence-form timeline)
becomes graph evidence. The fictional SIM01-SIM20 comments never enter the graph: they are
imported into the environment as SYNTHETIC personas, and real actors are context-only.
"""
import argparse
import re
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
STUDY = (HERE / "ETH_Sea_Access_Case_Study.md").read_text(encoding="utf-8")

TIMELINE = """On 15 October 2023, Prime Minister Abiy Ahmed set out a peaceful rationale for Ethiopian sea access (S01).

AFP Fact Check reported that a claim that a speech by Abiy Ahmed threatened force was misleading (S02).

On 1 January 2024, Ethiopia and Somaliland signed the Ethiopia-Somaliland Memorandum of Understanding on sea access (S03).

On 2 January 2024, Somalia rejected the Ethiopia-Somaliland Memorandum of Understanding on sovereignty grounds (S04).

On 31 August 2024, Djibouti Foreign Minister Mahmoud Ali Youssouf offered Ethiopia access through the port of Tadjoura (S05).

On 11 December 2024, Ethiopia and Somalia agreed the Ankara Declaration, facilitated by Türkiye and President Erdoğan, recognising a commercial-access pathway under Somali sovereignty (S06, S13).

On 20 March 2025, Abiy Ahmed reiterated a peaceful approach and ruled out war with Eritrea over sea access (S07).

On 25 March 2025, Foreign Ministry spokesperson Nebiat Getachew described Ethiopia's give-and-take diplomacy (S08).

On 18 September 2025, the Eritrean Ministry of Information expressed security concerns about Ethiopia's maritime ambitions (S09).

On 3 February 2026, Abiy Ahmed told parliament that Red Sea access is a long-term national need (S10).

On 6 October 2026, Abiy Ahmed reiterated the maritime-access priority after his reappointment (S11).

On 24 October 2026, Abiy Ahmed linked maritime access with long-term security and prosperity in a speech at the Tana Forum (S12)."""

CASE = {
    "title": "Ethiopia's Quest for Sea Access (ETH-SEA-001)",
    "description": ("Ethiopia's pursuit of reliable sea access, 2023-2026: official framing, responses from Somalia, "
                    "Somaliland, Eritrea, Djibouti and Türkiye, and media reporting. Commercial access is kept distinct "
                    "from sovereignty, military bases and recognition of Somaliland, whose status is treated as disputed."),
    "research_question": ("How has Ethiopia's pursuit of reliable sea access been presented by officials, interpreted by "
                          "regional and international governments, and reported in the media between October 2023 and "
                          "October 2026? Where do documented positions agree or conflict on commerce, sovereignty, "
                          "cooperation and security?"),
    "objective": ("Explore hypothetical scenarios (commercial corridor agreement, diplomatic deadlock, regional integration, "
                  "information disorder) with synthetic personas. Simulated outcomes are not forecasts or public opinion."),
    "scope_type": "country", "visibility": "Team",
    "tags": ["ethiopia", "sea access", "red sea", "somalia", "somaliland", "eritrea", "djibouti", "turkiye", "horn of africa"],
}
SCENARIO = ("Hypothetical: Ethiopia and a coastal partner announce a commercial port-access agreement based on transparent "
            "leasing and customs arrangements, explicitly without territorial or military provisions.")


def section(md: str, start: str, end: str) -> str:
    return md[md.index(start):md.index(end)]


def wait(c: httpx.Client, job_id: str, label: str) -> dict:
    while True:
        j = c.get(f"/jobs/{job_id}").json()
        if j["status"] in ("done", "failed", "cancelled"):
            print(f"  {label}: {j['status']}" + (f" — {j['error']}" if j.get("error") else ""))
            return j
        time.sleep(1.5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--email", default="analyst@lattice.demo")
    ap.add_argument("--password", default="demo1234")
    a = ap.parse_args()
    c = httpx.Client(base_url=f"{a.api}/api/v1", timeout=120)
    tok = c.post("/auth/login", json={"email": a.email, "password": a.password}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    existing = next((x for x in c.get("/cases").json() if x["title"] == CASE["title"]), None)
    if existing:  # add the material to the analyst's case instead of creating a duplicate
        case = existing
        print("adding to existing case", case["id"])
    else:
        case = c.post("/cases", json=CASE).json()
        print("created case", case["id"])
    documented = STUDY.replace(section(STUDY, "## 6.", "## 7."), "")  # fictional comments stay out of the evidence graph
    r = c.post(f"/cases/{case['id']}/documents", files=[
        ("files", ("ETH-SEA-001 - Case study (documented sections).md", documented.encode(), "text/markdown"))]).json()
    print("  uploaded", [d["filename"] for d in r.get("documents", r.get("accepted", []))] or r)
    c.post(f"/cases/{case['id']}/documents/text", json={"name": "ETH-SEA-001 - Documented timeline (analyst summary)", "text": TIMELINE})
    job = c.post(f"/cases/{case['id']}/graph/build", json={}).json()
    wait(c, job["id"], "graph build")

    env = c.post(f"/cases/{case['id']}/environments", json={
        "name": "Commercial corridor agreement", "scenario": SCENARIO,
        "config": {"rounds": 24, "llm_personas": 0, "llm_posts_per_round": 1, "real_actors_context_only": True,
                   "focus_label": "Ethiopian sea access through a commercial port agreement"}}).json()
    wait(c, env["job_id"], "environment")
    personas = section(STUDY, "## 6.", "## 7.")
    r = c.post(f"/environments/{env['id']}/personas", json={"text": personas}).json()
    print(f"  imported {r.get('imported')} synthetic personas; skipped {len(r.get('skipped', []))}")
    print(f"\nOpen: http://localhost:5173/cases/{case['id']}/environments/{env['id']}")
    if re.search(r"SIM\d+", documented):
        print("warning: synthetic persona text leaked into the documented source")


if __name__ == "__main__":
    main()
