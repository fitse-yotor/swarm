"""Initialize databases and load the demo workspace.

    python -m app.seed            # create schema, users, demo cases; build their graphs
    python -m app.seed --no-build # skip graph builds (just upload sources)
    python -m app.seed --reset    # DROP all M2 Swarm tables and graph data first (local development only)

The demo cases and documents are fictional. All demo accounts use the password `demo1234`.
"""
import argparse
from pathlib import Path

from sqlalchemy import select, text

from app.core.db import Base, engine, session_scope
from app.core.neo4j import ensure_schema, get_driver
from app.core.security import hash_password
from app.models import AuditEvent, Case, ProcessingJob, SourceDocument, Tenant, User
from app.services import storage
from app.services.pipeline import run_graph_build

SEED_DIR = Path(__file__).resolve().parent.parent / "seed_data"
PASSWORD = "demo1234"
USERS = [
    ("Mira Okonjo", "admin@lattice.demo", "Administrator", "Active"),
    ("Samuel Teklu", "analyst@lattice.demo", "Lead analyst", "Active"),
    ("Lena Brandt", "lena@lattice.demo", "Analyst", "Active"),
    ("Yusuf Adeyemi", "reviewer@lattice.demo", "Reviewer", "Active"),
    ("Ines Carvalho", "viewer@lattice.demo", "Viewer", "Active"),
    ("Peter Nakamura", "peter@lattice.demo", "Analyst", "Suspended"),
]
CASES = [
    {"title": "Lake Varn water-sharing dispute", "owner": "analyst@lattice.demo", "scope_type": "country",
     "description": "Upstream dam filling and downstream irrigation pressure ahead of a basin summit.",
     "research_question": "How might domestic and cross-border actors respond to accelerated dam filling before the Kesh Summit?",
     "objective": "Compare discussion dynamics with and without a joint monitoring offer.",
     "tags": ["water", "negotiation", "fictional"],
     "files": ["VBC Quarterly Briefing — Q3.md", "Northline Press — Valley Dispatch.md",
               "IHC Technical Note — Inflow Modelling.txt"]},
    {"title": "Harbor City transit strike", "owner": "lena@lattice.demo", "scope_type": "organization",
     "description": "Labour dispute between transit workers and the metro authority.",
     "research_question": "Which actors shape public sentiment during a 48-hour strike?",
     "objective": "Map stakeholders before environment design.", "tags": ["labour", "urban", "fictional"],
     "files": ["Harbor City Labour Bulletin.txt"]},
]
EXTRACT = ["person", "organization", "country", "location", "event", "policy", "topic"]


def reset() -> None:
    Base.metadata.drop_all(engine)
    with get_driver().session() as s:
        s.run("MATCH (n:Entity) DETACH DELETE n")


def init_schema() -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.create_all(engine)
    ensure_schema()


def seed(build: bool) -> None:
    init_schema()
    jobs = []
    with session_scope() as db:
        if db.scalar(select(Tenant)):
            print("Already seeded — skipping demo data")
            return
        t = Tenant(name="Northbridge Institute")
        db.add(t)
        db.flush()
        users = {}
        for name, email, role, status in USERS:
            u = User(tenant_id=t.id, name=name, email=email, role=role, status=status,
                     password_hash=hash_password(PASSWORD))
            db.add(u)
            users[email] = u
        db.flush()
        for spec in CASES:
            owner = users[spec["owner"]]
            c = Case(tenant_id=t.id, owner_id=owner.id, extract_types=EXTRACT,
                     **{k: spec[k] for k in ("title", "description", "research_question", "objective", "tags",
                                             "scope_type")})
            db.add(c)
            db.flush()
            db.add(AuditEvent(tenant_id=t.id, case_id=c.id, actor=owner.name, action="case.create", target=c.title))
            for fn in spec["files"]:
                data = (SEED_DIR / fn).read_bytes()
                kind, media = storage.sniff(fn, data)
                digest = storage.checksum(data)
                db.add(SourceDocument(case_id=c.id, filename=fn, kind=kind, media_type=media, size=len(data),
                                      checksum=digest, uploaded_by=owner.name,
                                      storage_path=storage.store(t.id, c.id, digest, Path(fn).suffix.lower(), data)))
                db.add(AuditEvent(tenant_id=t.id, case_id=c.id, actor=owner.name, action="doc.upload", target=fn))
            if build:
                j = ProcessingJob(tenant_id=t.id, case_id=c.id, kind="graph_build", created_by=owner.name, stats={})
                db.add(j)
                db.flush()
                jobs.append(j.id)
    for jid in jobs:
        print(f"Building graph for job {jid}…")
        run_graph_build(jid)
    print(f"Seeded. Sign in as analyst@lattice.demo / {PASSWORD}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()
    if args.reset:
        reset()
    seed(build=not args.no_build)
