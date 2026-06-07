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

  // التواريخ الفعلية كما تُحفظ في قاعدة البيانات (مثال: "الأحد 7 يونيو 2026")
  const todayStr    = fmt(today);
  const tomorrowStr = fmt(tomorrow);

  // نجلب المواعيد المحجوزة لليوم وغداً — نطابق التاريخ الكامل + الكلمات القديمة احتياطاً
  const res = await pool.query(
    "SELECT time FROM bookings WHERE status='confirmed' AND (date=$1 OR date='اليوم')",
    [todayStr]
  );
  const todayBooked = res.rows.map(r=>r.time).join("، ") || "لا يوجد";
  const res2 = await pool.query(
    "SELECT time FROM bookings WHERE status='confirmed' AND (date=$1 OR date='بكره' OR date='غداً')",
    [tomorrowStr]
  );
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

─── قاعدة الإملاء (إلزامية) ───
اكتب عربية فصيحة سليمة 100% بدون أي خطأ إملائي.
انتبه جيداً للتاء المربوطة (ة) والهاء (ه)، والهمزات (أ إ آ ء ؤ ئ).
أمثلة على الكتابة الصحيحة:
"عيادة" لا "عياده" | "الجميلة" لا "الجميله" | "الساعة" لا "الساعه"
"الابتسامة" لا "الابتسامه" | "موعد" لا "موعد" | "أبشر" لا "ابشر"
راجع كل كلمة قبل الإرسال — الأخطاء الإملائية غير مقبولة إطلاقاً.

─── قاعدة اللغة ───
عربي → رد عربي | إنجليزي → رد إنجليزي

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

─── قاعدة الأوقات (مهمة جداً) ───
المواعيد المحجوزة اليوم: ${todayBooked}
المواعيد المحجوزة غداً: ${tomorrowBooked}

اعتمد على القائمة أعلاه فقط. أي وقت غير مذكور فيها = متاح.
- إذا الوقت غير مذكور في القائمة → احجزه مباشرة (لا تقل إنه محجوز)
- إذا الوقت مذكور في القائمة → أخبر العميل أنه محجوز واقترح وقتاً غير موجود في القائمة
ممنوع منعاً باتاً اختراع تعارض لوقت غير مذكور في القائمة.

عندما يقول العميل "اليوم" أو "بكرة" بدون وقت:
- اسأله: "أي وقت يناسبك؟"
- لا تخترع أوقاتاً من عندك

─── باقي الخيارات ───
2 → اعرض: ${servicesList}
3 → اعرض: ${offersList}
4 → الدوام: ${bizHours}
5 → "حاضر، سيتواصل معك أحد موظفينا قريباً" ثم [TRANSFER_TO_HUMAN]

─── معلومات المنشأة ───
اليوم: ${fmt(today)} | غداً: ${fmt(tomorrow)}
الدوام: ${bizHours}

─── قاعدة الوقت ───
حوّل الوقت دائماً لـ AM/PM في الـ tag:
الظهر = 12:00 PM | العصر = 4:00 PM | 9 الصبح = 9:00 AM | 8 الليل = 8:00 PM
في رسالتك للعميل: اكتب الوقت بالعربي
في الـ tag: AM/PM فقط

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
      // حماية برمجية ضد الحجز المزدوج — نتحقق من قاعدة البيانات قبل الإضافة
      const conflict = await pool.query(
        "SELECT id FROM bookings WHERE date=$1 AND time=$2 AND status='confirmed'",
        [event.date, event.time]
      );
      if (conflict.rows.length > 0) {
        console.log("⛔ رُفض حجز مزدوج:", event.date, event.time);
        const isEn = /^[a-zA-Z]/.test(event.name || "");
        const busyMsg = isEn
          ? `Sorry, ${event.time} on ${event.date} was just booked. Could you pick another time?`
          : `عذراً، الموعد ${event.time} يوم ${event.date} انحجز للتو. ممكن تختار وقت ثاني؟`;
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
      if (existing.rows.length > 0) {
        await pool.query(
          "UPDATE bookings SET service=$1,date=$2,time=$3,price=$4 WHERE id=$5",
          [event.service, event.date, event.time, event.price, existing.rows[0].id]
        );
        console.log("✅ تعديل حجز:", event.name, event.service, event.time);
        notifyClients({ type:"updated_booking", name:event.name, service:event.service, time:event.time });
      } else {
        // لو ما في حجز قديم، نضيف جديد — مع فحص التعارض
        const conflict2 = await pool.query(
          "SELECT id FROM bookings WHERE date=$1 AND time=$2 AND status='confirmed'",
          [event.date, event.time]
        );
        if (conflict2.rows.length > 0) {
          console.log("⛔ رُفض حجز مزدوج (تعديل):", event.date, event.time);
          const isEn = /^[a-zA-Z]/.test(event.name || "");
          const busyMsg = isEn
            ? `Sorry, ${event.time} on ${event.date} is already booked. Could you pick another time?`
            : `عذراً، الموعد ${event.time} يوم ${event.date} محجوز. ممكن تختار وقت ثاني؟`;
          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message(busyMsg);
          return res.type("text/xml").send(twiml.toString());
        }
        const bookingId = Date.now();
        await pool.query(
          "INSERT INTO bookings (id,phone,name,service,date,time,price,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed','whatsapp')",
          [bookingId, from, event.name, event.service, event.date, event.time, event.price]
        );
        console.log("✅ حجز جديد (بديل):", event.name);
      }
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

      // تذكير قبل ساعة — يرسل لو الحجز اليوم وبعد 50-70 دقيقة
      if (!b.reminded_hour && isBookingToday) {
        const diffMin = (apptUTC - now) / (1000 * 60);
        console.log(`⏰ فحص تذكير ساعة ${b.name}: الفرق ${Math.round(diffMin)} دقيقة`);
        if (diffMin >= 30 && diffMin <= 90) {
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

// فحص إذا كان التاريخ اليوم
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

// شغّل كل 30 دقيقة
setInterval(sendReminders, 30 * 60 * 1000);
setInterval(sendReviews,   30 * 60 * 1000);

// شغّل مرة عند بدء السيرفر (بعد 10 ثواني)
setTimeout(()=>{ sendReminders(); sendReviews(); }, 10000);

// ─── API التقييمات ───────────────────────────────────────────────
app.get("/api/reviews", async (_req, res) => {
  const r = await pool.query("SELECT * FROM reviews ORDER BY created_at DESC");
  res.json(r.rows);
});

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
