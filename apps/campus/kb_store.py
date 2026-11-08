"""Query-time collection isolation over the reviewed, immutable-row release."""
import json,re
from pathlib import Path
from datetime import datetime
import numpy as np
ROOT=Path(__file__).resolve().parent
CONFIG=json.loads((ROOT/'data/kb-active.json').read_text(encoding='utf8'))
class Store:
 def __init__(self):
  base=ROOT/CONFIG['release'];self.chunks=[json.loads(l) for l in (base/'chunks.jsonl').open(encoding='utf8') if l.strip()];self.emb=np.load(base/'embeddings.npy');self.collections=np.array([c['collection'] for c in self.chunks])
  assert len(self.chunks)==len(self.emb)
 def __len__(self):return len(self.chunks)
 @staticmethod
 def _bigrams(text):
  chars=[c for c in text if c.isalnum()];return {''.join(chars[i:i+2]) for i in range(len(chars)-1)}
 def search(self,qv,query,k=200):
  cross=bool(re.search('辅修|跨校|联合培养|交换|交流项目|外校|海法大学',query))
  admin=bool(re.search('学费|缴费|收费|补考|缓考|考试|成绩|奖学金|转专业|毕业|学籍|申请|办理|宿舍|食堂|营业|借阅|校园网',query))
  scopes=['campus'] if admin else ['campus','news']
  if cross:scopes.append('cross_campus')
  allowed=np.isin(self.collections,scopes)
  grams=self._bigrams(query);q=np.asarray(qv,dtype=np.float32);q=q/max(float(np.linalg.norm(q)),1e-8);sims=self.emb@q
  lex=np.array([sum(g in c['text'] for g in grams)/max(len(grams),1) for c in self.chunks])
  scores=.5*sims+.5*lex
  ids=np.flatnonzero(allowed);ids=ids[np.argsort(-scores[ids])[:k]];out=[]
  for i in ids:
   c=dict(self.chunks[i]);year=int(c.get('year') or 0);age=datetime.now().year-year
   boost=(.03 if 0<=age<=1 else -.1 if admin and age>2 else 0) if year else 0
   c.update(distance=round(float(1-sims[i]),4),final_score=round(float(scores[i]+boost),4));out.append(c)
  return out
