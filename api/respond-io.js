// Proxy for respond.io webhooks -> Maily
// Validates signature + forwards with auth

import crypto from 'crypto';

// Signing keys per event type
const SIGNING_KEYS = {
  'message.received': 'xWcVxZimckKg5m6zvhe3YbRm9ojtKiJ+rXQFkr6vcOA=',
  'conversation.opened': 'uX/7Eb9+INZ8eneL6KUgyvpHaSmCSGEICw8FCUETodA='
};

const MAILY_URL = 'https://maily-production.up.railway.app/hooks/respond-io';
const MAILY_TOKEN = 'O6ZfvymeUGg4PTL7K0wiWeMiHJe6STtxMioWxB5A8ck=';

function verifySignature(payload, signature, eventType) {
  if (!signature) return true; // Skip if no signature header
  const key = SIGNING_KEYS[eventType];
  if (!key) return true; // Skip unknown event types
  
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(JSON.stringify(payload));
  const expected = hmac.digest('base64');
  return signature === expected;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const eventType = req.body?.event_type;
    const signature = req.headers['x-respond-signature'] || req.headers['x-signature'];
    
    // Verify signature if present
    if (signature && !verifySignature(req.body, signature, eventType)) {
      console.warn('Invalid signature rejected for:', eventType);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Forward to Maily
    const response = await fetch(MAILY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.text();
    
    console.log('respond-io webhook forwarded:', {
      status: response.status,
      event: eventType,
      contact: req.body?.contact?.firstName
    });

    res.status(response.status).send(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
}
