'use strict';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 quiet-river/1.0';

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Fetch with a hard timeout and a byte cap. Personal feed readers die on one
 * hung origin, so every request gets its own deadline rather than a global one.
 */
async function get(url, { timeoutMs = 15000, accept = '*/*', headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
    });
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: response.ok, status: response.status, url: response.url, contentType: response.headers.get('content-type') || '', body: '', finalUrl: response.url };
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error(`response larger than ${MAX_BYTES} bytes`);
      }
      chunks.push(value);
    }
    const contentType = response.headers.get('content-type') || '';
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
    let body;
    try {
      body = new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(concat(chunks));
    } catch {
      body = new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks));
    }
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      finalUrl: response.url,
      contentType,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function absolute(base, maybeRelative) {
  if (!maybeRelative) return null;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

async function postJson(url, body, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
    return { ok: response.ok, status: response.status, body: text, json: parsed };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { get, postJson, absolute, USER_AGENT };
