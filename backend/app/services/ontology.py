"""Schema registry for the case graph: entity types, relation types and their semantics."""
import re

ENTITY_TYPES: dict[str, dict[str, str]] = {
    "person": {"label": "Person", "neo4j": "Person", "desc": "Named individuals: officials, experts, journalists, leaders."},
    "organization": {"label": "Organization", "neo4j": "Organization",
                     "desc": "Agencies, ministries, companies, unions, NGOs and media outlets."},
    "country": {"label": "Country", "neo4j": "Country", "desc": "Sovereign states and their national-level positions."},
    "location": {"label": "Location", "neo4j": "Location",
                 "desc": "Places, infrastructure, regions and geographic features."},
    "event": {"label": "Event", "neo4j": "Event", "desc": "Meetings, protests, incidents and dated occurrences."},
    "policy": {"label": "Policy", "neo4j": "Policy",
               "desc": "Agreements, laws, protocols, tariffs and formal rules."},
    "topic": {"label": "Topic", "neo4j": "Topic", "desc": "Themes and issues discussed across sources."},
    "document": {"label": "Document", "neo4j": "Document", "desc": "Source documents represented as nodes for provenance."},
}

# Direction is always subject -> object. Analysts may add other UPPER_SNAKE types manually;
# extraction is constrained to this list.
RELATION_TYPES: dict[str, str] = {
    "MEMBER_OF": "Subject is a member of the object organization or body.",
    "PART_OF": "Subject is a unit or component of the object.",
    "LEADS": "Subject person heads or chairs the object organization.",
    "WORKS_FOR": "Subject is employed by or works for the object.",
    "REPRESENTS": "Subject acts on behalf of the object (country, organization, group).",
    "LOCATED_IN": "Subject is physically located in the object place.",
    "OPERATES": "Subject runs or operates the object (infrastructure, service).",
    "ADMINISTERS": "Subject administers or governs the object policy or process.",
    "REGULATES": "Subject policy or body regulates the object.",
    "HOSTS": "Subject hosts or convenes the object event.",
    "ORGANIZED": "Subject organized the object event.",
    "PARTICIPATED_IN": "Subject took part in the object event.",
    "ANNOUNCED": "Subject announced the object event, policy or decision.",
    "INITIATES": "Subject starts or carries out the object action or event.",
    "PUBLISHED": "Subject published the object document.",
    "AUTHORED": "Subject wrote the object document.",
    "REPORTS_ON": "Subject reports on, studies or describes the object.",
    "ADVISES": "Subject advises the object.",
    "MET_WITH": "Subject met with the object.",
    "NEGOTIATES_WITH": "Subject is negotiating with the object.",
    "SUPPORTS": "Subject expresses support for the object.",
    "OPPOSES": "Subject expresses opposition to the object.",
    "AFFECTS": "Subject has a stated effect on the object.",
    "DEPENDS_ON": "Subject depends on the object.",
    "BENEFITS": "Subject provides benefit to the object.",
    "PRECEDES": "Subject event happens before the object event.",
    "DISCUSSES": "Subject event or document discusses the object.",
    "CONCERNED_WITH": "Subject is concerned with the object topic.",
    "RELATED_TO": "Explicit stated relation that fits no other type.",
}
# Produced only by the heuristic extractor; never by the model.
CO_OCCURS = "CO_OCCURS_WITH"

EDGE_STATUSES = ("pending", "approved", "rejected", "conflict", "manual")
NODE_STATUSES = ("pending", "approved", "rejected", "conflict", "manual")
EPISTEMIC = ("observed", "reported", "inferred", "hypothetical")

_REL_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,40}$")


def normalize_rel_type(value: str) -> str:
    t = re.sub(r"\s+", "_", value.strip().upper())
    if not _REL_RE.match(t):
        raise ValueError("Relationship type must be UPPER_SNAKE_CASE letters, digits and underscores")
    return t


def neo4j_label(entity_type: str) -> str:
    return ENTITY_TYPES[entity_type]["neo4j"]
