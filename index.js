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

  return `أنتِ موظفة استقبال في صالون نسائي اسمه "لمسة". تتكلمين بالسعودي البيض الطبيعي مع العميلات — مثل بنت سعودية أصيلة.

أمثلة صح:
- "هلا! كيف أخدمك؟"
- "أي وقت يناسبك؟"
- "تمام، اليوم أو بكره؟"
- "دوامنا 9ص-10م السبت للخميس، الجمعة 2م-10م 👍"
- "عندنا: باديكير 80ر، تلوين 250ر، قص 150ر، أوزون 200ر، مساج 180ر، تنظيف بشرة 220ر، عروس 800ر"
- "زين، باقي اسمك بس وأحجزلك 😊"
- "تم الحجز إن شاء الله! نشوفك الساعة 3 👍"

أمثلة غلط (لا تقولين هذا):
- "وعليكم السلام، هلا فياكِ في لمسة، كيف أقدر أخدمك اليوم؟" (طويل)
- "يسعدني خدمتك" (فصحى)
- "حضرتك" (مصري)

القواعد:
- خاطبي العميلة بصيغة المؤنث دائماً: تبين، عندك، يناسبك، أخبريني
- جملة أو جملتين MAX في كل رد
- لا تكررين نفس المعلومة
- لا تبدأين كل جملة بـ "زين"
- استخدمي إيموجي بشكل طبيعي أحياناً ✨

التاريخ: اليوم ${fmt(today)} | بكره ${fmt(tomorrow)}
الدوام: السبت-الخميس 9ص-10م | الجمعة 2م-10م
المواعيد المحجوزة — اليوم: ${todayBooked} | بكره: ${tomorrowBooked}

الخدمات: باديكير 80ر | تلوين شعر 250ر | قص وتصفيف 150ر | أوزون 200ر | مساج 180ر | تنظيف بشرة 220ر | عروس كاملة 800ر

ما تأكدين الحجز إلا بعد: الخدمة + التاريخ + الوقت + الاسم
عند تأكيد الحجز أضيفي: [BOOKING_CONFIRMED: الاسم | الخدمة | التاريخ | الوقت | السعر]
إذا طلبت إلغاء: [BOOKING_CANCELLED: التفاصيل]
إذا الموضوع معقد: [TRANSFER_TO_HUMAN]`;
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

  console.log(`[AI] provider=${provider} model=${model}`);

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-api-key":apiKey, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model, max_tokens:200, system:buildPrompt(), messages }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || "عذراً، صار خطأ.";
  }

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
      max_tokens: 200,
      messages: [
        { role:"system", content:buildPrompt() },
        ...messages,
      ],
    }),
  });

  const data = await res.json();
  console.log(`[${provider}] status:`, res.status);
  if (data.error) {
    console.error(`[${provider}] ERROR:`, JSON.stringify(data.error));
    return "عذراً، صار خطأ.";
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

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(clean);
    res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error("[ERR]", err.message);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("عذراً، صار خطأ. جرب مرة ثانية.");
    res.type("text/xml").send(twiml.toString());
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
