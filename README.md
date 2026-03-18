# Dulos Proxy

Webhook proxy for services that don't support custom auth headers.

## Endpoints

### POST /api/respond-io
Original endpoint — forwards webhooks to Maily with Bearer auth.

### POST /api/respond-io-maily
Forwards webhooks to **Maily** with Bearer auth.

### POST /api/respond-io-maximo
Forwards webhooks to **Maximo** with Bearer auth.

**Usage in respond.io:**
```
WhatsApp Número 1 (Maily):  https://dulos-proxy.vercel.app/api/respond-io-maily
WhatsApp Número 2 (Maximo): https://dulos-proxy.vercel.app/api/respond-io-maximo
```

## Deploy

1. Connect repo to Vercel
2. Deploy
3. Use the Vercel URL in respond.io

## Adding more endpoints

Create new files in `api/` folder:
- `api/new-service.js` → `/api/new-service`
