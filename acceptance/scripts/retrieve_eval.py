#!/usr/bin/env python3
"""Retrieval-layer evaluation against the delivered v1.2 index or the v1.3 candidate.

The script reuses the delivery package's own Store/retrieval code (copied under
scripts/harness/) and its bundled bge-small-zh-v1.5 model. It does not start or
modify the delivery services and forces CPU embedding to avoid GPU contention.

Usage:
  python retrieve_eval.py --kb v12 --cases ../cases/cases.jsonl --run-dir ../runs/<id>
  python retrieve_eval.py --kb v13 --cases ../cases/cases.jsonl --run-dir ../runs/<id>
"""
import argparse
import json
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE / "harness"
sys.path.insert(0, str(HARNESS))

KB_CONFIG = {
    "v12": {
        "version": "v1.2-reviewed-20261108",
        "release": "Z:/home/konglingrui/suibeagent/data/kb-v12-reviewed",
    },
    "v13": {
        "version": "v1.3-20261108",
        "release": "Z:/home/konglingrui/suibeagent/kb-v13-work/build",
    },
}

EMBEDDING_MODEL = (
    "Z:/home/konglingrui/suibeagent/delivery/dist/xiaomao-suite-v1.2.0/models/bge-small-zh-v1.5"
)


def norm(text):
    import re

    return re.sub(r"[\s|｜]+", "", text or "")


