# Weather Trading Bot for Polymarket

## Strategy

Exploit informational edge between professional weather forecasts (NOAA, Open-Meteo) and Polymarket weather market prices.

### How It Works

1. **Market Discovery** - Scans Polymarket every 2 minutes for active weather markets
2. **Forecast Fetching** - Gets authoritative weather data:
   - US cities: NOAA Weather API (api.weather.gov)
   - International: Open-Meteo API
3. **Edge Calculation** - Compares forecast probability vs market price
4. **Risk-Managed Trading** - Conservative position sizing and limits

### Risk Management

- **Max Position Size**: $2 per market
- **Max Open Positions**: 5 concurrent
- **Min Edge Threshold**: 15%
- **Total Budget**: ~$80 available

## Setup

Already configured! Your wallet and environment are ready.

## Usage

### Start the bot (simulation mode):
```bash
cd /Users/tobi/code/polymarket-bot
node weather-bot.mjs
```

### Discover current weather markets:
```bash
node discover-weather-markets.mjs
```

### View logs:
```bash
tail -f weather-bot.log
```

### Enable real trading:
Edit `weather-bot.mjs` and uncomment the trading execution code in the `executeTrade()` function (line ~286).

## Supported Cities

Currently monitoring:
- **US**: NYC, Chicago, Los Angeles, Miami, Boston, Washington DC
- **International**: London, Paris

Add more cities by editing the `CITY_COORDS` object in `weather-bot.mjs`.

## Market Types

The bot can handle markets like:
- "Will NYC high temperature exceed 50°F tomorrow?"
- "London temperature above 15°C on Feb 15?"
- "Will it snow in Chicago this weekend?"

## Current Status

⚠️ **No active weather markets found as of Feb 2026**

The bot is ready and will automatically detect and analyze weather markets when they appear on Polymarket.

## Logs

All decisions are logged to `weather-bot.log` with reasoning:
```
[2026-02-09T12:00:00Z] 🔍 Analyzing: Will NYC high exceed 45°F?
[2026-02-09T12:00:00Z]    NOAA says: 50°F high
[2026-02-09T12:00:00Z]    Market says: 30% YES
[2026-02-09T12:00:00Z]    Edge: 70% (NOAA confidence ~100%, market at 30%)
[2026-02-09T12:00:00Z]    💸 EXECUTING: BUY 6.67 shares @ $0.300
```

## Architecture

- **weather-bot.mjs** - Main bot loop
- **discover-weather-markets.mjs** - Standalone market scanner
- **weather-bot.log** - Decision log
- **.env** - Private key (DO NOT COMMIT)

## Next Steps

1. Run discovery script to see if weather markets exist
2. If found, let bot observe for a few cycles
3. Review logs to understand market structure
4. Refine `calculateEdge()` function for specific market types
5. When confident, enable real trading

## Safety Notes

- Bot starts in **SIMULATION MODE** - no real trades
- Private key only in `.env`, never logged
- Max loss capped at $10 (5 positions × $2)
- All actions logged for review
- Stop anytime with Ctrl+C

## Improvements Needed

The `calculateEdge()` function currently returns `null` because each weather market type needs custom logic:

1. **Binary temperature thresholds** - "Above/Below X°F"
2. **Temperature ranges** - "Between 40-50°F"
3. **Weather conditions** - "Will it rain/snow?"
4. **Timing windows** - "Tomorrow" vs "This Week"

Once we see actual market structures, implement specific logic for each type.
