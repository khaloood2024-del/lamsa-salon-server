import express from "express";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// حفظ المحادثات والحجوزات
const sessions = {};
const bookings = [];

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

  return `انت موظف استقبال ذكي في صالون سبا فاخر اسمه "لمسة" وتردّ على واتساب.
اللهجة سعودية بيضاء — هلا، تفضل، زين، ايش، الحين، بكره، إن شاء الله، يعطيك العافية.
ردودك قصيرة ومناسبة للواتساب.

التاريخ: اليوم ${fmt(today)} | بكره ${fmt(tomorrow)}
الدوام: السبت-الخميس 9ص-10م | الجمعة 2م-10م

الخدمات:
1.باديكير وميديكير-45د-80ر | 2.تلوين شعر-90د-250ر | 3.قص وتصفيف-60د-150ر
4.علاج بالأوزون-60د-200ر   | 5.مساج استرخاء-60د-180ر | 6.تنظيف بشرة-75د-220ر
7.عروس كاملة-4س-800ر

المواعيد المحجوزة — اليوم: ${todayBooked} | بكره: ${tomorrowBooked}

القواعد:
1. ما تأكد الحجز إلا بعد: الخدمة + التاريخ + الوقت + الاسم
2. إذا الوقت محجوز اقترح بديل
3. إذا العميل زعلان تعامل بلطف وحول للمدير
4. عند تأكيد الحجز أضف: [BOOKING_CONFIRMED: الاسم | الخدمة | التاريخ | الوقت | السعر]
5. إذا طلب إلغاء: [BOOKING_CANCELLED: التفاصيل]
6. إذا تحتاج تحويل للمدير: [TRANSFER_TO_HUMAN]`;
}

// ─── PARSE RESPONSE ──────────────────────────────────────────────────
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

// ─── AI CALL (يدعم Anthropic / OpenAI / OpenRouter) ─────────────────
async function callAI(messages) {
  const provider = process.env.AI_PROVIDER || "anthropic"; // anthropic | openai | openrouter

  // ── Anthropic ──
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "x-api-key":            process.env.AI_API_KEY,
        "anthropic-version":    "2023-06-01",
      },
      body: JSON.stringify({
        model:      process.env.AI_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 500,
        system:     buildPrompt(),
        messages,
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || "عذراً، صار خطأ.";
  }

  // ── OpenAI أو OpenRouter (نفس الـ format) ──
  const baseURL = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";

  const res = await fetch(baseURL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + process.env.AI_API_KEY,
    },
    body: JSON.stringify({
      model:      process.env.AI_MODEL || "gpt-4o-mini",
      max_tokens: 500,
      messages: [
        { role: "system", content: buildPrompt() },
        ...messages,
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "عذراً، صار خطأ.";
}

// ─── WHATSAPP WEBHOOK ────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return res.sendStatus(200);

  if (!sessions[from]) sessions[from] = [];
  sessions[from].push({ role:"user", content:body });
  if (sessions[from].length > 20) sessions[from] = sessions[from].slice(-20);

  try {
    const rawText           = await callAI(sessions[from]);
    const { clean, event }  = parseResponse(rawText);
    sessions[from].push({ role:"assistant", content:rawText });

    if (event?.type === "booking") {
      bookings.push({
        id: Date.now(), phone: from,
        name: event.name, service: event.service,
        date: event.date, time: event.time, price: event.price,
        status: "confirmed", source: "whatsapp",
      });
      console.log("✅ حجز جديد:", event.name, "-", event.service, "-", event.time);
    }

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
app.get("/api/bookings", (_req, res) => res.json(bookings));

app.patch("/api/bookings/:id/cancel", (req, res) => {
  const b = bookings.find(b=>b.id===Number(req.params.id));
  if (!b) return res.status(404).json({ error:"not found" });
  b.status = "cancelled";
  res.json(b);
});

app.get("/", (_req, res) => res.json({ status:"✅ لمسة سيرفر شغال", provider: process.env.AI_PROVIDER || "anthropic" }));

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server on port", process.env.PORT || 3000, "| AI:", process.env.AI_PROVIDER || "anthropic")
);
