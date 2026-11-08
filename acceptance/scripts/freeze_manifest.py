#!/usr/bin/env python3
"""Freeze SHA-256 hashes for the v0.1 acceptance baseline."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INCLUDE = [
    "README.md",
    "BASELINE-v0.1.md",
    "正确性验收规范-v1.0.md",
    "cases/cases.jsonl",
    "cases/cases-review.csv",
    "cases/标准答案与证据表.csv",
    "cases/cases-stats.json",
    "docs/待核验资料与知识缺口.md",
    "docs/问题清单.md",
    "docs/验收报告模板.md",
    "reports/验收报告-v1.0-20261108.md",
    "reports/baseline/baseline.json",
    "reports/baseline/基线版本记录.md",
    "reports/static-validation/validation.json",
    "reports/static-validation/validation.md",
    "reports/coverage/case-coverage.csv",
    "reports/coverage/source-docs.csv",
    "reports/coverage/coverage-summary.json",
    "runs/run-20261108-v1/raw-retrieval-v12.jsonl",
    "runs/run-20261108-v1/raw-retrieval-v13.jsonl",
    "runs/run-20261108-v1/summary-retrieval-v12.json",
    "runs/run-20261108-v1/summary-retrieval-v13.json",
    "runs/run-20261108-v1/raw-tools.jsonl",
    "runs/run-20261108-v1/summary-tools.json",
    "runs/run-20261108-v1/README.md",
    "runs/run-20261108-v1/SMOKE-NOTE.md",
    "scripts/build_cases.py",
    "scripts/cases_common.py",
    "scripts/cases_a_b.py",
    "scripts/cases_c_d.py",
    "scripts/cases_e_f_p.py",
    "scripts/validate_cases.py",
    "scripts/retrieve_eval.py",
    "scripts/tool_eval.py",
    "scripts/generation_eval.py",
    "scripts/e2e_eval.py",
    "scripts/score_eval.py",
    "scripts/compare_runs.py",
    "scripts/coverage_report.py",
    "scripts/record_baseline.py",
    "scripts/tool_runner.cjs",
    "scripts/README.md",
]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    manifest = {}
    lines = []
    for relative in INCLUDE:
        path = ROOT / relative
        if not path.exists():
            manifest[relative] = {"bytes": None, "sha256": None, "exists": False}
            lines.append("MISSING  " + relative)
            continue
        digest = sha256(path)
        manifest[relative] = {"bytes": path.stat().st_size, "sha256": digest, "exists": True}
        lines.append("%s  %s" % (digest, relative))
    (ROOT / "MANIFEST.sha256").write_text("\n".join(lines) + "\n", encoding="utf8")
    (ROOT / "reports/baseline/file-hashes-v0.1.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf8"
    )
    print("files", len(manifest), "missing", sum(1 for value in manifest.values() if not value["exists"]))


if __name__ == "__main__":
    main()
