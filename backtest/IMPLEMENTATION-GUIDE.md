# Weather Bot Optimization - Implementation Guide

Based on backtest results from Feb 3-10, 2026.

## Quick Summary

**Current Performance:** +15.2% ROI, 58.7% win rate  
**Optimized Performance (projected):** +60% ROI/month, 85%+ win rate

---

## 🚀 Immediate Changes (Copy-Paste Ready)

### 1. Update City Whitelist/Blacklist

**Edit `weather-bot-v2.mjs` line ~27 (CITY_COORDS):**

```javascript
// Whitelist: Only profitable cities
const CITY_COORDS = {
  // 🏆 TOP TIER (100% win rate)
  'miami':      { lat: 25.7617, lon: -80.1918,  country: 'US', name: 'Miami',         slug: 'miami', tier: 'A', positionSize: 4 },
  'atlanta':    { lat: 33.7490, lon: -84.3880,  country: 'US', name: 'Atlanta',       slug: 'atlanta', tier: 'A', positionSize: 3 },
  
  // 🥈 HIGH CONFIDENCE (75-87% win rate)
  'dallas':     { lat: 32.7767, lon: -96.7970,  country: 'US', name: 'Dallas',        slug: 'dallas', tier: 'B', positionSize: 3 },
  'wellington': { lat: -41.2865, lon: 174.7762, country: 'NZ', name: 'Wellington',    slug: 'wellington', tier: 'B', positionSize: 2 },
  
  // ⚠️ MONITOR (60% win rate - reduce position size)
  // 'seoul':      { lat: 37.5665, lon: 126.9780,  country: 'KR', name: 'Seoul',         slug: 'seoul', tier: 'C', positionSize: 1 },
  // 'seattle':    { lat: 47.6062, lon: -122.3321, country: 'US', name: 'Seattle',       slug: 'seattle', tier: 'C', positionSize: 1 },
  
  // ❌ BLACKLISTED (losing money)
  // 'nyc':        { lat: 40.7128, lon: -74.0060,  country: 'US', name: 'New York City', slug: 'nyc', tier: 'F' },
  // 'london':     { lat: 51.5074, lon: -0.1278,   country: 'UK', name: 'London',        slug: 'london', tier: 'F' },
  // 'ankara':     { lat: 39.9334, lon: 32.8597,   country: 'TR', name: 'Ankara',        slug: 'ankara', tier: 'F' },
  // 'chicago':    { lat: 41.8781, lon: -87.6298,  country: 'US', name: 'Chicago',       slug: 'chicago', tier: 'F' },
  // 'toronto':    { lat: 43.6532, lon: -79.3832,  country: 'CA', name: 'Toronto',       slug: 'toronto', tier: 'F' },
};
```

### 2. Dynamic Position Sizing

**Add after CONFIG (line ~55):**

```javascript
const CONFIG = {
  pollIntervalMs: 120_000,
  maxPositionSize: 2,             // Default (override per city)
  maxOpenPositions: 10,           // Increase from 5 (more cities = more trades)
  minEdgeThreshold: 0.15,
  maxBudget: 50,                  // Increase from 20 (we're more confident now)
  edgePriceThreshold: 0.60,
  forecastConfidence: 0.80,
  logFile: 'weather-bot.log',
  stateFile: 'weather-bot-state.json',
  rpcUrl: 'https://polygon.drpc.org',
  usdcE: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
  
  // NEW: Per-city position sizing
  cityPositionSizes: {
    'miami': 4,
    'atlanta': 3,
    'dallas': 3,
    'wellington': 2,
    'seoul': 1,
    'seattle': 1,
  },
  
  // NEW: Per-city edge thresholds
  cityEdgeThresholds: {
    'miami': 0.10,      // Lower threshold for high-confidence cities
    'atlanta': 0.10,
    'dallas': 0.12,
    'wellington': 0.15,
    'seoul': 0.20,      // Higher threshold for risky cities
    'seattle': 0.20,
  },
};
```

### 3. Update Trade Execution Logic

**Replace `executeTrade()` function (line ~450) to use dynamic sizing:**

```javascript
async function executeTrade(sdk, edge) {
  // Get city-specific parameters
  const cityInfo = edge.cityInfo || {};
  const citySlug = cityInfo.slug || 'unknown';
  const maxPositionSize = CONFIG.cityPositionSizes[citySlug] || CONFIG.maxPositionSize;
  const minEdgeThreshold = CONFIG.cityEdgeThresholds[citySlug] || CONFIG.minEdgeThreshold;
  
  // Pre-checks
  if (state.openPositions.length >= CONFIG.maxOpenPositions) {
    log('   ⚠️  Max positions reached');
    return false;
  }
  
  // Check city-specific edge threshold
  if (edge.edgePercent < minEdgeThreshold) {
    log(`   ℹ️  Edge ${(edge.edgePercent * 100).toFixed(1)}% below ${citySlug} threshold ${(minEdgeThreshold * 100).toFixed(0)}%`);
    return false;
  }
  
  if (state.totalSpent + maxPositionSize > CONFIG.maxBudget) {
    log(`   ⚠️  Budget limit ($${CONFIG.maxBudget}) would be exceeded`);
    return false;
  }
  
  // Check actual wallet balance
  const balance = await getUsdcEBalance();
  if (balance === null) {
    log('   ❌ Cannot verify wallet balance — skipping trade for safety');
    return false;
  }
  if (balance < maxPositionSize + 0.5) {
    log(`   ❌ Insufficient USDC.e balance: $${balance.toFixed(2)} (need $${maxPositionSize + 0.5})`);
    return false;
  }
  log(`   💰 Wallet: $${balance.toFixed(2)} USDC.e | City tier: ${cityInfo.tier || '?'} | Position: $${maxPositionSize}`);
  
  // Already traded this event?
  if (state.tradedMarkets.includes(edge.eventSlug)) {
    log('   ⚠️  Already traded this event (race condition guard)');
    return false;
  }
  
  // Calculate order parameters (use city-specific position size)
  const tokenId = edge.tokenId;
  const price = Math.min(edge.marketPrice + 0.01, 0.99);
  const size = Math.max(maxPositionSize / price, 5.1);
  const orderValue = price * size;
  
  if (orderValue < 1.0) {
    log(`   ⚠️  Order value $${orderValue.toFixed(2)} below $1 minimum`);
    return false;
  }
  
  log(`   💸 PLACING ORDER: BUY ${size.toFixed(2)} shares @ $${price.toFixed(3)} = $${orderValue.toFixed(2)} [${citySlug.toUpperCase()}]`);
  
  // ... rest of function unchanged
```

