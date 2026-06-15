import express from "express";
import twilio from "twilio";
import pg from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";

const app = express();
// Railway/Vercel خلف بروكسي — ضروري عشان rate-limit يقرأ IP الحقيقي
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── سرّ توقيع الـ JWT (مطلوب) ───────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET غير مضبوط في متغيرات البيئة. أوقف التشغيل.");
  process.exit(1);
}

// ─── CORS: نطاقات محددة فقط (مو * للجميع) ─────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── المصادقة والصلاحيات ──────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "مطلوب تسجيل الدخول" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "انتهت الجلسة، سجّل الدخول من جديد" }); }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin")
    return res.status(403).json({ error: "هذا الإجراء للمدير فقط" });
  next();
}

// ─── Rate limiting ────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "محاولات تسجيل دخول كثيرة، حاول بعد 15 دقيقة" },
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
});

// ─── التحقق من توقيع تويليو على الـ webhook ───────────────────────
function validateTwilio(req, res, next) {
  // مسموح تعطيله محلياً فقط أثناء التطوير (لا تستخدمه في الإنتاج)
  if (process.env.SKIP_TWILIO_VALIDATION === "true") return next();
  const signature = req.headers["x-twilio-signature"];
  const base = process.env.PUBLIC_URL
    || `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const url = base + req.originalUrl;
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN, signature, url, req.body || {}
  );
  if (!valid) {
    console.warn("[WEBHOOK] ❌ توقيع تويليو غير صالح — تم الرفض");
    return res.status(403).send("Forbidden");
  }
  next();
}

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─── SSE Clients ─────────────────────────────────────────────────
const sseClients = new Set();

function notifyClients(data) {
  const msg = "data: " + JSON.stringify(data) + "\n\n";
  sseClients.forEach(client => {
    try { client.write(msg); } catch { sseClients.delete(client); }
  });
}

// ─── قاعدة البيانات ───────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// إنشاء الجداول عند التشغيل
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGINT PRIMARY KEY,
      phone TEXT,
      name TEXT,
      service TEXT,
      date TEXT,
      time TEXT,
      price TEXT,
      status TEXT DEFAULT 'confirmed',
      source TEXT DEFAULT 'whatsapp',
      reminded BOOLEAN DEFAULT false,
      reviewed BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminded BOOLEAN DEFAULT false;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminded_hour BOOLEAN DEFAULT false;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reviewed BOOLEAN DEFAULT false;
    CREATE TABLE IF NOT EXISTS sessions (
      phone TEXT PRIMARY KEY,
      messages JSONB DEFAULT '[]',
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'staff',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      phone TEXT,
      name TEXT,
      rating INTEGER,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price NUMERIC DEFAULT 0,
      icon TEXT DEFAULT '⭐',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS offers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price NUMERIC DEFAULT 0,
      icon TEXT DEFAULT '🎁',
      discount NUMERIC DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // أنشئ الحسابات الافتراضية لو ما عندها (كلمات المرور مشفّرة)
  const adminPwd = process.env.DEFAULT_ADMIN_PASSWORD || "admin2026";
  const staffPwd = process.env.DEFAULT_STAFF_PASSWORD || "lamsa2026";
  if (!process.env.DEFAULT_ADMIN_PASSWORD)
    console.warn("⚠️ DEFAULT_ADMIN_PASSWORD غير مضبوط — تستخدم كلمة مرور افتراضية، غيّرها فوراً.");
  const adminHash = await bcrypt.hash(adminPwd, 10);
  const staffHash = await bcrypt.hash(staffPwd, 10);
  await pool.query(
    `INSERT INTO users (username, password, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (username) DO NOTHING`, ["مدير", adminHash]
  );
  await pool.query(
    `INSERT INTO users (username, password, role) VALUES ($1, $2, 'staff')
     ON CONFLICT (username) DO NOTHING`, ["موظفة", staffHash]
  );
  console.log("✅ DB جاهز");
}

// ─── Session helpers ──────────────────────────────────────────────
async function getSession(phone) {
  const res = await pool.query("SELECT messages FROM sessions WHERE phone=$1", [phone]);
  return res.rows[0]?.messages || [];
}

async function saveSession(phone, messages) {
  await pool.query(`
    INSERT INTO sessions (phone, messages, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (phone) DO UPDATE SET messages=$2, updated_at=NOW()
  `, [phone, JSON.stringify(messages)]);
}

// ─── System Prompt ────────────────────────────────────────────────
async function buildPrompt() {
  const now          = new Date();
  const arabicDays   = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
  const arabicMonths = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const fmt = d => arabicDays[d.getDay()]+" "+d.getDate()+" "+arabicMonths[d.getMonth()]+" "+d.getFullYear();
  const today    = new Date(now); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate()+1);

  const res = await pool.query("SELECT time FROM bookings WHERE date='اليوم' AND status='confirmed'");
  const todayBooked = res.rows.map(r=>r.time).join("، ") || "لا يوجد";
  const res2 = await pool.query("SELECT time FROM bookings WHERE date='بكره' AND status='confirmed'");
  const tomorrowBooked = res2.rows.map(r=>r.time).join("، ") || "لا يوجد";

  // جلب الإعدادات من قاعدة البيانات
  const settingsRes = await pool.query("SELECT key, value FROM settings");
  const dbSettings = {};
  settingsRes.rows.forEach(r => dbSettings[r.key] = r.value);

  const bizName  = dbSettings.businessName  || process.env.BUSINESS_NAME  || "منشأتنا";
  const bizType  = dbSettings.businessType  || process.env.BUSINESS_TYPE  || "منشأة";
  const bizHours = dbSettings.businessHours || process.env.BUSINESS_HOURS || "السبت-الخميس 9ص-10م";
  const supportPhone = dbSettings.supportPhone || process.env.SUPPORT_WHATSAPP || "";
  const supportName  = dbSettings.supportName  || "الموظف المسؤول";

  // جلب الخدمات والعروض من قاعدة البيانات
  const svcRes = await pool.query("SELECT * FROM services WHERE active=true ORDER BY created_at");
  const offRes = await pool.query("SELECT * FROM offers WHERE active=true ORDER BY created_at");
  const servicesList = svcRes.rows.length > 0
    ? svcRes.rows.map(s => s.icon + " " + s.name + " — " + s.price + " ر.س").join(" | ")
    : process.env.BUSINESS_SERVICES || "لا توجد خدمات مضافة بعد";
  const offersList = offRes.rows.length > 0
    ? offRes.rows.map(o => o.icon + " " + o.name + (o.discount>0?" (خصم "+o.discount+"%)":"") + " — " + o.price + " ر.س").join(" | ")
    : "لا توجد عروض حالياً";

  return `أنت موظف استقبال سعودي محترف في ${bizType} اسمها "${bizName}".
تتكلم بشكل طبيعي تماماً مثل موظف واتساب حقيقي.
لغتك سليمة ولا تكتب كلمات مكسورة أو فيها أخطاء إملائية.

─── قاعدة اللغة (مهمة) ───
طابق لغة العميل في كل رد. إذا كتب العميل بالإنجليزي، رد بالإنجليزي فقط حتى الكلمات القصيرة مثل "thanks" أو "ok".
إذا كانت المحادثة كلها إنجليزي، لا ترد بالعربي أبداً حتى لو كانت رسالة شكر بسيطة.
عربي → رد عربي بالكامل | إنجليزي → رد إنجليزي بالكامل

─── أسلوب التعامل ───
استخدم كلمات طبيعية: حياك، تمام، ممتاز، أبشر، زين
لا تستخدم: "بالتأكيد"، "يسعدني"، "بكل سرور"، "تم بنجاح"
الرد من سطر إلى سطرين كحد أقصى
لا تسأل عن معلومة ذكرها العميل مسبقاً

─── متى تعرض القائمة ───
فقط إذا كانت الرسالة تحية عامة مثل: "هلا"، "سلام"، "مرحبا"
إذا فهمت المطلوب مباشرة، ابدأ فيه بدون قائمة.

القائمة عند التحية:
"هلا! أهلاً في ${bizName} 👋
1️⃣ حجز موعد
2️⃣ الخدمات والأسعار
3️⃣ العروض
4️⃣ الدوام
5️⃣ تحدث مع موظف"

─── مسار الحجز ───
اجمع المعلومات بذكاء وبالترتيب: خدمة ← يوم ← وقت ← اسم
إذا ذكر العميل أكثر من معلومة في رسالة واحدة، لا تسأل عنها مرة ثانية

─── قاعدة الأوقات (مهمة جداً جداً) ───
احجز أي وقت يطلبه العميل مباشرة. لا تقل أبداً إن وقتاً "غير متاح" أو "محجوز".
لا تقترح وقتاً بديلاً من عندك إطلاقاً. النظام يتكفّل بفحص التعارض تلقائياً.
إذا طلب العميل "12:20" احجز "12:20" بالضبط — لا تغيّره لـ "12:30" ولا غيره.

عندما يقول العميل "اليوم" أو "بكرة" بدون وقت محدد:
- اسأله فقط: "أي وقت يناسبك؟"
- لا تخترع أوقاتاً ولا تعرض قائمة أوقات من عندك

─── باقي الخيارات ───
2 → اعرض: ${servicesList}
3 → اعرض: ${offersList}
4 → الدوام: ${bizHours}
5 → "حاضر، سيتواصل معك أحد موظفينا قريباً" ثم [TRANSFER_TO_HUMAN]

─── معلومات المنشأة ───
اليوم: ${fmt(today)} | غداً: ${fmt(tomorrow)}
الدوام: ${bizHours}

─── قاعدة الوقت (مهمة) ───
اكتب الوقت دائماً بصيغة AM/PM في كل مكان: في رسالتك للعميل وفي الـ tag.
ممنوع تكتب "ظهراً" أو "عصراً" أو "مساءً" — استخدم AM/PM فقط.
حوّل كلام العميل لـ AM/PM:
الظهر = 12:00 PM | 1 وربع الظهر = 1:15 PM | العصر = 4:00 PM | 9 الصبح = 9:00 AM | 8 الليل = 8:00 PM
مثال رسالة صحيحة: "تم حجز موعدك اليوم الساعة 1:15 PM"
مثال خاطئ: "تم حجز موعدك الساعة 1:15 ظهراً"

─── Tags (في نهاية الرد) ───
ما تؤكد الحجز إلا بعد: الخدمة + التاريخ + الوقت + الاسم
[BOOKING_CONFIRMED: الاسم | الخدمة | التاريخ | الوقت AM/PM | السعر]
[BOOKING_UPDATED: الاسم | الخدمة | التاريخ | الوقت AM/PM | السعر]
[BOOKING_CANCELLED: التفاصيل]
[TRANSFER_TO_HUMAN]`;
}

function parseResponse(text) {
  let clean = text; let event = null;
  const bm  = text.match(/\[BOOKING_CONFIRMED:\s*([^\]]+)\]/);
  const ubm = text.match(/\[BOOKING_UPDATED:\s*([^\]]+)\]/);
  const cm  = text.match(/\[BOOKING_CANCELLED:\s*([^\]]+)\]/);
  const tm  = text.match(/\[TRANSFER_TO_HUMAN\]/);
  if (bm) {
    const [name,service,date,time,price] = bm[1].split("|").map(s=>s.trim());
    event = { type:"booking", name, service, date, time, price };
    clean = text.replace(bm[0],"").trim();
  } else if (ubm) {
    const [name,service,date,time,price] = ubm[1].split("|").map(s=>s.trim());
    event = { type:"update", name, service, date, time, price };
    clean = text.replace(ubm[0],"").trim();
  } else if (cm) {
    event = { type:"cancel" };
    clean = text.replace(cm[0],"").trim();
  } else if (tm) {
    event = { type:"transfer" };
    clean = text.replace(tm[0],"").trim();
  }
  return { clean, event };
}

async function callAI(messages) {
  const provider = (process.env.AI_PROVIDER || "openrouter").toLowerCase().trim();
  const apiKey   = (process.env.AI_API_KEY  || "").trim();
  const model    = (process.env.AI_MODEL    || "openai/gpt-4o").trim();

  const url = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : provider === "anthropic"
    ? null
    : "https://api.openai.com/v1/chat/completions";

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
      body: JSON.stringify({ model, max_tokens:500, system: await buildPrompt(), messages }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || "عذراً، صار خطأ.";
  }

  const res = await fetch(url, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${apiKey}`,
      "HTTP-Referer":"https://lamsa-salon.app",
      "X-Title":"Lamsa Salon",
    },
    body: JSON.stringify({
      model, max_tokens:500,
      messages:[{ role:"system", content: await buildPrompt() }, ...messages],
    }),
  });
  const data = await res.json();
  if (data.error) { console.error("AI ERROR:", data.error); return "عذراً، صار خطأ."; }
  return data.choices?.[0]?.message?.content || "عذراً، صار خطأ.";
}

