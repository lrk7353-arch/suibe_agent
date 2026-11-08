#!/usr/bin/env python3
"""Generate version coverage tables for the gap document."""
import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

CASES = Path(__file__).resolve().parents[1] / "cases/cases.jsonl"
OUT = Path(__file__).resolve().parents[1] / "reports/coverage"


def main():
    rows = [json.loads(line) for line in CASES.open(encoding="utf8") if line.strip()]
    base = [row for row in rows if not row.get("paraphrase_of")]
    OUT.mkdir(parents=True, exist_ok=True)

    with (OUT / "case-coverage.csv").open("w", encoding="utf8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["case_id", "category", "question", "expected_v12", "expected_v13", "v12_quotes", "v13_quotes", "sources", "v12_docs", "v13_docs"])
        for row in rows:
            writer.writerow([
                row["case_id"], row["category"], row["question"],
                row["expected_behavior"].get("v1.2"), row["expected_behavior"].get("v1.3"),
                row["version_coverage"]["v12"]["quote_count"], row["version_coverage"]["v13"]["quote_count"],
                len(row["standard_sources"]),
                ";".join(row["expected_evidence"].get("v12_doc_ids", [])),
                ";".join(row["expected_evidence"].get("v13_doc_ids", [])),
            ])

    docs = {}
    for row in rows:
        for source in row["standard_sources"]:
            key = source["doc_id"]
            entry = docs.setdefault(key, {
                "doc_id": key, "title": source["title"], "date": source["published_at"],
                "url": source["url"], "in_v12": source["in_v12"], "in_v13": source["in_v13"],
                "v12_cases": set(), "v13_cases": set(), "quotes": set(),
            })
            if source["in_v12"]:
                entry["v12_cases"].add(row["case_id"])
            if source["in_v13"]:
                entry["v13_cases"].add(row["case_id"])
            entry["quotes"].add(source["quote"][:80])
    with (OUT / "source-docs.csv").open("w", encoding="utf8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["doc_id", "in_v12", "in_v13", "date", "title", "url", "v12_case_count", "v13_case_count"])
        for key in sorted(docs):
            entry = docs[key]
            writer.writerow([key, entry["in_v12"], entry["in_v13"], entry["date"], entry["title"], entry["url"], len(entry["v12_cases"]), len(entry["v13_cases"])])

    stats = {
        "base_cases": len(base),
        "v12_behavior": dict(Counter(row["expected_behavior"].get("v1.2") for row in base)),
        "v13_behavior": dict(Counter(row["expected_behavior"].get("v1.3") for row in base)),
        "v12_coverage": dict(Counter(row["version_coverage"]["v12"]["quote_count"] == len(row["standard_sources"]) and "all" or (row["version_coverage"]["v12"]["quote_count"] > 0 and "some" or "none") for row in base)),
        "v13_coverage": dict(Counter(row["version_coverage"]["v13"]["quote_count"] == len(row["standard_sources"]) and "all" or (row["version_coverage"]["v13"]["quote_count"] > 0 and "some" or "none") for row in base)),
        "v13_only_docs": sorted([key for key, entry in docs.items() if entry["in_v13"] and not entry["in_v12"]]),
        "v12_only_docs": sorted([key for key, entry in docs.items() if entry["in_v12"] and not entry["in_v13"]]),
    }
    (OUT / "coverage-summary.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
