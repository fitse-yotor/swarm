"""Settings page .env editing: parsing, masking and safe writes (pure functions, no services needed)."""
import pytest

from app.services import envfiles as ef

SAMPLE = """# Copy to .env
DATABASE_URL=postgresql+psycopg://swarm:swarm@localhost:5432/swarm
JWT_SECRET=change-me

# All models are local.
OLLAMA_MODEL=gemma4
EMPTY=
"""


def test_parse_keeps_comments_and_values():
    lines = ef.parse(SAMPLE)
    assert [ln.key for ln in lines if ln.key] == ["DATABASE_URL", "JWT_SECRET", "OLLAMA_MODEL", "EMPTY"]
    assert ef.render(lines) == SAMPLE
    assert ef.comments_by_key(lines)["OLLAMA_MODEL"] == "All models are local."


def test_secrets_are_masked_and_round_trip_unchanged():
    assert ef.mask("JWT_SECRET", "abc") == ef.MASK
    assert ef.mask("DATABASE_URL", "postgresql://u:pw@h/db") == f"postgresql://u:{ef.MASK}@h/db"
    assert ef.mask("OLLAMA_MODEL", "gemma4") == "gemma4"
    lines, changed = ef.apply(ef.parse(SAMPLE), {"JWT_SECRET": ef.MASK,
                                                 "DATABASE_URL": f"postgresql+psycopg://swarm:{ef.MASK}@localhost:5432/swarm"})
    assert changed == [] and ef.render(lines) == SAMPLE


def test_apply_sets_adds_removes_and_keeps_order():
    lines, changed = ef.apply(ef.parse(SAMPLE), {"OLLAMA_MODEL": "qwen3.5:4b", "NEW_KEY": "a b", "EMPTY": None})
    out = ef.render(lines)
    assert changed == ["OLLAMA_MODEL", "NEW_KEY", "EMPTY"]
    assert "OLLAMA_MODEL=qwen3.5:4b" in out and 'NEW_KEY="a b"' in out and "EMPTY=" not in out
    assert out.index("# All models are local.") < out.index("OLLAMA_MODEL=")


@pytest.mark.parametrize("key,value", [("lower", "x"), ("1BAD", "x"), ("OK", "two\nlines"), ("OK", "x" * 2001)])
def test_invalid_input_is_refused(key, value):
    with pytest.raises(ValueError):
        ef.apply(ef.parse(SAMPLE), {key: value})


def test_partial_mask_is_refused():
    with pytest.raises(ValueError):
        ef.apply(ef.parse(SAMPLE), {"JWT_SECRET": "x" + ef.MASK})


def test_write_backs_up_and_replaces(tmp_path, monkeypatch):
    env, tmpl = tmp_path / ".env", tmp_path / ".env.example"
    tmpl.write_text(SAMPLE)
    monkeypatch.setitem(ef.FILES, "t", ("Test", env, tmpl, ""))
    monkeypatch.setattr(ef, "REPO_DIR", tmp_path)
    assert ef.write("t", {"OLLAMA_MODEL": "qwen3.5:4b"}) == ["OLLAMA_MODEL"]  # first save starts from the template
    assert "OLLAMA_MODEL=qwen3.5:4b" in env.read_text() and "# Copy to .env" in env.read_text()
    ef.write("t", {"OLLAMA_MODEL": "llama3.2:3b"})
    assert "qwen3.5:4b" in (tmp_path / ".env.bak").read_text()
    d = ef.describe("t")
    secret = next(e for e in d["entries"] if e["key"] == "JWT_SECRET")
    assert secret["secret"] and secret["value"] == ef.MASK
