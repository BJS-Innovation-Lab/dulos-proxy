# Dulos Proxy

Webhook proxy for services that don't support custom auth headers.

## Endpoints

### POST /api/respond-io
Forwards webhooks to Maily with Bearer auth.

**Usage:**
```
respond.io webhook URL: https://dulos-proxy.vercel.app/api/respond-io
```

## Deploy

1. Connect repo to Vercel
2. Deploy
3. Use the Vercel URL in respond.io

## Adding more endpoints

Create new files in `api/` folder:
- `api/new-service.js` → `/api/new-service`
