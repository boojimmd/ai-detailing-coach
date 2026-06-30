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
        return respond({ ok: true, version: '4.6', storage: !!env.DATA_STORE });
      }
      if (path === '/status') {
        return respond({
          version: '4.6',
          keys: {
            cf_workers_ai: !!env.AI,
            groq:          !!env.GROQ_KEY,
            openrouter:    !!env.OPENROUTER_KEY,
            deepseek:      !!env.DEEPSEEK_KEY,
            github_models: !!env.GITHUB_MODELS_KEY,
            claude:        !!env.CLAUDE_KEY,
            google_cse:    !!(env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX),
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
// Removes invalid JSON characters (control chars, broken \u escapes)
// that can appear in Persian/Arabic text input
function sanitize(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\\u(?![0-9A-Fa-f]{4})/g, '\\\\u');
}

function buildMessages(system, messages) {
  return [
    { role: 'system', content: sanitize(system) },
    ...messages.map(m => ({
      role: m.role,
      content: sanitize(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    }))
  ];
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
//  WEB SEARCH GROUNDING
//  اولویت با Google Custom Search JSON API (قانونی، رایگان تا ۱۰۰ جستجو/روز،
//  بدون نیاز به کارت بانکی). اگه کلیدش تنظیم نشده باشه یا fail بشه،
//  fallback به DuckDuckGo HTML (بدون کلید، ولی کمتر قابل‌اتکا).
// ═══════════════════════════════════════════════════
async function webSearchGoogle(query, env, maxResults = 5) {
  if (!env.GOOGLE_CSE_KEY || !env.GOOGLE_CSE_CX) throw new Error('Google CSE تنظیم نشده');
  const url = `https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_CSE_KEY}&cx=${env.GOOGLE_CSE_CX}&q=${encodeURIComponent(query)}&num=${maxResults}`;
  const res = await fetch(url);
  const data = await safeJson(res);
  if (data.error) throw new Error(data.error.message || 'خطای Google CSE');
  const items = data.items || [];
  return items.map(it => ({ title: it.title || '', snippet: it.snippet || '', url: it.link || '' })).filter(r => r.title);
}

async function webSearchDuckDuckGo(query, maxResults = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`جستجوی وب ناموفق (HTTP ${res.status})`);
  const html = await res.text();

  // استخراج عنوان + لینک + خلاصه هر نتیجه با regex (Workers به DOMParser دسترسی نداره)
  const results = [];
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;
  let m;
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
  while ((m = blockRe.exec(html)) && results.length < maxResults) {
    const rawUrl = m[1];
    const title = strip(m[2]);
    const snippet = strip(m[3]);
    // DDG لینک‌ها رو از طریق ریدایرکت /l/?uddg= می‌فرسته — استخراج لینک واقعی
    let realUrl = rawUrl;
    const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
    if (uddgMatch) { try { realUrl = decodeURIComponent(uddgMatch[1]); } catch (e) {} }
    if (title) results.push({ title, snippet, url: realUrl });
  }
  return results;
}

// ── SearXNG (متاسرچ متن‌باز، instance های عمومی، بدون کلید) ──
// چند instance رو امتحان می‌کنه چون هر کدوم ممکنه پایین باشه یا JSON رو غیرفعال کرده باشه.
const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://searx.tiekoetter.com',
  'https://priv.au',
];

async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function webSearchSearxng(query, maxResults = 5) {
  let lastErr = null;
  for (const base of SEARXNG_INSTANCES) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIDetailingCoach/1.0)' },
      }, 6000);
      if (!res.ok) { lastErr = new Error(`${base} → HTTP ${res.status}`); continue; }
      const data = await res.json();
      const items = (data.results || []).slice(0, maxResults);
      if (items.length) {
        return items.map(it => ({ title: it.title || '', snippet: it.content || '', url: it.url || '' }));
      }
      lastErr = new Error(`${base} → نتیجه‌ای نداشت`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('هیچ instance سرچ‌انگ‌ای جواب نداد');
}

// ── دارویاب: وقتی نتایج جستجو یه صفحه شرکت از darooyab.ir پیدا کردن،
// به‌جای اکتفا به خلاصهٔ کوتاه جستجو، مستقیم خود صفحه رو می‌گیریم —
// چون اونجا لیست کامل و واقعی محصولات شرکت با نام برند دقیق موجوده.
function stripHtmlToText(html, maxLen = 9000) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(tr|p|div|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
  return text.slice(0, maxLen);
}

async function fetchDarooyabPageText(url) {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
  }, 8000);
  if (!res.ok) throw new Error(`دارویاب → HTTP ${res.status}`);
  const html = await res.text();
  return stripHtmlToText(html, 9000);
}

