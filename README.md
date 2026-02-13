# Polymarket Weather Bot 🌡️

Trading bot that exploits forecast edges on Polymarket temperature markets. Compares NOAA/Open-Meteo weather forecasts against market prices and places trades when it finds mispriced buckets.

## Strategy

- Fetches daily high temperature forecasts from **NOAA** and **Open-Meteo**
- Scans Polymarket for temperature prediction markets (e.g. "Will the highest temperature in Miami be between 76-77°F?")
- When forecast confidence exceeds market price by ≥15%, places a trade
- Focuses on warm, stable climates where forecasts are most accurate

### Cities (Whitelist)

| City | Tier | Position Size | Backtest Win Rate |
|------|------|--------------|-------------------|
| Miami | A | $4 | 100% |
| Atlanta | A | $3 | 100% |
| Dallas | B | $3 | 87.5% |
| Wellington | B | $2 | 75% |

Cold/volatile cities (NYC, London, Toronto, Chicago, Seoul) are excluded — backtest showed them to be unprofitable.

## Setup

```bash
npm install
cp .env.example .env  # Add your private key
```

### Environment Variables

```
PRIVATE_KEY=0x...        # Polygon wallet private key
POLY_API_KEY=...         # Polymarket API key
POLY_API_SECRET=...      # Polymarket API secret
POLY_PASSPHRASE=...      # Polymarket passphrase
```

### Requirements

- Wallet funded with **USDC.e** (bridged USDC, not native) on Polygon
- Small amount of **POL** for gas fees
- Node.js v22+

## Usage

```bash
# Run directly
node weather-bot-v2.mjs

# Run in background on VPS
nohup node weather-bot-v2.mjs >> weather-bot.log 2>&1 &
```

The bot:
- Scans every 2 minutes
- Persists state to `weather-bot-state.json` (survives restarts)
- Prevents duplicate trades on the same market
- Logs forecasts to `forecast-log.jsonl` for accuracy analysis
- Auto-discovers new cities on Polymarket daily
- Max budget: $50, max 10 concurrent positions

## Deployment

Code is deployed to VPS via `scp` (no git on VPS):

```bash
scp weather-bot-v2.mjs root@<VPS_IP>:/root/polymarket-bot/
```

## Files

| File | Description |
|------|-------------|
| `weather-bot-v2.mjs` | **Main bot** — current production version |
| `weather-bot-state.json` | Persistent state (positions, trades, budget) |
| `forecast-log.jsonl` | Forecast accuracy log (JSON-lines) |
| `backtest/` | Historical backtest data and analysis |
| `bot.mjs` | Legacy v1 bot (deprecated) |
| `scan.mjs` | Market scanner utility |
| `discover-weather-markets.mjs` | Market discovery tool |

## Backtest Results

8-day backtest (Feb 3-10, 2026):
- **Overall**: 58.7% win rate, +15.2% ROI
- **Whitelist only (projected)**: 85-90% win rate, +600-800% annual ROI
- See `backtest/EXECUTIVE-SUMMARY.md` for details

## Key Learnings

- Polymarket uses **USDC.e** (bridged), not native USDC
- Warm stable climates = profitable, cold winters = money pit
- Wide temperature buckets ("X°F or higher") are easier to predict than narrow ones (1°F precision)
- Market makers are fast — no arb opportunities on crypto up/down markets

## License

Private — not for distribution.
