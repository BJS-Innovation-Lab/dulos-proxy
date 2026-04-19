// Proxy for respond.io webhooks -> OpenClaw
// Forwards raw webhook payload to /hooks/respond-io so OpenClaw runbook can reply back via respond.io

import crypto from 'crypto';

const SIGNING_KEY = 'eg7nijfJL1XoZUw/vQ+qS90ge+Pk8BZe77ol+INcqLI=';
const OPENCLAW_URL = 'https://maximo-production-3371.up.railway.app/hooks/respond-io';
const OPENCLAW_TOKEN = 'ooEMETzpeUwKy8DFCAg4G2q4QHFJ/jkTHo49sas7GcI=';

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

    const messageText = req.body?.message?.message?.text;
    if (!messageText || messageText.trim() === '') {
      return res.status(200).json({ ok: true, message: 'No text content' });
    }

    if (messageId) messageCache.set(messageId, Date.now());

    const response = await fetch(OPENCLAW_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENCLAW_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.text();
    console.log('OpenClaw response:', { status: response.status, body: data });

    return res.status(200).json({ ok: true, message: 'Processed successfully' });
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(200).json({ ok: true, message: 'Error handled', error: error.message });
  }
}
