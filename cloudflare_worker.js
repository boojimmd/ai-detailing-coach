// ═══════════════════════════════════════════════════
//  AI Detailing Coach — Cloudflare Worker
//  Features: AI Fallback (Gemini→Groq→Claude) + KV Storage
//
//  Environment variables (Secrets):
//    GEMINI_KEY   — از aistudio.google.com (رایگان)
//    GROQ_KEY     — از console.groq.com (رایگان)
//    DEEPSEEK_KEY      — از openmodel.ai (رایگان موقت — رویداد تشویقی، ممکنه تموم بشه)
//    GITHUB_MODELS_KEY — از github.com/settings/tokens (رایگان دائمی، محدودیت روزانه کم)
//    CLAUDE_KEY        — از console.anthropic.com (پولی، پشتیبان نهایی)
//
//  KV Binding:
//    DATA_STORE   — یه KV namespace بساز و به اسم DATA_STORE bind کن
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
      // ── Data Storage ──────────────────────────────
      if (path === '/data') {
        return await handleData(request, url, env);
      }

      // ── AI Call ───────────────────────────────────
      if (path === '/ai') {
        if (request.method !== 'POST') {
          return respond({ error: 'POST only' }, 405);
        }
        const body = await request.json();
        return await handleAI(body, env);
      }

      // ── Health check ──────────────────────────────
      if (path === '/ping') {
        return respond({ ok: true, version: '3.0', storage: !!env.DATA_STORE });
      }

      return respond({ error: 'not found' }, 404);

    } catch (err) {
      return respond({ error: err.message }, 500);
    }
  }
};

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
    if (!raw) {
      return respond({ products: [], doctors: [], sessions: 0, firstSync: true });
    }
    return respond(JSON.parse(raw));
  }

  if (request.method === 'POST') {
    if (!env.DATA_STORE) return respond({ error: 'KV storage تنظیم نشده' }, 503);
    const body = await request.json();
    // Validate structure
    const data = {
      products: Array.isArray(body.products) ? body.products : [],
      doctors:  Array.isArray(body.doctors)  ? body.doctors  : [],
      sessions: typeof body.sessions === 'number' ? body.sessions : 0,
      lastSync: new Date().toISOString(),
    };
    await env.DATA_STORE.put(key, JSON.stringify(data), {
      expirationTtl: 86400 * 365 // ۱ سال
    });
    return respond({ ok: true, lastSync: data.lastSync });
  }

  return respond({ error: 'method not allowed' }, 405);
}

// ═══════════════════════════════════════════════════
//  AI FALLBACK CASCADE
// ═══════════════════════════════════════════════════
async function handleAI({ system, messages, fallbackQuery }, env) {
  const errors = [];

  // ── 1. Gemini 2.0 Flash (رایگان، اولین) ──────────
  if (env.GEMINI_KEY) {
    try {
      const text = await callGemini(system, messages, env.GEMINI_KEY);
      return respond({ text, source: 'gemini' });
    } catch (e) {
      errors.push(`Gemini: ${e.message}`);
      console.log('Gemini failed:', e.message);
    }
  } else {
    errors.push('Gemini: کلید تنظیم نشده');
  }

  // ── 2. Groq Llama (رایگان، دوم) ─────────────────
  if (env.GROQ_KEY) {
    try {
      const text = await callGroq(system, messages, env.GROQ_KEY);
      return respond({ text, source: 'groq' });
    } catch (e) {
      errors.push(`Groq: ${e.message}`);
      console.log('Groq failed:', e.message);
    }
  } else {
    errors.push('Groq: کلید تنظیم نشده');
  }

  // ── 3. DeepSeek V4 Flash via OpenModel.ai (رایگان موقت — رویداد تشویقی) ──
  // Not a permanent free tier like Gemini/Groq — OpenModel's promo can end
  // at any time. Placed before the paid Claude fallback so it's used while
  // free, but the cascade still works normally (via Claude) once it isn't.
  if (env.DEEPSEEK_KEY) {
    try {
      const text = await callDeepSeek(system, messages, env.DEEPSEEK_KEY);
      return respond({ text, source: 'deepseek' });
    } catch (e) {
      errors.push(`DeepSeek: ${e.message}`);
      console.log('DeepSeek failed:', e.message);
    }
  } else {
    errors.push('DeepSeek: کلید تنظیم نشده');
  }

  // ── 4. GitHub Models — GPT-4o (رایگان دائمی، فقط با محدودیت روزانه کم) ──
  // Uses the rep's own GitHub Personal Access Token — completely free, no
  // promo/expiry like DeepSeek, but GPT-4o's free quota here is small
  // (~10 RPM / 50 RPD), so it sits as a deeper fallback, not a primary tier.
  if (env.GITHUB_MODELS_KEY) {
    try {
      const text = await callGitHubModels(system, messages, env.GITHUB_MODELS_KEY);
      return respond({ text, source: 'github-models' });
    } catch (e) {
      errors.push(`GitHub Models: ${e.message}`);
      console.log('GitHub Models failed:', e.message);
    }
  } else {
    errors.push('GitHub Models: کلید تنظیم نشده');
  }

  // ── 5. Claude Haiku (پشتیبان نهایی، پولی) ─────────────
  if (env.CLAUDE_KEY) {
    try {
      const text = await callClaude(system, messages, env.CLAUDE_KEY);
      return respond({ text, source: 'claude' });
    } catch (e) {
      errors.push(`Claude: ${e.message}`);
      console.log('Claude failed:', e.message);
    }
  } else {
    errors.push('Claude: کلید تنظیم نشده');
  }

  // ── 6. Non-AI fallback: openFDA structured drug label + MyMemory translation ──
  // Only attempted if the client supplied a fallbackQuery (the drug's generic/
  // ingredient name). This is a LAST RESORT: a real government drug database,
  // not an LLM, used only when every AI vendor above has failed — which in
  // practice can be a recurring situation, not just a rare edge case, since
  // Gemini/Groq/Claude have all been observed blocking requests tied to Iran.
  if (fallbackQuery) {
    try {
      const text = await callNonAiFallback(fallbackQuery, env);
      return respond({ text, source: 'fallback-db' });
    } catch (e) {
      errors.push(`Fallback DB: ${e.message}`);
      console.log('Non-AI fallback failed:', e.message);
    }
  }

  return respond({ error: 'همه AI ها در دسترس نیستند:\n' + errors.join('\n') }, 503);
}