// ─── فحص التعارض واقتراح وقت بديل ──────────────────────────────────
// تحويل (ساعة 24، دقيقة) إلى صيغة "H:MM AM/PM"
function toAmPm(h24, m) {
  const period = h24 >= 12 ? "PM" : "AM";
  let h = h24 % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2,"0")} ${period}`;
}

// توحيد التاريخ لصيغة عربية واحدة "D شهر YYYY" مهما كانت اللغة (عربي/إنجليزي/نسبي)
// مثال: "Tuesday 9 June 2026" و "الاثنين 9 يونيو 2026" و "اليوم" → كلها "9 يونيو 2026"
function normalizeDate(dateStr) {
  if (!dateStr) return "";
  const arabicMonths = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const enMonths = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11,jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
  const fmt = (d,m,y) => `${d} ${arabicMonths[m]} ${y}`;

  let s = String(dateStr).trim();
  const low = s.toLowerCase();
  const today = new Date();

  // كلمات نسبية → تاريخ فعلي
  if (s === "اليوم" || low === "today")
    return fmt(today.getDate(), today.getMonth(), today.getFullYear());
  if (["بكره","بكرة","غداً","غدا"].includes(s) || low === "tomorrow") {
    const t = new Date(); t.setDate(t.getDate()+1);
    return fmt(t.getDate(), t.getMonth(), t.getFullYear());
  }

  // السنة
  const yearMatch = s.match(/\b(20\d{2})\b/);
  const year = yearMatch ? parseInt(yearMatch[1]) : today.getFullYear();

  // الشهر: ابحث عن شهر عربي أو إنجليزي
  let month = -1;
  for (let i = 0; i < arabicMonths.length; i++) {
    if (s.includes(arabicMonths[i])) { month = i; break; }
  }
  if (month === -1) {
    for (const [name, idx] of Object.entries(enMonths)) {
      if (new RegExp(`\\b${name}\\b`, "i").test(s)) { month = idx; break; }
    }
  }

  // اليوم: أول رقم من خانة أو خانتين بعد حذف السنة
  const dayMatch = s.replace(/20\d{2}/, "").match(/\b(\d{1,2})\b/);
  const day = dayMatch ? parseInt(dayMatch[1]) : null;

  // لو ما قدرنا نحلل التاريخ، رجّع النص كما هو
  if (month === -1 || !day) return s;
  return fmt(day, month, year);
}

// هل هذا الوقت محجوز في هذا التاريخ؟ (مقارنة بعد التوحيد)
async function isSlotTaken(date, time, excludeId=null) {
  const targetDate = normalizeDate(date);
  const targetTime = (time||"").trim();
  // نجيب كل الحجوزات المؤكدة بنفس الوقت ونقارن التاريخ بعد التوحيد
  const r = await pool.query(
    "SELECT id, date FROM bookings WHERE status='confirmed' AND TRIM(time)=$1",
    [targetTime]
  );
  return r.rows.some(row =>
    normalizeDate(row.date) === targetDate && String(row.id) !== String(excludeId)
  );
}

// يبحث عن أقرب وقت متاح بعد الوقت المطلوب (بفواصل 30 دقيقة)
async function findNextFreeSlot(date, time) {
  const parsed = parseTimeToHour24(time);
  if (!parsed) return null;
  let total = parsed.h * 60 + parsed.m;
  for (let i = 0; i < 16; i++) {       // نجرّب حتى 8 ساعات قدام
    total += 30;
    const h = Math.floor(total / 60) % 24;
    const m = total % 60;
    const candidate = toAmPm(h, m);
    if (!(await isSlotTaken(date, candidate))) return candidate;
  }
  return null;
}

// ضمانة: تحوّل أي وقت بصيغة عربية (1:15 ظهراً / 4 عصراً) إلى AM/PM
// تُطبّق على رسالة الـ AI الخارجة حتى لو زلّ وكتب بالعربي
function arabicTimeToAmPm(text) {
  if (!text) return text;
  const pmWords = ["ظهراً","ظهرا","الظهر","عصراً","عصرا","العصر","مساءً","مساء","المساء","الليل","ليلاً","ليلا","المغرب","مغرباً"];
  // نمط: رقم[:دقائق] متبوع بكلمة فترة عربية
  const re = /(\d{1,2})(?::(\d{2}))?\s*(ظهراً|ظهرا|الظهر|عصراً|عصرا|العصر|مساءً|مساء|المساء|الليل|ليلاً|ليلا|المغرب|مغرباً|صباحاً|صباحا|الصبح|الصباح|فجراً|فجرا|الفجر)/g;
  return text.replace(re, (m, h, min, word) => {
    const hour = parseInt(h);
    const mins = min || "00";
    const period = pmWords.includes(word) ? "PM" : "AM";
    return `${hour}:${mins} ${period}`;
  });
}

// يطابق اسم الخدمة اللي كتبه الـ AI مع الاسم الرسمي في قاعدة البيانات
// يرجّع الاسم العربي الرسمي مهما كتب الـ AI (Dental → أسنان)
// يتجاهل اختلاف الهمزات (أ/إ/آ/ا) والتاء المربوطة عشان المطابقة تكون دقيقة
function normalizeArabic(str) {
  return String(str).trim().toLowerCase()
    .replace(/[أإآ]/g, "ا")   // كل أشكال الهمزة على الألف → ألف عادية
    .replace(/ى/g, "ي")        // ألف مقصورة → ياء
    .replace(/ة/g, "ه")        // تاء مربوطة → هاء
    .replace(/\s+/g, " ");     // توحيد المسافات
}

async function matchService(rawName) {
  if (!rawName) return rawName;
  const input = normalizeArabic(rawName);
  const r = await pool.query("SELECT name FROM services");
  if (r.rows.length === 0) return rawName;

  // مرادفات إنجليزية شائعة → الكلمة العربية المقابلة
  const synonyms = {
    "dental": "اسنان", "dentist": "اسنان", "teeth": "اسنان", "tooth": "اسنان",
    "ophthalmology": "عيون", "eye": "عيون", "eyes": "عيون", "optical": "عيون",
    "internal medicine": "باطنيه", "internal": "باطنيه",
    "dermatology": "جلديه", "skin": "جلديه",
    "hair": "شعر", "haircut": "شعر",
  };

  // 1) تطابق مباشر (بعد تجاهل الهمزات)
  for (const row of r.rows) {
    if (normalizeArabic(row.name) === input) return row.name;
  }
  // 2) تطابق عبر المرادفات: لو المدخل مرادف، دوّر خدمة تطابق الكلمة العربية
  for (const [en, ar] of Object.entries(synonyms)) {
    if (input.includes(en)) {
      const arNorm = normalizeArabic(ar);
      const found = r.rows.find(row => normalizeArabic(row.name).includes(arNorm));
      if (found) return found.name;
    }
  }
  // 3) تطابق جزئي (بعد التجاهل)
  for (const row of r.rows) {
    const n = normalizeArabic(row.name);
    if (n.includes(input) || input.includes(n)) return row.name;
  }
  // 4) ما لقينا تطابق → رجّع كما هو
  return rawName;
}

// ─── Webhook ──────────────────────────────────────────────────────
app.post("/webhook", webhookLimiter, validateTwilio, async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return res.sendStatus(200);
  console.log(`[MSG] ${from}: "${body}"`);

  try {
    let messages = await getSession(from);

    // فحص إذا العميل في وضع التقييم
    const isReviewMode = messages.length > 0 && messages[0]?.content?.startsWith("REVIEW_MODE:");
    if (isReviewMode) {
      // تحقق من انتهاء الوقت
      const rvExpiryMatch = messages[0].content.match(/REVIEW_MODE:(\d+):/);
      const rvExpiry = rvExpiryMatch ? parseInt(rvExpiryMatch[1]) : 0;
      if (Date.now() > rvExpiry) {
        // انتهى الوقت — امسح وعالج كرسالة جديدة
        await pool.query("DELETE FROM sessions WHERE phone=$1", [from]);
        messages = [];
      } else {
        const isRating = /^[1-5]$/.test(body.trim());
        if (isRating) {
          // احفظ التقييم في قاعدة البيانات
          const ratingNum = parseInt(body.trim());
          // جيب اسم العميل من آخر حجز
          const lastBooking = await pool.query(
            "SELECT name FROM bookings WHERE phone=$1 ORDER BY id DESC LIMIT 1", [from]
          );
          const clientName = lastBooking.rows[0]?.name || "";
          await pool.query(
            "INSERT INTO reviews (phone, name, rating) VALUES ($1,$2,$3)",
            [from, clientName, ratingNum]
          );
          // أرسل رسالة الشكر + طلب الملاحظة
          const ar = `شكراً على تقييمك.\nإذا عندك أي ملاحظة أو اقتراح نحب نسمعها.`;
          const en = `Thank you for your rating.\nFeel free to share any notes or suggestions.`;
          const replyMsg = /^[a-zA-Z]/.test(body) ? en : ar;
          // غيّر الجلسة لوضع انتظار الملاحظة (5 دقائق) مع حفظ التقييم
          const feedbackExpiry = Date.now() + (5 * 60 * 1000);
          await saveSession(from, [
            { role:"system", content:"FEEDBACK_MODE:" + feedbackExpiry + ":rating=" + ratingNum + ": العميل قيّم وننتظر ملاحظته الآن." }
          ]);
          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message(replyMsg);
          return res.type("text/xml").send(twiml.toString());
        } else {
          // كتب شيء آخر — ذكّره بالتقييم ولا تبدأ محادثة جديدة
          const ar = `من فضلك قيّمنا من 1 إلى 5 ⭐`;
          const en = `Please rate us from 1 to 5 ⭐`;
          const replyMsg = /^[a-zA-Z]/.test(body) ? en : ar;
          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message(replyMsg);
          return res.type("text/xml").send(twiml.toString());
        }
      }
    }

    // فحص إذا العميل في وضع انتظار الملاحظة
    const isFeedbackMode = messages.length > 0 && messages[0]?.content?.startsWith("FEEDBACK_MODE:");
    if (isFeedbackMode) {
      // تحقق من انتهاء الوقت (5 دقائق)
      const expiryMatch = messages[0].content.match(/FEEDBACK_MODE:(\d+):/);
      const expiry = expiryMatch ? parseInt(expiryMatch[1]) : 0;
      if (Date.now() > expiry) {
        // انتهى الوقت — امسح الجلسة وعالج الرسالة كرسالة جديدة
        await pool.query("DELETE FROM sessions WHERE phone=$1", [from]);
        messages = [];
      } else {
        // لسه في الوقت — احفظ الملاحظة ورد عليها
        const ratingMatch = messages[0].content.match(/rating=(\d+)/);
        const ratingNum = ratingMatch ? parseInt(ratingMatch[1]) : null;
        // أضف الملاحظة لآخر تقييم من هذا الرقم
        const lastReview = await pool.query(
          "SELECT id FROM reviews WHERE phone=$1 AND note IS NULL ORDER BY created_at DESC LIMIT 1",
          [from]
        );
        if (lastReview.rows.length > 0) {
          await pool.query(
            "UPDATE reviews SET note=$1 WHERE id=$2",
            [body, lastReview.rows[0].id]
          );
          console.log("✅ ملاحظة محفوظة:", body);
        }
        const ar = `شكراً على ملاحظتك، سنأخذها بعين الاعتبار.`;
        const en = `Thank you for your feedback, we'll take it into consideration.`;
        const replyMsg = /^[a-zA-Z]/.test(body) ? en : ar;
        await pool.query("DELETE FROM sessions WHERE phone=$1", [from]);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(replyMsg);
        return res.type("text/xml").send(twiml.toString());
      }
    }

    messages.push({ role:"user", content:body });
    if (messages.length > 20) messages = messages.slice(-20);

    const rawText          = await callAI(messages);
    const { clean, event } = parseResponse(rawText);
    // توحيد صيغة التاريخ والوقت والخدمة لكل حجز/تعديل (مصدر واحد للحقيقة)
    if (event && (event.type === "booking" || event.type === "update")) {
      event.date = normalizeDate(event.date);
      event.time = (event.time || "").trim();
      event.service = await matchService(event.service);
    }
    messages.push({ role:"assistant", content:rawText });
    await saveSession(from, messages);

    // إشعار للموظف عند التحويل
    if (event?.type === "transfer") {
      try {
        const sRes = await pool.query("SELECT key,value FROM settings");
        const s = {}; sRes.rows.forEach(r=>s[r.key]=r.value);
        const supportPhone = s.supportPhone || process.env.SUPPORT_WHATSAPP || "";
        const supportName  = s.supportName  || "الموظف";
        console.log("📱 محاولة إرسال إشعار للرقم:", supportPhone);
        if (supportPhone) {
          // آخر 5 رسائل من العميل
          const lastMsgs = messages.slice(-6).filter(m=>m.role==="user").map(m=>"• "+m.content).join("\n");
          const clientNum = from.replace("whatsapp:","");
          let spNum = supportPhone.replace("whatsapp:","").trim();
          if (spNum.startsWith("05")) spNum = "+966" + spNum.slice(1);
          else if (spNum.startsWith("5") && spNum.length === 9) spNum = "+966" + spNum;
          if (!spNum.startsWith("+") && !spNum.startsWith("00")) spNum = "+" + spNum;
          const toNumber = "whatsapp:" + spNum;
          const notifAr = `🔔 ${supportName}، عميل يحتاج مساعدة!

الرقم: ${clientNum}

آخر رسائله:
${lastMsgs}

يمكنك التواصل معه مباشرة على: ${clientNum}`;
          console.log("📤 إرسال إلى:", toNumber);
          const msg = await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: toNumber,
            body: notifAr,
          });
          console.log("✅ إشعار تحويل أُرسل! SID:", msg.sid);
        } else {
          console.log("⚠️ رقم الموظف غير محدد في الإعدادات");
        }
      } catch(err) { console.error("Transfer notify error:", err.message, err.stack); }
    }

    if (event?.type === "booking") {
      // فحص التعارض في قاعدة البيانات قبل أي حجز
      if (await isSlotTaken(event.date, event.time)) {
        console.log("⛔ تعارض حجز:", event.date, event.time);
        const isEn = /^[a-zA-Z]/.test(event.name || "");
        const free = await findNextFreeSlot(event.date, event.time);
        const busyMsg = isEn
          ? (free
              ? `Sorry, ${event.time} is already booked. The nearest available time is ${free}. Does that work?`
              : `Sorry, ${event.time} is already booked. Could you pick another time?`)
          : (free
              ? `عذراً، الوقت ${event.time} محجوز. أقرب وقت متاح هو ${free}، يناسبك؟`
              : `عذراً، الوقت ${event.time} محجوز. ممكن تختار وقت ثاني؟`);
        // نصحّح الجلسة حتى لا يظن الـ AI أن الحجز تم
        messages.push({ role:"system", content:`النظام رفض الحجز: الوقت ${event.time} محجوز مسبقاً. لم يتم الحجز. اطلب من العميل وقتاً آخر${free?` (مثل ${free})`:""}.` });
        await saveSession(from, messages);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(busyMsg);
        return res.type("text/xml").send(twiml.toString());
      }
      const bookingId = Date.now();
      await pool.query(
        "INSERT INTO bookings (id,phone,name,service,date,time,price,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed','whatsapp')",
        [bookingId, from, event.name, event.service, event.date, event.time, event.price]
      );
      console.log("✅ حجز جديد:", event.name, event.service, event.time);
      notifyClients({ type:"new_booking", name:event.name, service:event.service, time:event.time });
    }

    if (event?.type === "update") {
      // نحدث آخر حجز مؤكد لنفس الرقم
      const existing = await pool.query(
        "SELECT id FROM bookings WHERE phone=$1 AND status='confirmed' ORDER BY id DESC LIMIT 1",
        [from]
      );
      // فحص التعارض مع حجوزات الآخرين (نستثني حجز العميل نفسه)
      const excludeId = existing.rows[0]?.id || null;
      if (await isSlotTaken(event.date, event.time, excludeId)) {
        console.log("⛔ تعارض تعديل:", event.date, event.time);
        const isEn = /^[a-zA-Z]/.test(event.name || "");
        const free = await findNextFreeSlot(event.date, event.time);
        const busyMsg = isEn
          ? (free ? `Sorry, ${event.time} is already booked. The nearest available time is ${free}. Does that work?`
                  : `Sorry, ${event.time} is already booked. Could you pick another time?`)
          : (free ? `عذراً، الوقت ${event.time} محجوز. أقرب وقت متاح هو ${free}، يناسبك؟`
                  : `عذراً، الوقت ${event.time} محجوز. ممكن تختار وقت ثاني؟`);
        messages.push({ role:"system", content:`النظام رفض التعديل: الوقت ${event.time} محجوز مسبقاً. اطلب من العميل وقتاً آخر${free?` (مثل ${free})`:""}.` });
        await saveSession(from, messages);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(busyMsg);
        return res.type("text/xml").send(twiml.toString());
      }
      if (existing.rows.length > 0) {
        await pool.query(
          "UPDATE bookings SET service=$1,date=$2,time=$3,price=$4 WHERE id=$5",
          [event.service, event.date, event.time, event.price, existing.rows[0].id]
        );
        console.log("✅ تعديل حجز:", event.name, event.service, event.time);
        notifyClients({ type:"updated_booking", name:event.name, service:event.service, time:event.time });
      } else {
        // لو ما في حجز قديم، نضيف جديد
        const bookingId = Date.now();
        await pool.query(
          "INSERT INTO bookings (id,phone,name,service,date,time,price,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed','whatsapp')",
          [bookingId, from, event.name, event.service, event.date, event.time, event.price]
        );
        console.log("✅ حجز جديد (بديل):", event.name);
      }
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(arabicTimeToAmPm(clean));
    res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error("[ERR]", err.message);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("عذراً، صار خطأ. جربي مرة ثانية.");
    res.type("text/xml").send(twiml.toString());
  }
});

