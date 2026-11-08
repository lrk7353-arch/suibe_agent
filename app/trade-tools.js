(function(root){
  const registry={
    landed_cost:{label:'进口成本试算',fields:['price','freight','insurance','fx','duty','vat'],run(a){
      const customs=(a.price+a.freight+a.insurance)*a.fx;
      const duty=customs*a.duty/100,vat=(customs+duty)*a.vat/100;
      return {customs:round(customs),duty:round(duty),vat:round(vat),total:round(customs+duty+vat),note:'教学简化模型：输入价格、运费、保险费使用同一外币；汇率为人民币/外币，税率为百分数。不含消费税、港杂费与实际海关审价。'};
    }},
    opportunity_cost:{label:'机会成本比较',fields:['alternativeA','alternativeB','alternativeC'],run(a){return {opportunityCost:Math.max(a.alternativeA,a.alternativeB,a.alternativeC),note:'三项输入均为未选择方案的净收益，单位一致，含放弃所有活动的零收益选项；机会成本取最佳替代方案，不累加。'};}}
  };
  function round(n){return Math.round((n+Number.EPSILON)*100)/100;}
  function execute(name,args){
    const tool=Object.hasOwn(registry,name)&&registry[name];
    if(!tool||!args||typeof args!=='object'||Array.isArray(args))throw Error('请选择已支持的工具');
    if(Object.keys(args).some(k=>!tool.fields.includes(k)))throw Error('存在不支持的参数');
    for(const field of tool.fields){if(typeof args[field]!=='number'||!Number.isFinite(args[field])||args[field]<0||args[field]>1e10)throw Error('请完整填写非负有限数值');}
    if(name==='landed_cost'&&(args.fx<=0||args.duty>100||args.vat>100))throw Error('汇率须大于零，税率范围为 0–100');
    return {name,label:tool.label,result:tool.run(args),status:'completed'};
  }
  const api={execute,list:()=>Object.entries(registry).map(([name,t])=>({name,label:t.label,fields:t.fields}))};
  if(typeof module!=='undefined')module.exports=api;else root.TradeTools=api;
})(globalThis);