// ── دیتابیس محلی دارویی (مرکز اطلاعات و مشاوره دارویی سریتا، GitHub Pages) ──
// شامل ~۳۰۰ دارو با نام، سیلاب (ژنریک انگلیسی)، گروه درمانی/فارماکولوژیک، نام تجاری، اشکال دارویی.
// توی KV کش می‌شه (۲۴ ساعت) که هر بار از GitHub دانلود نشه.
const CERITA_DRUG_JSON_URL = 'https://raw.githubusercontent.com/ceritamedicalconsult/ceritamedicalconsult.github.io/main/contents/data/drug.json';
const CERITA_CACHE_KEY = 'cerita_drug_db_cache';
const CERITA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 ساعت

async function getLocalDrugDB(env) {
  if (env.DATA_STORE) {
    try {
      const cached = await env.DATA_STORE.get(CERITA_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.fetchedAt < CERITA_CACHE_TTL_MS) return parsed.data;
      }
    } catch (e) { /* کش خراب بود، دوباره fetch کن */ }
  }

  const res = await fetchWithTimeout(CERITA_DRUG_JSON_URL, {}, 8000);
  if (!res.ok) throw new Error(`دیتابیس محلی دارویی → HTTP ${res.status}`);
  const data = await res.json();

  if (env.DATA_STORE) {
    try {
      await env.DATA_STORE.put(CERITA_CACHE_KEY, JSON.stringify({ data, fetchedAt: Date.now() }), { expirationTtl: 86400 * 7 });
    } catch (e) { /* اگه ذخیره fail شد مهم نیست، همون data برگردونده می‌شه */ }
  }
  return data;
}

function normalizeFa(s) {
  return (s || '').toString()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[\u064B-\u065F\u0670]/g, '') // اعراب
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function searchLocalDrugDB(query, env, maxResults = 5) {
  const db = await getLocalDrugDB(env);
  const q = normalizeFa(query);
  if (!q) return [];
  const matches = db.filter(d => {
    const name   = normalizeFa(d['نام دارو']);
    const syl    = normalizeFa(d['سیلاب ']);
    const brand  = normalizeFa(d['نام تجاری ']);
    return (name && (name.includes(q) || q.includes(name))) ||
           (syl  && (syl.includes(q)  || q.includes(syl)))  ||
           (brand&& (brand.includes(q)|| q.includes(brand)));
  }).slice(0, maxResults);

  return matches.map(d => ({
    title: `${(d['نام دارو']||'').trim()}${d['نام تجاری ']?.trim() ? ' (' + d['نام تجاری '].trim() + ')' : ''}`,
    snippet: [
      d['سیلاب ']?.trim()             ? `ژنریک: ${d['سیلاب '].trim()}` : '',
      d['گروه درمانی ']?.trim()       ? `گروه درمانی: ${d['گروه درمانی '].trim()}` : '',
      d['گروه فارماکولوژیک ']?.trim() ? `گروه فارماکولوژیک: ${d['گروه فارماکولوژیک '].trim()}` : '',
      d['اشکال دارویی ']?.trim()      ? `اشکال دارویی: ${d['اشکال دارویی '].trim().replace(/\n/g, '، ')}` : '',
    ].filter(Boolean).join(' | '),
    url: 'cerita-local-db',
  }));
}

