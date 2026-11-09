'use strict';
// 可选的真实模型适配器：只做“意图与参数提案”，金额仍由确定性工具计算。
// 支持显式 TRADE_DEMO_MODEL_URL，或使用项目的 DEEPSEEK_API_KEY 预设（deepseek-flash）。
function stripFences(content) {
  const text = String(content || '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1] : text;
}

function extractJsonCandidate(content) {
  const text = String(content || '').trim();
  if (!text) return '';
  try { JSON.parse(stripFences(text)); return stripFences(text); } catch { /* 继续找 JSON 片段 */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = text.slice(start, end + 1);
    try { JSON.parse(candidate); return candidate; } catch { /* 不是完整 JSON */ }
  }
  return text;
}

function errorFromResponse(status, bodyText) {
  let providerMessage = '';
  let requestId = null;
  try {
    const parsed = JSON.parse(bodyText);
    providerMessage = parsed?.error?.message || parsed?.message || '';
    const m = providerMessage.match(/request_id:\s*([A-Za-z0-9-]+)/);
    if (m) requestId = m[1];
  } catch {
    providerMessage = String(bodyText || '').slice(0, 300);
    const m = providerMessage.match(/request_id[":\s]+([A-Za-z0-9-]+)/);
    if (m) requestId = m[1];
  }
  const err = new Error(`模型服务返回 HTTP ${status}${providerMessage ? `：${providerMessage}` : ''}`);
  err.code = 'model_http_error';
  err.providerStatus = status;
  err.providerMessage = providerMessage;
  err.requestId = requestId;
  return err;
}

function createHttpModel({ baseUrl, model, apiKey, timeoutMs = 30000, name = 'http-model', mode = 'http', provider = 'openai-compatible' }) {
  if (!baseUrl) throw new Error('缺少模型地址');
  const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const systemPrompt = [
    '你是“小贸”经贸演示中的参数提案器，只做自然语言理解，不做任何金额计算。',
    '只输出 JSON 对象，字段：intent（calculate|update|new_scenario|compare|sensitivity|export|explain|resume|cancel|restore_fx|campus|unknown）、slots 数组、term、flags。',
    'slots 每项：{field, value, basis, quantityUnit, quote}。field 只能是 quantity、priceTerm、currency、unitPrice、totalPrice、freight、insurance、fx、dutyRate、vatRate、domesticFees、exciseRate。',
    '不要推断用户没有明确给出的数值，不要补默认汇率或税率，不要自己计算任何金额。',
    '如果句子是假设（“如果汇率涨到 7.2”），intent 用 sensitivity，并给出 fx 的 slot；不要假设已经修改方案。',
    '如果用户说“把汇率改成 7.2”或“按 7.2 重算”，intent 用 update；只有这种情况才修改当前方案。',
    '如果用户说“另一个供应商……其他条件一样”，intent 用 new_scenario，flags.inherit=true；只把新报价的金额放进 slots，运费和保险费已含在 CIF 总价里时不要再给 freight/insurance。',
    '报价口径只接受 FOB、CFR、CIF；其他口径放在 term 并让程序拒绝。',
    '用户转去问校园问题（借阅、校园网、食堂、宿舍等）时，intent 用 campus，slots 为空。'
  ].join('\n');
  return {
    name,
    mode,
    provider,
    endpoint,
    model,
    async propose({ text, state }) {
      const context = {
        phase: state?.phase,
        activeScenarioId: state?.activeScenarioId,
        scenarios: (state?.scenarios || []).map(s => ({ id: s.id, priceTerm: s.priceTerm, input: s.input })),
        pending: state?.pending || null
      };
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const payload = {
          model,
          temperature: 0,
          max_tokens: 3000,
          stream: false,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt + (attempt > 1 ? '\n上一次没有返回可解析的 JSON。这次只输出一个 JSON 对象，不要解释，不要 Markdown。' : '') },
            { role: 'user', content: `当前状态：${JSON.stringify(context)}\n用户这句话：${text}\n只输出 JSON。` }
          ]
        };
        try {
          const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) {
            const bodyText = await res.text().catch(() => '');
            const err = errorFromResponse(res.status, bodyText);
            if (res.status === 401 || res.status === 402) throw err;
            if (res.status === 429 || res.status >= 500) { lastError = err; continue; }
            throw err;
          }
          const body = await res.json();
          const choice = body?.choices?.[0];
          const message = choice?.message;
          let content = message?.content;
          let contentSource = 'content';
          if ((!content || !String(content).trim()) && message?.reasoning_content) {
            content = message.reasoning_content;
            contentSource = 'reasoning_content';
          }
          if (!content || !String(content).trim()) {
            const err = new Error(`模型没有返回内容（finish_reason=${choice?.finish_reason || 'unknown'}）`);
            err.code = 'model_empty';
            err.finishReason = choice?.finish_reason || null;
            err.usage = body?.usage || null;
            err.debug = {
              attempt,
              finishReason: choice?.finish_reason || null,
              contentLength: String(message?.content || '').length,
              reasoningLength: String(message?.reasoning_content || '').length,
              reasoningPreview: String(message?.reasoning_content || '').slice(0, 300),
              usage: body?.usage || null
            };
            lastError = err;
            continue;
          }
          try {
            const parsed = JSON.parse(extractJsonCandidate(content));
            parsed.__meta = { contentSource, finishReason: choice?.finish_reason || null, usage: body?.usage || null, attempt };
            return parsed;
          } catch {
            const err = new Error('模型返回的不是合法 JSON，已拒绝执行');
            err.code = 'model_bad_json';
            err.contentPreview = String(content).slice(0, 200);
            err.finishReason = choice?.finish_reason || null;
            err.debug = { attempt, contentSource, contentLength: String(content).length };
            lastError = err;
            continue;
          }
        } catch (err) {
          if (err.code === 'model_http_error' && (err.providerStatus === 401 || err.providerStatus === 402)) throw err;
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            lastError = Object.assign(new Error('模型请求超时'), { code: 'model_timeout', attempt });
          } else {
            lastError = err;
          }
          continue;
        }
      }
      throw lastError || Object.assign(new Error('模型没有返回可用结果'), { code: 'model_empty' });
    }
  };
}

function fromEnv(env = process.env, { allowDeepSeek = true } = {}) {
  if (env.TRADE_DEMO_MODEL_URL) {
    return createHttpModel({
      baseUrl: env.TRADE_DEMO_MODEL_URL,
      model: env.TRADE_DEMO_MODEL || 'local-model',
      apiKey: env.TRADE_DEMO_MODEL_KEY || '',
      timeoutMs: Number(env.TRADE_DEMO_MODEL_TIMEOUT_MS || 30000),
      name: env.TRADE_DEMO_MODEL_NAME || env.TRADE_DEMO_MODEL || 'http-model',
      mode: 'http',
      provider: 'explicit'
    });
  }
  if (allowDeepSeek && env.DEEPSEEK_API_KEY) {
    const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
    return createHttpModel({
      baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model,
      apiKey: env.DEEPSEEK_API_KEY,
      timeoutMs: Number(env.DEEPSEEK_TIMEOUT_MS || 30000),
      name: `DeepSeek ${model}`,
      mode: 'deepseek',
      provider: 'deepseek'
    });
  }
  return null;
}

module.exports = { createHttpModel, fromEnv, stripFences, errorFromResponse };
