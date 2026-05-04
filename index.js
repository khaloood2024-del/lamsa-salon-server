import express from "express";
import twilio from "twilio";
import pg from "pg";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// السماح للداشبورد بالوصول
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      phone TEXT PRIMARY KEY,
      messages JSONB DEFAULT '[]',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
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

  return `أنتِ موظفة استقبال في صالون نسائي اسمه "لمسة". تتكلمين بالسعودي البيض الطبيعي مع العميلات.

أمثلة صح:
- "هلا! كيف أخدمك؟"
- "أي وقت يناسبك؟"
- "تمام، اليوم أو بكره؟"
- "دوامنا 9ص-10م السبت للخميس، الجمعة 2م-10م"
- "زين، باقي اسمك بس وأحجزلك 😊"
- "تم الحجز إن شاء الله! نشوفك الساعة 3"

القواعد:
- خاطبي العميلة بصيغة المؤنث: تبين، عندك، يناسبك
- جملة أو جملتين MAX
- إيموجي واحد بالرد كحد أقصى
- إذا قالت "صبغة" = تلوين شعر | "فيشل" = تنظيف بشرة | "قص" = قص وتصفيف

التاريخ: اليوم ${fmt(today)} | بكره ${fmt(tomorrow)}
الدوام: السبت-الخميس 9ص-10م | الجمعة 2م-10م
المواعيد المحجوزة — اليوم: ${todayBooked} | بكره: ${tomorrowBooked}

الخدمات: باديكير 80ر | تلوين شعر 250ر | قص وتصفيف 150ر | أوزون 200ر | مساج 180ر | تنظيف بشرة 220ر | عروس كاملة 800ر

ما تأكدين الحجز إلا بعد: الخدمة + التاريخ + الوقت + الاسم
عند تأكيد الحجز — مثال الرد الصح:
"تم الحجز إن شاء الله! نشوفك الثلاثاء 5 مايو الساعة 11 الظهر 😊 [BOOKING_CONFIRMED: هاجر | أوزون | الثلاثاء 5 مايو 2026 | 11:00 م | 200 ريال]"
يعني لازم تضيفين [BOOKING_CONFIRMED: ...] في نفس الرسالة بعد كلامك مباشرة — هذا إلزامي ومو اختياري.
إذا طلبت إلغاء أضيفي: [BOOKING_CANCELLED: التفاصيل]
إذا الموضوع معقد أضيفي: [TRANSFER_TO_HUMAN]`;
}

function parseResponse(text) {
  let clean = text; let event = null;
  const bm = text.match(/\[BOOKING_CONFIRMED:\s*([^\]]+)\]/);
  const cm = text.match(/\[BOOKING_CANCELLED:\s*([^\]]+)\]/);
  const tm = text.match(/\[TRANSFER_TO_HUMAN\]/);
  if (bm) {
    const [name,service,date,time,price] = bm[1].split("|").map(s=>s.trim());
    event = { type:"booking", name, service, date, time, price };
    clean = text.replace(bm[0],"").trim();
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
  const model    = (process.env.AI_MODEL    || "openai/gpt-4.1-mini").trim();

  const url = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : provider === "anthropic"
    ? null
    : "https://api.openai.com/v1/chat/completions";

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
      body: JSON.stringify({ model, max_tokens:200, system: await buildPrompt(), messages }),
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
      model, max_tokens:200,
      messages:[{ role:"system", content: await buildPrompt() }, ...messages],
    }),
  });
  const data = await res.json();
  if (data.error) { console.error("AI ERROR:", data.error); return "عذراً، صار خطأ."; }
  return data.choices?.[0]?.message?.content || "عذراً، صار خطأ.";
}

// ─── Webhook ──────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return res.sendStatus(200);
  console.log(`[MSG] ${from}: "${body}"`);

  try {
    let messages = await getSession(from);
    messages.push({ role:"user", content:body });
    if (messages.length > 20) messages = messages.slice(-20);

    const rawText          = await callAI(messages);
    const { clean, event } = parseResponse(rawText);
    messages.push({ role:"assistant", content:rawText });
    await saveSession(from, messages);

    if (event?.type === "booking") {
      await pool.query(
        "INSERT INTO bookings (id,phone,name,service,date,time,price,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed','whatsapp')",
        [Date.now(), from, event.name, event.service, event.date, event.time, event.price]
      );
      console.log("✅ حجز:", event.name, event.service, event.time);
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(clean);
    res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error("[ERR]", err.message);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("عذراً، صار خطأ. جربي مرة ثانية.");
    res.type("text/xml").send(twiml.toString());
  }
});

// ─── API للداشبورد ────────────────────────────────────────────────
app.get("/api/bookings", async (_req, res) => {
  const result = await pool.query("SELECT * FROM bookings ORDER BY created_at DESC");
  res.json(result.rows);
});

app.patch("/api/bookings/:id/cancel", async (req, res) => {
  await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

app.get("/", (_req, res) => res.json({
  status:   "✅ شغال",
  provider: process.env.AI_PROVIDER,
  model:    process.env.AI_MODEL,
  keySet:   !!process.env.AI_API_KEY,
  db:       !!process.env.DATABASE_URL,
}));

// ─── Start ────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(process.env.PORT || 3000, () =>
    console.log("🚀 Server on port", process.env.PORT || 3000, "| AI:", process.env.AI_PROVIDER)
  );
});
