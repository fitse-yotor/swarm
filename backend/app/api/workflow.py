"""Stages 2-5: environments, simulations, reports and conversations."""
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.jobs import enqueue, job_out
from app.core.db import SessionLocal, get_db
from app.core.deps import audit, current_user, get_case, require
from app.models import (Conversation, Environment, GraphVersion, ProcessingJob, Report, SimEvent, Simulation, User,
                        utcnow)
from app.services import interaction, personas, reactions, versions
from app.services.environment import DEFAULT_CONFIG

router = APIRouter(tags=["workflow"])


def owned(db: Session, user: User, model, obj_id: str, label: str):
    row = db.get(model, obj_id)
    if row is None:
        raise HTTPException(404, f"{label} not found")
    get_case(db, user, row.case_id)
    return row


def start_job(db: Session, user: User, case_id: str, kind: str, target_id: str, **stats) -> str:
    job = ProcessingJob(tenant_id=user.tenant_id, case_id=case_id, kind=kind, created_by=user.name,
                        stats={"target_id": target_id, **stats})
    db.add(job)
    db.flush()
    return job.id


def latest_job(db: Session, job_id: str | None) -> dict | None:
    j = db.get(ProcessingJob, job_id) if job_id else None
    return job_out(j).model_dump() if j else None


# ---------------------------------------------------------------- environments
def env_out(db: Session, e: Environment, full: bool = True) -> dict:
    v = db.get(GraphVersion, e.version_id)
    out = {k: getattr(e, k) for k in ("id", "case_id", "version_id", "name", "scenario", "status", "config", "revision",
                                      "created_by", "created_at", "updated_at", "job_id")}
    out.update(version_label=v.label if v else "?", version_status=v.status if v else None,
               agent_count=len(e.agents), link_count=len(e.links),
               simulation_count=db.scalar(select(func.count()).where(Simulation.environment_id == e.id)))
    if full:
        out.update(agents=e.agents, links=e.links, seed_posts=e.seed_posts, job=latest_job(db, e.job_id))
    return out


class EnvIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    scenario: str = Field(default="", max_length=4000)
    version_id: str | None = None
    config: dict = Field(default_factory=dict)


class EnvPatch(BaseModel):
    revision: int
    name: str | None = None
    scenario: str | None = None
    config: dict | None = None
    agents: list[dict] | None = None
    links: list[dict] | None = None


