import networkx as nx

METHOD = "Louvain modularity (networkx, seed 42) over non-rejected relationships"


def communities(nodes: list[dict], edges: list[dict]) -> tuple[dict[str, str], list[dict], dict[str, int]]:
    """Returns (node_id -> community id, community list, node_id -> degree)."""
    g = nx.Graph()
    g.add_nodes_from(n["id"] for n in nodes)
    for e in edges:
        if e.get("status") != "rejected" and g.has_node(e["s"]) and g.has_node(e["o"]):
            g.add_edge(e["s"], e["o"])
    deg = dict(g.degree())
    names = {n["id"]: n["name"] for n in nodes}
    groups = nx.community.louvain_communities(g, seed=42) if g.number_of_nodes() else []
    groups = sorted(groups, key=lambda c: (-len(c), min(c)))
    of, out = {}, []
    for i, ids in enumerate(groups):
        cid = f"cm{i}"
        hub = max(sorted(ids), key=lambda x: deg.get(x, 0))
        out.append({"id": cid, "name": f"{names[hub]} cluster" if len(ids) > 1 else names[hub], "size": len(ids),
                    "hub": hub})
        for x in ids:
            of[x] = cid
    return of, out, deg
