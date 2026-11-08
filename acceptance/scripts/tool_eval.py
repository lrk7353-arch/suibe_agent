#!/usr/bin/env python3
"""Deterministic tool-layer evaluation using the delivery trade-tools implementation."""
import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path


def run_tool(node, tool_js, name, args):
    runner = Path(__file__).resolve().parent / "tool_runner.cjs"
    proc = subprocess.run(
        [node, str(runner), str(tool_js), name, json.dumps(args, ensure_ascii=False)],
        capture_output=True,
        text=True,
        encoding="utf8",
    )
    if proc.returncode != 0:
        return {"ok": False, "error": (proc.stderr or proc.stdout or "").strip()}
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        return {"ok": False, "error": "invalid runner output: " + proc.stdout[:300]}


def close_enough(actual, expected, tolerance):
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return abs(actual - expected) <= tolerance
    return actual == expected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--tool-js", default="Z:/home/konglingrui/suibeagent/delivery/src/trade-tools.js")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()

    rows = []
    with open(args.cases, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    tool_cases = [row for row in rows if row.get("tool")]

    run_dir = Path(args.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    raw_path = run_dir / "raw-tools.jsonl"
    records = []
    with raw_path.open("w", encoding="utf8") as handle:
        for case in tool_cases:
            tool = case["tool"]
            results = {}
            passed = True
            notes = []
            if tool.get("mode") == "valid":
                result = run_tool(args.node, args.tool_js, tool["name"], tool["args"])
                results["valid"] = result
                if not result.get("ok"):
                    passed = False
                    notes.append("valid call failed: " + result.get("error", ""))
                else:
                    expected = tool.get("expected", {})
                    actual = result.get("out", {}).get("result", {})
                    tolerance = tool.get("tolerance", 0.0)
                    for key, value in expected.items():
                        if not close_enough(actual.get(key), value, tolerance):
                            passed = False
                            notes.append(
                                "%s expected %s got %s" % (key, value, actual.get(key))
                            )
            if tool.get("mode") in {"invalid", "missing"}:
                result = run_tool(args.node, args.tool_js, tool["name"], tool["args"])
                results["invalid"] = result
                expected_error = tool.get("expected_error", "")
                if result.get("ok"):
                    passed = False
                    notes.append("invalid call unexpectedly succeeded")
                elif expected_error and expected_error not in result.get("error", ""):
                    passed = False
                    notes.append(
                        "error text expected %r got %r"
                        % (expected_error, result.get("error", ""))
                    )
            if tool.get("invalid_args"):
                result = run_tool(args.node, args.tool_js, tool["name"], tool["invalid_args"])
                results["invalid_args"] = result
                expected_error = tool.get("invalid_error", "")
                if result.get("ok"):
                    passed = False
                    notes.append("invalid_args unexpectedly succeeded")
                elif expected_error and expected_error not in result.get("error", ""):
                    passed = False
                    notes.append(
                        "invalid_args error expected %r got %r"
                        % (expected_error, result.get("error", ""))
                    )
            record = {
                "case_id": case["case_id"],
                "question": case["question"],
                "tool": tool,
                "results": results,
                "passed": passed,
                "notes": notes,
            }
            records.append(record)
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(
                "[%s] %s %s"
                % ("PASS" if passed else "FAIL", case["case_id"], "; ".join(notes)),
                flush=True,
            )

    passed = sum(1 for row in records if row["passed"])
    summary = {
        "tool_cases": len(records),
        "passed": passed,
        "failed": len(records) - passed,
        "pass_rate": round(passed / len(records), 4) if records else None,
        "raw_file": str(raw_path),
    }
    (run_dir / "summary-tools.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf8"
    )
    with (run_dir / "summary-tools.csv").open("w", encoding="utf8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["case_id", "passed", "notes"])
        for row in records:
            writer.writerow([row["case_id"], row["passed"], "; ".join(row["notes"])])
    lines = [
        "# 工具层结果",
        "",
        "- 工具用例：%d" % len(records),
        "- 通过：%d" % passed,
        "- 失败：%d" % (len(records) - passed),
        "- 通过率：%s" % summary["pass_rate"],
        "",
        "| 用例 | 结果 | 说明 |",
        "|---|---|---|",
    ]
    for row in records:
        lines.append(
            "| %s | %s | %s |"
            % (row["case_id"], "通过" if row["passed"] else "失败", "; ".join(row["notes"]))
        )
    (run_dir / "summary-tools.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
