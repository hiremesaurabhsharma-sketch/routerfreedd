// api/models.js — model list ke liye (Settings me dropdown bharta hai)
// GET  => server ki env key se list laata hai
// POST { key } => app ki settings me daali key se list laata hai

const BASE = (
  process.env.ORCAROUTER_BASE_URL ||
  "https://api.orcarouter.ai/v1/chat/completions"
)
  .replace(/\/chat\/completions.*$/, "")
  .replace(/\/+$/, "");

const MODELS_URL = BASE + "/models";
const CACHE_MS = 10 * 60 * 1000;

const DEFAULTS = [
  { id: "deepseek/deepseek-v4-pro-free", free: true },
  { id: "qwen/qwen3.8-27b-free", free: true },
  { id: "openai/gpt-4o-mini", free: false },
  { id: "anthropic/claude-haiku-4.5", free: false },
  { id: "google/gemini-flash-latest", free: false },
  { id: "orcarouter/auto", free: false },
];

let cache = { at: 0, models: null };

function isFree(m) {
  const id = String(m.id || "");
  if (/[-:]free$/i.test(id)) return true;
  const p = m.pricing || {};
  const nums = [p.prompt, p.completion, p.input, p.output]
    .filter((v) => v !== undefined && v !== null)
    .map(Number);
  return nums.length > 0 && nums.every((n) => n === 0);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const byok =
    body && typeof body.key === "string" && body.key.trim().startsWith("sk-")
      ? body.key.trim()
      : "";
  const API_KEY = byok || process.env.ORCAROUTER_API_KEY || "";

  if (!API_KEY) {
    return res.status(200).json({ models: DEFAULTS, source: "default" });
  }

  const refresh = req.query && (req.query.refresh === "1" || req.query.refresh === "true");
  if (!refresh && cache.models && Date.now() - cache.at < CACHE_MS) {
    return res.status(200).json({ models: cache.models, source: "cache" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const upstream = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      return res.status(200).json({ models: DEFAULTS, source: "default" });
    }
    const data = await upstream.json();
    const raw = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
      ? data.models
      : [];

    const models = raw
      .map((m) => ({ id: String(m.id || m.name || ""), free: isFree(m) }))
      .filter((m) => m.id)
      .sort((a, b) =>
        a.free === b.free ? a.id.localeCompare(b.id) : a.free ? -1 : 1
      );

    if (!models.length) {
      return res.status(200).json({ models: DEFAULTS, source: "default" });
    }

    if (!byok) cache = { at: Date.now(), models };
    return res.status(200).json({ models, source: "live", count: models.length });
  } catch {
    return res.status(200).json({ models: DEFAULTS, source: "default" });
  } finally {
    clearTimeout(timer);
  }
};
