#!/usr/bin/env python3
"""Rule-based auto scoring for generation/e2e records.

This is an initial screen only. Scope, source correspondence and expression
still require human review; the output is labelled "自动初评".
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path


WEIGHTS = {
    "core_facts": 30,
    "scope": 20,
    "source": 20,
    "coverage": 15,
    "temporal": 10,
    "expression": 5,
}


def score(record):
    checks = record.get("checks") or {}
    answer = (record.get("response") or {}).get("answer") or record.get("answer") or ""
    fact_hits = checks.get("fact_hits") or {}
    facts_ratio = (
        sum(1 for value in fact_hits.values() if value) / len(fact_hits) if fact_hits else None
    )
    forbidden = checks.get("forbidden_hits") or []
    expected = checks.get("expected_behavior", "direct")

    core = WEIGHTS["core_facts"] * (facts_ratio if facts_ratio is not None else (1.0 if expected in {"clarify", "gap"} else 0.0))
    scope = 0 if forbidden else WEIGHTS["scope"]
    if checks.get("source_support") is False:
        source = 0
    elif checks.get("citation_present") or expected in {"clarify", "gap"}:
        source = WEIGHTS["source"]
    else:
        source = WEIGHTS["source"] * 0.5
    coverage = WEIGHTS["coverage"] if checks.get("pass_rule") else WEIGHTS["coverage"] * 0.4
    temporal = 0 if forbidden else WEIGHTS["temporal"]
    length = len(re.sub(r"\s+", "", answer))
    expression = WEIGHTS["expression"] if 20 <= length <= 400 else WEIGHTS["expression"] * 0.5
    total = round(core + scope + source + coverage + temporal + expression, 1)
    veto = []
    if forbidden:
        veto.append("forbidden_assertion")
    if checks.get("source_support") is False:
        veto.append("citation_not_supporting")
    if expected == "direct" and facts_ratio is not None and facts_ratio < 1:
        veto.append("missing_required_fact")
    passed = not veto and total >= 85
    return {
        "case_id": record.get("case_id"),
        "expected_behavior": expected,
        "fact_coverage": facts_ratio,
        "forbidden_hits": forbidden,
        "veto": veto,
        "scores": {
            "core_facts": round(core, 1),
            "scope": round(scope, 1),
            "source": round(source, 1),
            "coverage": round(coverage, 1),
            "temporal": round(temporal, 1),
            "expression": round(expression, 1),
        },
        "total": total,
        "pass_auto": passed,
        "review_status": "自动初评",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    rows = [json.loads(line) for line in open(args.raw, encoding="utf8") if line.strip()]
    scored = [score(row) for row in rows]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf8") as handle:
        for row in scored:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    with (out.parent / (out.stem + ".csv")).open("w", encoding="utf8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["case_id", "expected", "fact_coverage", "veto", "total", "pass_auto", "review_status"])
        for row in scored:
            writer.writerow([
                row["case_id"], row["expected_behavior"], row["fact_coverage"],
                "|".join(row["veto"]), row["total"], row["pass_auto"], row["review_status"],
            ])
    summary = {
        "cases": len(scored),
        "pass_auto": sum(1 for row in scored if row["pass_auto"]),
        "veto_cases": sum(1 for row in scored if row["veto"]),
        "mean_total": round(sum(row["total"] for row in scored) / len(scored), 1) if scored else None,
        "note": "自动初评；关键事实/否决项需人工复核。",
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
