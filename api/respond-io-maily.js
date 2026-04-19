// Proxy for respond.io webhooks -> OpenClaw
// Forwards raw webhook payload to /hooks/respond-io so OpenClaw runbook can reply back via respond.io

import crypto from 'crypto';

const SIGNING_KEY = 'fVpkPpQk3uXQUvAPhjfBV1bmXdNyRVJwZxRgCAw5zCk=';
const OPENCLAW_URL = 'https://maily-production.up.railway.app/hooks/respond-io';
const OPENCLAW_TOKEN = 'O6ZfvymeUGg4PTL7K0wiWeMiHJe6STtxMioWxB5A8ck=';

const RESPOND_IO_API_BASE = process.env.RESPOND_IO_API_BASE || 'https://api.respond.io/v2';
const RESPOND_IO_TOKEN = process.env.RESPOND_IO_TOKEN || '8vL2GyZldClqASN6t3ZI3Zec8b5pvL1pcBAIluK+X1U=';
const DEFAULT_ACK_TEXT = process.env.RESPOND_IO_ACK_TEXT || 'Gracias por escribirnos 🙏 Estamos procesando tu mensaje y te respondemos enseguida.';
const MAX_INLINE_MEDIA_BYTES = Number(process.env.RESPOND_IO_MAX_INLINE_MEDIA_BYTES || 700000);
const PROXY_OUTBOUND_MODE = process.env.RESPOND_IO_PROXY_OUTBOUND_MODE || 'disabled'; // disabled|sync|hybrid
const OPENCLAW_GATEWAY_BASE = process.env.OPENCLAW_GATEWAY_BASE || OPENCLAW_URL.replace(/\/hooks\/respond-io$/, '');
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const FINAL_TEXT_POLL_MS = Number(process.env.RESPOND_IO_FINAL_TEXT_POLL_MS || 10000);
const FINAL_TEXT_POLL_INTERVAL_MS = Number(process.env.RESPOND_IO_FINAL_TEXT_POLL_INTERVAL_MS || 1500);

const messageCache = new Map();
const outboundCache = new Map();
const CACHE_TTL = Number(process.env.RESPOND_IO_DEDUPE_WINDOW_MS || 300000);
const OUTBOUND_DEDUPE_WINDOW_MS = Number(process.env.RESPOND_IO_OUTBOUND_DEDUPE_WINDOW_MS || 300000);

function cleanCache() {
  const now = Date.now();
  for (const [messageId, timestamp] of messageCache.entries()) {
    if (now - timestamp > CACHE_TTL) messageCache.delete(messageId);
  }
  for (const [outKey, timestamp] of outboundCache.entries()) {
    if (now - timestamp > OUTBOUND_DEDUPE_WINDOW_MS) outboundCache.delete(outKey);
  }
}

async function sendRespondIoText(identifier, text) {
  if (!identifier || !text) return { ok: false, reason: 'missing_identifier_or_text' };
  if (!RESPOND_IO_TOKEN) return { ok: false, reason: 'missing_respond_io_token' };

  const url = `${RESPOND_IO_API_BASE}/contact/${encodeURIComponent(identifier)}/message`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESPOND_IO_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      message: {
        type: 'text',
        text
      }
    })
  });

  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body };
}

