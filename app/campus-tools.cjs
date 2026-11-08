const fs = require('node:fs');
const path = require('node:path');
const docs = require('./kb-data.cjs').docs.filter(d=>d.collection==='campus');
const borrowing = docs.find(d=>d.title==='借阅服务'&&d.source_url==='https://lib.suibe.edu.cn/12/list.htm') || docs.find(d=>d.source_url==='https://lib.suibe.edu.cn/2021/0603/c132a10584/page.htm');
const wireless = docs.find(d=>d.source_url==='https://itc.suibe.edu.cn/2024/1225/c21770a179736/page.htm') || require('./data/network-service-reviewed.json');
const categories = ['本科生','硕士研究生','博士研究生','教职工'];

function runCampusTool(question, previous={}) {
  const networkNames=['SUIBE','SUIBE-1X','eduroam'];
  const selected=networkNames.find(name=>question.toLowerCase()===name.toLowerCase());
  if(wireless && (/校园网|无线网|wifi/i.test(question) || (previous?.task==='campus_network' && selected))){
    const base={context:{task:'campus_network'},options:networkNames,tools:[{name:'get_network_guide',status:'completed',label:'查询信息化办公室无线网络指南'}],mode:'本地网络工具 · 按网络名称展示原文'};
    if(!selected) return {...base,answer:'不同网络的认证方式不同。你正在连接哪个 Wi-Fi 名称？'};
    const starts=[wireless.text.indexOf('\nSUIBE\n'),wireless.text.indexOf('\nSUIBE-1X\n'),wireless.text.indexOf('\neduroam\n')];
    const index=networkNames.indexOf(selected);
    if(starts[index]<0)return null;
    const text=wireless.text.slice(starts[index],index<2?starts[index+1]:undefined).trim();
    return {...base,answer:'以下是信息化办公室指南中 '+selected+' 的说明：\n'+text,
      sources:[{title:wireless.title,url:wireless.source_url,date:wireless.published_at,text}]};
  }
  const continuation = previous?.task==='library_borrowing' &&
    /^(那)?(其实)?(我是|我|是)?(本科生|硕士研究生|博士研究生|教职工|研究生|怎么续借|续借|能借几本|可以借多久|能借多久)[呢呀啊？?。]*$/.test(question);
  if(!/借书|借阅|续借|借几本书|图书.{0,12}借/.test(question) && !continuation) return null;
  if(!borrowing) return null;
  const explicit = categories.find(c=>question.includes(c));
  const ambiguous = !explicit && question.includes('研究生');
  const studentType = ambiguous ? '' : explicit || (categories.includes(previous?.studentType)?previous.studentType:'');
  const context={task:'library_borrowing',studentType};
  const intent = /续借/.test(question) ? 'renew' :
    /多久|期限|几本|多少/.test(question) ? 'quota' :
    continuation && ['quota','renew'].includes(previous?.intent) ? previous.intent : '';
  context.intent=intent;
  if(!intent)return null;
  const source={title:borrowing.title,url:borrowing.source_url,date:borrowing.published_at,text:''};
  const base={context,options:[],mode:'本地借阅工具 · 依据已收录服务指南',tools:[{name:'get_service_guide',status:'completed',label:'查询借阅服务指南'}]};
  if(intent==='renew'){
    const modern=borrowing.text.match(/\n续\s*借\n/);
    const start=modern?modern.index:borrowing.text.indexOf('3.怎样续借图书');
    const end=modern?borrowing.text.indexOf('预 约',start):borrowing.text.indexOf('4.图书遗失',start);
    if(start<0 || end<0)return null;
    source.text=borrowing.text.slice(start,end);
    return {...base,answer:source.text,sources:[source],options:['图书可以借多久？']};
  }
  if(!studentType)return {...base,answer:'借阅数量和期限按读者类别区分。你是哪一类读者？',options:ambiguous?['硕士研究生','博士研究生']:categories};
  const lines=borrowing.text.split(/\r?\n/).map(s=>s.trim());
  let row=lines.find(line=>line.startsWith(studentType+'可借'));
  if(!row){const at=lines.indexOf(studentType);if(at>=0&&/^[0-9]+册/.test(lines[at+1]||'')&&/^[0-9]+个月$/.test(lines[at+2]||''))row=studentType+'可借'+lines[at+1]+'，借阅期限'+lines[at+2]+'。';}
  if(!row)return null;
  source.text=row;
  return {...base,answer:'按已收录的图书馆服务指南，'+row,sources:[source],options:['怎么续借']};
}
module.exports={runCampusTool};
