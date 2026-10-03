import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1048576; // Grenze der Messages API pro Bild

let client = null;
export const identifyAvailable = () => !!process.env.ANTHROPIC_API_KEY;
function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 1, timeout: 60_000 });
  return client;
}

const fail = (status, code) => Object.assign(new Error(code), { status, code });

// Holt das erste JSON-Objekt aus der Antwort, auch wenn es in einem Codeblock
// steht oder von Text umgeben ist.
export function extractJson(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } }
    }
  }
  throw fail(502, 'invalid_json');
}

// body: { prompt: string, images?: [{ type, data (base64) }] }
// Schickt einen Prompt (optional mit Bildern) an die Messages API und gibt das
// JSON-Objekt aus der Antwort zurück.
async function completeJson({ prompt, images = [], model, maxTokens, maxPrompt, signal, tag }) {
  if (!identifyAvailable()) throw fail(503, 'not_granted');
  if (typeof prompt !== 'string' || !prompt.trim()) throw fail(400, 'invalid_argument');
  if (prompt.length > maxPrompt) throw fail(413, 'prompt_too_large');

  const content = [];
  for (const img of Array.isArray(images) ? images.slice(0, 4) : []) {
    if (!img || !IMAGE_TYPES.has(img.type) || typeof img.data !== 'string') throw fail(400, 'image_rejected');
    if (img.data.length * 0.75 > MAX_IMAGE_BYTES) throw fail(413, 'image_rejected');
    content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
  }
  content.push({ type: 'text', text: prompt });

  let res;
  try {
    res = await getClient().messages.create(
      { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] },
      { signal });
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) throw fail(499, 'cancelled');
    if (e instanceof Anthropic.RateLimitError) throw fail(429, 'rate_limited');
    if (e instanceof Anthropic.BadRequestError) {
      console.warn(`${tag}: bad request`, e.message);
      throw fail(400, content.length > 1 ? 'image_rejected' : 'invalid_argument');
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      console.error(`${tag}: API-Key ungültig oder ohne Berechtigung`);
      throw fail(503, 'not_granted');
    }
    console.error(`${tag}:`, e?.status || '', e?.message || e);
    throw fail(502, 'upstream');
  }
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJson(text);
}

// Teilesuche
export function identify(body, signal) {
  return completeJson({ prompt: body?.prompt, images: body?.images, model: MODEL, maxTokens: 4096, maxPrompt: 20000, signal, tag: 'identify' });
}

// Drop: würfelt Projektideen und schreibt das Geschmacksprofil. Eigenes Modell,
// weil hier Ideen gefragt sind; Standard wie in Random Drop.
const DROP_MODEL = process.env.DROP_MODEL || 'claude-sonnet-4-6';
export function dropGenerate(body, signal) {
  return completeJson({ prompt: body?.prompt, model: DROP_MODEL, maxTokens: 3000, maxPrompt: 40000, signal, tag: 'drop' });
}