@router.get("/cases/{case_id}/environments")
def list_envs(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    rows = db.scalars(select(Environment).where(Environment.case_id == case_id).order_by(Environment.created_at.desc()))
    return [env_out(db, e, full=False) for e in rows]


@router.post("/cases/{case_id}/environments", status_code=202)
def create_env(case_id: str, body: EnvIn, bg: BackgroundTasks, db: Session = Depends(get_db),
               user: User = Depends(require("env.edit"))):
    case = get_case(db, user, case_id)
    v = versions.get_version(db, case, body.version_id) if body.version_id else (
        versions.latest_approved(db, case_id) or versions.latest(db, case_id))
    if v is None:
        raise HTTPException(409, "Build a knowledge graph before setting up an environment")
    allowed = {k: body.config[k] for k in DEFAULT_CONFIG.keys() | {"focus_node_id", "focus_label"} if k in body.config}
    env = Environment(case_id=case_id, version_id=v.id, name=body.name.strip(), scenario=body.scenario.strip(),
                      config={**DEFAULT_CONFIG, **allowed}, created_by=user.name)
    db.add(env)
    db.flush()
    env.job_id = start_job(db, user, case_id, "environment", env.id)
    case.stage = max(case.stage, 1)
    audit(db, user, "environment.create", f"{env.name} from {v.label}", case_id)
    db.commit()
    enqueue(env.job_id, bg)
    return env_out(db, env)


@router.get("/environments/{env_id}")
def read_env(env_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return env_out(db, owned(db, user, Environment, env_id, "Environment"))


@router.patch("/environments/{env_id}")
def patch_env(env_id: str, body: EnvPatch, db: Session = Depends(get_db), user: User = Depends(require("env.edit"))):
    env = owned(db, user, Environment, env_id, "Environment")
    if env.status == "approved":
        raise HTTPException(409, "Approved environments are read-only — duplicate it to make changes")
    if env.status == "preparing":
        raise HTTPException(409, "The environment is still being generated")
    if body.revision != env.revision:
        raise HTTPException(409, "Someone else changed this environment — reload to see their changes")
    if body.agents is not None:
        ids = [a.get("id") for a in body.agents]
        if len(set(ids)) != len(ids) or not all(ids) or len(ids) < 2:
            raise HTTPException(422, "Agents need unique ids, and an environment needs at least two")
        for a in body.agents:
            a["stance"] = max(-1.0, min(1.0, float(a.get("stance", 0))))
            a["activity"] = max(0.0, min(1.0, float(a.get("activity", 0.5))))
            a["influence"] = max(0.05, min(1.0, float(a.get("influence", 0.5))))
            for k, d in (("interests", []), ("facts", []), ("platforms", env.config["platforms"]), ("persona", ""),
                         ("bio", ""), ("profession", "Agent"), ("tone", "neutral"), ("kind", "individual")):
                a.setdefault(k, d)
        env.agents = body.agents
    ids = {a["id"] for a in env.agents}
    if body.links is not None:
        env.links = [x for x in body.links if x.get("s") in ids and x.get("o") in ids and x["s"] != x["o"]]
    else:
        env.links = [x for x in env.links if x["s"] in ids and x["o"] in ids]
    if body.config is not None:
        env.config = {**env.config, **{k: v for k, v in body.config.items() if k in DEFAULT_CONFIG}}
        if "real_actors_context_only" in body.config:
            speak = not bool(body.config["real_actors_context_only"])
            env.agents = [a if a.get("synthetic") else {**a, "speaks": speak} for a in env.agents]
    if body.name is not None:
        env.name = body.name.strip() or env.name
    if body.scenario is not None:
        env.scenario = body.scenario.strip()
        env.seed_posts = [s for s in env.seed_posts if s["source"] != "scenario injection"] + (
            [{"round": env.config["inject_round"], "content": env.scenario, "source": "scenario injection"}]
            if env.scenario else [])
    env.revision += 1
    audit(db, user, "environment.edit", env.name, env.case_id)
    db.commit()
    return env_out(db, env)


class PersonaIn(BaseModel):
    text: str = Field(min_length=10, max_length=200_000)
    topics: dict[str, str] = Field(default_factory=dict)
    replace: bool = False


@router.post("/environments/{env_id}/personas")
def import_personas(env_id: str, body: PersonaIn, db: Session = Depends(get_db), user: User = Depends(require("env.edit"))):
    """Add synthetic personas parsed from pasted case-study lines (SIM01 — label (place; viewpoint): "…")."""
    env = owned(db, user, Environment, env_id, "Environment")
    if env.status not in ("ready",):
        raise HTTPException(409, f"Personas can be imported into a ready environment (this one is {env.status})")
    found, skipped = personas.parse(body.text, body.topics)
    if not found:
        raise HTTPException(422, "No persona lines found. Expected lines like: SIM01 — Label (Country; viewpoint): \"comment\"")
    keep = [a for a in env.agents if not (body.replace and a.get("synthetic"))]
    new = personas.to_agents(found, env.config["platforms"], {a["id"] for a in keep})
    everyone = keep + new
    ids = {a["id"] for a in everyone}
    links = [x for x in env.links if x["s"] in ids and x["o"] in ids] + personas.links_for(new, everyone)
    env.agents, env.links, env.revision = everyone, links, env.revision + 1
    audit(db, user, "environment.personas", f"{env.name}: {len(new)} synthetic personas", env.case_id)
    db.commit()
    return {**env_out(db, env), "imported": len(new), "skipped": skipped}


@router.post("/environments/{env_id}/approve")
def approve_env(env_id: str, db: Session = Depends(get_db), user: User = Depends(require("env.approve"))):
    env = owned(db, user, Environment, env_id, "Environment")
    if env.status != "ready":
        raise HTTPException(409, f"Only a ready environment can be approved (this one is {env.status})")
    env.status = "approved"
    audit(db, user, "environment.approve", env.name, env.case_id)
    db.commit()
    return env_out(db, env)


@router.post("/environments/{env_id}/regenerate", status_code=202)
def regenerate_env(env_id: str, bg: BackgroundTasks, db: Session = Depends(get_db),
                   user: User = Depends(require("env.edit"))):
    env = owned(db, user, Environment, env_id, "Environment")
    if env.status in ("approved", "preparing"):
        raise HTTPException(409, f"Cannot regenerate a {env.status} environment")
    env.status, env.agents, env.links = "preparing", [], []
    env.job_id = start_job(db, user, env.case_id, "environment", env.id)
    db.commit()
    enqueue(env.job_id, bg)
    return env_out(db, env)


@router.post("/environments/{env_id}/duplicate", status_code=201)
def duplicate_env(env_id: str, db: Session = Depends(get_db), user: User = Depends(require("env.edit"))):
    src = owned(db, user, Environment, env_id, "Environment")
    if src.status not in ("ready", "approved"):
        raise HTTPException(409, "Only a generated environment can be duplicated")
    env = Environment(case_id=src.case_id, version_id=src.version_id, name=f"{src.name} (copy)", scenario=src.scenario,
                      status="ready", config=dict(src.config), agents=list(src.agents), links=list(src.links),
                      seed_posts=list(src.seed_posts), created_by=user.name)
    db.add(env)
    db.commit()
    return env_out(db, env)


@router.delete("/environments/{env_id}", status_code=204)
def delete_env(env_id: str, db: Session = Depends(get_db), user: User = Depends(require("env.edit"))):
    env = owned(db, user, Environment, env_id, "Environment")
    if env.status == "approved":
        raise HTTPException(409, "Approved environments cannot be deleted")
    audit(db, user, "environment.delete", env.name, env.case_id)
    db.delete(env)
    db.commit()


# ---------------------------------------------------------------- simulations
def sim_out(db: Session, s: Simulation, full: bool = True) -> dict:
    env = db.get(Environment, s.environment_id)
    out = {k: getattr(s, k) for k in ("id", "case_id", "environment_id", "name", "engine", "status", "created_by",
                                      "created_at", "finished_at", "job_id")}
    cfg = (s.config or {}).get("config", {})
    out.update(environment_name=env.name if env else "?", rounds_total=cfg.get("rounds"), rounds_done=len(s.rounds),
               platforms=cfg.get("platforms", []), agent_count=len((s.config or {}).get("agents", [])),
               report_count=db.scalar(select(func.count()).where(Report.simulation_id == s.id)))
    if full:
        out.update(rounds=s.rounds, stats=s.stats, agents=(s.config or {}).get("agents", []),
                   links=(s.config or {}).get("links", []), config=cfg, job=latest_job(db, s.job_id),
                   scenario=env.scenario if env else "")
    return out


class SimIn(BaseModel):
    name: str | None = None
    rounds: int | None = Field(default=None, ge=1, le=200)
    llm_posts_per_round: int | None = Field(default=None, ge=0, le=10)
    seed: int | None = None
    agent_mode: str | None = Field(default=None, pattern=r"^(rules|ai)$")
    ai_turns_per_round: int | None = Field(default=None, ge=1, le=20)
    inject_round: int | None = Field(default=None, ge=0, le=200)


@router.get("/cases/{case_id}/simulations")
def list_sims(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    rows = db.scalars(select(Simulation).where(Simulation.case_id == case_id).order_by(Simulation.created_at.desc()))
    return [sim_out(db, s, full=False) for s in rows]


@router.post("/environments/{env_id}/simulations", status_code=202)
def start_sim(env_id: str, body: SimIn, bg: BackgroundTasks, db: Session = Depends(get_db),
              user: User = Depends(require("sim.run"))):
    env = owned(db, user, Environment, env_id, "Environment")
    if env.status not in ("ready", "approved"):
        raise HTTPException(409, f"The environment is {env.status}; it must be ready or approved")
    overrides = {k: v for k, v in body.model_dump().items() if v is not None and k != "name"}
    n = db.scalar(select(func.count()).where(Simulation.case_id == env.case_id)) + 1
    sim = Simulation(case_id=env.case_id, environment_id=env.id, name=body.name or f"Run {n} · {env.name}",
                     created_by=user.name,
                     config={"config": {**env.config, **overrides}, "agents": env.agents, "links": env.links,
                             "seed_posts": env.seed_posts, "environment_revision": env.revision})
    db.add(sim)
    db.flush()
    sim.job_id = start_job(db, user, env.case_id, "simulation", sim.id)
    case = get_case(db, user, env.case_id)
    case.stage = max(case.stage, 2)
    audit(db, user, "simulation.start", sim.name, env.case_id)
    db.commit()
    enqueue(sim.job_id, bg)
    return sim_out(db, sim)


@router.get("/simulations/{sim_id}")
def read_sim(sim_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return sim_out(db, owned(db, user, Simulation, sim_id, "Simulation"))


@router.get("/simulations/{sim_id}/events")
def sim_events(sim_id: str, platform: str | None = None, agent: str | None = None, after_round: int = -1,
               originals: bool = False, limit: int = 200, db: Session = Depends(get_db),
               user: User = Depends(current_user)):
    owned(db, user, Simulation, sim_id, "Simulation")
    q = select(SimEvent).where(SimEvent.simulation_id == sim_id, SimEvent.round > after_round)
    if platform:
        q = q.where(SimEvent.platform == platform)
    if agent:
        q = q.where(SimEvent.agent_id == agent)
    if originals:
        q = q.where(SimEvent.action.in_(["CREATE_POST", "CREATE_COMMENT", "REPOST"]))
    rows = db.scalars(q.order_by(SimEvent.round.desc(), SimEvent.id).limit(min(limit, 1000)))
    return [{k: getattr(e, k) for k in ("id", "round", "platform", "agent_id", "agent_name", "action", "content",
                                        "target_id", "stance", "likes", "replies", "reposts", "generated_by", "why")}
            for e in rows]


@router.get("/simulations/{sim_id}/reaction-graph")
def reaction_graph(sim_id: str, post_id: str | None = None, agent_id: str | None = None, db: Session = Depends(get_db),
                   user: User = Depends(current_user)):
    """scope = whole run (agents), one post's cascade, or everything one persona posted and the reactions it drew."""
    sim = owned(db, user, Simulation, sim_id, "Simulation")
    if post_id:
        ev = db.get(SimEvent, post_id)
        if ev is None or ev.simulation_id != sim.id:
            raise HTTPException(404, "Post not found in this simulation")
        return reactions.cascade_graph(db, sim, [post_id])
    if agent_id:
        if agent_id not in reactions.agents_of(sim):
            raise HTTPException(404, "Agent not found in this simulation")
        return reactions.agent_graph(db, sim, agent_id)
    return reactions.interaction_graph(db, sim)


class ActionIn(BaseModel):
    agent_id: str
    action: str = Field(pattern=r"^(CREATE_POST|CREATE_COMMENT|REPOST|LIKE_POST|DISLIKE_POST)$")
    platform: str = Field(default="microblog", pattern=r"^(microblog|forum)$")
    target_id: str | None = None
    content: str = Field(default="", max_length=1000)
    react: bool = False        # let the other personas react to the new post / comment / repost
    use_llm: bool = False      # write the text with the local model (15-40 s) instead of a template


@router.post("/simulations/{sim_id}/actions", status_code=201)
def trigger_action(sim_id: str, body: ActionIn, db: Session = Depends(get_db), user: User = Depends(require("sim.run"))):
    """Make one persona post, comment, repost, like or dislike inside a finished run (optionally with reactions)."""
    sim = owned(db, user, Simulation, sim_id, "Simulation")
    if sim.status != "done":
        raise HTTPException(409, f"Actions can be triggered in a finished run (this one is {sim.status})")
    agent = reactions.agents_of(sim).get(body.agent_id)
    if agent is None:
        raise HTTPException(404, "Agent not found in this simulation")
    if not agent.get("speaks", True):
        raise HTTPException(409, "This real actor is context-only: no statements are generated in their name")
    target = None
    if body.action != "CREATE_POST":
        target = db.get(SimEvent, body.target_id or "")
        if target is None or target.simulation_id != sim.id:
            raise HTTPException(422, "Choose the post to comment on, repost, like or dislike")
        if target.agent_id == body.agent_id:
            raise HTTPException(422, "A persona cannot react to its own post")
        if body.action == "DISLIKE_POST" and target.platform != "forum":
            raise HTTPException(422, "Dislike exists on the forum only")
        if target.action not in reactions.CONTENT_ACTIONS:
            raise HTTPException(422, "That event is not a post or comment")
    elif body.content.strip() == "" and not body.use_llm:
        pass  # template post
    created = reactions.trigger(db, sim, agent_id=body.agent_id, action=body.action, platform=body.platform, target=target,
                                content=body.content, react=body.react, use_llm=body.use_llm, actor=user.name)
    audit(db, user, "simulation.trigger", f"{agent['name']} {body.action}", sim.case_id, simulation=sim.id)
    db.commit()
    return {"events": [{k: getattr(e, k) for k in ("id", "round", "platform", "agent_id", "agent_name", "action", "content", "target_id",
                                                   "stance", "likes", "replies", "reposts", "generated_by", "why")} for e in created],
            "target": {"id": target.id, "likes": target.likes, "reposts": target.reposts, "replies": target.replies} if target else None}


@router.delete("/simulations/{sim_id}", status_code=204)
def delete_sim(sim_id: str, db: Session = Depends(get_db), user: User = Depends(require("sim.run"))):
    sim = owned(db, user, Simulation, sim_id, "Simulation")
    if sim.status in ("queued", "running"):
        raise HTTPException(409, "Cancel the run before deleting it")
    audit(db, user, "simulation.delete", sim.name, sim.case_id)
    db.delete(sim)
    db.commit()


# ---------------------------------------------------------------- reports
def rep_out(db: Session, r: Report, full: bool = True) -> dict:
    sim = db.get(Simulation, r.simulation_id)
    out = {k: getattr(r, k) for k in ("id", "case_id", "simulation_id", "title", "status", "model", "created_by",
                                      "created_at", "approved_by", "approved_at", "job_id")}
    out["simulation_name"] = sim.name if sim else "?"
    if full:
        out.update(sections=r.sections, facts=r.facts, job=latest_job(db, r.job_id))
    return out


class ReportPatch(BaseModel):
    sections: list[dict]


@router.get("/cases/{case_id}/reports")
def list_reports(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    rows = db.scalars(select(Report).where(Report.case_id == case_id).order_by(Report.created_at.desc()))
    return [rep_out(db, r, full=False) for r in rows]


@router.post("/simulations/{sim_id}/reports", status_code=202)
def create_report(sim_id: str, bg: BackgroundTasks, db: Session = Depends(get_db),
                  user: User = Depends(require("report.edit"))):
    sim = owned(db, user, Simulation, sim_id, "Simulation")
    if sim.status != "done":
        raise HTTPException(409, "Reports can only be generated from a finished simulation")
    rep = Report(case_id=sim.case_id, simulation_id=sim.id, title=f"Report — {sim.name}", created_by=user.name)
    db.add(rep)
    db.flush()
    rep.job_id = start_job(db, user, sim.case_id, "report", rep.id)
    case = get_case(db, user, sim.case_id)
    case.stage = max(case.stage, 3)
    audit(db, user, "report.create", rep.title, sim.case_id)
    db.commit()
    enqueue(rep.job_id, bg)
    return rep_out(db, rep)


@router.get("/reports/{rep_id}")
def read_report(rep_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return rep_out(db, owned(db, user, Report, rep_id, "Report"))


@router.patch("/reports/{rep_id}")
def edit_report(rep_id: str, body: ReportPatch, db: Session = Depends(get_db),
                user: User = Depends(require("report.edit"))):
    rep = owned(db, user, Report, rep_id, "Report")
    if rep.status != "draft":
        raise HTTPException(409, f"Only draft reports can be edited (this one is {rep.status})")
    old = {s["id"]: s for s in rep.sections}
    new = []
    for s in body.sections:
        prev = old.get(s.get("id"))
        if prev is None:
            raise HTTPException(422, f"Unknown section {s.get('id')}")
        body_text = str(s.get("body", prev["body"]))
        new.append({**prev, "body": body_text, "kind": "edited" if body_text != prev["body"] else prev["kind"]})
    rep.sections = new
    audit(db, user, "report.edit", rep.title, rep.case_id)
    db.commit()
    return rep_out(db, rep)


@router.post("/reports/{rep_id}/approve")
def approve_report(rep_id: str, db: Session = Depends(get_db), user: User = Depends(require("report.approve"))):
    rep = owned(db, user, Report, rep_id, "Report")
    if rep.status != "draft":
        raise HTTPException(409, f"Only draft reports can be approved (this one is {rep.status})")
    rep.status, rep.approved_by, rep.approved_at = "approved", user.name, utcnow()
    case = get_case(db, user, rep.case_id)
    case.stage = max(case.stage, 4)
    audit(db, user, "report.approve", rep.title, rep.case_id)
    db.commit()
    return rep_out(db, rep)


@router.get("/reports/{rep_id}/export", response_class=PlainTextResponse)
def export_report(rep_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    rep = owned(db, user, Report, rep_id, "Report")
    head = (f"# {rep.title}\n\n_Status: {rep.status} · generated {rep.created_at:%Y-%m-%d %H:%M} · narrative: "
            f"{rep.model}_\n\n> Simulated outcomes, not predictions.\n")
    body = "\n\n".join(f"## {s['title']}\n\n_{s['kind']}_\n\n{s['body']}" for s in rep.sections)
    return PlainTextResponse(head + "\n" + body, headers={"Content-Disposition": f'attachment; filename="{rep.id}.md"'})


# ---------------------------------------------------------------- conversations
class ConvIn(BaseModel):
    target: str = Field(pattern=r"^(graph|report:[\w-]+|agent:[\w-]+)$")
    simulation_id: str | None = None


class MsgIn(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


def conv_out(c: Conversation, full: bool = True) -> dict:
    out = {k: getattr(c, k) for k in ("id", "case_id", "simulation_id", "target", "title", "created_by", "created_at",
                                      "updated_at")}
    out["message_count"] = len(c.messages)
    if full:
        out["messages"] = c.messages
    return out


@router.get("/cases/{case_id}/conversations")
def list_convs(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    rows = db.scalars(select(Conversation).where(Conversation.case_id == case_id, Conversation.created_by == user.name)
                      .order_by(Conversation.updated_at.desc()))
    return [conv_out(c, full=False) for c in rows]


@router.post("/cases/{case_id}/conversations", status_code=201)
def create_conv(case_id: str, body: ConvIn, db: Session = Depends(get_db), user: User = Depends(require("chat.use"))):
    get_case(db, user, case_id)
    kind, _, ref = body.target.partition(":")
    if kind == "report":
        rep = owned(db, user, Report, ref, "Report")
        if not rep.sections:
            raise HTTPException(409, "The report is not ready yet")
        title, sim_id = f"Report agent · {rep.title.removeprefix('Report — ')}", rep.simulation_id
    elif kind == "agent":
        sim = owned(db, user, Simulation, body.simulation_id or "", "Simulation")
        agent = next((a for a in (sim.config or {}).get("agents", []) if a["id"] == ref), None)
        if agent is None or sim.status != "done":
            raise HTTPException(409, "Agent not found in a finished simulation")
        if not agent.get("speaks", True):
            raise HTTPException(409, "This real actor was context-only — no statements are generated in their name. "
                                     "Use Ask the graph for their documented positions.")
        title, sim_id = f"{agent['name']} · {sim.name}", sim.id
    else:
        if versions.latest(db, case_id) is None:
            raise HTTPException(409, "This case has no graph yet")
        title, sim_id = "Ask the graph", None
    c = Conversation(case_id=case_id, simulation_id=sim_id, target=body.target, title=title, created_by=user.name)
    db.add(c)
    db.commit()
    return conv_out(c)


def own_conv(db: Session, user: User, conv_id: str) -> Conversation:
    c = owned(db, user, Conversation, conv_id, "Conversation")
    if c.created_by != user.name:
        raise HTTPException(404, "Conversation not found")
    return c


@router.get("/conversations/{conv_id}")
def read_conv(conv_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return conv_out(own_conv(db, user, conv_id))


@router.post("/conversations/{conv_id}/messages")
def send_message(conv_id: str, body: MsgIn, db: Session = Depends(get_db), user: User = Depends(require("chat.use"))):
    """Stream the reply as plain text; both turns are saved once the stream completes."""
    conv = own_conv(db, user, conv_id)
    tokens, model = interaction.reply(db, conv, body.content)
    asked_at = datetime.now().isoformat(timespec="seconds")

    def gen():
        parts: list[str] = []
        try:
            for t in tokens:
                parts.append(t)
                yield t
        except Exception as e:  # model dropped mid-answer: keep what arrived and say so
            msg = f"\n\n_[Reply interrupted: {type(e).__name__}]_"
            parts.append(msg)
            yield msg
        finally:
            with SessionLocal() as s:
                c = s.get(Conversation, conv_id)
                c.messages = [*c.messages, {"role": "user", "content": body.content, "at": asked_at},
                              {"role": "assistant", "content": "".join(parts), "model": model,
                               "at": datetime.now().isoformat(timespec="seconds")}]
                c.updated_at = utcnow()
                s.commit()

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8", headers={"X-Model": model,
                                                                                     "Cache-Control": "no-cache"})


@router.delete("/conversations/{conv_id}", status_code=204)
def delete_conv(conv_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    db.delete(own_conv(db, user, conv_id))
    db.commit()
