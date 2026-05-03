import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";

const app  = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const claude       = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// حفظ محادثات العملاء في الذاكرة
const sessions  = {};
// حفظ الحجوزات
const bookings  = [];

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────
function buildPrompt() {
  const now          = new Date();
  const arabicDays   = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
  const arabicMonths = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const fmt = d => arabicDays[d.getDay()]+" "+d.getDate()+" "+arabicMonths[d.getMonth()]+" "+d.getFullYear();
  const today    = new Date(now); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate()+1);

  const todayBooked    = bookings.filter(b=>b.date==="اليوم").map(b=>b.time).join("، ") || "لا يوجد";
  const tomorrowBooked = bookings.filter(b=>b.date==="بكره").map(b=>b.time).join("، ")  || "لا يوجد";

  return `انتِ موظفة استقبال ذكية في صالون سبا فاخر اسمه "لمسة" وتردين على واتساب.
اللهجة سعودية بيضاء طبيعية — هلا، تفضل، زين، ايش، الحين، بكره، إن شاء الله، يعطيك العافية.
ردودك قصيرة ومناسبة للواتساب (مو رسائل طويلة).

التاريخ:
- اليوم: ${fmt(today)}
- بكره: ${fmt(tomorrow)}

أوقات الدوام: السبت-الخميس 9ص-10م | الجمعة 2م-10م

الخدمات:
1. باديكير وميديكير - 45د - 80ر
2. تلوين شعر - 90د - 250ر
3. قص وتصفيف - 60د - 150ر
4. علاج بالأوزون - 60د - 200ر
5. مساج استرخاء - 60د - 180ر
6. تنظيف بشرة - 75د - 220ر
7. عروس كاملة - 4س - 800ر

المواعيد المحجوزة:
- اليوم: ${todayBooked}
- بكره: ${tomorrowBooked}

القواعد:
1. ما تأكد الحجز إلا بعد: الخدمة + التاريخ + الوقت + الاسم
2. إذا الوقت محجوز اقترح بديل
3. إذا العميل زعلان تعامل بلطف وأخبره بأنك ستحول الأمر للمدير
4. عند تأكيد الحجز أضف: [BOOKING_CONFIRMED: الاسم | الخدمة | التاريخ | الوقت | السعر]
5. إذا طلب إلغاء: [BOOKING_CANCELLED: التفاصيل]
6. إذا تحتاج تحويل للمدير: [TRANSFER_TO_HUMAN]`;
}

// ─── PARSE AI RESPONSE ───────────────────────────────────────────────
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

// ─── WHATSAPP WEBHOOK ────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const from = req.body.From;   // رقم العميل
  const body = req.body.Body?.trim();

  if (!from || !body) return res.sendStatus(200);

  // أنشئ session للعميل لو ما عنده
  if (!sessions[from]) sessions[from] = [];
  sessions[from].push({ role:"user", content:body });

  // احتفظ بآخر 10 رسائل فقط لتوفير tokens
  if (sessions[from].length > 20) sessions[from] = sessions[from].slice(-20);

  try {
    const response = await claude.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 500,
      system:     buildPrompt(),
      messages:   sessions[from],
    });

    const rawText = response.content[0]?.text || "عذراً، صار خطأ.";
    const { clean, event } = parseResponse(rawText);

    // حفظ رد الـ AI في الـ session
    sessions[from].push({ role:"assistant", content:rawText });

    // إذا تأكد حجز، احفظه
    if (event?.type === "booking") {
      bookings.push({
        id:      Date.now(),
        phone:   from,
        name:    event.name,
        service: event.service,
        date:    event.date,
        time:    event.time,
        price:   event.price,
        status:  "confirmed",
        source:  "whatsapp",
      });
      console.log("✅ حجز جديد:", event.name, event.service, event.time);
    }

    // إرسال الرد على الواتساب
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   from,
      body: clean,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err.message);
    res.sendStatus(500);
  }
});

// ─── API للداشبورد ───────────────────────────────────────────────────
app.get("/api/bookings", (req, res) => {
  res.json(bookings);
});

app.patch("/api/bookings/:id/cancel", (req, res) => {
  const b = bookings.find(b=>b.id===Number(req.params.id));
  if (!b) return res.status(404).json({error:"not found"});
  b.status = "cancelled";
  res.json(b);
});

// Health check
app.get("/", (req, res) => res.json({ status:"✅ لمسة سيرفر شغال" }));

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running on port", process.env.PORT || 3000);
});
