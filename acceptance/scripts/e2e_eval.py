#!/usr/bin/env python3
"""End-to-end /ask evaluation against the delivered web service.

The service must be running on the configured ports with the delivered model.
If it is not, the script writes a blocked record and exits 2; it never starts or
stops the delivery services.
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def norm(text):
    return re.sub(r"[\s|｜]+", "", text or "")


def get_json(url, timeout=5):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf8"))


def post_json(url, payload, timeout=120):
    body = json.dumps(payload, ensure_ascii=False).encode("utf8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf8"))


def build_context(case):
    context = {}
    if case.get("retrieval_query"):
        context["ragQuestion"] = case["retrieval_query"][:500]
    context["topic"] = case["category"][:40]
    profile = case.get("user_profile") or {}
    student_type = profile.get("student_category")
    if isinstance(student_type, str) and student_type:
        context["studentType"] = student_type[:40]
    return context


def check_answer(case, payload):
    answer = payload.get("answer", "")
    answer_norm = norm(answer)
    expected = case.get("expected_behavior", {}).get("v1.2", "direct")
    fact_hits = {}
    for fact in case.get("required_facts", []):
        value = fact.get("value")
        if value and fact.get("critical", True):
            fact_hits[fact["key"]] = norm(value) in answer_norm
    forbidden_hits = []
    for item in case.get("forbidden_assertions", []):
        if item and norm(item) in answer_norm:
            forbidden_hits.append(item)
    citation = bool(re.search(r"\[\d+\]", answer))
    clarify = bool(re.search(r"[?？]", answer)) and bool(
        re.search(r"哪|什么|请说明|具体|你是|哪一个", answer)
    )
    gap = bool(re.search(r"没有|未|无法|资料不足|不能|缺少", answer))
    sources = payload.get("sources") or []
    source_docs = set()
    for source in sources:
        chunk_id = source.get("chunk_id") or ""
        if chunk_id:
            source_docs.add(chunk_id.rsplit("_", 1)[0])
    expected_docs = set(case.get("expected_evidence", {}).get("v12_doc_ids", []))
    source_support = bool(expected_docs & source_docs) if expected_docs else None
    facts_ok = all(fact_hits.values()) if fact_hits else None
    if expected == "direct":
        pass_rule = bool(facts_ok) and citation and not forbidden_hits and source_support is not False
    elif expected == "partial":
        pass_rule = any(fact_hits.values()) and (gap or clarify) and not forbidden_hits
    elif expected == "clarify":
        pass_rule = clarify and not forbidden_hits
    elif expected == "gap":
        pass_rule = gap and not forbidden_hits
    else:
        pass_rule = not forbidden_hits
    return {
        "expected_behavior": expected,
        "fact_hits": fact_hits,
        "facts_ok": facts_ok,
        "forbidden_hits": forbidden_hits,
        "citation_present": citation,
        "clarify": clarify,
        "gap": gap,
        "source_docs": sorted(source_docs),
        "source_support": source_support,
        "pass_rule": pass_rule,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:18766")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--case", default="")
    parser.add_argument("--health-only", action="store_true")
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    try:
        health = get_json(args.base_url.rstrip("/") + "/health")
    except Exception as error:
        blocked = {
            "status": "blocked",
            "reason": "web service unavailable: " + type(error).__name__ + ": " + str(error),
            "base_url": args.base_url,
            "note": "do not substitute a different model or port for delivery acceptance",
        }
        (run_dir / "e2e-blocked.json").write_text(
            json.dumps(blocked, ensure_ascii=False, indent=2), encoding="utf8"
        )
        print(json.dumps(blocked, ensure_ascii=False, indent=2))
        return 2
    (run_dir / "e2e-health.json").write_text(
        json.dumps(health, ensure_ascii=False, indent=2), encoding="utf8"
    )
    if args.health_only:
        print(json.dumps(health, ensure_ascii=False, indent=2))
        return 0 if health.get("ready") else 2

    rows = [json.loads(line) for line in open(args.cases, encoding="utf8") if line.strip()]
    rows = [row for row in rows if row.get("expected_behavior", {}).get("v1.2") != "tool"]
    if args.case:
        rows = [row for row in rows if row["case_id"] == args.case]
    if args.limit:
        rows = rows[: args.limit]

    raw_path = run_dir / "raw-e2e.jsonl"
    records = []
    with raw_path.open("w", encoding="utf8") as handle:
        for index, case in enumerate(rows, 1):
            payload = {"question": case["question"], "context": build_context(case), "mode": "local"}
            record = {
                "case_id": case["case_id"],
                "category": case["category"],
                "question": case["question"],
                "request": payload,
                "expected_behavior": case.get("expected_behavior", {}).get("v1.2"),
            }
            started = time.time()
            try:
                response = post_json(args.base_url.rstrip("/") + "/ask", payload, args.timeout)
                record["response"] = response
                record["latency_ms"] = round((time.time() - started) * 1000, 1)
                record["checks"] = check_answer(case, response)
            except Exception as error:
                record["error"] = type(error).__name__ + ": " + str(error)
                record["latency_ms"] = round((time.time() - started) * 1000, 1)
                record["checks"] = {"pass_rule": False, "error": record["error"]}
            records.append(record)
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(
                "[%d/%d] %s %s"
                % (index, len(rows), case["case_id"], record["checks"].get("pass_rule")),
                flush=True,
            )

    latencies = sorted(row["latency_ms"] for row in records if "latency_ms" in row)
    summary = {
        "cases": len(records),
        "passed_rule": sum(1 for row in records if row.get("checks", {}).get("pass_rule")),
        "errors": sum(1 for row in records if row.get("error")),
        "latency_ms": {
            "p50": latencies[len(latencies) // 2] if latencies else None,
            "p95": latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))] if latencies else None,
            "max": max(latencies) if latencies else None,
        },
        "raw_file": str(raw_path),
        "note": "规则判定只是初筛；关键事实、否决项需人工依据来源复核。",
    }
    (run_dir / "summary-e2e.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
