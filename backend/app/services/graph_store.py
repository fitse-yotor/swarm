"""Neo4j persistence for versioned case graphs.

Each graph version is a full, independent copy: `(:Entity:<Type> {version_id, id, ...})`
nodes joined by `[:REL {version_id, id, type, ...}]` relationships. Copy-on-version keeps
approved versions immutable and makes every snapshot directly queryable with Cypher.
Relationship semantics live in the `type` property (validated by the ontology) so that
retyping a claim is a property update rather than delete-and-recreate.
"""
import json
from typing import Any

from app.core.neo4j import get_driver
from app.services.ontology import ENTITY_TYPES, neo4j_label

NODE_FIELDS = ("id", "type", "name", "aliases", "description", "status", "confidence", "doc_ids", "evidence_ids",
               "dup_of", "not_dup")
EDGE_FIELDS = ("id", "type", "statement", "confidence", "status", "flag", "directed", "epistemic_status",
               "evidence_ids", "valid_from", "valid_to")
_ALL_LABELS = ":".join(v["neo4j"] for v in ENTITY_TYPES.values())


def _node_props(n: dict) -> dict:
    p = {k: n.get(k) for k in NODE_FIELDS}
    p["aliases"] = list(p["aliases"] or [])
    p["doc_ids"] = list(p["doc_ids"] or [])
    p["evidence_ids"] = list(p["evidence_ids"] or [])
    p["not_dup"] = bool(p["not_dup"])
    p["attrs"] = json.dumps(n.get("attrs") or {}, sort_keys=True)
    return p


def _edge_props(e: dict) -> dict:
    p = {k: e.get(k) for k in EDGE_FIELDS}
    p["evidence_ids"] = list(p["evidence_ids"] or [])
    p["directed"] = bool(True if p["directed"] is None else p["directed"])
    return p


def _node_out(p: dict) -> dict:
    d = {k: p.get(k) for k in NODE_FIELDS}
    d["attrs"] = json.loads(p.get("attrs") or "{}")
    return d


def write_version(case_id: str, version_id: str, nodes: list[dict], edges: list[dict]) -> None:
    by_type: dict[str, list[dict]] = {}
    for n in nodes:
        by_type.setdefault(n["type"], []).append(_node_props(n))
    with get_driver().session() as s:
        for t, rows in by_type.items():
            s.run(f"UNWIND $rows AS r CREATE (n:Entity:{neo4j_label(t)}) SET n = r, n.case_id = $cid, n.version_id = $vid",
                  rows=rows, cid=case_id, vid=version_id)
        if edges:
            rows = [{"s": e["s"], "o": e["o"], "p": _edge_props(e)} for e in edges]
            s.run("""UNWIND $rows AS r
                     MATCH (a:Entity {version_id: $vid, id: r.s}), (b:Entity {version_id: $vid, id: r.o})
                     CREATE (a)-[x:REL]->(b) SET x = r.p, x.case_id = $cid, x.version_id = $vid""",
                  rows=rows, cid=case_id, vid=version_id)


def read_version(version_id: str) -> tuple[list[dict], list[dict]]:
    with get_driver().session() as s:
        nodes = [_node_out(dict(r["n"])) for r in s.run("MATCH (n:Entity {version_id: $vid}) RETURN n", vid=version_id)]
        edges = []
        for r in s.run("MATCH (a:Entity {version_id: $vid})-[x:REL {version_id: $vid}]->(b) RETURN a.id AS s, b.id AS o, x",
                       vid=version_id):
            d = {k: r["x"].get(k) for k in EDGE_FIELDS}
            d["s"], d["o"] = r["s"], r["o"]
            edges.append(d)
    return nodes, edges


def delete_version(version_id: str) -> None:
    with get_driver().session() as s:
        s.run("MATCH (n:Entity {version_id: $vid}) DETACH DELETE n", vid=version_id)


def get_node(version_id: str, node_id: str) -> dict | None:
    with get_driver().session() as s:
        r = s.run("MATCH (n:Entity {version_id: $vid, id: $id}) RETURN n", vid=version_id, id=node_id).single()
        return _node_out(dict(r["n"])) if r else None


def get_edge(version_id: str, edge_id: str) -> dict | None:
    with get_driver().session() as s:
        r = s.run("MATCH (a)-[x:REL {version_id: $vid, id: $id}]->(b) RETURN a.id AS s, b.id AS o, x",
                  vid=version_id, id=edge_id).single()
        if not r:
            return None
        d = {k: r["x"].get(k) for k in EDGE_FIELDS}
        d["s"], d["o"] = r["s"], r["o"]
        return d


