#!/usr/bin/env python3
"""Build cases.jsonl, the review table, and the standard-answer/evidence table."""
import csv
import json
import sys
from collections import Counter
from pathlib import Path

import cases_a_b
import cases_c_d
import cases_e_f_p
from cases_common import build_cases

OUT = Path(__file__).resolve().parents[1] / "cases"



RETRIEVAL_QUERY_OVERRIDES = {
    "A01": "2026级本科普通专业一年学费多少钱？",
    "A02": "2026级理工类专业本科学费是多少？",
    "A03": "2026级中外合作专业学费多少？",
    "A04": "2026-2027学年本科生住宿费一年多少？",
    "A05": "2026级本科新生报到要缴哪些费用、合计多少？",
    "A06": "2026-2027学年研究生学费多少？",
    "A07": "2026级MBA非全日制学费多少？",
    "A08": "2026级博士研究生学费多少？",
    "A09": "2026-2027学年学费在哪里交？怎么查缴费记录和电子票据？",
    "A10": "2026年本科生国家奖学金多少钱？需要什么条件？",
    "A11": "2026年本科生国家助学金一年多少？分几档？",
    "A12": "校园地国家助学贷款最多能贷多少？利息怎么算？",
    "A13": "2026年研究生学业奖学金金额和获奖比例是多少？",
    "A16": "松江学生一食堂几点开饭？",
    "A17": "长宁校区食堂几点供餐？",
    "A18": "校园网SUIBE和SUIBE-1x怎么连？",
    "A19": "松江校区宿舍物业报修电话多少？",
    "A20": "六期宿舍报修电话是多少？",
    "A21": "松江学生公寓宿舍电费怎么交？",
    "A22": "学生能坐教职工班车吗？短驳车怎么预约？",
    "A23": "图书馆自习座位怎么预约？",
    "A24": "校园卡丢了怎么挂失补办？",
    "A25": "本科生在读证明和成绩单怎么开？",
    "B01": "2025级本科生转专业需要什么条件？什么时候申请？",
    "B02": "2025级本科生转专业的具体流程是什么？",
    "B03": "哪些情况不能转专业？",
    "B04": "2024-2025学年缓考什么时候申请？",
    "B07": "对成绩有疑问怎么复核？什么时候申请？",
    "B08": "成绩核实的流程和结果查询是怎样的？",
    "B09": "2026-2027学年补办学生证怎么弄？",
    "B11": "研究生成绩单怎么办理？",
    "B12": "出国成绩单怎么办理？需要什么材料？",
    "B13": "2026年辅修报名需要什么条件？什么时候报名？",
    "B14": "2025-2026学年辅修怎么收费？",
    "B15": "2026-2027学年重新学习怎么报名、多少钱？",
    "C02": "补考的流程和补考成绩怎么算？",
    "C03": "博士研究生复试面试流程是什么？",
    "C05": "2025级本科文科生2026-2027学年学费多少？",
    "C07": "MBA非全日制学费多少？",
    "C09": "2025级大一学生转专业需要什么条件？",
    "C10": "大三学生还能转专业吗？",
    "C11": "博士研究生学费多少？",
    "C12": "研究生学费多少，不是本科生？",
    "C13": "松江和长宁校区食堂几点开门？",
    "C14": "宿舍电费怎么交？",
    "C15": "本科生、硕士、博士图书馆借阅册数分别是多少？",
    "C17": "图书馆自习室座位怎么预约？",
    "C18": "校园网密码忘了怎么办？",
    "D01": "2027级本科新生学费多少？",
    "D02": "2025-2026学年第二学期辅修缴费多少？",
    "D03": "2026-2027学年第一学期辅修缴费多少钱？",
    "D04": "华东师范大学辅修收费多少？",
    "D05": "上海交通大学2022级跨校辅修怎么报名？",
    "D06": "上海中医药大学2024年跨校辅修怎么收费？",
    "D07": "教职工班车学生能坐吗？",
    "D08": "2026级新生和老生学费一样吗？",
    "D09": "2026年博士招生考试流程是什么？",
    "D10": "2024级专升本新生缴费合计多少？",
    "D11": "2025级新生缴费合计多少？",
    "D12": "留学生本科学费多少？",
    "D13": "2026-2027学年研究生住宿费多少？",
    "D14": "辅修收费和本科学费一样吗？",
    "D15": "松江和长宁校区食堂时间一样吗？",
    "D16": "2024-2025学年第一学期缓考通知现在还能用吗？",
    "E06": "松江学生一食堂早餐几点开始？",
    "E07": "2026级新生学费是6500吗？2024年的表怎么说？",
    "E09": "2026-2027第一学期辅修缴费通知正文写了多少钱？",
    "E12": "研究生学费呢？",
    "E13": "金融专硕学费多少？",
    "E14": "2024级专升本缴费多少？",
}



