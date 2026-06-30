// ═══════════════════════════════════════════════════
//  AI Detailing Coach — Cloudflare Worker v3.1
//  Fix: gemini-2.5-flash + safe JSON parsing for all providers
// ═══════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response('', { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/data') {
        return await handleData(request, url, env);
      }
      if (path === '/ai') {
        if (request.method !== 'POST') {
          return respond({ error: 'POST only' }, 405);
        }
        const body = await request.json();
        return await handleAI(body, env);
      }
      if (path === '/ping') {
        return respond({ ok: true, version: '3.2', storage: !!env.DATA_STORE });
      }
      if (path === '/status') {
        return respond({
          version: '3.2',
          keys: {
            groq:          !!env.GROQ_KEY,
            deepseek:      !!env.DEEPSEEK_KEY,
            github_models: !!env.GITHUB_MODELS_KEY,
            claude:        !!env.CLAUDE_KEY,
          },
          storage: !!env.DATA_STORE,
        });
      }
      return respond({ error: 'not found' }, 404);
    } catch (err) {
      return respond({ error: err.message }, 500);
    }
  }
};

// ═══════════════════════════════════════════════════
//  SAFE JSON PARSE — handles plain-text rate-limit responses
// ═══════════════════════════════════════════════════
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Plain text error (e.g. "Too many requests", "Service Unavailable")
    throw new Error(text.slice(0, 120).trim());
  }
}

// ═══════════════════════════════════════════════════
//  DATA STORAGE (Cloudflare KV)
// ═══════════════════════════════════════════════════
async function handleData(request, url, env) {
  const uid = url.searchParams.get('uid');
  if (!uid || uid.length < 8) {
    return respond({ error: 'uid الزامیه (حداقل ۸ کاراکتر)' }, 400);
  }
  const key = `user:${uid}`;

  if (request.method === 'GET') {
    if (!env.DATA_STORE) return respond({ error: 'KV storage تنظیم نشده' }, 503);
    const raw = await env.DATA_STORE.get(key);
    if (!raw) return respond({ products: [], doctors: [], sessions: 0, firstSync: true });
    return respond(JSON.parse(raw));
  }

  if (request.method === 'POST') {
    if (!env.DATA_STORE) return respond({ error: 'KV storage تنظیم نشده' }, 503);
    const body = await request.json();
    const data = {
      products: Array.isArray(body.products) ? body.products : [],
      doctors:  Array.isArray(body.doctors)  ? body.doctors  : [],
      sessions: typeof body.sessions === 'number' ? body.sessions : 0,
      lastSync: new Date().toISOString(),
    };
    await env.DATA_STORE.put(key, JSON.stringify(data), { expirationTtl: 86400 * 365 });
    return respond({ ok: true, lastSync: data.lastSync });
  }

  return respond({ error: 'method not allowed' }, 405);
}

// ═══════════════════════════════════════════════════
//  AI FALLBACK CASCADE
// ═══════════════════════════════════════════════════
async function handleAI({ system, messages, fallbackQuery }, env) {
  const errors = [];

  // 1. Groq Llama
  if (env.GROQ_KEY) {
    try {
      const text = await callGroq(system, messages, env.GROQ_KEY);
      return respond({ text, source: 'groq' });
    } catch (e) {
      errors.push(`Groq: ${e.message}`);
    }
  } else { errors.push('Groq: کلید تنظیم نشده'); }

  // 2. DeepSeek via OpenModel
  if (env.DEEPSEEK_KEY) {
    try {
      const text = await callDeepSeek(system, messages, env.DEEPSEEK_KEY);
      return respond({ text, source: 'deepseek' });
    } catch (e) {
      errors.push(`DeepSeek: ${e.message}`);
    }
  } else { errors.push('DeepSeek: کلید تنظیم نشده'); }

  // 3. GitHub Models GPT-4o
  if (env.GITHUB_MODELS_KEY) {
    try {
      const text = await callGitHubModels(system, messages, env.GITHUB_MODELS_KEY);
      return respond({ text, source: 'github-models' });
    } catch (e) {
      errors.push(`GitHub Models: ${e.message}`);
    }
  } else { errors.push('GitHub Models: کلید تنظیم نشده'); }

  // 4. Claude Haiku
  if (env.CLAUDE_KEY) {
    try {
      const text = await callClaude(system, messages, env.CLAUDE_KEY);
      return respond({ text, source: 'claude' });
    } catch (e) {
      errors.push(`Claude: ${e.message}`);
    }
  } else { errors.push('Claude: کلید تنظیم نشده'); }

  // 6. Non-AI fallback: openFDA + MyMemory
  if (fallbackQuery) {
    try {
      const text = await callNonAiFallback(fallbackQuery, env);
      return respond({ text, source: 'fallback-db' });
    } catch (e) {
      errors.push(`Fallback DB: ${e.message}`);
    }
  }

  return respond({ error: 'همه AI ها در دسترس نیستند:\n' + errors.join('\n') }, 503);
}

