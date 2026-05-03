import express from "express";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const sessions = {};
const bookings  = [];

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
الخدمات: 1.باديكير-45د-80ر | 2.تلوين شعر-90د-250ر | 3.قص وتصفيف-60د-150ر | 4.أوزون-60د-200ر | 5.مساج-60د-180ر | 6.تنظيف بشرة-75د-220ر | 7.عروس-4س-800ر
المواعيد المحجوزة — اليوم: ${todayBooked} | بكره: ${tomorrowBooked}
القواعد: ما تأكد الحجز إلا بعد الخدمة+التاريخ+الوقت+الاسم. عند التأكيد أضف: [BOOKING_CONFIRMED: الاسم | الخدمة | التاريخ | الوقت | السعر]`;
}

function parseResponse(text) {
  let clean = text; let event = null;
  const bm = text.match(/\[BOOKING_CONFIRMED:\s*([^\]]+)\]/);
  if (bm) {
    const [name,service,date,time,price] = bm[1].split("|").map(s=>s.trim());
    event = { type:"booking", name, service, date, time, price };
    clean = text.replace(bm[0],"").trim();
  }
  return { clean, event };
}

async function callAI(messages) {
  const provider = (process.env.AI_PROVIDER || "openrouter").toLowerCase().trim();
  const apiKey   = (process.env.AI_API_KEY  || "").trim();
  const model    = (process.env.AI_MODEL    || "google/gemini-2.0-flash-exp:free").trim();

  console.log(`[AI] provider=${provider} model=${model} keyPrefix=${apiKey.slice(0,12)}...`);

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens:500, system:buildPrompt(), messages }),
    });
    const data = await res.json();
    console.log("[Anthropic] status:", res.status, JSON.stringify(data).slice(0,200));
    return data.content?.[0]?.text || "عذراً، صار خطأ.";
  }

  // OpenAI or OpenRouter
  const url = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer":  "https://lamsa-salon.app",
      "X-Title":       "Lamsa Salon",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [
        { role:"system", content:buildPrompt() },
        ...messages,
      ],
    }),
  });

  const data = await res.json();
  console.log(`[${provider}] status:`, res.status, JSON.stringify(data).slice(0,300));

  if (data.error) {
    console.error(`[${provider}] ERROR:`, JSON.stringify(data.error));
    return "عذراً، صار خطأ في الاتصال.";
  }

  return data.choices?.[0]?.message?.content || "عذراً، صار خطأ.";
}

app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();
  console.log(`[MSG] from=${from} body="${body}"`);
  if (!from || !body) return res.sendStatus(200);

  if (!sessions[from]) sessions[from] = [];
  sessions[from].push({ role:"user", content:body });
  if (sessions[from].length > 20) sessions[from] = sessions[from].slice(-20);

  try {
    const rawText          = await callAI(sessions[from]);
    const { clean, event } = parseResponse(rawText);
    sessions[from].push({ role:"assistant", content:rawText });

    if (event?.type === "booking") {
      bookings.push({ id:Date.now(), phone:from, ...event, status:"confirmed", source:"whatsapp" });
      console.log("✅ حجز:", event.name, event.service, event.time);
    }

    console.log(`[REPLY] "${clean.slice(0,80)}..."`);

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   from,
      body: clean,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("[ERR]", err.message, err.stack?.slice(0,300));
    res.sendStatus(500);
  }
});

app.get("/api/bookings", (_req, res) => res.json(bookings));
app.get("/", (_req, res) => res.json({
  status: "✅ شغال",
  provider: process.env.AI_PROVIDER,
  model:    process.env.AI_MODEL,
  keySet:   !!process.env.AI_API_KEY,
}));

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server on port", process.env.PORT || 3000, "| AI:", process.env.AI_PROVIDER)
);