OPTIONAL_FACTS = {
    "A01": ["住宿费", "合计-文科类"],
    "A02": ["合计-理工类"],
    "A03": ["中外合作合计"],
    "A04": ["老生住宿费"],
    "A07": ["MBA非全日制年缴费"],
    "A08": ["博士年缴费"],
    "A14": ["续借天数", "预约量"],
    "A15": ["松江123/128室", "长宁馆"],
    "A19": ["松江空调报修", "一期三期物业", "六期物业"],
    "A20": ["六期空调", "六期洗衣机"],
    "A21": ["自助充值机", "充值机报修"],
    "A22": ["爽约限制"],
    "A23": ["智联屏专区"],
    "A24": ["长宁卡中心"],
    "A25": ["本科生费用", "已毕业研究生"],
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    modules = [cases_a_b, cases_c_d, cases_e_f_p]
    cases = build_cases(modules)
    for case in cases:
        case["retrieval_query"] = RETRIEVAL_QUERY_OVERRIDES.get(case["case_id"], case["question"])
        optional = set(OPTIONAL_FACTS.get(case["case_id"], []))
        for fact in case.get("required_facts", []):
            fact["critical"] = fact["key"] not in optional

    # Add paraphrase cases after all base cases exist.
    by_id = {case["case_id"]: case for case in cases}
    for pid, question, base_id in cases_e_f_p.PARAPHRASES:
        base = by_id[base_id]
        clone = json.loads(json.dumps(base, ensure_ascii=False))
        clone.update(
            {
                "case_id": pid,
                "category": "等义改写一致性",
                "risk_tags": ["一致性", "改写", "不计入100条"],
                "question": question,
                "paraphrase_of": base_id,
                "severity": "medium",
                "notes": "等义改写，用于一致性检查；不计入 100 条基础用例。",
            }
        )
        cases.append(clone)

    with (OUT / "cases.jsonl").open("w", encoding="utf8") as handle:
        for case in cases:
            handle.write(json.dumps(case, ensure_ascii=False) + "\n")

    with (OUT / "cases-review.csv").open("w", encoding="utf8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "case_id",
                "category",
                "question",
                "expected_v1.2",
                "expected_v1.3",
                "facts",
                "sources",
                "v12_supported_sources",
                "v13_supported_sources",
                "severity",
                "risk_tags",
                "review_status",
            ]
        )
        for case in cases:
            writer.writerow(
                [
                    case["case_id"],
                    case["category"],
                    case["question"],
                    case["expected_behavior"].get("v1.2"),
                    case["expected_behavior"].get("v1.3"),
                    len(case["required_facts"]),
                    len(case["standard_sources"]),
                    case["version_coverage"]["v12"]["quote_count"],
                    case["version_coverage"]["v13"]["quote_count"],
                    case["severity"],
                    "|".join(case["risk_tags"]),
                    case["review_status"],
                ]
            )

    with (OUT / "标准答案与证据表.csv").open("w", encoding="utf8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "case_id",
                "question",
                "standard_answer",
                "required_facts",
                "sources",
                "v12_coverage",
                "v13_coverage",
                "forbidden_assertions",
                "pass_conditions",
                "severity",
                "review_status",
            ]
        )
        for case in cases:
            facts = "；".join(
                "%s=%s（%s %s：%s）"
                % (
                    fact["key"],
                    fact["value"],
                    fact["source_doc_id"],
                    fact["source_location"],
                    fact["quote"],
                )
                for fact in case["required_facts"]
            )
            sources = "；".join(
                "%s | %s | %s | %s | %s"
                % (
                    source["doc_id"],
                    source["title"],
                    source["url"],
                    source["published_at"],
                    source["quote"],
                )
                for source in case["standard_sources"]
            )
            writer.writerow(
                [
                    case["case_id"],
                    case["question"],
                    case["standard_answer"],
                    facts,
                    sources,
                    "%d/%d" % (
                        case["version_coverage"]["v12"]["quote_count"],
                        len(case["standard_sources"]),
                    ),
                    "%d/%d" % (
                        case["version_coverage"]["v13"]["quote_count"],
                        len(case["standard_sources"]),
                    ),
                    " | ".join(case["forbidden_assertions"]),
                    case["pass_conditions"],
                    case["severity"],
                    case["review_status"],
                ]
            )

    base = [case for case in cases if not case.get("paraphrase_of")]
    counts = Counter(case["category"] for case in base)
    stats = {
        "total": len(cases),
        "base": len(base),
        "paraphrase": len(cases) - len(base),
        "by_category": dict(sorted(counts.items())),
        "expected_behavior": {
            version: dict(Counter(case["expected_behavior"].get(version) for case in base))
            for version in ("v1.2", "v1.3")
        },
        "source_docs": {
            version: len({source["doc_id"] for case in cases for source in case["standard_sources"] if source["in_" + version]})
            for version in ("v12", "v13")
        },
    }
    (OUT / "cases-stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf8"
    )
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    print("wrote", OUT / "cases.jsonl")


if __name__ == "__main__":
    sys.exit(main())