def update_node(case_id: str, version_id: str, node_id: str, changes: dict[str, Any]) -> None:
    props = {k: v for k, v in changes.items() if k in NODE_FIELDS and k not in ("id", "type")}
    if "attrs" in changes:
        props["attrs"] = json.dumps(changes["attrs"] or {}, sort_keys=True)
    with get_driver().session() as s:
        if props:
            s.run("MATCH (n:Entity {version_id: $vid, id: $id}) SET n += $p", vid=version_id, id=node_id, p=props)
        if "type" in changes:
            new = neo4j_label(changes["type"])
            s.run(f"MATCH (n:Entity {{version_id: $vid, id: $id}}) REMOVE n:{_ALL_LABELS} SET n:{new}, n.type = $t",
                  vid=version_id, id=node_id, t=changes["type"])


def create_node(case_id: str, version_id: str, node: dict) -> None:
    write_version(case_id, version_id, [node], [])


def update_edge(version_id: str, edge_id: str, changes: dict[str, Any]) -> None:
    props = {k: v for k, v in changes.items() if k in EDGE_FIELDS and k != "id"}
    with get_driver().session() as s:
        s.run("MATCH ()-[x:REL {version_id: $vid, id: $id}]->() SET x += $p", vid=version_id, id=edge_id, p=props)


def swap_edge(case_id: str, version_id: str, edge_id: str) -> None:
    e = get_edge(version_id, edge_id)
    if not e:
        return
    with get_driver().session() as s:
        s.run("MATCH ()-[x:REL {version_id: $vid, id: $id}]->() DELETE x", vid=version_id, id=edge_id)
    e["s"], e["o"] = e["o"], e["s"]
    write_version(case_id, version_id, [], [e])


def create_edge(case_id: str, version_id: str, edge: dict) -> None:
    write_version(case_id, version_id, [], [edge])


def merge_nodes(case_id: str, version_id: str, keep_id: str, drop_ids: list[str], keep_changes: dict) -> None:
    """Re-point the dropped nodes' relationships to `keep`, then remove the dropped nodes."""
    _, edges = read_version(version_id)
    moved, seen = [], set()
    drop = set(drop_ids)
    for e in edges:
        if e["s"] not in drop and e["o"] not in drop:
            seen.add((e["s"], e["type"], e["o"]))
    for e in edges:
        if e["s"] in drop or e["o"] in drop:
            s_, o_ = (keep_id if e["s"] in drop else e["s"]), (keep_id if e["o"] in drop else e["o"])
            if s_ == o_ or (s_, e["type"], o_) in seen:
                continue  # self-loop or duplicate of an existing claim after the merge
            seen.add((s_, e["type"], o_))
            moved.append({**e, "s": s_, "o": o_})
    with get_driver().session() as s:
        s.run("MATCH (n:Entity {version_id: $vid}) WHERE n.id IN $ids DETACH DELETE n", vid=version_id, ids=drop_ids)
        s.run("MATCH (n:Entity {version_id: $vid}) WHERE n.dup_of IN $ids SET n.dup_of = null", vid=version_id, ids=drop_ids)
    update_node(case_id, version_id, keep_id, keep_changes)
    write_version(case_id, version_id, [], moved)


def neighborhood(version_id: str, seed_ids: list[str], limit: int = 40) -> tuple[list[dict], list[dict]]:
    """Seeds plus one hop: the subgraph GraphRAG grounds its answers in."""
    if not seed_ids:
        return [], []
    with get_driver().session() as s:
        rows = s.run("""MATCH (a:Entity {version_id: $vid})-[x:REL {version_id: $vid}]-(b:Entity {version_id: $vid})
                        WHERE a.id IN $ids AND x.status <> 'rejected'
                        RETURN DISTINCT startNode(x).id AS s, endNode(x).id AS o, x,
                               (CASE WHEN b.id IN $ids THEN 0 ELSE 1 END) AS hop
                        ORDER BY hop, x.confidence DESC LIMIT $lim""", vid=version_id, ids=seed_ids, lim=limit)
        edges = []
        for r in rows:
            d = {k: r["x"].get(k) for k in EDGE_FIELDS}
            d["s"], d["o"] = r["s"], r["o"]
            edges.append(d)
        ids = sorted({*seed_ids, *(e["s"] for e in edges), *(e["o"] for e in edges)})
        nodes = [_node_out(dict(r["n"])) for r in
                 s.run("MATCH (n:Entity {version_id: $vid}) WHERE n.id IN $ids RETURN n", vid=version_id, ids=ids)]
    return nodes, edges
