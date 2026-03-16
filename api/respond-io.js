// Proxy for respond.io webhooks -> Maily
// Public endpoint that forwards with auth

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch('https://maily-production.up.railway.app/hooks/respond-io', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer O6ZfvymeUGg4PTL7K0wiWeMiHJe6STtxMioWxB5A8ck=',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.text();
    
    // Log for debugging
    console.log('respond-io webhook forwarded:', {
      status: response.status,
      bodyLength: data.length
    });

    res.status(response.status).send(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
}
