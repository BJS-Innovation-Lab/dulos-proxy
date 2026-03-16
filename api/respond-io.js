// Proxy for respond.io webhooks -> Maily
// Transforms payload + forwards with auth

import crypto from 'crypto';

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

// Transform respond.io payload to simple OpenClaw format
function transformPayload(body) {
  const eventType = body?.event_type || 'unknown';
  const contact = body?.contact || {};
  const channel = body?.channel || {};
  const messageObj = body?.message?.message || {};
  
  const contactName = contact.firstName || contact.phone || 'Cliente';
  const channelSource = channel.source || 'desconocido';
  const messageText = messageObj.text || '';
  const contactPhone = contact.phone || '';
  
  let message = '';
  
  if (eventType === 'message.received' && messageText) {
    message = `[respond.io] Nuevo mensaje de ${contactName} (${contactPhone}) via ${channelSource}: "${messageText}"`;
  } else if (eventType === 'conversation.opened') {
    message = `[respond.io] Nueva conversación abierta con ${contactName} (${contactPhone}) via ${channelSource}`;
  } else {
    message = `[respond.io] Evento ${eventType} de ${contactName}`;
  }
  
  // Only send message and name - minimal payload
  return { message, name: 'respond-io' };
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

    // Transform to simple OpenClaw format
    const transformedPayload = transformPayload(req.body);
    
    console.log('Sending to Maily:', JSON.stringify(transformedPayload));

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
    
    console.log('Maily response:', { status: response.status, body: data });

    res.status(response.status).send(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
}
