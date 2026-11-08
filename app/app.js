const el = id => document.getElementById(id);
const icons = {
  home:'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',
  chat:'M4 4h16v12H9l-5 4Z M8 8h8 M8 12h5',
  book:'M12 5C8 3 5 3 3 4v16c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-5-1-9 1v16',
  bookmark:'M6 3h12v18l-6-4-6 4Z',
  file:'M5 3h9l5 5v13H5Z M14 3v6h5 M9 13h6 M9 17h4',
  bulb:'M9 18h6 M9 21h6 M8 15c-6-5-3-12 4-12s10 7 4 12l-1 3H9Z',
  compass:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M16 8l-3 5-5 3 3-5Z',
  shield:'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7Z M8 12l3 3 5-6'
};
document.querySelectorAll('[data-icon]').forEach(node=>{
  node.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+icons[node.dataset.icon]+'"/></svg>';
});
let context={}, busy=false, saved=[], toastTimer;
const titles={home:'校园首页',chat:'和小贸聊聊',library:'校园知识库',saved:'本次收藏',settings:'偏好与关于'};
function route(){
  const name=Object.hasOwn(titles,location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  document.querySelectorAll('.view').forEach(view=>view.hidden=view.id!==name);
  document.querySelectorAll('[data-route]').forEach(a=>{
    if(a.dataset.route===name) a.setAttribute('aria-current','page');
    else a.removeAttribute('aria-current');
  });
  el('breadcrumb').textContent=titles[name];
  document.title=titles[name]+' · 小贸';
  if(name==='saved') renderSaved();
  window.scrollTo(0,0);
}
function toast(text){el('toast').textContent=text;el('toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>el('toast').style.display='none',2500)}
function node(tag,text,className){const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n}
function line(text,mine=false){
  const box=node('article','',mine?'message me':'message');
  box.append(node('span',mine?'你':'小贸','message-label'),node('p',text));
  el('log').append(box);return box;
}
function choices(items=[]){
  el('options').replaceChildren();
  for(const label of items){const b=node('button',label);b.onclick=()=>ask(label);b.disabled=busy;el('options').append(b)}
}
function reset(){
  if(busy){toast('等这条回复完成，就可以开始新对话。');return}
  context={};el('log').replaceChildren();el('q').value='';el('count').textContent='0 / 500';
  el('form-error').textContent='';
  line('你好呀，我是小贸。校园知识库 1.0 已接入，你可以问图书馆借阅、校园网或校务办理问题。重要事项记得核对原文的日期和适用对象。');
  choices(['成绩核实什么时候申请？','解释机会成本','你是谁']);
}
async function ask(question){
  const q=question.trim();
  if(busy) {toast('小贸正在回复，请稍等一下。');return}
  if(!q||q.length>500){el('form-error').textContent='请输入 1–500 字的问题。';return}
  document.querySelectorAll('[data-tool-run]').forEach(b=>{b.disabled=true;b.textContent='历史草案 · 请使用最新一条';});
  location.hash='chat';busy=true;el('send').disabled=true;
  el('q').value='';el('count').textContent='0 / 500';el('form-error').textContent='';
  line(q,true);choices([]);const box=line('正在查阅，请稍等…');box.setAttribute('aria-busy','true');
  box.scrollIntoView({block:'nearest'});
  try{
    const r=await fetch('/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q,context,mode:el('model-mode').value}),signal:AbortSignal.timeout(65000)});
    if(!r.ok)throw Error();
    const data=await r.json();box.querySelector('p').textContent=data.answer;context=data.context;
    for(const tool of data.tools||[])box.append(node('small','已完成 · '+tool.label));
    for(const [sourceIndex,source] of (data.sources||[]).entries()){
      const details=node('details');
      details.append(node('summary','['+(sourceIndex+1)+'] '+source.title+' · '+(source.date||'日期未知')),node('p',source.text));
      const link=node('a','查看原文 ↗','source-link');
      if(/^https?:\/\//.test(source.url)){link.href=source.url;link.target='_blank';link.rel='noopener';details.append(link)}
      box.append(details);
    }
    if(data.mode)box.append(node('small',data.mode));
    if(data.source){
      box.append(node('small','历史细则 · 办理前请核对当期通知'));
      const a=node('a',data.source.title+' ↗','source-link');
      a.href=data.source.url;a.target='_blank';a.rel='noopener';box.append(a);
    }
    if(data.toolProposal){
      const p=data.toolProposal,labels={price:'货价（外币）',freight:'运费（同一外币）',insurance:'保险费（同一外币）',fx:'汇率（人民币/外币）',duty:'关税率（%）',vat:'增值税率（%）'};
      box.append(node('p',Object.entries(p.args).map(([k,v])=>(labels[k]||k)+'：'+v).join('；')));
      const run=node('button','按上述参数计算','quiet');run.dataset.toolRun='true';run.onclick=async()=>{run.disabled=true;try{const r=await fetch('/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:p.name,args:p.args})});if(!r.ok)throw Error();const d=await r.json();box.append(node('p','完税价格 ¥'+d.result.customs+'；关税 ¥'+d.result.duty+'；增值税 ¥'+d.result.vat+'；合计 ¥'+d.result.total),node('small',d.result.note));run.textContent='计算完成';}catch{run.disabled=false;toast('计算未完成，请重试');}};box.append(run);
    }
    for(const action of data.actions||[]){if(action.url==='/pocket#tools'){const a=node('a',action.label,'source-link');a.href=action.url;a.target='_blank';a.rel='noopener';box.append(a);}}
    const save=node('button','收藏这条回答','save-answer');
    save.onclick=()=>{if(saved.some(item=>item===data)){toast('这条回答已收藏');return}saved.push(data);save.textContent='已收藏';toast('已加入本次收藏，刷新后会清空')};
    box.append(save);busy=false;choices(data.options);
  }catch{
    box.querySelector('p').textContent='连接暂时中断，你的问题还在。可以重试，或先浏览知识库。';
    busy=false;choices([q]);el('q').value=q;el('count').textContent=q.length+' / 500';
    el('form-error').textContent='未收到回复，请确认本地服务已启动。';
  }finally{busy=false;el('send').disabled=false;box.removeAttribute('aria-busy')}
}
function renderSaved(){
  el('saved-list').replaceChildren();
  if(!saved.length){el('saved-list').append(node('div','还没有收藏。聊天时点“收藏这条回答”，就能在这里找到。','empty'));return}
  saved.forEach((item,i)=>{
    const box=node('article','','saved-item');box.append(node('p',item.answer));
    for(const source of item.sources || (item.source?[item.source]:[])){
      const a=node('a',source.title+' ↗','source-link');a.href=source.url;a.target='_blank';a.rel='noopener';box.append(a)
    }
    const remove=node('button','移除','quiet');remove.onclick=()=>{saved.splice(i,1);renderSaved();toast('已移除收藏')};box.append(remove);el('saved-list').append(box);
  });
}
let documents=[];
function renderDocs(){
  const keyword=el('search').value.trim();el('documents').replaceChildren();
  const matches=documents.filter(d=>(d.title+d.description).includes(keyword));
  if(!matches.length){el('documents').append(node('div','没有匹配的资料，试试“成绩”或“机会成本”。','empty'));return}
  el('documents').append(node('p','匹配 '+matches.length+' 条，展示前 50 条。输入题名或关键词可缩小范围。'));
  for(const d of matches.slice(0,50)){
    const box=node('article','','document');box.append(node('span',d.type,'tag'),node('h2',d.title),node('p',d.description));
    const actions=node('div','','document-actions');const askButton=node('button','请小贸讲讲','quiet');askButton.onclick=()=>ask(d.question);actions.append(askButton);
    if(d.url){const link=node('a','查看来源原文 ↗');link.href=d.url;link.target='_blank';link.rel='noopener';actions.append(link)}
    box.append(actions);el('documents').append(box);
  }
}
document.addEventListener('click',event=>{
  const question=event.target.closest('[data-question]');if(question)ask(question.dataset.question);
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action==='chat')location.hash='chat';
  if(action==='new'){reset();location.hash='chat'}
  if(action==='about')location.hash='settings';
  if(action==='pet')el('pet-dialog').showModal();
  if(action==='pet-chat'){el('pet-dialog').close();location.hash='chat';el('q').focus()}
});
el('pet-dialog').querySelector('.close').onclick=()=>el('pet-dialog').close();
el('chat-form').onsubmit=e=>{e.preventDefault();ask(el('q').value)};
el('q').oninput=()=>el('count').textContent=el('q').value.length+' / 500';
el('q').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ask(el('q').value)}};
el('search').oninput=renderDocs;
el('large-text').onchange=e=>document.body.classList.toggle('large-text',e.target.checked);
el('reduce-motion').onchange=e=>document.body.classList.toggle('reduce-motion',e.target.checked);
const pet=el('pet-art');
function showPet(){if(pet.naturalWidth){pet.hidden=false;el('pet-pending').hidden=true}}
pet.onload=showPet;showPet();
el('today').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long',timeZone:'Asia/Shanghai'}).format(new Date());
window.addEventListener('hashchange',route);reset();route();
fetch('/catalog').then(r=>{if(!r.ok)throw Error();return r.json()}).then(data=>{documents=data;renderDocs();el('status').textContent='本地资料可用'}).catch(()=>{el('status').textContent='服务暂未连接';el('documents').append(node('div','资料加载失败，请刷新重试。','empty'))});

el('model-mode').onchange=()=>{const local=el('model-mode').value==='cloud';el('model-help').textContent=local?'问题与资料留在本机。':'将问题和命中的资料发送至 DeepSeek；规则工具仍在本机执行。';el('processing-mode').textContent=local?'本地处理 · 校务答案附原文':'已启用云端 · 问题与资料片段将发送至 DeepSeek';};
fetch('/capabilities').then(r=>r.json()).then(c=>{if(!c.cloudConfigured){for(const o of el('model-mode').options)if(o.value!=='cloud')o.disabled=true;el('model-help').textContent='云端 API 模式可用；服务端尚未配置云端密钥。';}}).catch(()=>{});