function computeOutboundKey(identifier, text) {
  const normalized = stripReplyTags(String(text || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const digest = crypto.createHash('sha1').update(normalized).digest('hex');
  return `${identifier}|${digest}`;
}

async function sendRespondIoTextDedup(identifier, text) {
  const key = computeOutboundKey(identifier, text);
  const now = Date.now();
  const prev = outboundCache.get(key);
  if (prev && now - prev < OUTBOUND_DEDUPE_WINDOW_MS) {
    return { ok: true, skipped: true, reason: 'duplicate_outbound_suppressed' };
  }

  const result = await sendRespondIoText(identifier, text);
  if (result.ok) outboundCache.set(key, now);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripReplyTags(text) {
  if (!text) return text;
  return String(text)
    .replace(/^\s*\[\[\s*reply_to[^\]]*\]\]\s*/i, '')
    .trim();
}

function extractAssistantText(historyMessages, minTimestampMs = 0) {
  if (!Array.isArray(historyMessages)) return null;

  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (!msg || msg.role !== 'assistant') continue;

    const ts = Number(msg.timestamp || 0);
    if (minTimestampMs && ts && ts < minTimestampMs) continue;

    const chunks = Array.isArray(msg.content) ? msg.content : [];
    const text = chunks
      .filter((chunk) => chunk?.type === 'text' && typeof chunk.text === 'string')
      .map((chunk) => chunk.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    const cleaned = stripReplyTags(text);
    if (cleaned && cleaned !== 'NO_REPLY') return cleaned;
  }

  return null;
}

async function invokeGatewayTool(tool, args) {
  if (!OPENCLAW_GATEWAY_TOKEN) return { ok: false, reason: 'missing_gateway_token' };

  const resp = await fetch(`${OPENCLAW_GATEWAY_BASE}/tools/invoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tool, args })
  });

  const body = await resp.text();
  let parsed = null;
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    parsed = { raw: body };
  }

  return { ok: resp.ok, status: resp.status, parsed, body };
}

async function pollFinalAssistantText(sessionKey, minTimestampMs = 0) {
  if (!sessionKey) return null;
  if (!OPENCLAW_GATEWAY_TOKEN) return null;

  const candidates = [sessionKey];
  if (!sessionKey.startsWith('agent:')) candidates.unshift(`agent:main:${sessionKey}`);
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

  const deadline = Date.now() + Math.max(0, FINAL_TEXT_POLL_MS);
  while (Date.now() < deadline) {
    for (const candidate of uniqueCandidates) {
      try {
        const toolResp = await invokeGatewayTool('sessions_history', {
          sessionKey: candidate,
          limit: 8,
          includeTools: false
        });

        if (!toolResp.ok) continue;

        const result = toolResp.parsed?.result || toolResp.parsed;
        const messages = result?.messages || [];
        const text = extractAssistantText(messages, minTimestampMs);
        if (text) return { text, sessionKey: candidate };
      } catch (err) {
        console.log('respond.io poll error:', String(err));
      }
    }

    await sleep(FINAL_TEXT_POLL_INTERVAL_MS);
  }

  return null;
}

function normalizeDedupeSource(body) {
  const messageObj = body?.message?.message || {};
  const phone = String(body?.contact?.phone || '').replace(/\D/g, '');
  const type = String(body?.message?.type || messageObj?.type || '').toLowerCase();
  const text = String(messageObj?.text || '').trim().toLowerCase();
  const caption = String(messageObj?.caption || '').trim().toLowerCase();
  const url = String(messageObj?.url || messageObj?.link || '').trim().toLowerCase();
  return `${phone}|${type}|${text}|${caption}|${url}`;
}

function computeDedupeKey(body) {
  const messageId = body?.message?.id;
  if (messageId) return `id:${messageId}`;
  const src = normalizeDedupeSource(body);
  return `fp:${crypto.createHash('sha1').update(src).digest('hex')}`;
}

function isLikelyOutboundEcho(body) {
  const direction = String(body?.message?.direction || body?.message?.message?.direction || '').toLowerCase();
  const fromType = String(body?.message?.fromType || body?.message?.from?.type || '').toLowerCase();
  const fromMe = body?.message?.message?.fromMe === true;
  return direction === 'outbound' || fromType === 'agent' || fromType === 'business' || fromMe;
}

function verifySignature(payload, signature) {
  if (!signature) return true;
  const hmac = crypto.createHmac('sha256', SIGNING_KEY);
  hmac.update(JSON.stringify(payload));
  return signature === hmac.digest('base64');
}

function extractSessionKey(phone) {
  if (!phone) return null;
  const cleanPhone = String(phone).replace(/^\+/, '').replace(/\D/g, '');
  return cleanPhone ? `hook:whatsapp:${cleanPhone}` : null;
}

function describeIncomingMessage(body) {
  const messageObj = body?.message?.message || {};
  const text = (messageObj?.text || '').trim();
  if (text) return text;

  const type = body?.message?.type || messageObj?.type || 'unknown';
  const caption = (messageObj?.caption || '').trim();
  const url = messageObj?.url || messageObj?.link || null;

  const typeLabel = `[attachment:${type}]`;
  if (caption && url) return `${typeLabel} ${caption} (${url})`;
  if (caption) return `${typeLabel} ${caption}`;
  if (url) return `${typeLabel} ${url}`;
  return typeLabel;
}

function buildMessage(body) {
  const contact = body?.contact || {};
  const channel = body?.channel || {};
  const messageText = describeIncomingMessage(body);
  const contactPhone = contact.phone || '';
  const contactName = contact.firstName || contact.phone || 'Cliente';
  const channelSource = channel.source || 'whatsapp';

  return {
    message: `[respond.io] Nuevo mensaje de ${contactName} (${contactPhone}) via ${channelSource}: "${messageText}"`,
    sessionKey: extractSessionKey(contactPhone)
  };
}

async function extractMediaPayload(body) {
  const messageObj = body?.message?.message || {};
  const type = body?.message?.type || messageObj?.type || null;
  if (!type || type === 'text') return null;

  const url = messageObj?.url || messageObj?.link || null;
  const caption = (messageObj?.caption || '').trim() || null;
  const mimeType = messageObj?.mimeType || messageObj?.mimetype || null;

  const media = { type, url, caption, mimeType, inlineDataUrl: null };
  if (!url) return media;

  try {
    const resp = await fetch(url, {
      headers: RESPOND_IO_TOKEN ? { Authorization: `Bearer ${RESPOND_IO_TOKEN}` } : undefined
    });
    if (!resp.ok) return media;

    const contentType = resp.headers.get('content-type') || mimeType || 'application/octet-stream';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 0 && buf.length <= MAX_INLINE_MEDIA_BYTES) {
      media.inlineDataUrl = `data:${contentType};base64,${buf.toString('base64')}`;
      media.inlineBytes = buf.length;
    }
  } catch (err) {
    console.log('respond.io media fetch failed:', String(err));
  }

  return media;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, message: 'Only POST supported' });

  try {
    const eventType = req.body?.event_type;
    const messageId = req.body?.message?.id;
    const dedupeKey = computeDedupeKey(req.body);

    cleanCache();

    if (eventType !== 'message.received') return res.status(200).json({ ok: true, message: `Ignored ${eventType}` });

    if (isLikelyOutboundEcho(req.body)) {
      return res.status(200).json({ ok: true, message: 'Ignored outbound echo' });
    }

    const signature = req.headers['x-respond-signature'] || req.headers['x-signature'];
    if (signature && !verifySignature(req.body, signature)) {
      return res.status(200).json({ ok: true, message: 'Invalid signature' });
    }

    if (messageCache.has(dedupeKey)) {
      return res.status(200).json({ ok: true, message: 'Duplicate message' });
    }

    const transformed = buildMessage(req.body);
    if (!transformed?.message || transformed.message.trim() === '') {
      return res.status(200).json({ ok: true, message: 'No usable content' });
    }

    const mediaPayload = await extractMediaPayload(req.body);

    messageCache.set(dedupeKey, Date.now());

    const forwardPayload = {
      message: transformed.message,
      sessionKey: transformed.sessionKey,
      _respondIoRaw: req.body,
      _respondIoMedia: mediaPayload
    };

    const requestStartMs = Date.now();

    const response = await fetch(OPENCLAW_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENCLAW_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(forwardPayload)
    });

    const data = await response.text();
    console.log('OpenClaw response:', { status: response.status, body: data });

    const contactPhone = req.body?.contact?.phone || null;
    const contactIdentifier = contactPhone ? `phone:${contactPhone}` : null;

    let outboundText = null;
    try {
      const parsed = JSON.parse(data || '{}');
      outboundText = parsed?.summary || parsed?.reply || parsed?.text || null;
    } catch {
      outboundText = null;
    }

    const parsed = (() => {
      try { return JSON.parse(data || '{}'); } catch { return {}; }
    })();
    const hasRunId = Boolean(parsed?.runId);

    if (PROXY_OUTBOUND_MODE === 'disabled') {
      console.log('respond.io outbound skipped: proxy outbound disabled (agent-run must send via API)', {
        mode: PROXY_OUTBOUND_MODE,
        hasRunId,
        hasSyncText: Boolean(outboundText)
      });
    } else if (PROXY_OUTBOUND_MODE === 'sync') {
      if (!outboundText) {
        console.log('respond.io outbound skipped: no final text in OpenClaw sync response');
      } else if (contactIdentifier) {
        const sendResult = await sendRespondIoTextDedup(contactIdentifier, outboundText);
        console.log('respond.io outbound result:', {
          identifier: contactIdentifier,
          ok: sendResult.ok,
          skipped: Boolean(sendResult.skipped),
          reason: sendResult.reason || null,
          status: sendResult.status,
          body: sendResult.body
        });
      } else {
        console.log('respond.io outbound skipped: missing contact.phone');
      }
    } else {
      // hybrid mode: prefer sync assistant text; try polling final run output; fallback to ack
      let textToSend = outboundText;
      let usedFallback = false;
      let usedPolledText = false;

      if (!textToSend && hasRunId) {
        const polled = await pollFinalAssistantText(transformed.sessionKey, requestStartMs);
        if (polled?.text) {
          textToSend = polled.text;
          usedPolledText = true;
          console.log('respond.io outbound poll success:', {
            sessionKey: polled.sessionKey,
            textLength: textToSend.length
          });
        }
      }

      if (!textToSend && hasRunId) {
        console.log('respond.io outbound skipped: no sync/polled text (ack fallback hard-disabled)', { hasRunId });
      }

      if (!textToSend) {
        console.log('respond.io outbound skipped: no text available in hybrid mode');
      } else if (contactIdentifier) {
        const sendResult = await sendRespondIoTextDedup(contactIdentifier, textToSend);
        console.log('respond.io outbound result:', {
          mode: PROXY_OUTBOUND_MODE,
          fallback: usedFallback,
          polled: usedPolledText,
          identifier: contactIdentifier,
          ok: sendResult.ok,
          skipped: Boolean(sendResult.skipped),
          reason: sendResult.reason || null,
          status: sendResult.status,
          body: sendResult.body
        });
      } else {
        console.log('respond.io outbound skipped: missing contact.phone');
      }
    }

    return res.status(200).json({ ok: true, message: 'Processed successfully' });
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(200).json({ ok: true, message: 'Error handled', error: error.message });
  }
}