def load_cases(path):
    rows = []
    with open(path, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def summarize(records, kb):
    testable = [
        row
        for row in records
        if row["expected_doc_ids"] and row["expected_behavior"] in {"direct", "partial"}
    ]
    expected_quote_rows = [row for row in testable if row["quote_results"]]

    def ratio(rows, key):
        return round(sum(1 for row in rows if row[key]) / len(rows), 4) if rows else None

    by_category = {}
    for category in sorted({row["category"] for row in records}):
        rows = [row for row in records if row["category"] == category]
        rows_testable = [
            row for row in rows if row["expected_doc_ids"] and row["expected_behavior"] in {"direct", "partial"}
        ]
        by_category[category] = {
            "cases": len(rows),
            "testable": len(rows_testable),
            "doc_any_at_k": ratio(rows_testable, "doc_any_at_k"),
            "doc_all_at_k": ratio(rows_testable, "doc_all_at_k"),
            "quote_all_at_k": ratio(
                [row for row in rows_testable if row["quote_results"]], "quote_all_at_k"
            ),
            "key_phrase_all_at_k": ratio(rows_testable, "key_phrase_all_at_k"),
            "key_phrase_any_at_k": ratio(rows_testable, "key_phrase_any_at_k"),
            "quote_any_at_k": ratio([row for row in rows_testable if row["quote_results"]], "quote_any_at_k"),
            "mean_reciprocal_rank": round(
                statistics.mean(row["mrr"] for row in rows_testable), 4
            )
            if rows_testable
            else None,
        }

    latencies = [row["latency_ms"] for row in records if row["latency_ms"] is not None]
    summary = {
        "kb": kb,
        "kb_version": KB_CONFIG[kb]["version"],
        "k": records[0]["k"] if records else None,
        "cases": len(records),
        "testable_cases": len(testable),
        "not_applicable": len(records) - len(testable),
        "doc_any_at_k": ratio(testable, "doc_any_at_k"),
        "doc_all_at_k": ratio(testable, "doc_all_at_k"),
        "quote_all_at_k": ratio(expected_quote_rows, "quote_all_at_k"),
        "key_phrase_all_at_k": ratio(testable, "key_phrase_all_at_k"),
        "key_phrase_any_at_k": ratio(testable, "key_phrase_any_at_k"),
        "quote_any_at_k": ratio(expected_quote_rows, "quote_any_at_k"),
        "quote_coverage_mean": round(statistics.mean(row["quote_coverage"] for row in expected_quote_rows), 4) if expected_quote_rows else None,
        "key_phrase_coverage_mean": round(statistics.mean(row["key_phrase_coverage"] for row in testable if row["key_phrase_coverage"] is not None), 4) if testable else None,
        "mean_reciprocal_rank": round(statistics.mean(row["mrr"] for row in testable), 4)
        if testable
        else None,
        "cross_campus_contamination_cases": sum(
            1 for row in records if row["cross_campus_in_top"]
        ),
        "latency_ms": {
            "p50": round(statistics.median(latencies), 1) if latencies else None,
            "p95": round(sorted(latencies)[int(len(latencies) * 0.95) - 1], 1)
            if latencies
            else None,
            "max": max(latencies) if latencies else None,
        },
        "by_category": by_category,
    }
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kb", choices=["v12", "v13"], required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--k", type=int, default=8)
    parser.add_argument("--case", default="")
    parser.add_argument("--category", default="")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    import numpy  # noqa: F401

    config = KB_CONFIG[args.kb]
    (HARNESS / "data").mkdir(parents=True, exist_ok=True)
    (HARNESS / "data/kb-active.json").write_text(
        json.dumps({"version": config["version"], "release": config["release"]}, ensure_ascii=False),
        encoding="utf8",
    )

    import os

    os.environ["XIAOMAO_EMBEDDING_MODEL"] = EMBEDDING_MODEL
    os.environ["XIAOMAO_EMBEDDING_DEVICE"] = "cpu"

    from kb_store import Store
    from rag_embedding import load_model
    from retrieval import retrieve

    cases = load_cases(args.cases)
    cases = [case for case in cases if not case.get("paraphrase_of")]
    if args.case:
        cases = [case for case in cases if case["case_id"] == args.case]
    if args.category:
        cases = [case for case in cases if case["category"] == args.category]
    if args.limit:
        cases = cases[: args.limit]

    started = time.time()
    store = Store()
    model = load_model()
    load_seconds = round(time.time() - started, 1)

    run_dir = Path(args.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    raw_path = run_dir / ("raw-retrieval-%s.jsonl" % args.kb)

    records = []
    with raw_path.open("w", encoding="utf8") as handle:
        for index, case in enumerate(cases, 1):
            query = case.get("retrieval_query") or case["question"]
            t0 = time.time()
            hits = retrieve(query, model, store)
            latency_ms = round((time.time() - t0) * 1000, 1)
            docs = [hit.get("doc_id") for hit in hits[: args.k]
            ]
            expected_docs = case.get("expected_evidence", {}).get(args.kb + "_doc_ids", [])
            expected_phrases = case.get("expected_evidence", {}).get("key_phrases", [])
            phrase_hits = {}
            for phrase in expected_phrases:
                phrase_hits[phrase] = any(
                    norm(phrase) in norm(hit.get("text")) for hit in hits[: args.k]
                )
            quote_results = {}
            for source in case.get("standard_sources", []):
                if not source.get("in_" + args.kb):
                    continue
                quote_results[source["doc_id"] + "|" + source["quote"][:40]] = any(
                    norm(source["quote"]) in norm(hit.get("text")) for hit in hits[: args.k]
                )
            ranks = []
            for doc_id in expected_docs:
                if doc_id in docs:
                    ranks.append(docs.index(doc_id) + 1)
            mrr = 1.0 / min(ranks) if ranks else 0.0
            cross_in_top = any(
                hit.get("collection") == "cross_campus" for hit in hits[: args.k]
            )
            phrase_values = list(phrase_hits.values())
            quote_values = list(quote_results.values())
            record = {
                "case_id": case["case_id"],
                "category": case["category"],
                "question": case["question"],
                "retrieval_query": query,
                "expected_behavior": case["expected_behavior"].get(
                    "v1.2" if args.kb == "v12" else "v1.3"
                ),
                "expected_doc_ids": expected_docs,
                "expected_phrases": expected_phrases,
                "top_docs": docs,
                "top_titles": [hit.get("title") for hit in hits[: args.k]],
                "top_scores": [hit.get("final_score") for hit in hits[: args.k]],
                "top_collections": [hit.get("collection") for hit in hits[: args.k]],
                "doc_any_at_k": bool(set(expected_docs) & set(docs)) if expected_docs else None,
                "doc_all_at_k": set(expected_docs).issubset(set(docs)) if expected_docs else None,
                "phrase_hits": phrase_hits,
                "key_phrase_all_at_k": all(phrase_hits.values()) if phrase_hits else None,
                "key_phrase_any_at_k": any(phrase_hits.values()) if phrase_hits else None,
                "key_phrase_coverage": round(sum(phrase_values) / len(phrase_values), 4) if phrase_values else None,
                "quote_results": quote_results,
                "quote_all_at_k": all(quote_results.values()) if quote_results else None,
                "quote_any_at_k": any(quote_results.values()) if quote_results else None,
                "quote_coverage": round(sum(quote_values) / len(quote_values), 4) if quote_values else None,
                "mrr": round(mrr, 4),
                "cross_campus_in_top": cross_in_top,
                "latency_ms": latency_ms,
                "k": args.k,
            }
            records.append(record)
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(
                "[%d/%d] %s docs=%s quote_all=%s mrr=%.2f %.0fms"
                % (
                    index,
                    len(cases),
                    case["case_id"],
                    record["doc_any_at_k"],
                    record["quote_all_at_k"],
                    record["mrr"],
                    latency_ms,
                ),
                flush=True,
            )

    summary = summarize(records, args.kb)
    summary["load_seconds"] = load_seconds
    summary["raw_file"] = str(raw_path)
    (run_dir / ("summary-retrieval-%s.json" % args.kb)).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf8"
    )

    with (run_dir / ("summary-retrieval-%s.csv" % args.kb)).open(
        "w", encoding="utf8", newline=""
    ) as handle:
        import csv

        writer = csv.writer(handle)
        writer.writerow(["category", "cases", "testable", "doc_any_at_k", "doc_all_at_k", "quote_all_at_k", "key_phrase_all_at_k", "mrr"])
        for category, row in summary["by_category"].items():
            writer.writerow(
                [
                    category,
                    row["cases"],
                    row["testable"],
                    row["doc_any_at_k"],
                    row["doc_all_at_k"],
                    row["quote_all_at_k"],
                    row["key_phrase_all_at_k"],
                    row["mean_reciprocal_rank"],
                ]
            )

    lines = [
        "# 检索层结果（%s，K=%d）" % (summary["kb_version"], summary["k"]),
        "",
        "- 用例：%d（可测 %d，不适用 %d）" % (summary["cases"], summary["testable_cases"], summary["not_applicable"]),
        "- 目标文档任一命中率：%s" % summary["doc_any_at_k"],
        "- 目标文档全命中率（严格）：%s" % summary["doc_all_at_k"],
        "- 标准引文全命中率：%s" % summary["quote_all_at_k"],
        "- 关键事实短语全命中率：%s" % summary["key_phrase_all_at_k"],
        "- MRR：%s" % summary["mean_reciprocal_rank"],
        "- 跨校资料进入前 K 的用例数：%d" % summary["cross_campus_contamination_cases"],
        "- 单查询耗时 P50/P95/max：%s / %s / %s ms" % (
            summary["latency_ms"]["p50"],
            summary["latency_ms"]["p95"],
            summary["latency_ms"]["max"],
        ),
        "- 模型加载：%s 秒" % summary["load_seconds"],
        "",
        "## 分类",
        "",
        "| 类别 | 可测 | 文档任一 | 文档全命中 | 引文全命中 | 短语全命中 | MRR |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for category, row in summary["by_category"].items():
        lines.append(
            "| %s | %d | %s | %s | %s | %s | %s |"
            % (
                category,
                row["testable"],
                row["doc_any_at_k"],
                row["doc_all_at_k"],
                row["quote_all_at_k"],
                row["key_phrase_all_at_k"],
                row["mean_reciprocal_rank"],
            )
        )
    (run_dir / ("summary-retrieval-%s.md" % args.kb)).write_text(
        "\n".join(lines) + "\n", encoding="utf8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
