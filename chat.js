// api/chat.js — Vercel Serverless Function (Node.js)
// Saara AI kaam yahin hota hai. API key sirf server par rehti hai, browser me nahi jaati.

const CHAT_URL =
  process.env.ORCAROUTER_BASE_URL ||
  "https://api.orcarouter.ai/v1/chat/completions";

// Default: OrcaRouter ke FREE models (balance zero par bhi chalte hain, bas
// rate-limited hote hain). Comma se list do -- pehla busy/limit hua to server
// khud agla model try karega.
const FALLBACK_MODELS = (
  process.env.ORCAROUTER_MODEL ||
  "deepseek/deepseek-v4-pro-free,qwen/qwen3.8-27b-free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const ENV_KEY = process.env.ORCAROUTER_API_KEY || "";

const MAX_CHARS = 24000; // poori conversation ka cap
const MAX_MSGS = 24;
const TIMEOUT_MS = 55000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 30);

const SYSTEM = {
  chat: [
    "Tum ek senior full-stack developer aur helpful assistant ho.",
    "Jawab short, clear aur actionable rakho; bullet points use karo.",
    "Code do to complete aur runnable ho, short comments ke saath, aur markdown code fence me ho.",
    "User jis bhasha me poochhe (Hindi / Hinglish / English) usi me jawab do.",
    "Jo pata nahi hai use guess mat karo -- saaf bol do.",
  ].join(" "),
  site: [
    "Tum ek expert frontend developer aur UI designer ho.",
    "Output me sirf EK complete single-file HTML document do, ek hi ```html code fence ke andar. Koi explanation, koi extra text nahi.",
    "Rules: <!doctype html> se shuru karo; saara CSS <style> me aur JS <script> me inline rakho (koi external file, CDN ya build step nahi);",
    "mobile-first responsive layout; system fonts; semantic HTML; form fields par labels aur images par alt text;",
    "images ke liye CSS gradients ya inline SVG use karo (external image URL mat lagao);",
    "menu, tabs, accordion, form validation jaisi interactivity plain JS me actually kaam kare;",
    "contact form ko JS se handle karke thank-you message dikhao;",
    "content real aur specific likho, lorem ipsum nahi; tap targets 44px se bade rakho.",
  ].join(" "),
  bug: [
    "Tum ek strict senior code reviewer ho.",
    "Jawab exactly is order me do:",
    "'## Bugs' -- numbered list; har item me severity (High/Medium/Low), problem wali line ya snippet, kya galat hai aur kyun.",
    "'## Fixed code' -- poora corrected code ek hi code fence me (sirf badla hua nahi, complete file).",
    "'## Suggestions' -- 3 se 5 short bullets (performance, security, readability).",
    "Sirf real issues batao; jhoothe bug mat banao. Koi bug na mile to saaf bolo aur sirf improvements do.",
  ].join(" "),
};

// Best-effort per-IP rate limit (per serverless instance)
const hits = new Map();
function tooManyRequests(ip, limit = RATE_LIMIT, windowMs = 60000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) hits.clear();
  return list.length > limit;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Sirf POST request allowed hai." });
  }

  const ip =
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown";
  if (tooManyRequests(ip)) {
    return res
      .status(429)
      .json({ error: "Bahut zyada requests. 1 minute baad try karo." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};

  // Key: app ki settings se aayi key (BYOK) warna server ki env key
  const byok =
    typeof body.key === "string" && body.key.trim().startsWith("sk-")
      ? body.key.trim()
      : "";
  const API_KEY = byok || ENV_KEY;
  if (!API_KEY) {
    return res.status(500).json({
      error:
        "Koi API key nahi mili. Vercel → Settings → Environment Variables me ORCAROUTER_API_KEY daalo aur Redeploy karo, ya app ke Settings me apni key daal do.",
    });
  }

  const mode = ["chat", "site", "bug"].includes(body.mode) ? body.mode : "chat";

  // Messages saaf karo
  let msgs = Array.isArray(body.messages) ? body.messages : [];
  msgs = msgs
    .filter(
      (m) =>
        m &&
        typeof m.content === "string" &&
        m.content.trim() &&
        (m.role === "user" || m.role === "assistant")
    )
    .slice(-MAX_MSGS)
    .map((m) => ({ role: m.role, content: m.content }));

  if (!msgs.length) {
    return res.status(400).json({ error: "Message khaali hai." });
  }

  // Peeche se chars ka budget bharo (purani baatein apne aap drop ho jaati hain)
  const kept = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].content.slice(0, MAX_CHARS);
    if (total + c.length > MAX_CHARS && kept.length) break;
    kept.unshift({ role: msgs[i].role, content: c });
    total += c.length;
  }

  const messages = [{ role: "system", content: SYSTEM[mode] }, ...kept];
  const temperature = clampNumber(
    body.temperature,
    0,
    1.2,
    mode === "site" ? 0.4 : 0.6
  );
  const maxTokens = mode === "site" ? 8000 : 4000;
  const wantStream = body.stream !== false;

  const requested =
    typeof body.model === "string" && body.model.trim() ? [body.model.trim()] : [];
  const models = [...new Set([...requested, ...FALLBACK_MODELS])];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let lastError = "Upstream API error";

  try {
    for (const model of models) {
      const upstream = await fetch(CHAT_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: wantStream,
        }),
      });

      if (!upstream.ok) {
        const raw = await upstream.text();
        let data = {};
        try {
          data = JSON.parse(raw);
        } catch {
          /* non-JSON error body */
        }
        lastError =
          (data && data.error && (data.error.message || data.error)) ||
          raw.slice(0, 200) ||
          `HTTP ${upstream.status}`;

        // 429 rate limit, 402 credit, 404 model missing, 5xx provider down -> agla model
        const retryable = [402, 404, 429, 500, 502, 503].includes(
          upstream.status
        );
        if (retryable) continue;
        break;
      }

      // ---- Non-streaming: seedha JSON ----
      if (!wantStream) {
        const data = await upstream.json().catch(() => ({}));
        const text = String(
          data?.choices?.[0]?.message?.content ??
            data?.choices?.[0]?.text ??
            ""
        ).trim();
        if (!text) {
          lastError = `${model} ne khaali jawab diya`;
          continue;
        }
        return res.status(200).json({ text, model });
      }

      // ---- Streaming: upstream SSE ko waise hi browser tak bhej do ----
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      const reader = upstream.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }

    return res.status(502).json({ error: `AI API error: ${lastError}` });
  } catch (err) {
    const aborted =
      err && (err.name === "AbortError" || err.name === "TimeoutError");
    const message = aborted
      ? "AI ne time se jawab nahi diya. Chhota prompt try karo."
      : `Server error: ${(err && err.message) || "unknown"}`;
    if (res.headersSent) {
      try {
        res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
        res.end();
      } catch {
        /* connection already closed */
      }
      return;
    }
    return res.status(aborted ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timer);
  }
};
