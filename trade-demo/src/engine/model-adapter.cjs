'use strict';
// 可选的真实模型适配器：只做“意图与参数提案”，金额仍由确定性工具计算。
// 未设置 TRADE_DEMO_MODEL_URL 时，服务默认使用模拟模型（规则抽取），离线可复现。
function stripFences(content) {
  const text = String(content || '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1] : text;
}

function createHttpModel({ baseUrl, model, apiKey, timeoutMs = 30000, name = 'http-model' }) {
  if (!baseUrl) throw new Error('缺少模型地址');
  const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const systemPrompt = [
    '你是“小贸”经贸演示中的参数提案器，只做自然语言理解，不做任何金额计算。',
    '只输出 JSON 对象，字段：intent（calculate|update|new_scenario|compare|sensitivity|export|explain|resume|cancel|restore_fx|campus|unknown）、slots 数组、term、flags。',
    'slots 每项：{field, value, basis, quantityUnit, quote}。field 只能是 quantity、priceTerm、currency、unitPrice、totalPrice、freight、insurance、fx、dutyRate、vatRate、domesticFees、exciseRate。',
    '不要推断用户没有明确给出的数值，不要补默认汇率或税率，不要自己计算任何金额。',
    '如果句子是假设（“如果汇率涨到 7.2”），intent 用 sensitivity，并给出 fx 的 slot；不要假设已经修改方案。',
    '如果用户说“另一个供应商……其他条件一样”，intent 用 new_scenario，flags.inherit=true。',
    '报价口径只接受 FOB、CFR、CIF；其他口径放在 term 并让程序拒绝。',
    '用户转去问校园问题（借阅、校园网、食堂、宿舍等）时，intent 用 campus，slots 为空。'
  ].join('\n');
  return {
    name,
    mode: 'http',
    endpoint,
    async propose({ text, state }) {
      const context = {
        phase: state?.phase,
        activeScenarioId: state?.activeScenarioId,
        scenarios: (state?.scenarios || []).map(s => ({ id: s.id, priceTerm: s.priceTerm, input: s.input })),
        pending: state?.pending || null
      };
      const payload = {
        model,
        temperature: 0,
        max_tokens: 700,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `当前状态：${JSON.stringify(context)}\n用户这句话：${text}\n只输出 JSON。` }
        ]
      };
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const err = new Error(`模型服务返回 HTTP ${res.status}`);
        err.code = 'model_http_error';
        throw err;
      }
      const body = await res.json();
      const content = body?.choices?.[0]?.message?.content;
      if (!content) {
        const err = new Error('模型没有返回内容');
        err.code = 'model_empty';
        throw err;
      }
      let parsed;
      try { parsed = JSON.parse(stripFences(content)); }
      catch {
        const err = new Error('模型返回的不是合法 JSON，已拒绝执行');
        err.code = 'model_bad_json';
        throw err;
      }
      return parsed;
    }
  };
}

function fromEnv(env = process.env) {
  const baseUrl = env.TRADE_DEMO_MODEL_URL;
  if (!baseUrl) return null;
  return createHttpModel({
    baseUrl,
    model: env.TRADE_DEMO_MODEL || 'local-model',
    apiKey: env.TRADE_DEMO_MODEL_KEY || '',
    timeoutMs: Number(env.TRADE_DEMO_MODEL_TIMEOUT_MS || 30000),
    name: env.TRADE_DEMO_MODEL_NAME || 'http-model'
  });
}

module.exports = { createHttpModel, fromEnv, stripFences };
