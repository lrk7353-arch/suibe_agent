const keys=['topic','course','task','studentType','intent','ragQuestion'];
function cleanContext(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  if(Number.isFinite(value.updatedAt)&&Date.now()-value.updatedAt>30*60*1000)return {};
  const result={};
  for(const key of keys)if(typeof value[key]==='string')result[key]=value[key].slice(0,key==='ragQuestion'?500:40);
  if(value.task==='landed_cost'){
    const fields=['price','freight','insurance','fx','duty','vat'];
    result.tradeArgs={};
    for(const key of fields)if(typeof value.tradeArgs?.[key]==='number'&&Number.isFinite(value.tradeArgs[key]))result.tradeArgs[key]=value.tradeArgs[key];
    result.pendingField=fields.includes(value.pendingField)?value.pendingField:'';
    result.tradeCurrencies=Array.isArray(value.tradeCurrencies)?value.tradeCurrencies.filter(c=>['USD','EUR','CNY','JPY','HKD'].includes(c)).slice(0,5):[];
  }
  return result;
}
module.exports={cleanContext};
