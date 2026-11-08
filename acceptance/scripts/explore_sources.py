#!/usr/bin/env python3
"""Read-only corpus explorer for building evidence-backed acceptance cases.

Usage:
  python -I explore_sources.py --v13 <documents.jsonl> --out <out.json> [--keywords ...]
"""
import argparse
import json
import re
import sys


def load(path):
    rows = []
    with open(path, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def snippet(text, keyword, width=160):
    index = text.find(keyword)
    if index < 0:
        return ""
    start = max(0, index - width)
    end = min(len(text), index + width)
    return re.sub(r"\s+", " ", text[start:end]).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--v13", required=True)
    parser.add_argument("--v12", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--keywords", nargs="*", default=[])
    args = parser.parse_args()

    v13 = load(args.v13)
    v12 = load(args.v12)
    v12_ids = {row["doc_id"] for row in v12}

    keywords = args.keywords or [
        "学费", "住宿费", "奖学金", "助学金", "助学贷款", "图书馆", "借阅",
        "食堂", "校园网", "宿舍", "报修", "转专业", "补考", "缓考", "缴费",
        "在读证明", "成绩单", "班车", "辅修", "华东师范大学", "考试", "自习",
        "电费", "清真", "招生", "博士", "MBA", "留学生", "校区", "校历",
        "校医院", "医保", "档案", "户口", "校园卡", "一卡通", "VPN", "邮箱",
        "选课", "学分", "毕业", "学位", "论文", "实习", "就业", "三方",
        "报到证", "征兵", "困难认定", "勤工助学", "绿色通道", "学生证",
        "研讨室", "座位预约", "浴室", "热水", "空调", "洗衣", "快递",
        "校车", "门禁", "作息", "重修", "微专业", "跨校", "交换", "暑期",
        "国际交流", "推免", "保研", "考研", "四六级", "普通话", "计算机等级",
    ]

    result = {"v13_count": len(v13), "v12_count": len(v12),
              "overlap": len(v13) and sum(1 for row in v13 if row["doc_id"] in v12_ids),
              "keywords": {}}

    for keyword in keywords:
        matches = []
        for row in v13:
            text = row.get("text") or ""
            title = row.get("title") or ""
            title_hits = title.count(keyword)
            text_hits = text.count(keyword)
            if title_hits or text_hits:
                matches.append({
                    "doc_id": row.get("doc_id"),
                    "title": title,
                    "published_at": row.get("published_at"),
                    "source_url": row.get("source_url"),
                    "collection": row.get("collection"),
                    "topic": row.get("topic") or row.get("topics"),
                    "applies_to": row.get("applies_to"),
                    "campus": row.get("campus"),
                    "academic_year": row.get("academic_year"),
                    "validity_status": row.get("validity_status"),
                    "in_v12": row.get("doc_id") in v12_ids,
                    "title_hits": title_hits,
                    "text_hits": text_hits,
                    "snippet": snippet(text, keyword),
                })
        matches.sort(key=lambda item: (item["title_hits"], item["text_hits"]), reverse=True)
        result["keywords"][keyword] = matches[:12]

    with open(args.out, "w", encoding="utf8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=1)
    print("wrote", args.out, "v13", len(v13), "v12", len(v12), "overlap", result["overlap"])


if __name__ == "__main__":
    sys.exit(main())
