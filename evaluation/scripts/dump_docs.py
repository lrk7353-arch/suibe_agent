#!/usr/bin/env python3
"""Dump selected corpus documents as readable UTF-8 text files (read-only)."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--docs", required=True)
    parser.add_argument("--ids", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    rows = []
    with open(args.docs, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    by_id = {row["doc_id"]: row for row in rows}

    ids = []
    with open(args.ids, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#"):
                ids.append(line)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    missing = []
    for doc_id in ids:
        row = by_id.get(doc_id)
        if not row:
            missing.append(doc_id)
            continue
        header = [
            "DOC_ID: " + doc_id,
            "TITLE: " + str(row.get("title")),
            "DATE: " + str(row.get("published_at")),
            "URL: " + str(row.get("source_url")),
            "COLLECTION: " + str(row.get("collection")),
            "TOPIC: " + str(row.get("topic") or row.get("topics")),
            "APPLIES: " + str(row.get("applies_to")),
            "CAMPUS: " + str(row.get("campus")),
            "ACADEMIC_YEAR: " + str(row.get("academic_year")),
            "VALIDITY: " + str(row.get("validity_status")),
            "ISSUER: " + str(row.get("issuer_institution")),
            "HOST: " + str(row.get("hosting_institution")),
            "ATTACHMENTS: " + str(row.get("attachment_paths")),
            "=" * 70,
        ]
        (out / (doc_id + ".txt")).write_text("\n".join(header) + "\n" + (row.get("text") or ""), encoding="utf8")
    print("dumped", len(ids) - len(missing), "missing", missing)


if __name__ == "__main__":
    main()
