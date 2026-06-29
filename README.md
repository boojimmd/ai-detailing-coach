# 🚀 راهنمای Deploy — AI Detailing Coach v3

---

## مرحله ۱ — کلیدهای API

### ۱.۱ Gemini API Key (رایگان)
1. برو به **aistudio.google.com**
2. با حساب Google وارد شو
3. بالا سمت راست → **Get API Key** → **Create API Key**
4. کلید رو کپی کن → `AIza...`

### ۱.۲ Groq API Key (رایگان)
1. برو به **console.groq.com**
2. با Google وارد شو
3. منوی چپ → **API Keys** → **Create API Key**
4. کلید رو کپی کن → `gsk_...`

### ۱.۳ DeepSeek V4 Flash Key (رایگان موقت — رویداد تشویقی)
1. برو به **openmodel.ai** → ثبت‌نام (با Google کافیه)
2. **$1 اعتبار رایگان** خودکار به حساب اضافه می‌شه
3. از داشبورد → **API Keys** → کلید رو کپی کن
4. ⚠️ این رایگان **موقتیه** (یه رویداد تشویقیه، تاریخ پایانش هنوز اعلام نشده). بعد از تموم شدنش، این لایه به‌صورت خودکار fail می‌شه و Worker می‌ره سراغ Claude — نیازی به تغییر کد نیست.

### ۱.۴ GitHub Models Key — برای GPT-4o (رایگان دائمی)
1. برو به **github.com/settings/tokens**
2. **Generate new token** → **Fine-grained token**
3. اسم بذار، expiration رو انتخاب کن
4. توی Permissions → **Account permissions** → **Models** → **Read-only**
5. **Generate token** → کپی کن
6. ⚠️ سهمیه رایگانش کمه (~۱۰ درخواست/دقیقه، ۵۰ درخواست/روز) — برای پشتیبان عمیق کافیه، نه استفاده اصلی

### ۱.۵ Claude API Key (پولی — پشتیبان نهایی)
1. برو به **console.anthropic.com**
2. ثبت‌نام → **API Keys** → **Create Key**
3. کلید رو کپی کن → `sk-ant-...`
4. ⚠️ کمی اعتبار اولیه بذار (5 دلار کافیه)

---

## مرحله ۲ — Cloudflare Worker (هوش مصنوعی + ذخیره‌سازی)

### ۲.۱ ساخت حساب Cloudflare
1. برو به **cloudflare.com** → Sign Up رایگان

### ۲.۲ ساخت KV Namespace (ذخیره‌سازی ابری)
1. داشبورد Cloudflare → **Workers & Pages** → **KV**
2. **Create a namespace** → نام: `DATA_STORE`
3. **Add** → کلیک کن

### ۲.۳ ساخت Worker
1. **Workers & Pages** → **Create** → **Create Worker**
2. اسم بذار: `ai-detailing-coach`
3. **Deploy** → بعد **Edit Code**
4. محتوای فایل `cloudflare_worker.js` رو کامل paste کن
5. **Deploy** کن

### ۲.۴ تنظیم KV Binding
1. Worker → **Settings** → **Bindings**
2. **+ Add** → **KV Namespace**
3. Variable name: `DATA_STORE`
4. KV namespace: همون `DATA_STORE` که ساختی
5. **Save**

### ۲.۵ اضافه کردن کلیدهای API
1. Worker → **Settings** → **Variables and Secrets**
2. سه متغیر اضافه کن:

| نام متغیر | مقدار |
|---|---|
| `GEMINI_KEY` | کلید Gemini از مرحله ۱.۱ |
| `GROQ_KEY` | کلید Groq از مرحله ۱.۲ |
| `DEEPSEEK_KEY` | کلید OpenModel از مرحله ۱.۳ |
| `GITHUB_MODELS_KEY` | کلید GitHub از مرحله ۱.۴ |
| `CLAUDE_KEY` | کلید Claude از مرحله ۱.۵ |

3. هر کدوم → **Type: Secret** → **Save**

### ۲.۶ گرفتن آدرس Worker
1. Worker → صفحه اصلی
2. آدرس زیر را کپی کن:
   `https://ai-detailing-coach.YOUR_NAME.workers.dev`

---

## مرحله ۳ — آپدیت HTML

فایل `AI_Detailing_Coach_v3.html` رو باز کن و این خط رو پیدا کن:

```javascript
const WORKER = 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev';
```

آدرس Worker از مرحله ۲.۶ رو جایگزین کن:

```javascript
const WORKER = 'https://ai-detailing-coach.YOUR_NAME.workers.dev';
```

---

## مرحله ۴ — GitHub

### ۴.۱ ساخت Repository
1. برو به **github.com** → New Repository
2. نام: `ai-detailing-coach`
3. **Private** انتخاب کن
4. **Create repository**

### ۴.۲ آپلود فایل‌ها
1. **Add file** → **Upload files**
2. فایل `AI_Detailing_Coach_v3.html` رو drag کن
3. نام فایل رو تغییر بده به `index.html`
4. **Commit changes**

---

## مرحله ۵ — Netlify

### ۵.۱ وصل کردن GitHub
1. برو به **app.netlify.com** → **Add new site**
2. **Import an existing project** → **GitHub**
3. Repository `ai-detailing-coach` رو انتخاب کن
4. Branch: `main`
5. Build command: خالی بذار
6. Publish directory: خالی بذار (یا `.`)
7. **Deploy site**

### ۵.۲ آدرس نهایی
بعد از deploy، آدرسی مثل این داری:
`https://ai-detailing-coach-XXXX.netlify.app`

---

## تست نهایی

بعد از deploy، این مراحل رو تست کن:

1. **اتصال AI**: یه محصول اضافه کن → «تحلیل با AI» → باید جواب بیاد
2. **Cloud Sync**: تنظیمات → کد sync ببینی
3. **Microlearning**: بنر آبی رو بزن → سوال بیاد
4. **Call Flow**: محصول → Call Flow → قالب بیاد

---

## اگه مشکلی داشتی

**AI جواب نداد:**
- Worker → Logs → ببین خطا چیه
- کلیدها رو دوباره چک کن

**Sync کار نکرد:**
- Worker → KV → DATA_STORE binding رو چک کن

**صفحه باز نشد:**
- Netlify → Deploys → وضعیت deploy رو چک کن
