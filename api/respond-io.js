// Proxy for respond.io webhooks -> Maily
// Transforms payload + forwards with auth

import crypto from 'crypto';

// Signing keys per event type
const SIGNING_KEYS = {
  'message.received': 'xWcVxZimckKg5m6zvhe3YbRm9ojtKiJ+rXQFkr6vcOA=',
  'conversation.opened': 'uX/7Eb9+INZ8eneL6KUgyvpHaSmCSGEICw8FCUETodA='
};

const MAILY_URL = 'https://maily-production.up.railway.app/hooks/respond-io';
const MAILY_TOKEN = 'O6ZfvymeUGg4PTL7K0wiWeMiHJe6STtxMioWxB5A8ck=';

function verifySignature(payload, signature, eventType) {
  if (!signature) return true;
  const key = SIGNING_KEYS[eventType];
  if (!key) return true;
  
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(JSON.stringify(payload));
  const expected = hmac.digest('base64');
  return signature === expected;
}

// Transform respond.io payload to OpenClaw format
function transformPayload(body) {
  const eventType = body?.event_type || 'unknown';
  const contact = body?.contact || {};
  const channel = body?.channel || {};
  const messageObj = body?.message?.message || {};
  
  const contactName = contact.firstName || contact.phone || 'Cliente';
  const channelSource = channel.source || 'unknown';
  const messageText = messageObj.text || '';
  
  if (eventType === 'message.received' && messageText) {
    return {
      message: `[respond.io] Mensaje de ${contactName} (${channelSource}): ${messageText}`,
      name: 'respond-io',
      metadata: {
        event_type: eventType,
        contact_id: contact.id,
        contact_phone: contact.phone,
        contact_email: contact.email,
        channel_source: channelSource,
        original_message: messageText
      }
    };
  } else if (eventType === 'conversation.opened') {
    return {
      message: `[respond.io] Nueva conversación abierta con ${contactName} (${channelSource})`,
      name: 'respond-io',
      metadata: {
        event_type: eventType,
        contact_id: contact.id,
        contact_phone: contact.phone,
        channel_source: channelSource
      }
    };
  }
  
  // Fallback for other events
  return {
    message: `[respond.io] Evento: ${eventType} de ${contactName}`,
    name: 'respond-io',
    metadata: { event_type: eventType, raw: body }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const eventType = req.body?.event_type;
    const signature = req.headers['x-respond-signature'] || req.headers['x-signature'];
    
    if (signature && !verifySignature(req.body, signature, eventType)) {
      console.warn('Invalid signature rejected for:', eventType);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Transform to OpenClaw format
    const transformedPayload = transformPayload(req.body);

    // Forward to Maily
    const response = await fetch(MAILY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(transformedPayload)
    });

    const data = await response.text();
    
    console.log('respond-io webhook forwarded:', {
      status: response.status,
      event: eventType,
      contact: req.body?.contact?.firstName,
      transformed: transformedPayload.message?.substring(0, 50)
    });

    res.status(response.status).send(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
}