// ─── بوابة المصادقة لكل /api (ما عدا تسجيل الدخول والـ SSE) ───────
app.use("/api", (req, res, next) => {
  if (req.path === "/login")  return next();   // تسجيل الدخول عام (محدود بمعدل)
  if (req.path === "/events") return next();   // الـ SSE يتحقق من التوكن داخلياً
  return auth(req, res, next);
});

// ─── SSE Endpoint ────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  // EventSource ما يقدر يرسل headers، فالتوكن يجي عبر query
  try { jwt.verify(req.query.token || "", JWT_SECRET); }
  catch { return res.status(401).end(); }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // أرسل ping كل 30 ثانية للإبقاء على الاتصال
  const ping = setInterval(() => {
    try { res.write(": ping" + "\n\n"); } catch { clearInterval(ping); }
  }, 30000);

  sseClients.add(res);
  console.log(`[SSE] client connected, total: ${sseClients.size}`);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(ping);
    console.log(`[SSE] client disconnected, total: ${sseClients.size}`);
  });
});

// ─── API للداشبورد ────────────────────────────────────────────────
app.get("/api/bookings", async (_req, res) => {
  const result = await pool.query("SELECT * FROM bookings ORDER BY created_at DESC");
  res.json(result.rows);
});

app.patch("/api/bookings/:id/confirm", async (req, res) => {
  try {
    await pool.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: "حدث خطأ في الخادم" }); }
});

