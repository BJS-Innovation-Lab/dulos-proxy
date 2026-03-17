// Proxy for respond.io webhooks -> OpenClaw
// Only processes message.received events with persistent sessions

import crypto from 'crypto';

const SIGNING_KEY = 'B3u5qRyRw9FFeWJ65fVAgC7OVWca80Eggt4XIPHbv/Q=';
const OPENCLAW_URL = 'https://maily-production.up.railway.app/hooks/agent';
const OPENCLAW_TOKEN = 'O6ZfvymeUGg4PTL7K0wiWeMiHJe6STtxMioWxB5A8ck=';

// In-memory deduplication cache (60 second window)
const messageCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

function cleanCache() {
  const now = Date.now();
  for (const [messageId, timestamp] of messageCache.entries()) {
    if (now - timestamp > CACHE_TTL) {
      messageCache.delete(messageId);
    }
  }
}

function verifySignature(payload, signature) {
  if (!signature) return true;
  
  const hmac = crypto.createHmac('sha256', SIGNING_KEY);
  hmac.update(JSON.stringify(payload));
  const expected = hmac.digest('base64');
  return signature === expected;
}

function extractSessionKey(phone) {
  if (!phone) return null;
  
  // Remove + prefix and any non-numeric characters
  const cleanPhone = phone.replace(/^\+/, '').replace(/\D/g, '');
  return cleanPhone ? `hook:whatsapp:${cleanPhone}` : null;
}

function transformPayload(body) {
  const contact = body?.contact || {};
  const channel = body?.channel || {};
  const messageObj = body?.message?.message || {};
  
  const contactName = contact.firstName || contact.phone || 'Cliente';
  const channelSource = channel.source || 'whatsapp';
  const messageText = messageObj.text || '';
  const contactPhone = contact.phone || '';
  
  const message = `[respond.io] Nuevo mensaje de ${contactName} (${contactPhone}) via ${channelSource}: "${messageText}"`;
  const sessionKey = extractSessionKey(contactPhone);
  
  return { message, sessionKey };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Only POST supported' });
  }

  try {
    const eventType = req.body?.event_type;
    const messageId = req.body?.message?.id;
    
    // Clean old cache entries periodically
    cleanCache();
    
    // Only process message.received events
    if (eventType !== 'message.received') {
      console.log(`Ignoring event type: ${eventType}`);
      return res.status(200).json({ ok: true, message: `Ignored ${eventType}` });
    }
    
    // Verify signature
    const signature = req.headers['x-respond-signature'] || req.headers['x-signature'];
    if (signature && !verifySignature(req.body, signature)) {
      console.warn('Invalid signature rejected for message.received');
      return res.status(200).json({ ok: true, message: 'Invalid signature' });
    }
    
    // Check for duplicate messageId
    if (messageId && messageCache.has(messageId)) {
      console.log(`Duplicate message ignored: ${messageId}`);
      return res.status(200).json({ ok: true, message: 'Duplicate message' });
    }
    
    // Extract and validate message text
    const messageText = req.body?.message?.message?.text;
    if (!messageText || messageText.trim() === '') {
      console.log('Ignoring message without text');
      return res.status(200).json({ ok: true, message: 'No text content' });
    }
    
    // Add to dedup cache
    if (messageId) {
      messageCache.set(messageId, Date.now());
    }
    
    // Transform payload
    const transformedPayload = transformPayload(req.body);
    
    if (!transformedPayload.sessionKey) {
      console.warn('No valid phone number found, cannot create sessionKey');
      return res.status(200).json({ ok: true, message: 'No valid phone number' });
    }
    
    console.log('Sending to OpenClaw:', JSON.stringify(transformedPayload));

    // Forward to OpenClaw
    const response = await fetch(OPENCLAW_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(transformedPayload)
    });

    const data = await response.text();
    
    console.log('OpenClaw response:', { status: response.status, body: data });

    // Always return 200 to prevent retries
    return res.status(200).json({ ok: true, message: 'Processed successfully' });
    
  } catch (error) {
    console.error('Proxy error:', error);
    // Still return 200 to prevent retries
    return res.status(200).json({ ok: true, message: 'Error handled', error: error.message });
  }
}