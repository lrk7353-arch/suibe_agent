#!/usr/bin/env python3
"""Static validation for the answer-acceptance case set.

Checks schema, category minimums, source resolution, quote presence in the full
documents (not retrieval snippets), paraphrase links, and expected-behaviour
consistency with static coverage. Writes validation.json and validation.md.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path


REQUIRED_FIELDS = [
    "case_id",
    "category",
    "risk_tags",
    "question",
    "pre_dialogue",
    "user_profile",
    "target_kb_version",
    "expected_behavior",
    "required_facts",
    "allowed_variants",
    "forbidden_assertions",
    "standard_sources",
    "source_validity",
    "expected_evidence",
    "pass_conditions",
    "severity",
    "reviewer",
    "review_status",
    "standard_answer",
]

MINIMUMS = {
    "高频校园事实": 25,
    "办事流程与条件": 15,
    "歧义与多轮": 15,
    "时效与适用范围": 15,
    "缺失、冲突与干扰": 15,
    "经贸解释与工具": 15,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    rows = []
    with open(args.cases, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    errors = []
    warnings = []
    ids = set()
    base = []
    paraphrases = []
    for row in rows:
        cid = row.get("case_id")
        if cid in ids:
            errors.append("duplicate case_id: %s" % cid)
        ids.add(cid)
        for field in REQUIRED_FIELDS:
            if field not in row:
                errors.append("%s missing field %s" % (cid, field))
        if row.get("paraphrase_of"):
            paraphrases.append(row)
        else:
            base.append(row)
        if not row.get("question"):
            errors.append("%s empty question" % cid)
        if not row.get("standard_answer"):
            errors.append("%s empty standard_answer" % cid)
        if not row.get("forbidden_assertions"):
            warnings.append("%s has no forbidden_assertions" % cid)
        if row.get("severity") == "critical" and not row.get("forbidden_assertions"):
            errors.append("%s critical case without forbidden_assertions" % cid)
        if row.get("expected_behavior", {}).get("v1.2") not in {"direct", "partial", "clarify", "gap", "tool"}:
            errors.append("%s invalid v1.2 expected behavior" % cid)
        if row.get("expected_behavior", {}).get("v1.3") not in {"direct", "partial", "clarify", "gap", "tool"}:
            errors.append("%s invalid v1.3 expected behavior" % cid)

        for source in row.get("standard_sources", []):
            if not source.get("in_v12") and not source.get("in_v13"):
                errors.append("%s source %s missing from both KBs" % (cid, source.get("doc_id")))
            if source.get("in_v12") and not source.get("quote_in_v12"):
                warnings.append(
                    "%s quote not found in v1.2 doc %s: %s"
                    % (cid, source.get("doc_id"), source.get("quote")[:60])
                )
            if source.get("in_v13") and not source.get("quote_in_v13"):
                warnings.append(
                    "%s quote not found in v1.3 doc %s: %s"
                    % (cid, source.get("doc_id"), source.get("quote")[:60])
                )

        # Expected behaviour must be explainable by static coverage.
        for version, key in (("v12", "v1.2"), ("v13", "v1.3")):
            coverage = row.get("version_coverage", {}).get(version, {})
            expected = row.get("expected_behavior", {}).get(key)
            if expected == "tool":
                continue
            if expected == "direct" and row.get("required_facts") and not coverage.get("all_quotes"):
                warnings.append(
                    "%s says %s direct but static coverage is %s/%s"
                    % (cid, key, coverage.get("quote_count"), len(row.get("standard_sources", [])))
                )
            if expected == "gap" and coverage.get("any_quote"):
                warnings.append(
                    "%s says %s gap but some evidence is present"
                    % (cid, key)
                )

    counts = Counter(row["category"] for row in base)
    for category, minimum in MINIMUMS.items():
        if counts.get(category, 0) < minimum:
            errors.append(
                "category %s has %d, minimum %d"
                % (category, counts.get(category, 0), minimum)
            )
    if len(base) < 100:
        errors.append("base cases %d < 100" % len(base))
    if len(paraphrases) < 10:
        errors.append("paraphrase cases %d < 10" % len(paraphrases))

    paraphrase_targets = {row.get("paraphrase_of") for row in paraphrases}
    missing_targets = sorted(target for target in paraphrase_targets if target not in ids)
    if missing_targets:
        errors.append("paraphrase targets missing: %s" % missing_targets)

    report = {
        "total": len(rows),
        "base": len(base),
        "paraphrase": len(paraphrases),
        "by_category": dict(sorted(counts.items())),
        "errors": errors,
        "warnings": warnings,
        "status": "pass" if not errors else "fail",
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")

    lines = [
        "# 用例集静态校验",
        "",
        "- 总用例：%d（基础 %d，等义改写 %d）" % (len(rows), len(base), len(paraphrases)),
        "- 状态：%s" % report["status"],
        "- 错误：%d" % len(errors),
        "- 警告：%d" % len(warnings),
        "",
        "## 分类计数",
        "",
    ]
    for category, count in sorted(counts.items()):
        lines.append("- %s：%d（最低 %d）" % (category, count, MINIMUMS.get(category, 0)))
    if errors:
        lines += ["", "## 错误", ""]
        lines += ["- " + item for item in errors]
    if warnings:
        lines += ["", "## 警告", ""]
        lines += ["- " + item for item in warnings]
    (out.parent / "validation.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