// ترتیب اولویت: دیتابیس محلی (سریتا، سریع و قابل‌اتکا) + SearXNG → Google CSE → DuckDuckGo
async function webSearch(query, env, maxResults = 5) {
  let results = [];
  let source = 'none';

  // دیتابیس محلی دارویی (سریتا) — همیشه اول چک می‌شه، سریع و مستقل از وضعیت شبکه جستجوی وب
  try {
    const localMatches = await searchLocalDrugDB(query, env, 3);
    if (localMatches.length) { results = [...localMatches]; source = 'cerita-local-db'; }
  } catch (e) { /* دیتابیس محلی در دسترس نبود، مهم نیست */ }

  // جستجوی وب — هر کدوم fail بشه می‌ره سراغ بعدی، بدون اینکه کل تابع رو بترکونه
  let webResults = null, webSource = null;
  try {
    webResults = await webSearchSearxng(query, maxResults);
    webSource = 'searxng';
  } catch (e) { /* fall through */ }

  if (!webResults || !webResults.length) {
    try {
      webResults = await webSearchGoogle(query, env, maxResults);
      webSource = 'google';
    } catch (e) { /* fall through */ }
  }

  if (!webResults || !webResults.length) {
    try {
      webResults = await webSearchDuckDuckGo(query, maxResults);
      webSource = 'duckduckgo';
    } catch (e) { /* همه راه‌های جستجوی وب fail شدن — اگه دیتابیس محلی هم چیزی نداشت، results خالی می‌مونه */ }
  }

  if (webResults && webResults.length) {
    // اگه یکی از نتایج صفحه شرکت دارویاب بود، مستقیم خودش رو هم بگیر (داده کامل‌تر از خلاصه جستجو)
    const darooyabHit = webResults.find(r => /darooyab\.ir\/Pharmaceuticalcompanies\//i.test(r.url || ''));
    if (darooyabHit) {
      try {
        const pageText = await fetchDarooyabPageText(darooyabHit.url);
        webResults = [{ title: darooyabHit.title + ' (لیست کامل محصولات از دارویاب)', snippet: pageText, url: darooyabHit.url }, ...webResults];
      } catch (e) { /* اگه fetch مستقیم fail شد، با همون خلاصه جستجو ادامه بده */ }
    }
    results = [...results, ...webResults];
    source = source === 'cerita-local-db' ? `cerita-local-db+${webSource}` : webSource;
  }

  return { results, source };
}

function buildGroundingContext(results, query, source) {
  if (!results.length) return '';
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n');
  return `\n\n[نتایج جستجوی وب (${source}) برای «${query}» — ${new Date().toISOString().slice(0,10)}]\n${lines}\n\nاز این نتایج به‌عنوان منبع داده واقعی و به‌روز استفاده کن. اگه نتایج کافی نبود یا نامرتبط بود، صراحتاً بگو اطلاعات کافی پیدا نشد به‌جای حدس زدن.\n`;
}

// ═══════════════════════════════════════════════════
//  AI FALLBACK CASCADE
// ═══════════════════════════════════════════════════
async function handleAI({ system, messages, fallbackQuery, groundQuery }, env) {
  // Vision requests (image/PDF) → dedicated vision handler
  if (isVisionRequest(messages)) {
    return await handleVision({ system, messages }, env);
  }

  // اگه groundQuery داده شده، اول جستجوی وب رو انجام بده و به system prompt اضافه کن
  // (non-fatal — اگه جستجو fail بشه، با همون system prompt قبلی ادامه می‌ده)
  // groundingSource/groundingCount به همه respond() ها اضافه می‌شه تا فرانت‌اند
  // بفهمه گراندینگ واقعاً اتفاق افتاده یا نه و از کجا.
  let groundingSource = null;
  let groundingCount  = 0;
  if (groundQuery) {
    try {
      const { results, source } = await webSearch(groundQuery, env);
      groundingSource = source;
      groundingCount  = results.length;
      system = system + buildGroundingContext(results, groundQuery, source);
    } catch (e) {
      groundingSource = 'failed';
      // جستجو fail شد — بدون grounding ادامه بده، کرش نکن
      system = system + `\n\n[توجه: جستجوی وب برای «${groundQuery}» ناموفق بود — بر اساس دانش داخلی جواب بده و صراحتاً بگو ممکنه به‌روز نباشه.]\n`;
    }
  }

  const errors = [];

  // 1. Cloudflare Workers AI (داخلی، بدون کلید خارجی)
  if (env.AI) {
    try {
      const text = await callCfAI(system, messages, env.AI);
      return respond({ text, source: 'cf-workers-ai', groundingSource, groundingCount });
    } catch (e) {
      errors.push(`CF Workers AI: ${e.message}`);
    }
  } else { errors.push('CF Workers AI: binding تنظیم نشده'); }

  // 2. Groq Llama
  if (env.GROQ_KEY) {
    try {
      const text = await callGroq(system, messages, env.GROQ_KEY);
      return respond({ text, source: 'groq', groundingSource, groundingCount });
    } catch (e) {
      errors.push(`Groq: ${e.message}`);
    }
  } else { errors.push('Groq: کلید تنظیم نشده'); }

  // 3. OpenRouter (35+ free models)
  if (env.OPENROUTER_KEY) {
    try {
      const text = await callOpenRouter(system, messages, env.OPENROUTER_KEY);
      return respond({ text, source: 'openrouter', groundingSource, groundingCount });
    } catch (e) {
      errors.push(`OpenRouter: ${e.message}`);
    }
  } else { errors.push('OpenRouter: کلید تنظیم نشده'); }

  // 4. DeepSeek
  if (env.DEEPSEEK_KEY) {
    try {
      const text = await callDeepSeek(system, messages, env.DEEPSEEK_KEY);
      return respond({ text, source: 'deepseek', groundingSource, groundingCount });
    } catch (e) {
      errors.push(`DeepSeek: ${e.message}`);
    }
  } else { errors.push('DeepSeek: کلید تنظیم نشده'); }

  // 5. GitHub Models GPT-4o
  if (env.GITHUB_MODELS_KEY) {
    try {
      const text = await callGitHubModels(system, messages, env.GITHUB_MODELS_KEY);
      return respond({ text, source: 'github-models', groundingSource, groundingCount });
    } catch (e) {
      errors.push(`GitHub Models: ${e.message}`);
    }
  } else { errors.push('GitHub Models: کلید تنظیم نشده'); }

  // 6. Claude Haiku
  if (env.CLAUDE_KEY) {
    try {
      const text = await callClaude(system, messages, env.CLAUDE_KEY);
      return respond({ text, source: 'claude', groundingSource, groundingCount });
    } catch (e) {
      errors.push(`Claude: ${e.message}`);
    }
  } else { errors.push('Claude: کلید تنظیم نشده'); }

  // 6. Non-AI fallback: openFDA + MyMemory
  if (fallbackQuery) {
    try {
      const text = await callNonAiFallback(fallbackQuery, env);
      return respond({ text, source: 'fallback-db', groundingSource, groundingCount });
    } catch (e) {
      errors.push(`Fallback DB: ${e.message}`);
    }
  }

  return respond({ error: 'همه AI ها در دسترس نیستند:\n' + errors.join('\n') }, 503);
}


// ── Vision helpers ──────────────────────────────────────────────────────────
function isVisionRequest(messages) {
  return messages.some(m => Array.isArray(m.content));
}

// Convert Claude multimodal format → OpenAI image_url format
function toVisionMessages(system, messages) {
  return [
    { role: 'system', content: sanitize(system) },
    ...messages.map(m => {
      if (!Array.isArray(m.content)) {
        return { role: m.role, content: sanitize(typeof m.content === 'string' ? m.content : String(m.content)) };
      }
      const parts = m.content.map(part => {
        if (part.type === 'text')
          return { type: 'text', text: sanitize(part.text || '') };
        if (part.type === 'image') {
          const { media_type, data } = part.source;
          return { type: 'image_url', image_url: { url: `data:${media_type};base64,${data}`, detail: 'high' } };
        }
        if (part.type === 'document') {
          // PDF: GPT-4o can't read raw PDF — send as base64 image hint
          const { data } = part.source;
          return { type: 'image_url', image_url: { url: `data:application/pdf;base64,${data}` } };
        }
        return { type: 'text', text: '' };
      }).filter(p => p.type !== 'text' || p.text);
      return { role: m.role, content: parts };
    })
  ];
}

async function handleVision({ system, messages }, env) {
  const errors = [];

  // GitHub Models GPT-4o — supports vision
  if (env.GITHUB_MODELS_KEY) {
    try {
      const visionMsgs = toVisionMessages(system, messages);
      const res = await fetch('https://models.github.ai/inference/chat/completions', {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GITHUB_MODELS_KEY}`,
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ model: 'openai/gpt-4o', messages: visionMsgs, max_tokens: 6000 })
      });
      const data = await safeJson(res);
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('پاسخی از GPT-4o نرسید');
      return respond({ text, source: 'github-models-vision' });
    } catch(e) { errors.push(`GitHub Models Vision: ${e.message}`); }
  } else { errors.push('GitHub Models: کلید تنظیم نشده'); }

  // Claude — supports both image and PDF natively
  if (env.CLAUDE_KEY) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.CLAUDE_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 6000, system, messages })
      });
      const data = await safeJson(res);
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const text = data.content?.[0]?.text;
      if (!text) throw new Error('پاسخی از Claude نرسید');
      return respond({ text, source: 'claude-vision' });
    } catch(e) { errors.push(`Claude Vision: ${e.message}`); }
  } else { errors.push('Claude: کلید تنظیم نشده'); }

  return respond({ error: 'آپلود فایل نیاز به AI با قابلیت Vision دارد:\n' + errors.join('\n') }, 503);
}

// ═══════════════════════════════════════════════════
//  AI PROVIDERS
// ═══════════════════════════════════════════════════
async function callCfAI(system, messages, AI) {
  const msgs = buildMessages(system, messages);
  const response = await AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: msgs,
    max_tokens: 6000,
  });
  const text = response?.response;
  if (!text) throw new Error('پاسخی از CF Workers AI نرسید');
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
      model: 'llama-3.3-70b-versatile',
      messages: buildMessages(system, messages),
      max_tokens: 6000,
      temperature: 0.8
    })
  });

  const data = await safeJson(res);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('پاسخی از Groq نرسید');
  return text;
}

async function callOpenRouter(system, messages, key) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://boojimmd.github.io/ai-detailing-coach/',
      'X-Title': 'AI Detailing Coach'
    },
    body: JSON.stringify({
      model: 'openrouter/auto',
      messages: buildMessages(system, messages),
      max_tokens: 6000,
      temperature: 0.8
    })
  });

  const data = await safeJson(res);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('پاسخی از OpenRouter نرسید');
  return text;
}

async function callDeepSeek(system, messages, key) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: buildMessages(system, messages),
      max_tokens: 6000,
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
      messages: buildMessages(system, messages),
      max_tokens: 6000,
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
      max_tokens: 6000,
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
