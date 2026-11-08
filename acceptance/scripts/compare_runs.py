#!/usr/bin/env python3
"""Compare two evaluation runs by case_id and field."""
import argparse
import csv
import json
import sys
from pathlib import Path


def load(path):
    rows = {}
    with open(path, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                row = json.loads(line)
                rows[row["case_id"]] = row
    return rows


def value(row, field):
    if field in row:
        return row[field]
    return row.get("checks", {}).get(field)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", required=True)
    parser.add_argument("--b", required=True)
    parser.add_argument("--field", default="doc_any_at_k")
    parser.add_argument("--label-a", default="A")
    parser.add_argument("--label-b", default="B")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    a = load(args.a)
    b = load(args.b)
    ids = sorted(set(a) | set(b))
    rows = []
    for cid in ids:
        va = value(a.get(cid, {}), args.field)
        vb = value(b.get(cid, {}), args.field)
        if va == vb:
            status = "unchanged"
        elif va is False and vb is True:
            status = "improved"
        elif va is True and vb is False:
            status = "regressed"
        else:
            status = "changed"
        rows.append({"case_id": cid, "a": va, "b": vb, "status": status})

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["case_id", args.label_a, args.label_b, "status"])
        for row in rows:
            writer.writerow([row["case_id"], row["a"], row["b"], row["status"]])

    counts = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    print(json.dumps({"field": args.field, "cases": len(rows), "counts": counts, "out": str(out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
