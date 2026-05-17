# Market History Lab Full Backend Deploy

Use this when you want login, live paper feed, CSV import and backtest APIs to work online.

## Best simple hosting

Deploy the full project as a Node.js web service on Render/Railway/VPS. Do not use Netlify Drop for the full engine because Netlify Drop only hosts static files.

## Render steps

1. Create a GitHub repository and upload this full project folder.
2. Go to Render and create a new **Web Service** from that GitHub repository.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Node version: 20 or higher
4. Add a persistent disk:
   - Mount path: `/var/data`
   - Size: `1 GB` or higher
5. Add environment variable:
   - `DATA_DIR=/var/data`
6. Deploy.

The same Render URL will serve:

- Website: `/`
- Login APIs: `/api/auth/register`, `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`
- Live paper feed: `/api/live/quote`, `/api/live/chain`
- Data import/backtest: `/api/import-csv`, `/api/backtest`

## Real live market feed later

The app currently has demo-live paper feed. To connect an external live quote provider, set:

- `LIVE_QUOTE_URL`
- Optional: `LIVE_QUOTE_AUTH_HEADER`

The URL can contain `{underlying}` or `{symbol}` placeholders.

Example:

```text
LIVE_QUOTE_URL=https://your-provider.example/quote?symbol={underlying}
LIVE_QUOTE_AUTH_HEADER=Authorization: Bearer YOUR_TOKEN
```

## Broker connect

Broker connect is available for paper/live-data mode. Real order placement is intentionally disabled until risk confirmations and compliance checks are added.

For Upstox OAuth, add these environment variables:

```text
UPSTOX_CLIENT_ID=your_upstox_api_key
UPSTOX_CLIENT_SECRET=your_upstox_api_secret
UPSTOX_REDIRECT_URI=https://your-render-url.onrender.com/api/broker/upstox/callback
```

For Dhan, users can paste a token in the Broker tab. For server-level setup, add:

```text
DHAN_CLIENT_ID=your_dhan_client_id
DHAN_ACCESS_TOKEN=your_dhan_access_token
```

## Local testing

```powershell
.\RUN-FULL-ENGINE.bat
```

Then open:

```text
http://127.0.0.1:5177/
```
