// Proxy for respond.io webhooks -> Maily
// Validates signature + forwards with auth

import crypto from 'crypto';

const SIGNING_KEY = 'xWcVxZimckKg5m6zvhe3YbRm9ojtKiJ+rXQFkr6vcOA=';
const MAILY_URL = 'https://maily-production.up.railway.app/hooks/respond-io';
const MAILY_TOKEN = 'O6ZfvymeUGg4PTL7K0wiWeMiHJe6STtxMioWxB5A8ck=';

function verifySignature(payload, signature) {
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', SIGNING_KEY);
  hmac.update(JSON.stringify(payload));
  const expected = hmac.digest('base64');
  return signature === expected;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify signature (optional - comment out if respond.io doesn't send it)
    const signature = req.headers['x-respond-signature'] || req.headers['x-signature'];
    if (signature && !verifySignature(req.body, signature)) {
      console.warn('Invalid signature rejected');
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
      event: req.body?.event_type,
      contact: req.body?.contact?.firstName
    });

    res.status(response.status).send(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
}