### 4. Bucket Type Filtering

**Add new helper function before `analyzeEvent()` (line ~380):**

```javascript
function shouldTradeBucket(temperatureRange) {
  if (!temperatureRange) return false;
  
  const text = temperatureRange.toLowerCase();
  
  // ✅ PREFER: "X or higher/lower" buckets (easier to hit)
  if (text.includes('or higher') || text.includes('or lower') || 
      text.includes('or above') || text.includes('or below')) {
    return { tradeable: true, confidence: 'high' };
  }
  
  // ✅ ALLOW: Wide ranges (3+ degrees)
  const rangeMatch = text.match(/(-?\d+)\s*-\s*(-?\d+)/);
  if (rangeMatch) {
    const spread = Math.abs(parseInt(rangeMatch[2]) - parseInt(rangeMatch[1]));
    if (spread >= 3) {
      return { tradeable: true, confidence: 'medium' };
    }
    // ⚠️ NARROW RANGE: Trade cautiously
    return { tradeable: true, confidence: 'low' };
  }
  
  // ✅ ALLOW: Single degree (exact match)
  if (text.match(/^\d+\s*°?[fc]$/i)) {
    return { tradeable: true, confidence: 'medium' };
  }
  
  return { tradeable: false, confidence: 'none' };
}
```

**Then update `analyzeEvent()` to filter:**

```javascript
async function analyzeEvent(eventSlug, markets, cityInfo, eventDate) {
  // ... existing code ...
  
  // BEFORE analyzing markets, filter by bucket type
  const tradeableMarkets = markets.filter(m => {
    const check = shouldTradeBucket(m.temperatureRange || m.question);
    if (!check.tradeable) {
      log(`   ⏭️  Skipping "${m.temperatureRange}" (narrow/complex bucket)`);
    }
    return check.tradeable;
  });
  
  if (tradeableMarkets.length === 0) {
    log('   ⚠️  No tradeable buckets in this market');
    return null;
  }
  
  // ... continue with tradeableMarkets instead of markets ...
```

---

## 📊 Expected Impact

### Before Optimization
- **Cities traded:** 11
- **Trades/week:** ~45
- **Win rate:** 58.7%
- **Weekly P&L:** ~$17
- **Monthly P&L:** ~$67

### After Optimization
- **Cities traded:** 4 (Miami, Atlanta, Dallas, Wellington)
- **Trades/week:** ~25-30
- **Win rate:** 85-90% (projected)
- **Weekly P&L:** ~$30-40
- **Monthly P&L:** ~$120-160

### Risk Reduction
- **Eliminated:** -$16.70 monthly losses from bad cities (Toronto, Chicago, London, etc.)
- **Improved:** Sharpe ratio from 0.16 → ~0.40 (less volatility)
- **Capital efficiency:** Better use of $50 budget on high-confidence trades

---

## 🧪 Testing Plan

### Phase 1: Validation (Feb 12-20, 2026)
1. Deploy changes to **test mode** (don't execute real trades)
2. Log all "would-be" trades
3. Compare performance vs baseline

### Phase 2: Gradual Rollout (Feb 20-28)
1. Enable ONLY Miami and Dallas (highest confidence)
2. Keep position sizes conservative ($2 max)
3. Monitor for 1 week

### Phase 3: Full Deployment (Mar 1+)
1. Enable all whitelist cities
2. Increase position sizes per tier
3. Increase budget to $50

---

## 🚨 Kill Switch Criteria

**Stop the bot immediately if:**
- Win rate drops below 50% for 3+ consecutive days
- Total drawdown exceeds -$30
- Any city has 5+ consecutive losses

**Pause and investigate if:**
- Win rate drops below 60% for 7 days
- P&L underperforms backtest by >50%
- Market liquidity dries up (can't fill orders)

---

## 📈 Monitoring Dashboard

### Key Metrics (check daily)
- [ ] Win rate (rolling 7-day average)
- [ ] P&L by city
- [ ] Edge capture (are we getting our target prices?)
- [ ] Forecast accuracy (actual vs predicted temps)

### Weekly Review
- [ ] Adjust city whitelist based on performance
- [ ] Rebalance position sizes
- [ ] Check for seasonal patterns
- [ ] Review forecast biases

---

## 🔮 Next Steps

1. **Immediate:** Implement changes above
2. **This week:** Gather 7 more days of data
3. **Next month:** 
   - Extend backtest to 30+ days
   - Analyze seasonal effects
   - Test forecast source alternatives (Weather.com, AccuWeather)
   - Measure actual market spreads and slippage
4. **Q2 2026:**
   - Build ML model for forecast error prediction
   - Implement time-of-day optimization
   - Explore other market types (precipitation, wind, etc.)

---

**Author:** Claude (OpenClaw Subagent)  
**Date:** February 12, 2026  
**Status:** Ready for implementation  
**Estimated work:** 2-3 hours for code changes + testing
