// Proxy for respond.io webhooks -> OpenClaw
// Forwards raw webhook payload to /hooks/respond-io so OpenClaw runbook can reply back via respond.io

import crypto from 'crypto';

const SIGNING_KEY = 'B3u5qRyRw9FFeWJ65fVAgC7OVWca80Eggt4XIPHbv/Q=';
const OPENCLAW_URL = 'https://maily-production.up.railway.app/hooks/respond-io';
const OPENCLAW_TOKEN = 'O6ZfvymeUGg4PTL7K0wiWeMiHJe6STtxMioWxB5A8ck=';

const RESPOND_IO_API_BASE = process.env.RESPOND_IO_API_BASE || 'https://api.respond.io/v2';
const RESPOND_IO_TOKEN = process.env.RESPOND_IO_TOKEN || '8vL2GyZldClqASN6t3ZI3Zec8b5pvL1pcBAIluK+X1U=';
const DEFAULT_ACK_TEXT = process.env.RESPOND_IO_ACK_TEXT || '¡Hola! 👋 Soy Andrea de Dulos. Ya recibimos tu mensaje y te ayudamos enseguida.';

// In-memory deduplication cache (60 second window)
const messageCache = new Map();
const CACHE_TTL = 60 * 1000;

function cleanCache() {
  const now = Date.now();
  for (const [messageId, timestamp] of messageCache.entries()) {
    if (now - timestamp > CACHE_TTL) messageCache.delete(messageId);
  }
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

function buildMessage(body) {
  const contact = body?.contact || {};
  const channel = body?.channel || {};
  const messageObj = body?.message?.message || {};

  const contactName = contact.firstName || contact.phone || 'Cliente';
  const channelSource = channel.source || 'whatsapp';
  const messageText = messageObj.text || '';
  const contactPhone = contact.phone || '';

  return {
    message: `[respond.io] Nuevo mensaje de ${contactName} (${contactPhone}) via ${channelSource}: "${messageText}"`,
    sessionKey: extractSessionKey(contactPhone)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Only POST supported' });
  }

  try {
    const eventType = req.body?.event_type;
    const messageId = req.body?.message?.id;

    cleanCache();

    if (eventType !== 'message.received') {
      console.log(`Ignoring event type: ${eventType}`);
      return res.status(200).json({ ok: true, message: `Ignored ${eventType}` });
    }

    const signature = req.headers['x-respond-signature'] || req.headers['x-signature'];
    if (signature && !verifySignature(req.body, signature)) {
      console.warn('Invalid signature rejected for message.received');
      return res.status(200).json({ ok: true, message: 'Invalid signature' });
    }

    if (messageId && messageCache.has(messageId)) {
      console.log(`Duplicate message ignored: ${messageId}`);
      return res.status(200).json({ ok: true, message: 'Duplicate message' });
    }

    const messageText = req.body?.message?.message?.text;
    if (!messageText || messageText.trim() === '') {
      console.log('Ignoring message without text');
      return res.status(200).json({ ok: true, message: 'No text content' });
    }

    if (messageId) messageCache.set(messageId, Date.now());

    const transformed = buildMessage(req.body);
    const forwardPayload = {
      message: transformed.message,
      sessionKey: transformed.sessionKey,
      _respondIoRaw: req.body
    };

    console.log('Forwarding hybrid webhook to OpenClaw /hooks/respond-io', {
      messageId,
      eventType,
      contactPhone: req.body?.contact?.phone || null,
      sessionKey: transformed.sessionKey
    });

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

    // Temporary outbound bridge: send confirmation back via respond.io so WhatsApp receives a reply.
    const contactIdentifier = req.body?.contact?.phone || null;
    if (contactIdentifier) {
      const sendResult = await sendRespondIoText(contactIdentifier, DEFAULT_ACK_TEXT);
      console.log('respond.io outbound result:', {
        identifier: contactIdentifier,
        ok: sendResult.ok,
        status: sendResult.status,
        body: sendResult.body
      });
    } else {
      console.log('respond.io outbound skipped: missing contact.phone');
    }

    return res.status(200).json({ ok: true, message: 'Processed successfully' });
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(200).json({ ok: true, message: 'Error handled', error: error.message });
  }
}
