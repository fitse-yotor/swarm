"""The shipped test cases must stay importable: personas parse cleanly, scenarios are in range, the setup script compiles."""
import json
from pathlib import Path

from app.services import personas

CASES = Path(__file__).resolve().parents[2] / "cases"
PACK = CASES / "ETH-GER-003_Tamsa_Reservoir_Rules"


def test_gerar_personas_parse_with_no_skipped_lines_and_four_topics():
    found, skipped = personas.parse((PACK / "personas.txt").read_text(encoding="utf-8"), {})
    assert len(found) == 14 and skipped == []
    assert {p["topic"] for p in found} == {"reservoir levels and power supply", "downstream irrigation water", "compensation and monitoring", "trust in the process"}
    assert min(p["stance"] for p in found) < -0.5 and max(p["stance"] for p in found) > 0.5  # both sides are represented
    agents = personas.to_agents(found, ["microblog", "forum"], set())
    assert all(a["synthetic"] and a["behavior"]["preset"] for a in agents)  # synthetic and given a behaviour profile


def test_gerar_scenarios_and_sources():
    spec = json.loads((PACK / "scenarios.json").read_text(encoding="utf-8"))
    assert len(spec["scenarios"]) == 4 and spec["focus"] and spec["knowledge_notes"]
    assert all(-1 <= s["shock"] <= 1 and len(s["text"]) > 40 for s in spec["scenarios"])
    assert min(s["shock"] for s in spec["scenarios"]) < 0 < max(s["shock"] for s in spec["scenarios"])
    sources = sorted((PACK / "sources").iterdir())
    assert [p.suffix for p in sources] == [".md", ".md", ".txt", ".md"]
    assert all("FICTIONAL" in p.read_text(encoding="utf-8")[:400] for p in sources)  # every source says it is invented


def test_all_case_scripts_compile():
    scripts = sorted(CASES.glob("create_*.py"))
    assert len(scripts) >= 3
    for script in scripts:
        compile(script.read_text(encoding="utf-8"), str(script), "exec")  # in memory: no bytecode files are written
