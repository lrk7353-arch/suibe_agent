const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const appConfig = require('./config.cjs');
const local = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
let version = appConfig.config.version || '0.0.0';
try { version = JSON.parse(local('VERSION.json')).version || version; } catch {}
const doc = JSON.parse(local('data/grade-review.json'));
const kbCatalog = require('./kb-data.cjs').docs.map(d=>({title:d.title||'未命名资料',description:d.text.slice(0,180),type:({campus:'校务资料',news:'校园新闻',cross_campus:'跨校与专项资料'}[d.collection])+' · '+(d.published_at||'日期未知'),question:'请介绍'+d.title,url:d.source_url}));
const page = local('index.html');
const port = appConfig.ports.web;
const host = appConfig.host;
const persona = '你叫小贸，是同学们的上经贸大校园小助手，是学生项目中的AI。用自然亲切的中文，耐心、轻快，最多三句话。不要装作校方或真人，不承诺替人办事。用生活中的例子讲解经贸概念。仅围绕给定概念和知识卡，保留条件；不编造数据、通知或网址。不主动追问。';
const cards = [
  {name:'机会成本', fact:'选择一项活动时放弃的最佳替代方案的价值。仅计算最佳替代选择，不能把所有放弃的选项相加。', example:'同一晚可去听讲座或做兼职。如果兼职是最佳替代，选择讲座的机会成本可包括放弃的兼职收入。'},
  {name:'比较优势', fact:'当一方生产某种产品的机会成本相对更低时，它在这种产品上有比较优势。比较时需要双方各自的机会成本。', example:'即使一位同学做表格和翻译都更快，两人分工时仍可比较各自为翻译一页而放弃多少表格工作。'}
];
const grade = '成绩核实';
const normalize = value => typeof value === 'string' ? value.trim() : '';
const courses = ['正常考试','补考','缓考','跨校选修'];
const topics = [grade, ...cards.map(c => c.name)];
function response(answer, topic='', options=[], extra={}) {
  return {answer, context:{topic}, options, ...extra};
}
async function probeJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw Error('HTTP ' + r.status);
  return r.json();
}
async function health() {
  const expected = appConfig.config;
  const result = {
    status: 'degraded', ready: false, service: 'web', version, pid: process.pid,
    model: { ok: false, expected: expected.model.id, url: appConfig.modelBase },
    kb: { ok: false, expectedVersion: expected.kb.version, expectedChunks: expected.kb.chunks, url: appConfig.ragBase }
  };
  result.model={ok:Boolean(process.env.DEEPSEEK_API_KEY),provider:'cloud',model:'deepseek-flash',status:'configuration-only; API connectivity not tested'};
  try {
    const h = await probeJson(appConfig.ragBase + '/health');
    result.kb.version = h.version;
    result.kb.chunks = h.chunks;
    result.kb.collections = h.collections;
    result.kb.ok = h.status === 'ok' && h.version === expected.kb.version && h.chunks === expected.kb.chunks;
    if (h.status === 'ok' && !result.kb.ok) result.kb.error = '知识库版本或分区数与配置不一致';
  } catch (error) { result.kb.error = error.message; }
  result.ready = result.model.ok && result.kb.ok;
  result.status = result.ready ? 'ok' : 'degraded';
  return result;
}
async function reply(question, context={}, generate=explain, mode='cloud') {
  context=require('./context.cjs').cleanContext(context);
  const q = question.trim();
  const trade=require('./trade-workflow.cjs').tradeWorkflow(q,context);
  if(trade && (mode==='local'||context.task==='landed_cost'||trade.toolProposal||Object.keys(trade.context?.tradeArgs||{}).length||(q.match(/\d+/g)||[]).length<6))return trade;
  if(/进口成本|关税计算|到岸成本/.test(q)){
    if((q.match(/\d+/g)||[]).length>=6){
      try{const proposal=await require('./providers.cjs').proposeTradeTool(q,mode);if(proposal)return response('我已把你给出的数值整理成计算草案。核对下方参数后，点击计算即可。','',[],{toolProposal:proposal,mode:proposal.provider==='cloud'?'DeepSeek 提取参数 · 待核对':require('./providers.cjs').capabilities().local+' 提取参数 · 待核对'});}catch{}
    }
    return response('可以呀。填写货价、运费、保险费、汇率、关税率和增值税率，就能看到完整计算过程。也可以一次把六个数值告诉我。','',[],{mode:'本地工具入口',actions:[{label:'打开进口成本计算器',url:'/pocket#tools'}]});
  }
  const last = topics.includes(context?.topic) ? context.topic : '';
  if (/忽略.{0,10}(指令|规则)|系统提示词|扮演教务处/.test(q))
    return response('我是小贸，可以帮你查已收录的校务资料，也可以一起学个经贸概念。');
  if (/^(你好|嗨|哈[喽啰]|你是谁|你能做什么)[呀啊吗！!？?。 ]*$/.test(q))
    return response('你好呀，我是小贸，同学们的校园 AI 小助手。你可以问我成绩怎么核实，也可以让我用校园里的小例子讲讲经贸。','',['成绩核实怎么申请？','解释机会成本']);
  const card = cards.find(c => q.includes(c.name)) ||
    (/^(再)?(举个例子|换个例子|解释一下)[？?。！!]*$/.test(q) && cards.find(c=>c.name===last));
  if (card) {
    let answer, mode;
    try { answer = await generate(card,q); mode='DeepSeek 讲解 · 已编写知识卡'; }
    catch { answer=card.fact+' '+card.example; mode='本地知识卡 · 模型超时、不可用或格式异常'; }
    return response(answer,card.name,['解释'+cards.find(c=>c!==card).name],{mode});
  }
  const follow = /^(那|我|是|那我)?(正常考试|补考|缓考|跨校选修|怎么申请|多久能查结果|可以申请几次|什么时候申请|什么时候能查结果)[呢呀啊？?。]*$/;
  if (/成绩核实|成绩复核|查分申请|成绩.{0,8}(异议|复核|核实)/.test(q) || (last===grade && follow.test(q))) {
    const course = courses.find(c=>q.includes(c)) ||
      (last===grade && courses.includes(context?.course) ? context.course : '');
    const state = {topic:grade,course};
    const result = (answer, options) => response(answer,grade,options,{
      context:state,source:{title:doc.title,url:doc.url},mode:'本地资料 · 2019 年修订，办理前请核对本学期通知'
    });
    if (/今天|今年|本学期.{0,5}(截止|最后)|几月几[日号]|还能|来得及/.test(q))
      return result('我这里只有历史细则，没有本学期的截止日期。你可以先到教务处核对当期通知。',['什么时候申请']);
    if (/结果|查询/.test(q) && !/补考/.test(q))
      return result(doc.chunks[2].body,['可以申请几次']);
    if (/几次|次数|还要.{0,5}补考|还用.{0,5}补考/.test(q))
      return result(doc.chunks[0].body,['怎么申请','多久能查结果']);
    if (/时间|何时|什么时候|截止/.test(q) || courses.some(c=>q.includes(c))) {
      if (!course) return result('申请时间和考试类型有关。你问的是哪一种？',courses);
      const sentence = /补考|缓考/.test(course) ? '补考或缓考课程，应在成绩公布后一周内提出核实申请。' :
        course==='跨校选修' ? '跨校选修课程，应在下学期开学第一周内向开课学校教务处提出申请。' :
        '本校正常考试课程，应在下学期开学第一周内向教务处提出申请。';
      return result('按这份细则，'+sentence,['怎么申请','多久能查结果']);
    }
    if (/怎么|如何|流程|申请表/.test(q)) return result(doc.chunks[2].body,['什么时候申请','可以申请几次']);
    return result('这份细则收录了申请条件、申请时间和办理流程。你想了解哪一项？',['可以申请几次','什么时候申请','怎么申请']);
  }
  try { return await require('./rag.cjs').askRag(q,context,mode); }
  catch { return response('这次服务没有完成回答，可以重试或在知识库中查看原文。','',[q],{mode:'服务异常'}); }
}
async function explain(card, question) { return (await require('./providers.cjs').complete([{role:'system',content:persona+' 仅依据以下知识卡解释：'+card.fact+' '+card.example},{role:'user',content:question}],'cloud')).answer; }
if (require.main===module) http.createServer(async(req,res)=>{
  const send=(code,type,data)=>{res.writeHead(code,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);};
  const allowedHosts = ['127.0.0.1:'+port, 'localhost:'+port, host+':'+port];
  if (!allowedHosts.includes(req.headers.host)) return send(403,'text/plain','仅限本机');
  if (req.method==='GET' && req.url==='/health') {
    try { return send(200,'application/json',JSON.stringify(await health())); }
    catch (error) { return send(500,'application/json',JSON.stringify({status:'error',error:error.message})); }
  }
  if (req.method==='GET' && req.url==='/') return send(200,'text/html',page);
  const assets = {'/ui-preview':['ui-preview.html','text/html'],'/ui-preview.css':['ui-preview.css','text/css'],'/ui-preview.js':['ui-preview.js','text/javascript'],'/app.css':['app.css','text/css'],'/app.js':['app.js','text/javascript'],'/mobile':['mobile.html','text/html'],'/pocket':['mobile-app.html','text/html'],'/mobile-app.html':['mobile-app.html','text/html'],'/trade-tools.js':['trade-tools.js','text/javascript'],'/offline-cards.json':['data/offline-cards.json','application/json']};
  if(req.method==='GET' && Object.hasOwn(assets,req.url)) {
    const [file,type]=assets[req.url];
    return send(200,type,local(file));
  }
  if(req.method==='GET' && req.url==='/assets/xiaomao.png' && fs.existsSync(path.join(__dirname,'assets/xiaomao.png'))) {
    res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});
    return res.end(fs.readFileSync(path.join(__dirname,'assets/xiaomao.png')));
  }
  if(req.method==='GET' && req.url==='/capabilities') return send(200,'application/json',JSON.stringify(require('./providers.cjs').capabilities()));
  if(req.method==='GET' && req.url==='/catalog') return send(200,'application/json',JSON.stringify(kbCatalog));
  if(req.method!=='POST'||!['/ask','/tool'].includes(req.url)) return send(404,'text/plain','没有这个入口');
  if(!req.headers['content-type']?.startsWith('application/json') || (req.headers.origin && !['http://127.0.0.1:'+port,'http://localhost:'+port,'http://'+host+':'+port].includes(req.headers.origin))) return send(403,'text/plain','请求来源不支持');
  try {
    let size=0, parts=[];
    for await (const part of req){size+=part.length;if(size>8192)return send(413,'text/plain','消息过长');parts.push(part);}
    const body=JSON.parse(Buffer.concat(parts).toString());
    if(req.url==='/tool')return send(200,'application/json',JSON.stringify(require('./trade-tools.js').execute(body.name,body.args)));
    const {question,context,mode='cloud'}=body;
    if(!['local','auto','cloud'].includes(mode)) return send(400,'text/plain','模式无效');
    const q=normalize(question);
    if(!q||q.length>500) return send(400,'text/plain','请使用 1–500 字提问');
    const result=await reply(q,context,explain,mode);
    result.context={...(result.context||{}),updatedAt:Date.now()};
    send(200,'application/json',JSON.stringify(result));
  } catch {send(400,'text/plain','请求未完成，请重试');}
}).listen(port,'127.0.0.1');
module.exports={reply,health};
