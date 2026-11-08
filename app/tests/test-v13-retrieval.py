import os,sys,json
from pathlib import Path
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root))
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HOME=str(root/'tmp/huggingface'),PYTHONDONTWRITEBYTECODE='1')
from rag_embedding import load_model
from kb_store import Store
from retrieval import retrieve
m=load_model();s=Store();out=[]
for q in ['2026级本科新生学费收费标准','食堂营业时间','宿舍报修电话','国家助学贷款额度','本科生借阅期限']:
    hits=retrieve(q,m,s)
    out.append(dict(question=q,hits=[dict(doc_id=x['doc_id'],title=x['title'],text=x['text'],collection=x['collection']) for x in hits]))
    assert hits,q
assert len(s)==3879
(root/'docs/v1.3-retrieval-smoke.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
print('PASS actual embedding + Store + retrieval: 5 queries, 3879 vectors; relevance requires separate acceptance')
