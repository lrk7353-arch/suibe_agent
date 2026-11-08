"""Service-aware ranking over the original hybrid candidate pool."""
import re
from datetime import datetime


ALIASES = {
    "借书": "借阅", "借多久": "借阅期限", "能借多久": "借阅期限",
    "几本": "借阅册数", "连不上": "无法登录 认证 无线网络",
    "查分": "成绩核实", "网坏了": "校园无线网络",
}
ARCHIVE = re.compile("馆报|专栏快递|学科信息参考|特色信息快报")

def retrieve(query, model, store):
    expanded = query
    for phrase, replacement in ALIASES.items():
        if phrase in query:
            expanded += " " + replacement
    candidates = store.search(model.encode([expanded], normalize_embeddings=True)[0], query, k=200)
    # A collection label alone does not make a passage relevant to the task.
    def relevant(h):
        title=h.get('title','');text=h.get('text','');probe=title+' '+text
        if re.search('本科',query) and re.search('MBA|MPA|研究生|博士|硕士',title):return False
        if re.search('学费|收费|缴费',query) and not re.search('学费|收费|缴费',probe):return False
        if '奖学金' in query and '奖学金' not in probe:return False
        if '奖学金' in query and re.search('导师|指导教师',title) and not re.search('导师|指导教师',query):return False
        if re.search('宿舍.*电费|电费.*宿舍',query) and not ('电费' in probe and re.search('宿舍|学生公寓',probe)):return False
        if re.search('食堂.*(营业|开放|时间)',query) and not ('食堂' in probe and re.search('营业时间|开放时间|供餐时间|供应时间|早餐.*[0-9０-９]',probe)):return False
        if re.search('成绩.*(复核|核实)',query) and re.search('学位授予|招生复试',title) and not re.search('学位|复试',query):return False
        return True
    candidates=[h for h in candidates if relevant(h)]
    grams = store._bigrams(expanded)
    for hit in candidates:
        title = hit.get("title", "")
        title_match = sum(g in title for g in grams) / max(len(grams), 1)
        score = hit["final_score"] + 0.18 * title_match
        if ARCHIVE.search(title):
            score -= 0.30
        if "校园网" in query and "校园网贷" in hit["text"]:
            score -= 0.35
        if re.search("借书|借阅|续借", query):
            if re.search("借阅服务|借阅规则", title):
                score += 0.22
            if re.search("多久|期限|几本|多少", query) and re.search("借期|借阅期限|可借", hit["text"]):
                score += 0.12
        hit["final_score"] = round(score, 4)
    result=[];counts={}
    for hit in sorted(candidates,key=lambda h:-h['final_score']):
        key=hit.get('doc_id',hit['chunk_id'])
        if counts.get(key,0)>=2:continue
        counts[key]=counts.get(key,0)+1;result.append(hit)
        if len(result)==8:break
    return result
