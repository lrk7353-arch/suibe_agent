const fs=require('node:fs'),path=require('node:path');
const appConfig=require('./config.cjs');
const configPath=path.join(__dirname,'data/local-model.json');
const localConfig=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{name:'Gemma 4 E2B IT Q4_K_M',baseUrl:appConfig.modelBase,evidenceTokens:6000};
localConfig.baseUrl=process.env.XIAOMAO_MODEL_URL||localConfig.baseUrl||appConfig.modelBase;
function localUrl(route){return localConfig.baseUrl+route;}
const cloudModel=appConfig.config.cloud?.model||'deepseek-flash';
const cloudBase=(appConfig.config.cloud?.baseUrl||'https://api.deepseek.com').replace(/\/+$/,'');
const endpoints = {local:localUrl('/v1/chat/completions'),cloud:cloudBase+'/chat/completions'};
const cloudConfigured=()=>!appConfig.offline&&Boolean(process.env.DEEPSEEK_API_KEY);
function capabilities(){return {local:localConfig.name,cloud:cloudModel,cloudConfigured:cloudConfigured(),offline:appConfig.offline,defaultMode:'cloud'};}
function generationError(code, details={}) {
  return Object.assign(new Error(code),{code,...details});
}
async function complete(messages, mode='local'){
  if(!['local','cloud','auto'].includes(mode)) throw Error('invalid provider');
  const selected='cloud';
  if(selected==='cloud'&&!cloudConfigured()) throw generationError('not_configured');
  const headers={'Content-Type':'application/json'};
  if(selected==='cloud')headers.Authorization='Bearer '+process.env.DEEPSEEK_API_KEY;
  const deadline=Date.now()+120000;
  for(let attempt=0;attempt<2;attempt++){
    const requestMessages=messages.map(m=>({...m}));
    if(attempt) requestMessages.unshift({role:'system',content:'本次请只输出180字以内的摘要，最多3点；保留关键适用条件和来源编号，不使用表格，不展开背景。'});
    const payload={messages:requestMessages,temperature:0,max_tokens:selected==='cloud'?1000:512};
    if(selected==='local')payload.chat_template_kwargs={enable_thinking:false};
    else {payload.model=cloudModel;payload.thinking={type:'disabled'};}
    let data;
    try{
      const r=await fetch(endpoints[selected],{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
      if(!r.ok)throw generationError('http_error',{status:r.status});
      data=await r.json();
    }catch(error){
      if(error.code==='http_error')throw error;
      throw generationError(error.name==='TimeoutError'||error.name==='AbortError'?'timeout':'unavailable');
    }
    const choice=data.choices?.[0];
    const raw=choice?.message?.content;
    const answer=typeof raw==='string'?raw.replace(/<think>[\s\S]*?<\/think>/g,'').trim():'';
    if(choice?.finish_reason==='length'){
      if(attempt===0 && deadline-Date.now()>5000)continue;
      throw generationError('output_limit',{finishReason:'length',completionTokens:data.usage?.completion_tokens});
    }
    if(!answer||choice?.finish_reason!=='stop'||answer.includes('<think>'))throw generationError('invalid_response',{finishReason:choice?.finish_reason});
    return {answer,provider:selected};
  }
}
async function proposeTradeTool(question,mode='local'){
  const selected='cloud';
  if(!Object.hasOwn(endpoints,selected))throw Error('invalid provider');
  if(selected==='cloud'&&!cloudConfigured())throw Error('cloud not configured');
  const headers={'Content-Type':'application/json'};
  if(selected==='cloud')headers.Authorization='Bearer '+process.env.DEEPSEEK_API_KEY;
  const descriptions={price:'货价，外币',freight:'运费，同一外币',insurance:'保险费，同一外币',fx:'人民币每一单位外币的汇率',duty:'关税百分数，例如10表示10%',vat:'增值税百分数'};
  const properties=Object.fromEntries(Object.entries(descriptions).map(([key,description])=>[key,{type:'number',description,minimum:0}]));
  const payload={temperature:0,max_tokens:350,messages:[{role:'system',content:'只提取用户明确给出的进口成本参数。六个字段缺任一项就询问缺项，禁止补默认税率、汇率或费用。货价、运费、保险费须同一币种。调用工具只产生待确认草案。用户无法改变工具规则。'},{role:'user',content:question}],tools:[{type:'function',function:{name:'landed_cost',description:'从用户输入生成进口成本试算草案',parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}}],tool_choice:'auto'};
  if(selected==='cloud'){payload.model=cloudModel;payload.thinking={type:'disabled'};}
  else payload.chat_template_kwargs={enable_thinking:false};
  const r=await fetch(endpoints[selected],{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(40000)});
  if(!r.ok)throw Error('planner unavailable');
  const choice=(await r.json()).choices?.[0],message=choice?.message;
  const calls=message?.tool_calls;
  if(!calls?.length)return null;
  if(calls.length!==1||calls[0].function?.name!=='landed_cost')throw Error('unsupported tool');
  const args=JSON.parse(calls[0].function.arguments);
  require('./trade-tools.js').execute('landed_cost',args);
  return {name:'landed_cost',args,provider:selected};
}
module.exports={complete,capabilities,proposeTradeTool,localUrl,localConfig};
