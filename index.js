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
  // أنشئ حساب المدير الافتراضي لو ما عنده
  await pool.query(`
    INSERT INTO users (username, password, role)
    VALUES ('مدير', 'admin2026', 'admin')
    ON CONFLICT (username) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO users (username, password, role)
    VALUES ('موظفة', 'lamsa2026', 'staff')
    ON CONFLICT (username) DO NOTHING
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

  return `أنت موظف استقبال ذكي في ${bizType} اسمها "${bizName}".

═══════════════════════════════════
قاعدة اللغة (مهمة جداً):
- إذا كتب العميل بالعربية → رد بالعربية فقط
- إذا كتب بالإنجليزية → رد بالإنجليزية فقط
- إذا خلط → استخدم اللغة الأكثر في رسالته
═══════════════════════════════════

أول رسالة من العميل — الرد يكون هكذا بالضبط (بالعربي):
"أهلاً بك في ${bizName}! 👋

اختر من القائمة:
1️⃣ حجز موعد
2️⃣ الخدمات والأسعار
3️⃣ العروض والتخفيضات
4️⃣ أوقات الدوام
5️⃣ التحدث مع موظف"

أول رسالة (بالإنجليزي إذا كتب English):
"Welcome to ${bizName}! 👋

Please choose:
1️⃣ Book an appointment
2️⃣ Services & prices
3️⃣ Offers & discounts
4️⃣ Working hours
5️⃣ Talk to staff"

عندما يختار العميل:
- 1 (حجز): اسأل عن الخدمة ثم التاريخ ثم الوقت ثم الاسم
- 2 (خدمات): اعرض الخدمات المتاحة مع أسعارها
- 3 (عروض): اعرض العروض المتاحة
- 4 (دوام): أخبره بأوقات الدوام
- 5 (موظف): أخبره أن موظف سيتواصل معه قريباً وأضف [TRANSFER_TO_HUMAN]

القواعد:
- لا تذكر اسم العميل قبل أن يعرّفك به
- ردودك قصيرة ومختصرة
- إيموجي واحد في الرد كحد أقصى
- تعرف على الكلمات الشعبية: صبغة/صبغ = تلوين شعر | فيشل/فيشيل = تنظيف بشرة | قص = قص وتصفيف

معلومات المنشأة:
التاريخ: اليوم ${fmt(today)} | غداً ${fmt(tomorrow)}
الدوام: ${bizHours}
المواعيد المحجوزة — اليوم: ${todayBooked} | غداً: ${tomorrowBooked}
الخدمات: ${servicesList}
العروض: ${offersList}

ما تؤكد الحجز إلا بعد الحصول على: الخدمة + التاريخ + الوقت + الاسم
عند تأكيد الحجز أضف في نهاية ردك:
[BOOKING_CONFIRMED: الاسم | الخدمة | التاريخ | الوقت | السعر]
عند طلب الإلغاء أضف: [BOOKING_CANCELLED: التفاصيل]
عند التحويل للموظف أضف: [TRANSFER_TO_HUMAN]`;
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
    // إشعار للموظف المسؤول سيتم في webhook
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
          const toNumber = supportPhone.startsWith("whatsapp:") ? supportPhone : "whatsapp:"+supportPhone;
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
      const bookingId = Date.now();
      await pool.query(
        "INSERT INTO bookings (id,phone,name,service,date,time,price,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed','whatsapp')",
        [bookingId, from, event.name, event.service, event.date, event.time, event.price]
      );
      console.log("✅ حجز:", event.name, event.service, event.time);
      notifyClients({ type:"new_booking", name:event.name, service:event.service, time:event.time });
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

// ─── SSE Endpoint ────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/bookings/:id/cancel", async (req, res) => {
  await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ─── إضافة حجز يدوي من الداشبورد ────────────────────────────────
app.post("/api/bookings/manual", async (req, res) => {
  const { name, service, date, time, price, phone, id } = req.body;
  try {
    await pool.query(
      "INSERT INTO bookings (id,phone,name,service,date,time,price,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed','manual')",
      [id || Date.now(), phone || "", name, service, date, time, price]
    );
    notifyClients({ type:"new_booking", name, service, time });
    console.log("✅ حجز يدوي:", name, service, time);
    res.json({ success: true });
  } catch (err) {
    console.error("Manual booking error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── إرسال رسالة واتساب ─────────────────────────────────────────
async function sendWhatsApp(phone, msg) {
  const to = phone.startsWith("whatsapp:") ? phone : "whatsapp:" + phone;
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to, body: msg,
  });
}

// ─── تذكير تلقائي ────────────────────────────────────────────────
async function sendReminders() {
  try {
    // تذكير قبل يوم
    const dayRes = await pool.query(
      "SELECT * FROM bookings WHERE status='confirmed' AND reminded=false"
    );
    const now = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate()+1);
    const tomorrowStr = tomorrow.toLocaleDateString("ar-SA");

    for (const b of dayRes.rows) {
      if (!b.phone) continue;
      const bookingDate = b.date;
      const isTomorrow = bookingDate === "بكره" || bookingDate === "غداً" || bookingDate.includes(tomorrowStr);
      if (isTomorrow) {
        const ar = `مرحباً ${b.name}! 😊 نذكّرك بموعدك غداً لخدمة "${b.service}" الساعة ${b.time} في ${bizName}. نتطلع لرؤيتك!`;
        const en = `Hi ${b.name}! 😊 Reminder: your "${b.service}" appointment is tomorrow at ${b.time} at ${bizName}. See you then!`;
        const msg = /^[a-zA-Z]/.test(b.name) ? en : ar;
        try {
          await sendWhatsApp(b.phone, msg);
          await pool.query("UPDATE bookings SET reminded=true WHERE id=$1", [b.id]);
          console.log("✅ تذكير (يوم):", b.name);
        } catch (err) { console.error("Reminder error:", err.message); }
      }
    }

    // تذكير قبل ساعة
    const hourRes = await pool.query(
      "SELECT * FROM bookings WHERE status='confirmed' AND reminded_hour=false AND date='اليوم'"
    );
    for (const b of hourRes.rows) {
      if (!b.phone || !b.time) continue;
      try {
        // تحقق من الوقت — هل الموعد خلال ساعة؟
        const [timePart, period] = b.time.split(" ");
        const [h, m] = timePart.split(":").map(Number);
        let hour24 = h;
        if (period === "م" && h !== 12) hour24 = h + 12;
        if (period === "ص" && h === 12) hour24 = 0;
        const apptTime = new Date();
        apptTime.setHours(hour24, m || 0, 0, 0);
        const diff = (apptTime - now) / (1000 * 60); // بالدقائق
        if (diff >= 50 && diff <= 70) {
          const ar = `تذكير: موعدك "${b.service}" بعد ساعة تقريباً الساعة ${b.time} في ${bizName} 🕐`;
          const en = `Reminder: your "${b.service}" appointment is in about 1 hour at ${b.time} at ${bizName} 🕐`;
          const msg = /^[a-zA-Z]/.test(b.name) ? en : ar;
          await sendWhatsApp(b.phone, msg);
          await pool.query("UPDATE bookings SET reminded_hour=true WHERE id=$1", [b.id]);
          console.log("✅ تذكير (ساعة):", b.name);
        }
      } catch (err) { console.error("Hour reminder error:", err.message); }
    }
  } catch (err) { console.error("Reminders error:", err.message); }
}

// ─── تقييم بعد الخدمة ────────────────────────────────────────────
// تحليل الوقت من أي صيغة (8 AM / 8 ص / 8:00 م)
function parseTimeToHour24(timeStr) {
  if (!timeStr) return null;
  const t = timeStr.trim();
  // صيغة: "8 AM" أو "8:30 AM"
  const enMatch = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (enMatch) {
    let h = parseInt(enMatch[1]);
    const m = parseInt(enMatch[2] || "0");
    const pm = enMatch[3].toUpperCase() === "PM";
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h, m };
  }
  // صيغة: "8 ص" أو "8:30 م"
  const arMatch = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(ص|م)$/);
  if (arMatch) {
    let h = parseInt(arMatch[1]);
    const m = parseInt(arMatch[2] || "0");
    if (arMatch[3] === "م" && h !== 12) h += 12;
    if (arMatch[3] === "ص" && h === 12) h = 0;
    return { h, m };
  }
  // صيغة: "08:00"
  const plain = t.match(/^(\d{1,2}):(\d{2})$/);
  if (plain) return { h: parseInt(plain[1]), m: parseInt(plain[2]) };
  return null;
}

// فحص إذا كان التاريخ اليوم
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

async function sendReviews() {
  try {
    // نجيب كل الحجوزات المؤكدة اللي ما اتقيّمت بعد
    const res = await pool.query(
      "SELECT * FROM bookings WHERE status='confirmed' AND reviewed=false"
    );
    const now = new Date();
    for (const b of res.rows) {
      if (!b.phone || !b.time) continue;
      // نتحقق إن الحجز اليوم
      if (!isToday(b.date)) continue;
      try {
        const parsed = parseTimeToHour24(b.time);
        if (!parsed) { console.log("⚠️ ما قدرت أحلل الوقت:", b.time); continue; }
        const apptEnd = new Date();
        apptEnd.setHours(parsed.h + 1, parsed.m, 0, 0);
        console.log(`🕐 فحص تقييم ${b.name}: وقت الانتهاء ${apptEnd.toTimeString()} | الآن ${now.toTimeString()}`);
        if (now >= apptEnd) {
          const ar = `شكراً ${b.name}! ✨ كيف كانت تجربتك معنا في ${bizName}؟\nقيّمنا من 1 إلى 5 ⭐\nرأيك يهمنا!`;
          const en = `Thank you ${b.name}! ✨ How was your experience at ${bizName}?\nRate us from 1 to 5 ⭐\nYour feedback matters!`;
          const msg = /^[a-zA-Z]/.test(b.name) ? en : ar;
          await sendWhatsApp(b.phone, msg);
          await pool.query("UPDATE bookings SET reviewed=true WHERE id=$1", [b.id]);
          console.log("✅ تقييم أُرسل:", b.name);
        }
      } catch (err) { console.error("Review error:", err.message); }
    }
  } catch (err) { console.error("Reviews error:", err.message); }
}

// شغّل كل 30 دقيقة
setInterval(sendReminders, 30 * 60 * 1000);
setInterval(sendReviews,   30 * 60 * 1000);

// ─── API الإعدادات ───────────────────────────────────────────────
app.get("/api/settings", async (_req, res) => {
  const r = await pool.query("SELECT key, value FROM settings");
  const obj = {};
  r.rows.forEach(row => obj[row.key] = row.value);
  res.json(obj);
});

app.post("/api/settings", async (req, res) => {
  const entries = Object.entries(req.body);
  try {
    for (const [key, value] of entries) {
      await pool.query(
        "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
        [key, value]
      );
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/services/:id", async (req, res) => {
  const { name, description, price, icon, active } = req.body;
  try {
    const r = await pool.query(
      "UPDATE services SET name=$1,description=$2,price=$3,icon=$4,active=$5 WHERE id=$6 RETURNING *",
      [name, description||"", price||0, icon||"⭐", active!==undefined?active:true, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/offers/:id", async (req, res) => {
  const { name, description, price, icon, discount, active } = req.body;
  try {
    const r = await pool.query(
      "UPDATE offers SET name=$1,description=$2,price=$3,icon=$4,discount=$5,active=$6 WHERE id=$7 RETURNING *",
      [name, description||"", price||0, icon||"🎁", discount||0, active!==undefined?active:true, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/offers/:id", async (req, res) => {
  await pool.query("DELETE FROM offers WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ─── API المستخدمين ──────────────────────────────────────────────

// تسجيل دخول
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      "SELECT id, username, role FROM users WHERE username=$1 AND password=$2",
      [username, password]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غلط" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب كل المستخدمين (للمدير فقط)
app.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, role, created_at FROM users ORDER BY created_at"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// إضافة مستخدم جديد
app.post("/api/users", async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبين" });
  try {
    const result = await pool.query(
      "INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role",
      [username, password, role || "staff"]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "اسم المستخدم موجود مسبقاً" });
    res.status(500).json({ error: err.message });
  }
});

// تعديل مستخدم
app.patch("/api/users/:id", async (req, res) => {
  const { username, password, role } = req.body;
  try {
    let query, params;
    if (password) {
      query = "UPDATE users SET username=$1, password=$2, role=$3 WHERE id=$4 RETURNING id, username, role";
      params = [username, password, role, req.params.id];
    } else {
      query = "UPDATE users SET username=$1, role=$2 WHERE id=$3 RETURNING id, username, role";
      params = [username, role, req.params.id];
    }
    const result = await pool.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "اسم المستخدم موجود مسبقاً" });
    res.status(500).json({ error: err.message });
  }
});

// حذف مستخدم
app.delete("/api/users/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
