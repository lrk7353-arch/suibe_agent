# -*- coding: utf-8 -*-
"""独立人工参考计算：只用 Python Decimal，不导入待测工具的代码。
用途：为经贸专项用例提供第二套公式实现，避免“以待测工具输出作为唯一依据”。
运行：python -I tests/reference_calc.py
"""
import json
from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def q(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def calc(quantity, goods_foreign, freight, insurance, fx, duty_rate, vat_rate,
         domestic=Decimal("0"), term="FOB"):
    """term=FOB: goods 为单价；CFR/CIF: goods 为整批总价。"""
    quantity = Decimal(str(quantity))
    goods = Decimal(str(goods_foreign))
    freight = Decimal(str(freight))
    insurance = Decimal(str(insurance))
    fx = Decimal(str(fx))
    duty_rate = Decimal(str(duty_rate)) / Decimal("100")
    vat_rate = Decimal(str(vat_rate)) / Decimal("100")

    if term == "FOB":
        goods_total = q(goods * quantity)
        cif = q(goods_total + freight + insurance)
    elif term == "CFR":
        goods_total = q(goods)
        cif = q(goods_total + insurance)
    else:
        goods_total = q(goods)
        cif = q(goods_total)

    taxable = q(cif * fx)
    duty = q(taxable * duty_rate)
    vat = q((taxable + duty) * vat_rate)
    outlay = q(taxable + duty + vat)
    per_unit = q(outlay / quantity)
    return {
        "quantity": str(int(quantity)) if quantity == int(quantity) else format(quantity.normalize(), "f"),
        "term": term,
        "goodsTotal": str(goods_total),
        "cifEquivalent": str(cif),
        "taxableValue": str(taxable),
        "duty": str(duty),
        "vat": str(vat),
        "outlay": str(outlay),
        "perUnit": str(per_unit),
        "domesticFees": str(q(domestic)),
        "grandTotal": str(q(outlay + Decimal(str(domestic)))),
    }


def main():
    result = {
        "caseId": "TEACHING-CASE-SUIBE-2026",
        "rules": "十进制定点；金额每步 ROUND_HALF_UP 到 2 位；合计用已舍入分项相加",
        "base": calc(100, "10.00", "100.00", "10.00", "7.0000", "10", "13"),
        "fx72": calc(100, "10.00", "100.00", "10.00", "7.2000", "10", "13"),
        "fx69": calc(100, "10.00", "100.00", "10.00", "6.9000", "10", "13"),
        "cif1080": calc(100, "1080.00", "0", "0", "7.0000", "10", "13", term="CIF"),
        "cfr1080": calc(100, "1080.00", "0", "10.00", "7.0000", "10", "13", term="CFR"),
        "qty200": calc(200, "10.00", "100.00", "10.00", "7.0000", "10", "13"),
        "qty200fx72": calc(200, "10.00", "100.00", "10.00", "7.2000", "10", "13"),
        "zeroRates": calc(100, "10.00", "100.00", "10.00", "7.0000", "0", "0"),
        "zeroFreight": calc(100, "10.00", "0", "0", "7.0000", "10", "13"),
        "roundingEdge": calc(1, "0.05", "0", "0", "1.0000", "10", "13"),
        "sameCostFob": calc(100, "9.70", "100.00", "10.00", "7.0000", "10", "13"),
        "cif1080fx72": calc(100, "1080.00", "0", "0", "7.2000", "10", "13", term="CIF"),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