// ═══════════════════════════════════════════════════
//  AI PROVIDERS
// ═══════════════════════════════════════════════════
async function callGroq(system, messages, key) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        }))
      ],
      max_tokens: 3000,
      temperature: 0.8
    })
  });

  const data = await safeJson(res);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('پاسخی از Groq نرسید');
  return text;
}

async function callDeepSeek(system, messages, key) {
  const res = await fetch('https://api.openmodel.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        }))
      ],
      max_tokens: 3000,
      temperature: 0.8
    })
  });

  const data = await safeJson(res);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('پاسخی از DeepSeek نرسید');
  return text;
}

async function callGitHubModels(system, messages, key) {
  const res = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        }))
      ],
      max_tokens: 3000,
      temperature: 0.8
    })
  });

  const data = await safeJson(res);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('پاسخی از GitHub Models نرسید');
  return text;
}

async function callClaude(system, messages, key) {
  const normalized = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content
  }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      system,
      messages: normalized
    })
  });

  const data = await safeJson(res);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('پاسخی از Claude نرسید');
  return text;
}

// ═══════════════════════════════════════════════════
//  NON-AI FALLBACK (openFDA + MyMemory)
// ═══════════════════════════════════════════════════
function looksPersian(s) {
  return /[\u0600-\u06FF]/.test(s || '');
}

async function callNonAiFallback(rawQuery, env) {
  let englishQuery = rawQuery.trim();
  if (looksPersian(englishQuery)) {
    englishQuery = await translateViaMyMemory(englishQuery, 'fa', 'en');
  }
  if (!englishQuery) throw new Error('نام دارو برای جستجو در دسترس نیست');

  const fdaRes = await fetch(
    `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${encodeURIComponent(englishQuery)}"&limit=1`
  );
  const fdaData = await safeJson(fdaRes);
  if (!fdaData.results || !fdaData.results.length) {
    throw new Error(`'${englishQuery}' در پایگاه داده FDA پیدا نشد`);
  }
  const label = fdaData.results[0];
  const pick = (field, maxLen = 500) => {
    const val = label[field];
    if (!val || !val.length) return null;
    return val[0].slice(0, maxLen);
  };

  const englishSummary = [
    pick('indications_and_usage') ? `Indication: ${pick('indications_and_usage')}` : '',
    pick('mechanism_of_action') ? `Mechanism: ${pick('mechanism_of_action')}` : '',
    pick('dosage_and_administration') ? `Dosage: ${pick('dosage_and_administration')}` : '',
    pick('adverse_reactions') ? `Adverse reactions: ${pick('adverse_reactions')}` : '',
    (pick('warnings_and_cautions') || pick('warnings')) ? `Warnings: ${pick('warnings_and_cautions') || pick('warnings')}` : '',
  ].filter(Boolean).join('\n\n');

  if (!englishSummary) throw new Error('اطلاعات کافی در FDA label موجود نبود');
  const persianSummary = await translateViaMyMemory(englishSummary, 'en', 'fa');
  return `[NON-AI-FALLBACK]\n🔧 منبع: پایگاه داده دارویی FDA (ترجمه خودکار)\n\n${persianSummary}`;
}

async function translateViaMyMemory(text, source, target) {
  const chunks = chunkText(text, 450);
  const translated = [];
  for (const chunk of chunks) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${source}|${target}`;
    const res = await fetch(url);
    const data = await safeJson(res);
    const t = data?.responseData?.translatedText;
    if (!t) throw new Error('ترجمه ناموفق بود (MyMemory)');
    translated.push(t);
  }
  return translated.join('\n\n');
}

function chunkText(text, maxLen) {
  const paragraphs = text.split('\n\n');
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > maxLen && current) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
  }
  if (current) chunks.push(current);
  return chunks.flatMap(c => {
    if (c.length <= maxLen) return [c];
    const parts = [];
    for (let i = 0; i < c.length; i += maxLen) parts.push(c.slice(i, i + maxLen));
    return parts;
  });
}

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
