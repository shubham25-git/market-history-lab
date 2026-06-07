# Real Market Setup

Market History Lab ab generic licensed market-data API se quote aur option-chain
read kar sakta hai. Demo feed tab tak fallback rahega jab tak provider configure
nahi hota.

## Render Environment Variables

Required:

```text
LIVE_DATA_PROVIDER=provider-name
LIVE_QUOTE_URL=https://provider.example/quote?symbol={symbol}
LIVE_CHAIN_URL=https://provider.example/option-chain?symbol={symbol}
```

Authentication me provider ke hisab se inme se jo zaruri ho use karo:

```text
LIVE_API_KEY=your-api-key
LIVE_API_TOKEN=your-bearer-token
LIVE_AUTH_HEADER=Authorization: Bearer your-token
LIVE_QUOTE_AUTH_HEADER=X-Custom-Header: value
LIVE_CHAIN_AUTH_HEADER=X-Custom-Header: value
LIVE_REFRESH_SECONDS=5
```

Secret keys ko GitHub files me kabhi mat likhna. Sirf Render ke Environment
section me save karna.

URL templates me `{underlying}`, `{symbol}` aur `{label}` supported hain.

## Accepted Quote Response

Connector nested `data`, `quote`, `result` ya `payload` object bhi read karta hai.

```json
{
  "data": {
    "ltp": 22450.25,
    "change": 82.4,
    "changePct": 0.37,
    "timestamp": "2026-06-07T09:30:00+05:30"
  }
}
```

Price field `ltp`, `last_price`, `lastPrice`, `price` ya `close` ho sakta hai.

## Accepted Option Chain Response

```json
{
  "rows": [
    {
      "strike": 22450,
      "CE": {
        "ltp": 128.5,
        "iv": 14.2,
        "oi": 120000,
        "volume": 45000,
        "bid": 128.2,
        "ask": 128.8
      },
      "PE": {
        "ltp": 119.3,
        "iv": 14.7,
        "oi": 135000,
        "volume": 51000,
        "bid": 119.0,
        "ask": 119.6
      }
    }
  ]
}
```

## Test URLs

Deploy complete hone ke baad:

```text
https://market-history-lab.onrender.com/api/live/status
https://market-history-lab.onrender.com/api/live/test?underlying=NIFTY
https://market-history-lab.onrender.com/api/live/quote?underlying=NIFTY
https://market-history-lab.onrender.com/api/live/chain?underlying=NIFTY
```

`quoteOk: true` aur `chainOk: true` aane par external market feed parse ho rahi
hai. Real exchange data ko public product me use karne se pehle provider ki
license, redistribution aur display conditions check karna zaruri hai.