app.patch("/api/bookings/:id/cancel", async (req, res) => {
  await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ─── حذف كل الحجوزات (للمدير فقط + إعادة إدخال كلمة المرور) ───────
app.delete("/api/bookings/all", adminOnly, async (req, res) => {
  const { password } = req.body || {};
  try {
    // إعادة تحقق من كلمة مرور المدير الحالي (طبقة حماية إضافية)
    const u = await pool.query("SELECT password FROM users WHERE id=$1", [req.user.id]);
    const stored = u.rows[0]?.password || "";
    const okPwd = stored.startsWith("$2")
      ? await bcrypt.compare(password || "", stored)
      : stored === password;
    if (!okPwd) return res.status(403).json({ error: "كلمة المرور غير صحيحة" });

    const result = await pool.query("DELETE FROM bookings");
    console.log("🗑️ حُذفت كل الحجوزات بواسطة:", req.user.username);
    notifyClients({ type:"bookings_cleared" });
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error("Delete all error:", err.message);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// ─── إضافة حجز يدوي من الداشبورد ────────────────────────────────
app.post("/api/bookings/manual", async (req, res) => {
  const { name, service, date, time, price, phone, id } = req.body;
  try {
    await pool.query(
      "INSERT INTO bookings (id,phone,name,service,date,time,price,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed','manual')",
      [id || Date.now(), phone || "", name, service, normalizeDate(date), (time||"").trim(), price]
    );
    notifyClients({ type:"new_booking", name, service, time });
    console.log("✅ حجز يدوي:", name, service, time);
    res.json({ success: true });
  } catch (err) {
    console.error("Manual booking error:", err.message);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// ─── إرسال رسالة واتساب ─────────────────────────────────────────
async function sendWhatsApp(phone, msg) {
  let p = phone.replace("whatsapp:","").trim();
  // تحويل 05XXXXXXXX → +9665XXXXXXXX
  if (p.startsWith("05")) p = "+966" + p.slice(1);
  else if (p.startsWith("5") && p.length === 9) p = "+966" + p;
  // تأكد من وجود +
  if (!p.startsWith("+") && !p.startsWith("00")) p = "+" + p;
  const to = "whatsapp:" + p;
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to, body: msg,
  });
}

// ─── تذكير تلقائي ────────────────────────────────────────────────
async function sendReminders() {
  try {
    const bizName = await getBizName();
    const now = new Date();
    const tzOffset = parseInt(process.env.TZ_OFFSET || "3");

    // جيب كل الحجوزات المؤكدة اللي ما اتذكّرت - فقط الحجوزات الحديثة (آخر 3 أيام)
    const allRes = await pool.query(
      "SELECT * FROM bookings WHERE status='confirmed' AND (reminded=false OR reminded_hour=false) AND created_at >= NOW() - INTERVAL '3 days'"
    );

    for (const b of allRes.rows) {
      if (!b.phone || !b.time) continue;

      // تحليل الوقت (AM/PM فقط الحين)
      const parsed = parseTimeToHour24(b.time);
      if (!parsed) continue;

      // وقت الموعد بتوقيت UTC
      const apptUTC = new Date();
      apptUTC.setUTCHours(parsed.h - tzOffset, parsed.m, 0, 0);

      // وقت يوم قبل الموعد
      const apptUTCTomorrow = new Date(apptUTC);
      apptUTCTomorrow.setUTCDate(apptUTCTomorrow.getUTCDate() - 1);

      // فحص إذا الحجز غداً (اليوم + 1)
      const isTomorrow = isTomorrowDate(b.date);
      // فحص إذا الحجز اليوم
      const isBookingToday = isToday(b.date);

      // تذكير قبل يوم — يرسل لو الحجز غداً
      if (!b.reminded && isTomorrow) {
        const ar = `مرحباً ${b.name}! 😊 نذكّرك بموعدك غداً لخدمة "${b.service}" الساعة ${b.time} في ${bizName}. نتطلع لرؤيتك!`;
        const en = `Hi ${b.name}! 😊 Reminder: your "${b.service}" appointment is tomorrow at ${b.time} at ${bizName}. See you then!`;
        try {
          await sendWhatsApp(b.phone, /^[a-zA-Z]/.test(b.name) ? en : ar);
          await pool.query("UPDATE bookings SET reminded=true WHERE id=$1", [b.id]);
          console.log("✅ تذكير (يوم):", b.name);
        } catch (err) { console.error("Reminder day error:", err.message); }
      }

      // تذكير قبل ساعة — يرسل لو الحجز اليوم وضمن نافذة 57-63 دقيقة (قريب من ساعة بالضبط)
      if (!b.reminded_hour && isBookingToday) {
        const diffMin = (apptUTC - now) / (1000 * 60);
        console.log(`⏰ فحص تذكير ساعة ${b.name}: الفرق ${Math.round(diffMin)} دقيقة`);
        if (diffMin >= 57 && diffMin <= 63) {
          const ar = `تذكير: موعدك "${b.service}" بعد ساعة الساعة ${b.time} في ${bizName} 🕐`;
          const en = `Reminder: your "${b.service}" appointment is in 1 hour at ${b.time} at ${bizName} 🕐`;
          try {
            await sendWhatsApp(b.phone, /^[a-zA-Z]/.test(b.name) ? en : ar);
            await pool.query("UPDATE bookings SET reminded_hour=true WHERE id=$1", [b.id]);
            console.log("✅ تذكير (ساعة):", b.name);
          } catch (err) { console.error("Reminder hour error:", err.message); }
        }
      }
    }
  } catch (err) { console.error("Reminders error:", err.message); }
}

// ─── تقييم بعد الخدمة ────────────────────────────────────────────
// تحليل الوقت من أي صيغة (8 AM / 8 ص / 8:00 م)
function parseTimeToHour24(timeStr) {
  if (!timeStr) return null;
  const t = timeStr.trim();

  // الصيغة الأساسية: "2:00 PM" أو "9:30 AM"
  const match = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (match) {
    let h = parseInt(match[1]);
    const m = parseInt(match[2] || "0");
    const pm = match[3].toUpperCase() === "PM";
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h, m };
  }

  // صيغة 24 ساعة: "14:30" أو "08:00"
  const plain = t.match(/^(\d{1,2}):(\d{2})$/);
  if (plain) return { h: parseInt(plain[1]), m: parseInt(plain[2]) };

  // Fallback: نظّف التشكيل وحاول مرة ثانية
  const cleaned = t
    .replace(/[\u064B-\u065F]/g, "") // كل التشكيل
    .replace(/[\u0649\u0622]/g, "\u0627") // ألف مقصورة/ممدودة
    .trim();

  const arFallback = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(ص|م|صباح|مساء|ظهر|عصر|فجر|ليل)$/);
  if (arFallback) {
    let h = parseInt(arFallback[1]);
    const m = parseInt(arFallback[2] || "0");
    const p = arFallback[3];
    const isPM = ["م","مساء","ظهر","عصر","ليل"].includes(p);
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return { h, m };
  }

  console.log("⚠️ صيغة وقت غير معروفة:", JSON.stringify(t));
  return null;
}

// فحص إذا كان التاريخ غداً
function isTomorrowDate(dateStr) {
  if (!dateStr) return false;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const d = dateStr.toLowerCase();
  if (d === "بكره" || d === "غداً" || d === "غدا" || d === "tomorrow") return true;
  const tDay   = tomorrow.getDate();
  const tMonth = tomorrow.getMonth();
  const months   = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const arMonths = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const hasDay   = d.includes(String(tDay));
  const hasMonth = months.some((m,i) => i === tMonth && d.includes(m)) ||
                   arMonths.some((m,i) => i === tMonth && d.includes(m));
  return hasDay && hasMonth;
}

function isToday(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  const d = dateStr.toLowerCase();
  if (d === "اليوم" || d === "today") return true;
  // فحص إذا يحتوي على تاريخ اليوم
  const todayDay = today.getDate();
  const todayMonth = today.getMonth(); // 0-based
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const arMonths = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const hasDay = d.includes(String(todayDay));
  const hasMonth = months.some((m,i) => i === todayMonth && d.includes(m)) ||
                   arMonths.some((m,i) => i === todayMonth && d.includes(m));
  return hasDay && hasMonth;
}

async function getBizName() {
  const r = await pool.query("SELECT value FROM settings WHERE key='businessName'");
  return r.rows[0]?.value || process.env.BUSINESS_NAME || "منشأتنا";
}

async function sendReviews() {
  try {
    const bizName = await getBizName();
    // نجيب كل الحجوزات المؤكدة اللي ما اتقيّمت بعد - فقط الحجوزات الحديثة
    const res = await pool.query(
      "SELECT * FROM bookings WHERE status='confirmed' AND reviewed=false AND created_at >= NOW() - INTERVAL '2 days'"
    );
    const now = new Date();
    for (const b of res.rows) {
      if (!b.phone || !b.time) continue;
      // نتحقق إن الحجز اليوم
      if (!isToday(b.date)) continue;
      try {
        const parsed = parseTimeToHour24(b.time);
        if (!parsed) { console.log("⚠️ ما قدرت أحلل الوقت:", b.time); continue; }
        const tzOffset = parseInt(process.env.TZ_OFFSET || "3"); // UTC+3 السعودية
        const apptEnd = new Date();
        apptEnd.setUTCHours(parsed.h - tzOffset + 1, parsed.m, 0, 0);
        console.log(`🕐 فحص تقييم ${b.name}: وقت الانتهاء ${apptEnd.toTimeString()} | الآن ${now.toTimeString()}`);
        if (now >= apptEnd) {
          const ar = `شكراً ${b.name}! كيف كانت تجربتك معنا في ${bizName}?\nقيّمنا من 1 إلى 5 ⭐`;
          const en = `Thank you ${b.name}! How was your experience at ${bizName}?\nRate us from 1 to 5 ⭐`;
          const msg = /^[a-zA-Z]/.test(b.name) ? en : ar;
          // نضمن أن الرقم بصيغة whatsapp: للجلسة
          const sessionPhone = b.phone.startsWith("whatsapp:") ? b.phone : "whatsapp:" + b.phone;
          await sendWhatsApp(b.phone, msg);
          await pool.query("UPDATE bookings SET reviewed=true WHERE id=$1", [b.id]);
          // احفظ جلسة خاصة تدل على أن العميل في وضع التقييم مع timestamp
          const reviewExpiry = Date.now() + (60 * 60 * 1000); // ساعة للرد على التقييم
          await saveSession(sessionPhone, [
            { role:"system", content:"REVIEW_MODE:" + reviewExpiry + ": العميل أُرسلت له رسالة التقييم." }
          ]);
          console.log("✅ تقييم أُرسل:", b.name, "| جلسة محفوظة لـ:", sessionPhone);
        }
      } catch (err) { console.error("Review error:", err.message); }
    }
  } catch (err) { console.error("Reviews error:", err.message); }
}

// شغّل التذكير كل 3 دقائق (دقة عالية) والتقييم كل 15 دقيقة
setInterval(sendReminders, 3 * 60 * 1000);
setInterval(sendReviews,   15 * 60 * 1000);

// شغّل مرة عند بدء السيرفر (بعد 10 ثواني)
setTimeout(()=>{ sendReminders(); sendReviews(); }, 10000);

// ─── API التقييمات ───────────────────────────────────────────────
app.get("/api/reviews", async (_req, res) => {
  const r = await pool.query("SELECT * FROM reviews ORDER BY created_at DESC");
  res.json(r.rows);
});

// ─── API الإعدادات ───────────────────────────────────────────────
app.get("/api/settings", adminOnly, async (_req, res) => {
  const r = await pool.query("SELECT key, value FROM settings");
  const obj = {};
  r.rows.forEach(row => obj[row.key] = row.value);
  res.json(obj);
});

app.post("/api/settings", adminOnly, async (req, res) => {
  const entries = Object.entries(req.body);
  try {
    for (const [key, value] of entries) {
      await pool.query(
        "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
        [key, value]
      );
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: "حدث خطأ في الخادم" }); }
});

// ─── API الخدمات ─────────────────────────────────────────────────
app.get("/api/services", async (_req, res) => {
  const r = await pool.query("SELECT * FROM services ORDER BY created_at");
  res.json(r.rows);
});

app.post("/api/services", async (req, res) => {
  const { name, description, price, icon } = req.body;
  if (!name) return res.status(400).json({ error: "اسم الخدمة مطلوب" });
  try {
    const r = await pool.query(
      "INSERT INTO services (name,description,price,icon) VALUES ($1,$2,$3,$4) RETURNING *",
      [name, description||"", price||0, icon||"⭐"]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: "حدث خطأ في الخادم" }); }
});

app.patch("/api/services/:id", async (req, res) => {
  const { name, description, price, icon, active } = req.body;
  try {
    const r = await pool.query(
      "UPDATE services SET name=$1,description=$2,price=$3,icon=$4,active=$5 WHERE id=$6 RETURNING *",
      [name, description||"", price||0, icon||"⭐", active!==undefined?active:true, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: "حدث خطأ في الخادم" }); }
});

app.delete("/api/services/:id", async (req, res) => {
  await pool.query("DELETE FROM services WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ─── API العروض ──────────────────────────────────────────────────
app.get("/api/offers", async (_req, res) => {
  const r = await pool.query("SELECT * FROM offers ORDER BY created_at");
  res.json(r.rows);
});

app.post("/api/offers", async (req, res) => {
  const { name, description, price, icon, discount } = req.body;
  if (!name) return res.status(400).json({ error: "اسم العرض مطلوب" });
  try {
    const r = await pool.query(
      "INSERT INTO offers (name,description,price,icon,discount) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [name, description||"", price||0, icon||"🎁", discount||0]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: "حدث خطأ في الخادم" }); }
});

app.patch("/api/offers/:id", async (req, res) => {
  const { name, description, price, icon, discount, active } = req.body;
  try {
    const r = await pool.query(
      "UPDATE offers SET name=$1,description=$2,price=$3,icon=$4,discount=$5,active=$6 WHERE id=$7 RETURNING *",
      [name, description||"", price||0, icon||"🎁", discount||0, active!==undefined?active:true, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: "حدث خطأ في الخادم" }); }
});

app.delete("/api/offers/:id", async (req, res) => {
  await pool.query("DELETE FROM offers WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ─── API المستخدمين ──────────────────────────────────────────────

// تسجيل دخول
app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبين" });
  try {
    const result = await pool.query(
      "SELECT id, username, role, password FROM users WHERE username=$1",
      [username]
    );
    // رسالة موحّدة عشان ما نكشف هل المستخدم موجود أو لا
    if (result.rows.length === 0)
      return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });

    const u = result.rows[0];
    let ok = false;
    if (u.password.startsWith("$2")) {
      ok = await bcrypt.compare(password, u.password);          // bcrypt
    } else {
      ok = u.password === password;                             // كلمة مرور قديمة (نص صريح)
      if (ok) {                                                 // رقّيها لـ hash تلقائياً
        const newHash = await bcrypt.hash(password, 10);
        await pool.query("UPDATE users SET password=$1 WHERE id=$2", [newHash, u.id]);
      }
    }
    if (!ok) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });

    const token = jwt.sign(
      { id: u.id, username: u.username, role: u.role },
      JWT_SECRET, { expiresIn: "12h" }
    );
    res.json({ token, username: u.username, role: u.role });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// جلب كل المستخدمين (للمدير فقط)
app.get("/api/users", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, role, created_at FROM users ORDER BY created_at"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// إضافة مستخدم جديد
app.post("/api/users", adminOnly, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبين" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role",
      [username, hash, role || "staff"]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "اسم المستخدم موجود مسبقاً" });
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// تعديل مستخدم
app.patch("/api/users/:id", adminOnly, async (req, res) => {
  const { username, password, role } = req.body;
  try {
    let query, params;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      query = "UPDATE users SET username=$1, password=$2, role=$3 WHERE id=$4 RETURNING id, username, role";
      params = [username, hash, role, req.params.id];
    } else {
      query = "UPDATE users SET username=$1, role=$2 WHERE id=$3 RETURNING id, username, role";
      params = [username, role, req.params.id];
    }
    const result = await pool.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "اسم المستخدم موجود مسبقاً" });
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// حذف مستخدم
app.delete("/api/users/:id", adminOnly, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

app.get("/", (_req, res) => res.json({ status: "✅ شغال" }));

// ─── Start ────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(process.env.PORT || 3000, () =>
    console.log("🚀 Server on port", process.env.PORT || 3000, "| AI:", process.env.AI_PROVIDER)
  );
});
