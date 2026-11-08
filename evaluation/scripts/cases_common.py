"""Shared helpers and source resolution for the answer-acceptance case builder."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
V13_DOCS = ROOT / "suibe-kb-handoff-v1.3-20261108/suibe-kb-v1.3/clean/documents.jsonl"
V12_DOCS = ROOT / "data/kb-v12-reviewed/documents.jsonl"


def load_jsonl(path):
    rows = []
    with open(path, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def norm(text):
    # Compare prose across PDF/table line breaks and table pipes.
    return re.sub(r"[\s|｜]+", "", text or "")


def F(key, value, doc_id, location, quote):
    return {
        "key": key,
        "value": value,
        "source_doc_id": doc_id,
        "source_location": location,
        "quote": quote,
    }


def S(doc_id, location, quote, note=""):
    return {"doc_id": doc_id, "location": location, "quote": quote, "note": note}


def C(
    cid,
    category,
    tags,
    question,
    facts=None,
    sources=None,
    behavior=None,
    pre=None,
    profile=None,
    variants=None,
    forbidden=None,
    evidence=None,
    tool=None,
    severity="high",
    standard_answer="",
    pass_conditions="",
    notes="",
    paraphrase_of=None,
):
    return {
        "case_id": cid,
        "category": category,
        "risk_tags": tags,
        "question": question,
        "pre_dialogue": pre or [],
        "user_profile": profile or {},
        "expected_behavior": behavior or {},
        "required_facts": facts or [],
        "allowed_variants": variants or [],
        "forbidden_assertions": forbidden or [],
        "extra_sources": sources or [],
        "expected_evidence": evidence or {},
        "tool": tool,
        "severity": severity,
        "standard_answer": standard_answer,
        "pass_conditions": pass_conditions
        or "无否决项；必须覆盖的事实点全部出现；总分不低于 85。",
        "notes": notes,
        "paraphrase_of": paraphrase_of,
    }


def build_cases(case_modules):
    v13_rows = load_jsonl(V13_DOCS)
    v12_rows = load_jsonl(V12_DOCS)
    v13 = {row["doc_id"]: row for row in v13_rows}
    v12 = {row["doc_id"]: row for row in v12_rows}
    v12_text = {row["doc_id"]: norm(row.get("text")) for row in v12_rows}
    v13_text = {row["doc_id"]: norm(row.get("text")) for row in v13_rows}

    cases = []
    for module in case_modules:
        cases.extend(module.CASES)

    seen = set()
    output = []
    for case in cases:
        if case["case_id"] in seen:
            raise SystemExit("duplicate case_id: " + case["case_id"])
        seen.add(case["case_id"])

        source_specs = []
        for fact in case["required_facts"]:
            source_specs.append(
                S(fact["source_doc_id"], fact["source_location"], fact["quote"])
            )
        source_specs.extend(case["extra_sources"])

        resolved = []
        seen_sources = set()
        for spec in source_specs:
            key = (spec["doc_id"], spec["location"], spec["quote"])
            if key in seen_sources:
                continue
            seen_sources.add(key)
            doc_id = spec["doc_id"]
            row13 = v13.get(doc_id)
            row12 = v12.get(doc_id)
            row = row13 or row12
            if row is None:
                raise SystemExit(
                    "unknown source %s in case %s" % (doc_id, case["case_id"])
                )
            quote_norm = norm(spec["quote"])
            resolved.append(
                {
                    "doc_id": doc_id,
                    "title": row.get("title"),
                    "url": row.get("source_url"),
                    "published_at": row.get("published_at"),
                    "collection": row.get("collection"),
                    "applies_to": row.get("applies_to"),
                    "campus": row.get("campus"),
                    "academic_year": row.get("academic_year"),
                    "validity_status": row.get("validity_status"),
                    "issuer_institution": row.get("issuer_institution"),
                    "hosting_institution": row.get("hosting_institution"),
                    "location": spec["location"],
                    "quote": spec["quote"],
                    "note": spec["note"],
                    "in_v12": doc_id in v12,
                    "in_v13": doc_id in v13,
                    "quote_in_v12": bool(quote_norm)
                    and quote_norm in v12_text.get(doc_id, ""),
                    "quote_in_v13": bool(quote_norm)
                    and quote_norm in v13_text.get(doc_id, ""),
                }
            )

        case["standard_sources"] = resolved
        coverage = {}
        for version in ("v12", "v13"):
            relevant = [
                source
                for source in resolved
                if source["in_" + version]
            ]
            covered = [
                source
                for source in relevant
                if source["quote_in_" + version]
            ]
            coverage[version] = {
                "source_count": len(relevant),
                "quote_count": len(covered),
                "all_quotes": len(relevant) > 0 and len(covered) == len(resolved),
                "any_quote": len(covered) > 0,
                "doc_ids": sorted({source["doc_id"] for source in covered}),
            }
        case["version_coverage"] = coverage

        expected = dict(case["expected_behavior"])
        for version, key in (("v12", "v1.2"), ("v13", "v1.3")):
            if key not in expected:
                info = coverage[version]
                if not resolved:
                    expected[key] = "gap"
                elif info["all_quotes"]:
                    expected[key] = "direct"
                elif info["any_quote"]:
                    expected[key] = "partial"
                else:
                    expected[key] = "gap"
        case["expected_behavior"] = expected

        expected_evidence = case["expected_evidence"]
        expected_evidence.setdefault(
            "v12_doc_ids", coverage["v12"]["doc_ids"] if coverage["v12"]["any_quote"] else []
        )
        expected_evidence.setdefault(
            "v13_doc_ids", coverage["v13"]["doc_ids"] if coverage["v13"]["any_quote"] else []
        )
        expected_evidence.setdefault(
            "key_phrases", [fact["value"] for fact in case["required_facts"] if fact["value"]]
        )
        case["expected_evidence"] = expected_evidence

        source_validity = []
        for source in resolved:
            source_validity.append(
                "%s（%s，%s）"
                % (
                    source["title"],
                    source["published_at"] or "日期未标注",
                    source["validity_status"] or "效力未标注",
                )
            )
        case["source_validity"] = "；".join(dict.fromkeys(source_validity))
        case["reviewer"] = "待人工复核"
        case["review_status"] = "自动初评（来源已定位，尚未人工签字）"
        case["target_kb_version"] = "v1.2-reviewed-20261108"
        case["candidate_kb_version"] = "v1.3-20261108（未交付、未加载）"
        output.append(case)
    return output
