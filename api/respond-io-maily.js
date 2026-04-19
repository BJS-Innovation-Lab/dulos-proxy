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
const PROXY_OUTBOUND_MODE = process.env.RESPOND_IO_PROXY_OUTBOUND_MODE || 'hybrid'; // disabled|sync|hybrid

const messageCache = new Map();
const CACHE_TTL = 60 * 1000;

function cleanCache() {
  const now = Date.now();
  for (const [messageId, timestamp] of messageCache.entries()) {
    if (now - timestamp > CACHE_TTL) messageCache.delete(messageId);
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

    cleanCache();

    if (eventType !== 'message.received') return res.status(200).json({ ok: true, message: `Ignored ${eventType}` });

    const signature = req.headers['x-respond-signature'] || req.headers['x-signature'];
    if (signature && !verifySignature(req.body, signature)) {
      return res.status(200).json({ ok: true, message: 'Invalid signature' });
    }

    if (messageId && messageCache.has(messageId)) {
      return res.status(200).json({ ok: true, message: 'Duplicate message' });
    }

    const transformed = buildMessage(req.body);
    if (!transformed?.message || transformed.message.trim() === '') {
      return res.status(200).json({ ok: true, message: 'No usable content' });
    }

    const mediaPayload = await extractMediaPayload(req.body);

    if (messageId) messageCache.set(messageId, Date.now());

    const forwardPayload = {
      message: transformed.message,
      sessionKey: transformed.sessionKey,
      _respondIoRaw: req.body,
      _respondIoMedia: mediaPayload
    };

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
        const sendResult = await sendRespondIoText(contactIdentifier, outboundText);
        console.log('respond.io outbound result:', {
          identifier: contactIdentifier,
          ok: sendResult.ok,
          status: sendResult.status,
          body: sendResult.body
        });
      } else {
        console.log('respond.io outbound skipped: missing contact.phone');
      }
    } else {
      // hybrid mode: prefer sync assistant text; otherwise send non-silent fallback
      let textToSend = outboundText;
      if (!textToSend && hasRunId) {
        textToSend = DEFAULT_ACK_TEXT;
        console.log('respond.io outbound fallback: no sync text, sending ack', { hasRunId });
      }

      if (!textToSend) {
        console.log('respond.io outbound skipped: no text available in hybrid mode');
      } else if (contactIdentifier) {
        const sendResult = await sendRespondIoText(contactIdentifier, textToSend);
        console.log('respond.io outbound result:', {
          mode: PROXY_OUTBOUND_MODE,
          fallback: textToSend === DEFAULT_ACK_TEXT,
          identifier: contactIdentifier,
          ok: sendResult.ok,
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
