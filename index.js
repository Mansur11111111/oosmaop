// Micn на Replit: один файл, без установки пакетов.
// Раздаёт сайт (index.html) и отвечает на запросы AI. Ключ хранится в Replit Secrets.
// Все ошибки пишутся в Console понятным языком, а сайту отдаются короткие коды.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1500, MAX_MESSAGES = 12, MAX_CHARS = 20000;
const RATE = 20, WINDOW = 10 * 60 * 1000; // не больше 20 запросов к AI за 10 минут с одного адреса
const TIMEOUT = Number(process.env.AI_TIMEOUT_MS) || 45000;

// ---- защита от падения сервера ----
process.on("uncaughtException", (e) => console.error("[ОШИБКА] Необработанная ошибка:", (e && e.stack) || e));
process.on("unhandledRejection", (e) => console.error("[ОШИБКА] Необработанный промис:", (e && e.stack) || e));

// ---- проверка настроек при запуске ----
if (!KEY) {
  console.warn("[ВНИМАНИЕ] Не задан ANTHROPIC_API_KEY. Добавьте его в Secrets (значок замка слева) и перезапустите проект. Сайт откроется, но AI работать не будет.");
} else if (!KEY.startsWith("sk-ant-")) {
  console.warn("[ВНИМАНИЕ] ANTHROPIC_API_KEY не похож на ключ Anthropic (должен начинаться с sk-ant-). Проверьте значение в Secrets.");
}

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const a = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  a.push(now);
  hits.set(ip, a);
  return a.length > RATE;
}

const send = (res, status, obj) => {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

// Читает тело запроса. Если оно слишком большое, возвращает null.
function readBody(req) {
  return new Promise((ok, no) => {
    let d = "", big = false;
    req.on("data", (c) => {
      if (big) return;
      d += c;
      if (d.length > 200000) { big = true; d = ""; }
    });
    req.on("end", () => ok(big ? null : d));
    req.on("error", no);
  });
}

// Оплата Stripe (необязательно): работает, только если заданы STRIPE_SECRET_KEY, STRIPE_PRICE_ID и SITE_URL
async function checkout(res) {
  const { STRIPE_SECRET_KEY: sk, STRIPE_PRICE_ID: price, SITE_URL: site } = process.env;
  if (!sk || !price || !site) return send(res, 501, { error: "config" });
  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + sk, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        mode: "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        success_url: site + "?sub=success",
        cancel_url: site + "?sub=cancel",
      }),
    });
    const s = await r.json();
    if (!s.url) console.error("[ОШИБКА STRIPE] Не удалось создать оплату:", r.status, JSON.stringify(s.error || s).slice(0, 300));
    return s.url ? send(res, 200, { url: s.url }) : send(res, 502, { error: "unreachable" });
  } catch (e) {
    console.error("[ОШИБКА STRIPE] Нет связи со Stripe:", e.message);
    return send(res, 502, { error: "unreachable" });
  }
}

async function ai(req, res, body) {
  if (!KEY) {
    console.error("[ОШИБКА AI] Запрос пришёл, но ANTHROPIC_API_KEY не задан.");
    return send(res, 500, { error: "config" });
  }
  const msgs = body && body.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > MAX_MESSAGES) return send(res, 400, { error: "Invalid messages" });
  let total = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== (i % 2 === 0 ? "user" : "assistant") || typeof m.content !== "string" || !m.content.trim())
      return send(res, 400, { error: "Invalid messages" });
    total += m.content.length;
  }
  if (msgs[msgs.length - 1].role !== "user" || total > MAX_CHARS) return send(res, 400, { error: "Request too large" });

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "rate" });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: msgs.map((m) => ({ role: m.role, content: m.content })) }),
    });
    if (!r.ok) {
      const txt = (await r.text().catch(() => "")).slice(0, 400);
      let code = "bad_request", status = 502;
      if (r.status === 401 || r.status === 403) { code = "auth"; status = 500; console.error("[ОШИБКА AI] Ключ недействителен или нет доступа. Проверьте ANTHROPIC_API_KEY в Secrets."); }
      else if (r.status === 429) { code = "rate"; status = 429; console.error("[ОШИБКА AI] Превышен лимит запросов Anthropic."); }
      else if (r.status >= 500) { code = "overloaded"; status = 503; console.error("[ОШИБКА AI] Сервис Anthropic перегружен или недоступен (" + r.status + ")."); }
      else if (/credit balance/i.test(txt)) { code = "billing"; status = 503; console.error("[ОШИБКА AI] На счёте Anthropic закончились деньги. Пополните баланс в console.anthropic.com."); }
      else console.error("[ОШИБКА AI] Anthropic отклонил запрос (" + r.status + "):", txt);
      return send(res, status, { error: code });
    }
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return send(res, 200, { text });
  } catch (e) {
    if (e.name === "AbortError") {
      console.error("[ОШИБКА AI] Anthropic не ответил за " + TIMEOUT / 1000 + " сек.");
      return send(res, 504, { error: "timeout" });
    }
    console.error("[ОШИБКА AI] Нет связи с Anthropic:", e.message);
    return send(res, 502, { error: "unreachable" });
  } finally {
    clearTimeout(timer);
  }
}

http
  .createServer(async (req, res) => {
    const t0 = Date.now();
    const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";
    res.on("finish", () => console.log(new Date().toISOString(), req.method, url, res.statusCode, Date.now() - t0 + "мс"));
    try {
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
      }
      if (req.method === "GET" && url === "/api/health") return send(res, 200, { ok: true, aiConfigured: !!KEY });
      if (req.method === "POST" && (url === "/api" || url === "/api/checkout")) {
        const raw = await readBody(req);
        if (raw === null) return send(res, 413, { error: "Request too large" });
        let body;
        try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "Invalid JSON" }); }
        return url === "/api" ? await ai(req, res, body) : await checkout(res);
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (e) {
      console.error("[ОШИБКА] Сбой при обработке запроса " + req.method + " " + url + ":", (e && e.stack) || e);
      send(res, 500, { error: "server_error" });
    }
  })
  .listen(PORT, "0.0.0.0", () => console.log("Micn запущен на порту " + PORT));
