"""The built-in skills shipped with the app (DEFAULT_BUILTIN_SKILLS_DIR), and the analysis skill's script.

Moved from apps/agent/src/skills/skills.test.ts (issue #264, step 5): the
Python chat agent's image has no Node, so the script is Python now.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType

from api_py.config import DEFAULT_BUILTIN_SKILLS_DIR
from api_py.skill_catalog import builtin_skills

PROFILE = Path(DEFAULT_BUILTIN_SKILLS_DIR) / "analysis" / "scripts" / "profile.py"


def load_profile() -> ModuleType:
    # Run from its source: an import would leave a __pycache__ folder in the
    # skill, and every user would get it with the skill's files.
    module = ModuleType("analysis_profile")
    exec(compile(PROFILE.read_text("utf-8"), str(PROFILE), "exec"), module.__dict__)
    return module


def test_the_built_in_skills_load():
    skills = {s.name: s for s in builtin_skills(DEFAULT_BUILTIN_SKILLS_DIR)}
    assert sorted(skills) == ["analysis", "paper-search", "tldr", "write-skill"]
    analysis = skills["analysis"]
    assert analysis.needs_execution, "it ships a script"
    assert sorted(f.path for f in analysis.files) == [
        "SKILL.md",
        "reference/report-template.md",
        "scripts/profile.py",
    ]
    (skill_md,) = (f for f in analysis.files if f.path == "SKILL.md")
    assert "python3 .claude/skills/analysis/scripts/profile.py" in skill_md.data.decode()
    assert skills["write-skill"].model_invocable is False


def test_the_analysis_skills_profile_script_reads_csv_columns():
    profile = load_profile().profile
    out = profile('wafer,dose,lot\n1,30,A\n2,"31",B\n3,,"A, again"\n')
    assert out["rows"] == 3
    assert out["columns"][1] == {
        "name": "dose",
        "count": 2,
        "missing": 1,
        "type": "number",
        "min": 30,
        "max": 31,
        "mean": 30.5,
        "std": 0.707107,
    }
    assert out["columns"][2]["type"] == "text" and out["columns"][2]["distinct"] == 3
    # Numbers as JavaScript's Number() reads them, not Python's float().
    odd = profile("a,b,c\n0x10,1_000,inf\n1e2,2,3\n")["columns"]
    assert odd[0]["type"] == "number" and (odd[0]["min"], odd[0]["max"]) == (16, 100)
    assert odd[1]["type"] == odd[2]["type"] == "text"
    tsv = profile("x\ty\r\n1\thi\r\n\r\n2\thi\r\n")
    assert tsv["rows"] == 2 and tsv["columns"][1]["top"] == [{"value": "hi", "n": 2}]
    big = profile("n\n" + "\n".join(str(i) for i in range(300_000)) + "\n")
    assert (big["columns"][0]["min"], big["columns"][0]["max"]) == (0, 299_999)


def test_the_profile_script_runs_as_a_command(tmp_path: Path):
    data = tmp_path / "data.csv"
    data.write_text("﻿kind,n\na,1\nb,2\na,3\n", encoding="utf-8")
    done = subprocess.run(
        [sys.executable, "-I", str(PROFILE), str(data), "--top", "1"],
        capture_output=True,
        text=True,
        check=True,
    )
    out = json.loads(done.stdout)
    assert out["file"] == str(data) and out["rows"] == 3
    assert out["columns"][0]["name"] == "kind"
    assert out["columns"][0]["top"] == [{"value": "a", "n": 2}]
    usage = subprocess.run([sys.executable, "-I", str(PROFILE)], capture_output=True, text=True)
    assert usage.returncode == 2 and "usage" in usage.stderr
