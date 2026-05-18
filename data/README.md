# Market History Lab Data Format

Real options backtesting ke liye CSV format:

```csv
date,time,underlying,expiry,strike,type,open,high,low,close,volume
2026-05-11,09:15,NIFTY,2026-05-14,22400,CE,142,151,136,148,245000
```

Required columns:

- `date`: `YYYY-MM-DD`
- `time`: `HH:MM`
- `underlying`: `NIFTY`, `BANKNIFTY`, etc.
- `expiry`: `YYYY-MM-DD`
- `strike`: option strike
- `type`: `CE` or `PE`
- `open`, `high`, `low`, `close`: option premium candle

Backend routes:

- `GET /api/health`
- `GET /api/sample-csv`
- `GET /api/datasets`
- `POST /api/import-csv`
- `POST /api/backtest`

This engine runs on real imported option premium candles. For "starting se aaj tak" backtests, import a full-history dataset with the same schema and keep adding new candles daily/monthly.

NSE F&O bhavcopy CSV is also supported. You can import modern NSE FO bhavcopy files with columns like:

- `TradDt` / `TckrSymb` / `XpryDt` / `StrkPric` / `OptnTp`
- `OpnPric` / `HghPric` / `LwPric` / `ClsPric`

Or older NSE files with:

- `INSTRUMENT` / `SYMBOL` / `EXPIRY_DT` / `STRIKE_PR` / `OPTION_TYP`
- `OPEN` / `HIGH` / `LOW` / `CLOSE` / `TIMESTAMP`

Helper downloader:

```powershell
.\tools\download-nse-fo-bhavcopy.ps1 -From 2026-05-01 -To 2026-05-17
```

It creates a combined CSV in `data\nse-bhavcopy\...csv`, which can be imported from the website Data tab.

Recommended dataset scope:

- NIFTY, BANKNIFTY, FINNIFTY, SENSEX
- All weekly/monthly expiries
- All liquid strikes around ATM and far OTM range
- 1-minute or 5-minute OHLC option premiums
- Corporate/calendar metadata where applicable
- Brokerage, slippage, lot size and expiry calendar settings

API-provider integration can be added after getting licensed historical options data access.