// ═══════════════════════════════════════════════════
//  TIER 4: NON-AI FALLBACK (openFDA + MyMemory translation)
// ═══════════════════════════════════════════════════

// Detects Persian/Arabic-script text so we know whether the ingredient name
// needs translating to English BEFORE querying openFDA (which only indexes
// English generic names), or whether it's already usable as-is.
function looksPersian(s) {
  return /[\u0600-\u06FF]/.test(s || '');
}

async function callNonAiFallback(rawQuery, env) {
  // Step 1: make sure we have an English/Latin ingredient name to search
  // openFDA with. If the rep typed the ingredient in Persian (the common
  // case throughout this app), translate fa→en first via MyMemory.
  let englishQuery = rawQuery.trim();
  if (looksPersian(englishQuery)) {
    englishQuery = await translateViaMyMemory(englishQuery, 'fa', 'en');
  }
  if (!englishQuery) throw new Error('نام دارو برای جستجو در دسترس نیست');

  // Step 2: query openFDA's structured drug label database (US FDA, free,
  // no key, NOT an AI — a real government dataset).
  const fdaRes = await fetch(
    `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${encodeURIComponent(englishQuery)}"&limit=1`
  );
  const fdaData = await fdaRes.json();
  if (!fdaData.results || !fdaData.results.length) {
    throw new Error(`'${englishQuery}' در پایگاه داده FDA پیدا نشد`);
  }
  const label = fdaData.results[0];

  const pick = (field, maxLen = 500) => {
    const val = label[field];
    if (!val || !val.length) return null;
    return val[0].slice(0, maxLen);
  };

  const mechanism  = pick('mechanism_of_action') || pick('clinical_pharmacology');
  const indication = pick('indications_and_usage');
  const dosage     = pick('dosage_and_administration');
  const adverse    = pick('adverse_reactions');
  const warnings   = pick('warnings_and_cautions') || pick('warnings');

  const englishSummary = [
    indication ? `Indication: ${indication}` : '',
    mechanism  ? `Mechanism: ${mechanism}` : '',
    dosage     ? `Dosage: ${dosage}` : '',
    adverse    ? `Adverse reactions: ${adverse}` : '',
    warnings   ? `Warnings: ${warnings}` : '',
  ].filter(Boolean).join('\n\n');

  if (!englishSummary) throw new Error('اطلاعات کافی در FDA label موجود نبود');

  // Step 3: translate the English FDA text to Persian — same translation
  // service, opposite direction.
  const persianSummary = await translateViaMyMemory(englishSummary, 'en', 'fa');

  // Leading marker lets the app's UI distinguish this from a real AI analysis
  // and show an explicit "non-AI source" badge instead of presenting it as
  // if it were AI-generated.
  return `[NON-AI-FALLBACK]\n🔧 منبع: پایگاه داده دارویی FDA (ترجمه خودکار) — این تحلیل هوش مصنوعی نیست\n\n${persianSummary}`;
}

// MyMemory: free, no-key translation API. Independent infrastructure from
// Gemini/Groq/Claude, so it's very unlikely to be down at the same time as
// all three of them — a genuinely separate failure domain.
async function translateViaMyMemory(text, source, target) {
  const chunks = chunkText(text, 450);
  const translated = [];
  for (const chunk of chunks) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${source}|${target}`;
    const res = await fetch(url);
    const data = await res.json();
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
  // Further split any single paragraph that's still too long on its own
  return chunks.flatMap(c => {
    if (c.length <= maxLen) return [c];
    const parts = [];
    for (let i = 0; i < c.length; i += maxLen) parts.push(c.slice(i, i + maxLen));
    return parts;
  });
}

// ═══════════════════════════════════════════════════
//  AI PROVIDERS
// ═══════════════════════════════════════════════════
async function callGemini(system, messages, key) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 3000 }
      })
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('پاسخی از Gemini نرسید');
  return text;
}

async function callGroq(system, messages, key) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
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

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('پاسخی از Groq نرسید');
  return text;
}

// DeepSeek V4 Flash via OpenModel.ai — OpenAI-compatible gateway.
// Free during OpenModel's promotional event (rate-limited to 10 RPM / 100K
// TPM per user); reverts to normal paid pricing whenever that event ends,
// at which point this tier will simply start erroring and the cascade
// moves on to Claude — no code change needed either way.
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

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('پاسخی از DeepSeek نرسید');
  return text;
}

// GitHub Models — official, free inference API for GitHub accounts.
// Auth: a GitHub Personal Access Token with "models: read" scope (create at
// github.com/settings/tokens — fine-grained token, no paid plan needed).
// Model id uses the publisher-prefixed form ("openai/gpt-4o") per GitHub's
// own REST API docs. Free quota is small (~10 RPM / 50 requests per day),
// so this is a deep fallback, not something to lean on for heavy traffic.
async function callGitHubModels(system, messages, key) {
  const res = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'X-GitHub-Api-Version': '2026-03-10'
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

  const data = await res.json();
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

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('پاسخی از Claude نرسید');
  return text;
}

// ═══════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════
function respond(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
