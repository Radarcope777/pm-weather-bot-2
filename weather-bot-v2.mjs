import 'dotenv/config';
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
import { writeFileSync, readFileSync, appendFileSync, existsSync } from 'fs';
import { ethers } from 'ethers';

/**
 * Weather Trading Bot v2.5 for Polymarket
 * ========================================
 * v2.5 improvements:
 * 1. GFS timing optimization (trade 2-4h after GFS runs for fresh data)
 * 2. Multi-source forecast consensus (NOAA + Open-Meteo for all cities)
 * 3. Dynamic exit / sell positions when forecast shifts
 * 4. Better bucket selection (prefer wider buckets)
 * 5. Auto-reload budget from actual wallet balance
 */

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════

const CONFIG = {
  pollIntervalMs: 120_000,        // 2 minutes between scans
  maxPositionSize: 3,             // Default $3 per position (overridden by city posSize)
  maxOpenPositions: 10,           // Max concurrent positions
  minEdgeThreshold: 0.15,         // 15% minimum edge (normal)
  minEdgeThresholdHigh: 0.25,     // 25% edge outside GFS window
  minEdgeThresholdLow: 0.10,      // 10% edge for very high confidence consensus
  maxBudget: 50,                  // Total max spend in USDC (legacy, now uses wallet balance)
  edgePriceThreshold: 0.60,       // Only buy below this price
  forecastConfidence: 0.80,       // Assumed forecast accuracy
  walletReserve: 2.0,             // Keep $2 reserve for gas
  logFile: 'weather-bot.log',
  stateFile: 'weather-bot-state.json',
  forecastLogFile: 'forecast-log.jsonl',
  rpcUrl: 'https://polygon.drpc.org',
  usdcE: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
};

// Known city coordinates for weather API
const CITY_COORDS = {
  'miami':      { lat: 25.7617, lon: -80.1918,  country: 'US', name: 'Miami',      slug: 'miami',      posSize: 4, tier: 'A' },
  'atlanta':    { lat: 33.7490, lon: -84.3880,  country: 'US', name: 'Atlanta',    slug: 'atlanta',    posSize: 3, tier: 'A' },
  'dallas':     { lat: 32.7767, lon: -96.7970,  country: 'US', name: 'Dallas',     slug: 'dallas',     posSize: 3, tier: 'B' },
  'wellington': { lat: -41.2865, lon: 174.7762, country: 'NZ', name: 'Wellington', slug: 'wellington', posSize: 2, tier: 'B' },
};

// Candidate cities to probe during auto-discovery
const CANDIDATE_CITIES = [
  { slug: 'tokyo',          lat: 35.6762, lon: 139.6503, country: 'JP', name: 'Tokyo' },
  { slug: 'paris',          lat: 48.8566, lon: 2.3522,   country: 'FR', name: 'Paris' },
  { slug: 'berlin',         lat: 52.5200, lon: 13.4050,  country: 'DE', name: 'Berlin' },
  { slug: 'sydney',         lat: -33.8688, lon: 151.2093, country: 'AU', name: 'Sydney' },
  { slug: 'mumbai',         lat: 19.0760, lon: 72.8777,  country: 'IN', name: 'Mumbai' },
  { slug: 'dubai',          lat: 25.2048, lon: 55.2708,  country: 'AE', name: 'Dubai' },
  { slug: 'singapore',      lat: 1.3521,  lon: 103.8198, country: 'SG', name: 'Singapore' },
  { slug: 'cairo',          lat: 30.0444, lon: 31.2357,  country: 'EG', name: 'Cairo' },
  { slug: 'beijing',        lat: 39.9042, lon: 116.4074, country: 'CN', name: 'Beijing' },
  { slug: 'mexico-city',    lat: 19.4326, lon: -99.1332, country: 'MX', name: 'Mexico City' },
  { slug: 'bangkok',        lat: 13.7563, lon: 100.5018, country: 'TH', name: 'Bangkok' },
  { slug: 'hong-kong',      lat: 22.3193, lon: 114.1694, country: 'HK', name: 'Hong Kong' },
  { slug: 'los-angeles',    lat: 34.0522, lon: -118.2437, country: 'US', name: 'Los Angeles' },
  { slug: 'san-francisco',  lat: 37.7749, lon: -122.4194, country: 'US', name: 'San Francisco' },
  { slug: 'denver',         lat: 39.7392, lon: -104.9903, country: 'US', name: 'Denver' },
  { slug: 'phoenix',        lat: 33.4484, lon: -112.0740, country: 'US', name: 'Phoenix' },
  { slug: 'houston',        lat: 29.7604, lon: -95.3698, country: 'US', name: 'Houston' },
  { slug: 'boston',          lat: 42.3601, lon: -71.0589, country: 'US', name: 'Boston' },
  { slug: 'washington-dc',  lat: 38.9072, lon: -77.0369, country: 'US', name: 'Washington DC' },
  { slug: 'austin',         lat: 30.2672, lon: -97.7431, country: 'US', name: 'Austin' },
  { slug: 'las-vegas',      lat: 36.1699, lon: -115.1398, country: 'US', name: 'Las Vegas' },
  { slug: 'minneapolis',    lat: 44.9778, lon: -93.2650, country: 'US', name: 'Minneapolis' },
  { slug: 'detroit',        lat: 42.3314, lon: -83.0458, country: 'US', name: 'Detroit' },
  { slug: 'new-orleans',    lat: 29.9511, lon: -90.0715, country: 'US', name: 'New Orleans' },
  { slug: 'nashville',      lat: 36.1627, lon: -86.7816, country: 'US', name: 'Nashville' },
  { slug: 'portland',       lat: 45.5152, lon: -122.6784, country: 'US', name: 'Portland' },
  { slug: 'salt-lake-city', lat: 40.7608, lon: -111.8910, country: 'US', name: 'Salt Lake City' },
  { slug: 'honolulu',       lat: 21.3069, lon: -157.8583, country: 'US', name: 'Honolulu' },
  { slug: 'philadelphia',   lat: 39.9526, lon: -75.1652, country: 'US', name: 'Philadelphia' },
  { slug: 'san-diego',      lat: 32.7157, lon: -117.1611, country: 'US', name: 'San Diego' },
];

// ═══════════════════════════════════════════════════
// STATE MANAGEMENT (persisted to disk)
// ═══════════════════════════════════════════════════

let state = {
  openPositions: [],     // { market, tokenId, orderId, shares, entryPrice, timestamp, eventSlug }
  tradedMarkets: [],     // eventSlugs we've already traded (prevent duplicates)
  totalSpent: 0,
  tradesExecuted: 0,
  stats: { scans: 0, marketsFound: 0, edgesIdentified: 0, errors: 0 },
  lastScan: null,
  pnl: {
    totalWins: 0,
    totalLosses: 0,
    winCount: 0,
    lossCount: 0,
    totalPayout: 0,
    totalCost: 0,
    netPnL: 0,
    walletBalance: null,
    lastUpdated: null,
    lastDailySummary: null,
  },
};

function loadState() {
  try {
    if (existsSync(CONFIG.stateFile)) {
      const data = JSON.parse(readFileSync(CONFIG.stateFile, 'utf-8'));
      state = { ...state, ...data };
      log(`📂 Loaded state: ${state.tradesExecuted} trades, $${state.totalSpent.toFixed(2)} spent, ${state.openPositions.length} positions`);
    }
  } catch (e) {
    log(`⚠️  Could not load state: ${e.message} — starting fresh`);
  }
}

function saveState() {
  try {
    state.lastScan = new Date().toISOString();
    writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`⚠️  Could not save state: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(CONFIG.logFile, line + '\n');
  } catch (_) { /* ignore log write errors */ }
}

function ts() {
  return new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
}

function logForecast(entry) {
  try {
    appendFileSync(CONFIG.forecastLogFile, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (_) { /* ignore */ }
}

// ═══════════════════════════════════════════════════
// ROBUST HTTP
// ═══════════════════════════════════════════════════

async function fetchWithRetry(url, options = {}, label = '', retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      
      if (resp.status === 403) {
        log(`  ⚠️  403 Forbidden on ${label || url} — possible Cloudflare block`);
        if (i < retries - 1) {
          const wait = (i + 1) * 10_000;
          log(`  ⏳ Retrying in ${wait / 1000}s...`);
          await sleep(wait);
          continue;
        }
        return null;
      }
      
      if (resp.status === 429) {
        const wait = (i + 1) * 15_000;
        log(`  ⚠️  Rate limited on ${label}, waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      
      if (!resp.ok) {
        log(`  ⚠️  HTTP ${resp.status} on ${label || url}`);
        if (i < retries - 1) { await sleep(5000); continue; }
        return null;
      }
      
      return await resp.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        log(`  ⚠️  Timeout on ${label || url}`);
      } else {
        log(`  ⚠️  Fetch error on ${label}: ${e.message}`);
      }
      if (i < retries - 1) { await sleep((i + 1) * 5000); continue; }
      return null;
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════
// FEATURE 1: GFS TIMING OPTIMIZATION
// ═══════════════════════════════════════════════════

/**
 * GFS model runs at 00, 06, 12, 18 UTC.
 * Data becomes available ~2h after run start.
 * Optimal trading window: 2-4h after each run.
 * Returns { inWindow, currentThreshold }
 */
function getGFSTimingInfo() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const hourFrac = utcHour + utcMinute / 60;
  
  // GFS runs: 00, 06, 12, 18 UTC
  // Optimal windows: 02:00-04:00, 08:00-10:00, 14:00-16:00, 20:00-22:00 UTC
  const gfsRuns = [0, 6, 12, 18];
  let inWindow = false;
  
  for (const run of gfsRuns) {
    const windowStart = run + 2;
    const windowEnd = run + 4;
    if (hourFrac >= windowStart && hourFrac < windowEnd) {
      inWindow = true;
      break;
    }
  }
  
  const threshold = inWindow ? CONFIG.minEdgeThreshold : CONFIG.minEdgeThresholdHigh;
  return { inWindow, currentThreshold: threshold };
}

// ═══════════════════════════════════════════════════
// WALLET & BALANCE
// ═══════════════════════════════════════════════════

async function getUsdcEBalance() {
  try {
    const provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
    const wallet = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY, provider);
    const balData = await provider.call({
      to: CONFIG.usdcE,
      data: '0x70a08231000000000000000000000000' + wallet.address.slice(2).toLowerCase(),
    });
    return parseInt(balData, 16) / 1e6;
  } catch (e) {
    log(`⚠️  Balance check failed: ${e.message}`);
    return null;
  }
}

/**
 * FEATURE 5: Auto-reload budget from actual wallet balance.
 * Available budget = wallet balance - reserve, not a cumulative counter.
 */
async function getAvailableBudget() {
  const balance = await getUsdcEBalance();
  if (balance === null) return null;
  const available = Math.max(0, balance - CONFIG.walletReserve);
  return { balance, available };
}

// ═══════════════════════════════════════════════════
// POSITION CLEANUP (remove resolved markets)
// ═══════════════════════════════════════════════════

function logTradeHistory(entry) {
  try {
    appendFileSync('trade-history.jsonl', JSON.stringify(entry) + '\n');
  } catch (e) {
    log(`⚠️  Could not write trade history: ${e.message}`);
  }
}

function updatePnL(result, payout, cost) {
  if (!state.pnl) state.pnl = { totalWins: 0, totalLosses: 0, winCount: 0, lossCount: 0, totalPayout: 0, totalCost: 0, netPnL: 0, walletBalance: null, lastUpdated: null, lastDailySummary: null };
  if (result === 'win') {
    state.pnl.winCount++;
    state.pnl.totalWins += payout - cost;
    state.pnl.totalPayout += payout;
  } else if (result === 'loss') {
    state.pnl.lossCount++;
    state.pnl.totalLosses += cost;
  }
  state.pnl.totalCost += cost;
  state.pnl.netPnL = state.pnl.totalPayout - state.pnl.totalCost;
  state.pnl.lastUpdated = new Date().toISOString();
}

async function cleanupResolvedPositions() {
  if (state.openPositions.length === 0) return;
  
  log(`\n🧹 Checking ${state.openPositions.length} open position(s) for resolution...`);
  
  const toRemove = [];
  
  for (const pos of state.openPositions) {
    const data = await fetchWithRetry(
      `${CONFIG.gammaHost}/events?slug=${pos.eventSlug}`,
      { headers: { 'Accept': 'application/json' } },
      `cleanup:${pos.eventSlug}`
    );
    
    if (!data || !Array.isArray(data) || data.length === 0) {
      const eventDate = parseDateFromSlug(pos.eventSlug);
      if (eventDate && Date.now() - eventDate.getTime() > 48 * 3600_000) {
        log(`   🗑️  ${pos.eventSlug} — event not found & >48h old, removing`);
        const cost = pos.cost || (pos.entryPrice * pos.shares) || 0;
        logTradeHistory({
          timestamp: new Date().toISOString(),
          city: pos.eventSlug.match(/in-(.+?)-on-/)?.[1] || 'unknown',
          date: pos.eventSlug.match(/on-(.+)$/)?.[1] || 'unknown',
          market: pos.market || pos.eventSlug,
          entryPrice: pos.entryPrice,
          cost,
          shares: pos.shares,
          result: 'unknown',
          payout: 0,
          pnl: -cost,
          walletBalance: state.pnl?.walletBalance,
        });
        updatePnL('loss', 0, cost);
        toRemove.push(pos);
      }
      await sleep(300);
      continue;
    }
    
    const event = data[0];
    const closed = event.closed || event.resolved;
    
    if (closed) {
      let result = '❓';
      let tradeResult = 'unknown';
      let payout = 0;
      const cost = pos.cost || (pos.entryPrice * pos.shares) || 0;
      
      if (event.markets) {
        for (const m of event.markets) {
          const tokens = safeJsonParse(m.clobTokenIds, []);
          if (tokens.includes(pos.tokenId)) {
            const outcomes = safeJsonParse(m.outcomes, []);
            const outcomePrices = safeJsonParse(m.outcomePrices, []);
            const yesIdx = outcomes.indexOf('Yes');
            if (yesIdx !== -1 && outcomePrices?.[yesIdx]) {
              const resolvedPrice = parseFloat(outcomePrices[yesIdx]);
              if (resolvedPrice >= 0.99) {
                payout = pos.shares;
                result = `✅ WIN +$${(payout - cost).toFixed(2)}`;
                tradeResult = 'win';
              } else if (resolvedPrice <= 0.01) {
                payout = 0;
                result = `❌ LOSS -$${cost.toFixed(2)}`;
                tradeResult = 'loss';
              }
            }
            break;
          }
        }
      }
      
      log(`   ${result} ${pos.market?.substring(0, 60) || pos.eventSlug} (entry $${pos.entryPrice?.toFixed(3)})`);
      updatePnL(tradeResult, payout, cost);
      logTradeHistory({
        timestamp: new Date().toISOString(),
        city: pos.eventSlug.match(/in-(.+?)-on-/)?.[1] || 'unknown',
        date: pos.eventSlug.match(/on-(.+)$/)?.[1] || 'unknown',
        market: pos.market || pos.eventSlug,
        entryPrice: pos.entryPrice,
        cost,
        shares: pos.shares,
        result: tradeResult,
        payout,
        pnl: payout - cost,
        walletBalance: state.pnl?.walletBalance,
      });
      
      toRemove.push(pos);
    } else {
      const eventDate = parseDateFromSlug(pos.eventSlug);
      if (eventDate) {
        const hoursAgo = (Date.now() - eventDate.getTime()) / 3600_000;
        if (hoursAgo > 0) {
          log(`   ⏳ ${pos.eventSlug} — ${hoursAgo.toFixed(0)}h past event date, awaiting resolution`);
        }
      }
    }
    
    await sleep(300);
  }
  
  if (toRemove.length > 0) {
    const removeSlugs = new Set(toRemove.map(p => p.eventSlug));
    state.openPositions = state.openPositions.filter(p => !removeSlugs.has(p.eventSlug));
    saveState();
    log(`   🧹 Removed ${toRemove.length} resolved position(s) — ${state.openPositions.length} remaining, ${CONFIG.maxOpenPositions - state.openPositions.length} slots free`);
    log(`   📈 P&L: ${state.pnl.winCount}W/${state.pnl.lossCount}L | Net: $${state.pnl.netPnL.toFixed(2)} | Wallet: $${state.pnl.walletBalance?.toFixed(2) || '?'}`);
  } else {
    log(`   ℹ️  No resolved positions found`);
  }
}

function parseDateFromSlug(slug) {
  const months = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const m = slug.match(/on-(\w+)-(\d+)-(\d{4})$/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (month === undefined) return null;
  return new Date(parseInt(m[3]), month, parseInt(m[2]));
}

// ═══════════════════════════════════════════════════
// FEATURE 3: DYNAMIC EXIT / SELL POSITIONS
// ═══════════════════════════════════════════════════

/**
 * Re-check open positions against current forecasts.
 * If forecast no longer supports our bucket, attempt to sell.
 */
async function dynamicExitCheck(sdk) {
  if (state.openPositions.length === 0) return;
  
  log(`\n🔄 Dynamic exit check on ${state.openPositions.length} position(s)...`);
  
  for (const pos of state.openPositions) {
    // Only check positions for future events (not yet resolved)
    const eventDate = parseDateFromSlug(pos.eventSlug);
    if (!eventDate || Date.now() > eventDate.getTime()) continue;
    
    // Extract city from slug
    const cityMatch = pos.eventSlug.match(/in-(.+?)-on-/);
    if (!cityMatch) continue;
    const citySlug = cityMatch[1];
    const cityInfo = CITY_COORDS[citySlug];
    if (!cityInfo) continue;
    
    // Get current consensus forecast
    const consensus = await getConsensus(cityInfo, eventDate);
    if (!consensus || !consensus.tempF) continue;
    
    // Parse the bucket we bet on from position market name
    const range = parseTemperatureRange(pos.market);
    if (!range) continue;
    
    const stillMatches = forecastMatchesRange(consensus.tempF, range);
    
    if (!stillMatches) {
      log(`   ⚠️  FORECAST SHIFTED for ${pos.eventSlug}`);
      log(`      Position: "${pos.market}" | New forecast: ${consensus.tempF.toFixed(1)}°F`);
      log(`      Attempting to sell position...`);
      
      // Try to sell by placing an ASK order
      try {
        const price = await getMarketPrice(pos.tokenId);
        if (price?.bestBid && price.bestBid > 0.02) {
          // Sell at slightly below best bid for quick fill
          const sellPrice = Math.max(price.bestBid - 0.01, 0.01);
          const sellSize = pos.shares;
          
          log(`      💸 SELL ${sellSize.toFixed(2)} shares @ $${sellPrice.toFixed(3)} (best bid: $${price.bestBid.toFixed(3)})`);
          
          const result = await sdk.tradingService.createLimitOrder({
            tokenId: pos.tokenId,
            side: 'SELL',
            price: sellPrice,
            size: sellSize,
            orderType: 'GTC',
          });
          
          if (result && result.success !== false) {
            const orderId = result.orderId || result.orderIds?.[0] || 'N/A';
            log(`      ✅ Sell order placed! ID: ${orderId}`);
            const estPayout = sellPrice * sellSize;
            const cost = pos.cost || (pos.entryPrice * pos.shares) || 0;
            log(`      📉 Est. recovery: $${estPayout.toFixed(2)} of $${cost.toFixed(2)} cost`);
            
            logTradeHistory({
              timestamp: new Date().toISOString(),
              city: citySlug,
              market: pos.market,
              type: 'dynamic_exit',
              sellPrice,
              shares: sellSize,
              estRecovery: estPayout,
              originalCost: cost,
              reason: `forecast shifted to ${consensus.tempF.toFixed(1)}°F`,
            });
            
            // Mark position for removal (sell order placed)
            pos._exitPending = true;
          } else {
            log(`      ❌ Sell order failed: ${result?.errorMsg || JSON.stringify(result)}`);
          }
        } else {
          log(`      ⚠️  No viable bid to sell into (best bid: $${price?.bestBid?.toFixed(3) || '0'})`);
        }
      } catch (e) {
        log(`      ❌ Sell attempt error: ${e.message}`);
      }
    } else {
      log(`   ✅ ${pos.market?.substring(0, 50)} — forecast still supports position`);
    }
    
    await sleep(500);
  }
  
  // Remove positions with pending exits
  const exitCount = state.openPositions.filter(p => p._exitPending).length;
  if (exitCount > 0) {
    state.openPositions = state.openPositions.filter(p => !p._exitPending);
    saveState();
    log(`   🔄 Exited ${exitCount} position(s) via dynamic sell`);
  }
}

// ═══════════════════════════════════════════════════
// MARKET DISCOVERY
// ═══════════════════════════════════════════════════

let lastDiscovery = 0;

async function discoverCities() {
  const now = Date.now();
  if (now - lastDiscovery < 86_400_000) return;
  lastDiscovery = now;
  
  log('🔎 Running city auto-discovery...');
  const today = new Date();
  let newCount = 0;
  
  for (const candidate of CANDIDATE_CITIES) {
    if (CITY_COORDS[candidate.slug]) continue;
    
    const slug = generateSlug(candidate.slug, today);
    const data = await fetchWithRetry(
      `${CONFIG.gammaHost}/events?slug=${slug}`,
      { headers: { 'Accept': 'application/json' } },
      `discover:${candidate.slug}`
    );
    
    if (data && Array.isArray(data) && data.length > 0) {
      CITY_COORDS[candidate.slug] = {
        lat: candidate.lat,
        lon: candidate.lon,
        country: candidate.country,
        name: candidate.name,
        slug: candidate.slug,
      };
      newCount++;
      log(`   🆕 Discovered: ${candidate.name} (${candidate.slug})`);
    }
    
    await sleep(300);
  }
  
  if (newCount > 0) {
    log(`   ✅ Added ${newCount} new cities, now monitoring ${Object.keys(CITY_COORDS).length} total`);
  } else {
    log(`   ℹ️  No new cities found (monitoring ${Object.keys(CITY_COORDS).length})`);
  }
}

function generateSlug(city, date) {
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                      'july', 'august', 'september', 'october', 'november', 'december'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `highest-temperature-in-${city}-on-${month}-${day}-${year}`;
}

async function fetchEventBySlug(slug) {
  const data = await fetchWithRetry(
    `${CONFIG.gammaHost}/events?slug=${slug}`,
    { headers: { 'Accept': 'application/json' } },
    `gamma:${slug}`
  );
  
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  
  const event = data[0];
  const markets = event.markets || [];
  
  return {
    eventSlug: slug,
    title: event.title,
    markets: markets
      .filter(m => m.active)
      .map(m => ({
        conditionId: m.conditionId,
        question: m.question,
        slug: m.slug,
        endDate: new Date(m.endDate),
        tokens: safeJsonParse(m.clobTokenIds, []),
        outcomes: safeJsonParse(m.outcomes, m.outcomes || []),
        active: m.active,
        temperatureRange: m.groupItemTitle || m.outcome,
      }))
  };
}

function safeJsonParse(val, fallback) {
  if (typeof val !== 'string') return val || fallback;
  try { return JSON.parse(val); }
  catch { return fallback; }
}

async function findWeatherMarkets() {
  const allMarkets = [];
  
  const dates = [0, 1, 2].map(d => {
    const dt = new Date();
    dt.setDate(dt.getDate() + d);
    return dt;
  });
  
  log('🔍 Searching for temperature markets...');
  
  for (const [cityKey, cityInfo] of Object.entries(CITY_COORDS)) {
    for (const date of dates) {
      const slug = generateSlug(cityInfo.slug, date);
      const event = await fetchEventBySlug(slug);
      
      if (event && event.markets.length > 0) {
        log(`   ✅ ${slug} → ${event.markets.length} markets`);
        for (const market of event.markets) {
          allMarkets.push({
            ...market,
            eventSlug: slug,
            city: cityKey,
            cityInfo,
            eventDate: date,
          });
        }
      }
      
      await sleep(400);
    }
  }
  
  return allMarkets;
}

// ═══════════════════════════════════════════════════
// WEATHER FORECASTS
// ═══════════════════════════════════════════════════

async function fetchNOAAForecast(lat, lon) {
  const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const pointsData = await fetchWithRetry(pointsUrl, {
    headers: { 'User-Agent': 'WeatherTradingBot/2.5 (contact@example.com)' }
  }, 'NOAA points');
  
  if (!pointsData) return null;
  
  const forecastUrl = pointsData.properties?.forecast;
  if (!forecastUrl) { log('  ⚠️  No forecast URL from NOAA'); return null; }
  
  const forecastData = await fetchWithRetry(forecastUrl, {
    headers: { 'User-Agent': 'WeatherTradingBot/2.5 (contact@example.com)' }
  }, 'NOAA forecast');
  
  if (!forecastData) return null;
  
  return (forecastData.properties?.periods || []).map(p => ({
    name: p.name,
    startTime: new Date(p.startTime),
    temperature: p.temperature,
    temperatureUnit: p.temperatureUnit,
    shortForecast: p.shortForecast,
    isDaytime: p.isDaytime,
    source: 'NOAA',
  }));
}

async function fetchOpenMeteoForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto`;
  
  const data = await fetchWithRetry(url, {}, 'Open-Meteo');
  if (!data?.daily) return null;
  
  return data.daily.time.map((date, i) => ({
    date: new Date(date),
    tempMax: data.daily.temperature_2m_max[i],
    tempMin: data.daily.temperature_2m_min[i],
    source: 'Open-Meteo',
  }));
}

function getNOAAHigh(noaaForecast, eventDate) {
  if (!noaaForecast || !eventDate) return null;
  const period = noaaForecast.find(f =>
    f.isDaytime && f.startTime.toDateString() === eventDate.toDateString()
  );
  return period ? period.temperature : null;
}

function getOpenMeteoHigh(omForecast, eventDate) {
  if (!omForecast || !eventDate) return null;
  const day = omForecast.find(f => f.date.toDateString() === eventDate.toDateString());
  return day ? day.tempMax : null;
}

// ═══════════════════════════════════════════════════
// FEATURE 2: MULTI-SOURCE FORECAST CONSENSUS
// ═══════════════════════════════════════════════════

/**
 * Fetch BOTH NOAA and Open-Meteo for every city.
 * Returns { tempF, confidence, noaaTemp, omTemp, source }
 * confidence: 'very_high' (<= 1°F diff), 'high' (<= 2°F), 'moderate' (<= 3°F), 'skip' (> 3°F)
 */
async function getConsensus(cityInfo, eventDate) {
  const [noaaForecast, omForecast] = await Promise.all([
    fetchNOAAForecast(cityInfo.lat, cityInfo.lon).catch(() => null),
    fetchOpenMeteoForecast(cityInfo.lat, cityInfo.lon).catch(() => null),
  ]);
  
  const noaaTemp = getNOAAHigh(noaaForecast, eventDate);
  const omTemp = getOpenMeteoHigh(omForecast, eventDate);
  
  // Log both forecasts
  logForecast({
    city: cityInfo.name,
    eventDate: eventDate.toISOString().slice(0, 10),
    noaaTemp,
    omTemp,
    diff: (noaaTemp != null && omTemp != null) ? Math.abs(noaaTemp - omTemp) : null,
  });
  
  // If both available, compute consensus
  if (noaaTemp != null && omTemp != null) {
    const diff = Math.abs(noaaTemp - omTemp);
    const avgTemp = (noaaTemp + omTemp) / 2;
    
    if (diff > 3) {
      log(`   ⚠️  Forecasts disagree by ${diff.toFixed(1)}°F (NOAA: ${noaaTemp}°F, OM: ${omTemp}°F) — SKIP`);
      return { tempF: avgTemp, confidence: 'skip', noaaTemp, omTemp, source: 'consensus', diff };
    }
    
    let confidence;
    if (diff <= 1) {
      confidence = 'very_high';
    } else if (diff <= 2) {
      confidence = 'high';
    } else {
      confidence = 'moderate';
    }
    
    log(`   🌡️  Consensus: ${avgTemp.toFixed(1)}°F (NOAA: ${noaaTemp}°F, OM: ${omTemp}°F, diff: ${diff.toFixed(1)}°F, confidence: ${confidence})`);
    return { tempF: avgTemp, confidence, noaaTemp, omTemp, source: 'consensus', diff };
  }
  
  // Fallback to whichever is available
  if (noaaTemp != null) {
    log(`   🌡️  NOAA only: ${noaaTemp}°F (Open-Meteo unavailable)`);
    return { tempF: noaaTemp, confidence: 'single_source', noaaTemp, omTemp: null, source: 'NOAA' };
  }
  if (omTemp != null) {
    log(`   🌡️  Open-Meteo only: ${omTemp}°F (NOAA unavailable)`);
    return { tempF: omTemp, confidence: 'single_source', noaaTemp: null, omTemp, source: 'Open-Meteo' };
  }
  
  return null;
}

/**
 * Get effective edge threshold based on consensus confidence and GFS timing.
 */
function getEffectiveEdgeThreshold(confidence, gfsTiming) {
  // Base threshold from GFS timing
  let threshold = gfsTiming.currentThreshold;
  
  // Adjust based on consensus confidence
  if (confidence === 'very_high') {
    threshold = Math.min(threshold, CONFIG.minEdgeThresholdLow); // 10%
  } else if (confidence === 'high') {
    // Use normal GFS-based threshold
  } else if (confidence === 'moderate') {
    threshold = Math.max(threshold, CONFIG.minEdgeThreshold); // At least 15%
  } else if (confidence === 'single_source') {
    threshold = Math.max(threshold, CONFIG.minEdgeThreshold); // At least 15%
  }
  
  return threshold;
}

// ═══════════════════════════════════════════════════
// TEMPERATURE PARSING
// ═══════════════════════════════════════════════════

function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }

function parseTemperatureRange(text) {
  if (!text) return null;
  
  // "24-25°F", "10-11°C"
  let m = text.match(/(-?\d+)\s*-\s*(-?\d+)\s*°?\s*([FC])/i);
  if (m) return { type: 'range', min: parseInt(m[1]), max: parseInt(m[2]), unit: m[3].toUpperCase() };
  
  // "23°F or below/lower"
  m = text.match(/(-?\d+)\s*°?\s*([FC])\s+or\s+(below|lower)/i);
  if (m) return { type: 'below', threshold: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  // "34°F or above/higher"
  m = text.match(/(-?\d+)\s*°?\s*([FC])\s+or\s+(above|higher)/i);
  if (m) return { type: 'above', threshold: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  // Single degree "10°C"
  m = text.match(/^(-?\d+)\s*°?\s*([FC])$/i);
  if (m) return { type: 'exact', value: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  return null;
}

function forecastMatchesRange(forecastF, range) {
  let temp = forecastF;
  if (range.unit === 'C') temp = fahrenheitToCelsius(forecastF);
  
  switch (range.type) {
    case 'range': return temp >= range.min && temp <= range.max;
    case 'below': return temp <= range.threshold;
    case 'above': return temp >= range.threshold;
    case 'exact': return Math.round(temp) === range.value;
    default: return false;
  }
}

// ═══════════════════════════════════════════════════
// FEATURE 4: BETTER BUCKET SELECTION
// ═══════════════════════════════════════════════════

/**
 * Score a bucket by width. Wider buckets (above/below) are preferred.
 * Returns a width score: higher = wider = preferred.
 */
function bucketWidthScore(range) {
  if (!range) return 0;
  switch (range.type) {
    case 'above': return 100; // "≥X°F" — very wide
    case 'below': return 100; // "≤X°F" — very wide
    case 'range': return range.max - range.min + 1; // e.g., "70-75" = 6
    case 'exact': return 1;   // single degree — narrowest
    default: return 0;
  }
}

/**
 * Given multiple matching markets, prefer wider buckets when edges are similar (within 5%).
 */
function selectBestBucket(candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  
  // Sort by edge descending
  candidates.sort((a, b) => b.edgePercent - a.edgePercent);
  
  const bestEdge = candidates[0].edgePercent;
  
  // Among candidates within 5% of best edge, prefer wider bucket
  const competitive = candidates.filter(c => bestEdge - c.edgePercent <= 0.05);
  competitive.sort((a, b) => b.widthScore - a.widthScore);
  
  return competitive[0];
}

// ═══════════════════════════════════════════════════
// MARKET PRICES
// ═══════════════════════════════════════════════════

async function getMarketPrice(tokenId) {
  const data = await fetchWithRetry(
    `${CONFIG.clobHost}/book?token_id=${tokenId}`,
    {},
    `CLOB book:${tokenId.slice(0, 10)}`
  );
  
  if (!data) return null;
  
  const bestAsk = data.asks?.length
    ? Math.min(...data.asks.map(a => parseFloat(a.price)))
    : null;
  const bestBid = data.bids?.length
    ? Math.max(...data.bids.map(b => parseFloat(b.price)))
    : null;
  
  return { bestAsk, bestBid };
}

// ═══════════════════════════════════════════════════
// EDGE ANALYSIS (with consensus + timing + bucket preference)
// ═══════════════════════════════════════════════════

async function analyzeEvent(eventSlug, markets, cityInfo, eventDate, gfsTiming) {
  if (!markets?.length || !cityInfo) return null;
  
  log(`\n🔍 ${eventSlug}`);
  log(`   ${cityInfo.name} — ${eventDate?.toLocaleDateString() || '?'} — ${markets.length} buckets`);
  
  if (state.tradedMarkets.includes(eventSlug)) {
    log('   ⏭️  Already traded this event, skipping');
    return null;
  }
  
  // FEATURE 2: Get consensus forecast from both sources
  const consensus = await getConsensus(cityInfo, eventDate);
  if (!consensus) { log('   ❌ No forecast data from any source'); return null; }
  
  // Skip if sources disagree too much
  if (consensus.confidence === 'skip') {
    return null;
  }
  
  const forecastF = consensus.tempF;
  
  // Get effective threshold based on consensus + GFS timing
  const effectiveThreshold = getEffectiveEdgeThreshold(consensus.confidence, gfsTiming);
  log(`   📊 Edge threshold: ${(effectiveThreshold * 100).toFixed(0)}% (confidence: ${consensus.confidence}, GFS window: ${gfsTiming.inWindow ? 'YES' : 'no'})`);
  
  // Parse all buckets and find ALL matching ones (for bucket selection)
  let marketUnit = null;
  const matchingCandidates = [];
  
  for (const market of markets) {
    const range = parseTemperatureRange(market.temperatureRange || market.question);
    if (!range) continue;
    if (!marketUnit) marketUnit = range.unit;
    
    if (forecastMatchesRange(forecastF, range)) {
      // Fetch price
      if (!market.tokens?.[0]) continue;
      const price = await getMarketPrice(market.tokens[0]);
      if (!price?.bestAsk) continue;
      
      const askPrice = price.bestAsk;
      if (askPrice >= CONFIG.edgePriceThreshold) continue;
      
      const edgePercent = (CONFIG.forecastConfidence - askPrice) / askPrice;
      const widthScore = bucketWidthScore(range);
      
      matchingCandidates.push({
        market,
        tokenId: market.tokens[0],
        marketPrice: askPrice,
        eventSlug,
        edgePercent,
        widthScore,
        range,
        cityInfo,
      });
    }
  }
  
  if (matchingCandidates.length === 0) {
    const forecastDisplay = marketUnit === 'C'
      ? `${forecastF.toFixed(1)}°F (${fahrenheitToCelsius(forecastF).toFixed(1)}°C)`
      : `${forecastF.toFixed(1)}°F`;
    log(`   ⚠️  Forecast ${forecastDisplay} — no matching bucket with viable price`);
    return null;
  }
  
  // FEATURE 4: Select best bucket (prefer wider when edges are similar)
  const best = selectBestBucket(matchingCandidates);
  
  const forecastDisplay = marketUnit === 'C'
    ? `${forecastF.toFixed(1)}°F (${fahrenheitToCelsius(forecastF).toFixed(1)}°C)`
    : `${forecastF.toFixed(1)}°F`;
  
  log(`   ✅ Forecast → ${best.market.temperatureRange} @ ${(best.marketPrice * 100).toFixed(1)}% (width: ${best.widthScore})`);
  
  if (best.edgePercent < effectiveThreshold) {
    log(`   ℹ️  Edge ${(best.edgePercent * 100).toFixed(1)}% below threshold ${(effectiveThreshold * 100).toFixed(0)}%`);
    return null;
  }
  
  state.stats.edgesIdentified++;
  log(`   🎯 EDGE: ${(best.edgePercent * 100).toFixed(1)}% — ${forecastDisplay} → "${best.market.temperatureRange}" @ ${(best.marketPrice * 100).toFixed(1)}%`);
  
  return {
    ...best,
    forecastDisplay,
    consensus,
  };
}

// ═══════════════════════════════════════════════════
// TRADE EXECUTION (with verification)
// ═══════════════════════════════════════════════════

async function executeTrade(sdk, edge) {
  if (state.openPositions.length >= CONFIG.maxOpenPositions) {
    log('   ⚠️  Max positions reached');
    return false;
  }
  
  // FEATURE 5: Check actual wallet balance instead of cumulative budget
  const budgetInfo = await getAvailableBudget();
  if (budgetInfo === null) {
    log('   ❌ Cannot verify wallet balance — skipping trade for safety');
    return false;
  }
  
  const posSize = edge.cityInfo?.posSize || CONFIG.maxPositionSize;
  if (budgetInfo.available < posSize) {
    log(`   ❌ Insufficient available budget: $${budgetInfo.available.toFixed(2)} (need $${posSize}, wallet: $${budgetInfo.balance.toFixed(2)}, reserve: $${CONFIG.walletReserve})`);
    return false;
  }
  log(`   💰 Wallet: $${budgetInfo.balance.toFixed(2)} USDC.e (available: $${budgetInfo.available.toFixed(2)})`);
  
  if (state.tradedMarkets.includes(edge.eventSlug)) {
    log('   ⚠️  Already traded this event (race condition guard)');
    return false;
  }
  
  const tokenId = edge.tokenId;
  const price = Math.min(edge.marketPrice + 0.01, 0.99);
  const size = Math.max(posSize / price, 5.1);
  const orderValue = price * size;
  
  if (orderValue < 1.0) {
    log(`   ⚠️  Order value $${orderValue.toFixed(2)} below $1 minimum`);
    return false;
  }
  
  log(`   💸 PLACING ORDER: BUY ${size.toFixed(2)} shares @ $${price.toFixed(3)} = $${orderValue.toFixed(2)}`);
  
  let result;
  try {
    result = await sdk.tradingService.createLimitOrder({
      tokenId,
      side: 'BUY',
      price,
      size,
      orderType: 'GTC',
    });
  } catch (e) {
    log(`   ❌ Order submission failed: ${e.message}`);
    state.stats.errors++;
    return false;
  }
  
  if (!result) {
    log('   ❌ Order returned null/undefined');
    state.stats.errors++;
    return false;
  }
  
  if (result.success === false) {
    log(`   ❌ Order rejected: ${result.errorMsg || JSON.stringify(result)}`);
    state.stats.errors++;
    return false;
  }
  
  const orderId = result.orderId || result.orderIds?.[0];
  if (!orderId) {
    log(`   ⚠️  Order response has no orderId — response: ${JSON.stringify(result)}`);
  }
  
  log(`   ✅ Order placed! ID: ${orderId || 'N/A'}`);
  if (result.transactionHashes?.length) {
    log(`   📋 TX: ${result.transactionHashes.join(', ')}`);
  }
  
  if (orderId) {
    await sleep(3000);
    try {
      const orderCheck = await fetchWithRetry(
        `${CONFIG.clobHost}/order/${orderId}`,
        { headers: sdk.tradingService?.clobClient?.getAuthHeaders?.() || {} },
        'order verification'
      );
      if (orderCheck) {
        log(`   ✅ Order verified in book: status=${orderCheck.status || orderCheck.order_status || 'present'}`);
      } else {
        log('   ⚠️  Could not verify order in book (may still be valid)');
      }
    } catch (e) {
      log(`   ⚠️  Order verification check failed: ${e.message}`);
    }
  }
  
  await sleep(2000);
  const newBalance = await getUsdcEBalance();
  if (newBalance !== null) {
    const diff = budgetInfo.balance - newBalance;
    log(`   💰 Balance after: $${newBalance.toFixed(2)} (Δ $${diff.toFixed(2)})`);
  }
  
  // Update state
  state.openPositions.push({
    market: edge.market.question || edge.market.temperatureRange,
    tokenId,
    orderId: orderId || null,
    shares: size,
    entryPrice: price,
    cost: orderValue,
    eventSlug: edge.eventSlug,
    timestamp: new Date().toISOString(),
    forecastDisplay: edge.forecastDisplay,
    consensus: edge.consensus ? { confidence: edge.consensus.confidence, noaa: edge.consensus.noaaTemp, om: edge.consensus.omTemp } : null,
  });
  
  state.tradedMarkets.push(edge.eventSlug);
  state.tradesExecuted++;
  state.totalSpent += orderValue;
  saveState();
  
  return true;
}

// ═══════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════

async function main() {
  log('');
  log('═══════════════════════════════════════════════════');
  log('  🌤️  Weather Trading Bot v2.5');
  log('  ✨ GFS timing | Consensus | Dynamic exit | Smart buckets | Auto-budget');
  log('═══════════════════════════════════════════════════');
  log(`📍 Cities: ${Object.keys(CITY_COORDS).join(', ')}`);
  log(`💰 Position size: $${CONFIG.maxPositionSize} | Reserve: $${CONFIG.walletReserve}`);
  log(`📊 Max positions: ${CONFIG.maxOpenPositions} | Edge: ${CONFIG.minEdgeThresholdLow * 100}%-${CONFIG.minEdgeThresholdHigh * 100}% (dynamic)`);
  log('');
  
  loadState();
  
  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    log('❌ POLYMARKET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }
  
  log('🔍 Pre-flight checks...');
  const budgetInfo = await getAvailableBudget();
  if (budgetInfo === null) {
    log('❌ Cannot read wallet balance — check RPC connection');
    process.exit(1);
  }
  if (budgetInfo.balance < 1) {
    log(`❌ Insufficient USDC.e: $${budgetInfo.balance.toFixed(2)} (need at least $1)`);
    process.exit(1);
  }
  log(`✅ Wallet: $${budgetInfo.balance.toFixed(2)} USDC.e | Available: $${budgetInfo.available.toFixed(2)}`);
  
  log('🔑 Initializing Polymarket SDK...');
  let sdk;
  try {
    sdk = await PolymarketSDK.create({
      privateKey: process.env.POLYMARKET_PRIVATE_KEY,
    });
    await sdk.tradingService.initialize();
    log('✅ SDK initialized, CLOB API ready');
  } catch (e) {
    log(`❌ SDK initialization failed: ${e.message}`);
    process.exit(1);
  }
  
  log('');
  
  let consecutiveErrors = 0;
  
  while (true) {
    try {
      state.stats.scans++;
      const scanNum = state.stats.scans;
      
      // FEATURE 1: GFS timing
      const gfsTiming = getGFSTimingInfo();
      
      // FEATURE 5: Auto-reload budget from wallet
      const currentBudget = await getAvailableBudget();
      const availableStr = currentBudget ? `$${currentBudget.available.toFixed(2)} avail` : '$? avail';
      
      log(`\n${'═'.repeat(60)}`);
      log(`🔄 Scan #${scanNum} — ${ts()} — ${availableStr} — GFS window: ${gfsTiming.inWindow ? '✅ OPTIMAL' : '⏳ off-peak (${(gfsTiming.currentThreshold * 100).toFixed(0)}% threshold)'}`);
      log(`${'═'.repeat(60)}`);
      
      // Clean up resolved positions
      await cleanupResolvedPositions();
      
      // FEATURE 3: Dynamic exit check
      await dynamicExitCheck(sdk);
      
      // Auto-discover new cities
      await discoverCities();
      
      // Find markets
      const markets = await findWeatherMarkets();
      state.stats.marketsFound += markets.length;
      
      if (markets.length === 0) {
        log('📭 No active weather markets found');
      } else {
        log(`📬 Found ${markets.length} market(s)`);
        
        const events = {};
        for (const m of markets) {
          if (!m.eventSlug) continue;
          if (!events[m.eventSlug]) {
            events[m.eventSlug] = { markets: [], cityInfo: m.cityInfo, eventDate: m.eventDate };
          }
          events[m.eventSlug].markets.push(m);
        }
        
        log(`📊 ${Object.keys(events).length} event(s)`);
        
        for (const [slug, group] of Object.entries(events)) {
          if (!group.cityInfo) continue;
          
          const edge = await analyzeEvent(slug, group.markets, group.cityInfo, group.eventDate, gfsTiming);
          
          if (edge) {
            const success = await executeTrade(sdk, edge);
            if (success) {
              log(`   🎉 Trade #${state.tradesExecuted} placed!`);
            }
          }
          
          await sleep(1000);
        }
      }
      
      // Wallet balance tracking
      const scanBalance = await getUsdcEBalance();
      if (scanBalance !== null) {
        if (!state.pnl) state.pnl = { totalWins: 0, totalLosses: 0, winCount: 0, lossCount: 0, totalPayout: 0, totalCost: 0, netPnL: 0, walletBalance: null, lastUpdated: null, lastDailySummary: null };
        state.pnl.walletBalance = scanBalance;
        state.pnl.lastUpdated = new Date().toISOString();
        log(`💰 Wallet: $${scanBalance.toFixed(2)} USDC.e`);
      }
      
      // Daily P&L summary
      const todayUTC = new Date().toISOString().slice(0, 10);
      if (state.pnl && state.pnl.lastDailySummary !== todayUTC) {
        state.pnl.lastDailySummary = todayUTC;
        const summary = `📅 DAILY P&L SUMMARY (${todayUTC}): ${state.pnl.winCount}W/${state.pnl.lossCount}L | Wins: +$${state.pnl.totalWins.toFixed(2)} | Losses: -$${state.pnl.totalLosses.toFixed(2)} | Net: $${state.pnl.netPnL.toFixed(2)} | Cost: $${state.pnl.totalCost.toFixed(2)} | Payout: $${state.pnl.totalPayout.toFixed(2)} | Wallet: $${state.pnl.walletBalance?.toFixed(2) || '?'}`;
        log(summary);
        logTradeHistory({ timestamp: new Date().toISOString(), type: 'daily_summary', date: todayUTC, ...state.pnl });
      }
      
      // Status summary
      log(`\n📊 Session: ${state.stats.scans} scans | ${state.stats.edgesIdentified} edges | ${state.tradesExecuted} trades | $${state.totalSpent.toFixed(2)} spent | ${state.stats.errors} errors`);
      if (state.pnl) {
        log(`📈 P&L: ${state.pnl.winCount}W/${state.pnl.lossCount}L | Net: $${state.pnl.netPnL.toFixed(2)} | Wallet: $${state.pnl.walletBalance?.toFixed(2) || '?'}`);
      }
      
      if (state.openPositions.length > 0) {
        log(`📂 Positions (${state.openPositions.length}):`);
        for (const pos of state.openPositions) {
          log(`   • ${pos.market?.substring(0, 50) || pos.eventSlug} @ $${pos.entryPrice?.toFixed(3)} — ${pos.forecastDisplay || ''}`);
        }
      }
      
      saveState();
      consecutiveErrors = 0;
      
      log(`\n⏳ Next scan in ${CONFIG.pollIntervalMs / 1000}s...`);
      await sleep(CONFIG.pollIntervalMs);
      
    } catch (e) {
      consecutiveErrors++;
      state.stats.errors++;
      log(`\n❌ Scan error: ${e.message}`);
      
      const backoff = Math.min(consecutiveErrors * 30_000, 300_000);
      log(`⏳ Backoff: ${backoff / 1000}s (${consecutiveErrors} consecutive errors)`);
      
      if (consecutiveErrors >= 10) {
        log('💀 Too many consecutive errors — shutting down');
        saveState();
        process.exit(1);
      }
      
      saveState();
      await sleep(backoff);
    }
  }
}

// ═══════════════════════════════════════════════════
// SHUTDOWN
// ═══════════════════════════════════════════════════

function shutdown(signal) {
  log(`\n🛑 ${signal} received — shutting down...`);
  log(`📊 Final: ${state.stats.scans} scans | ${state.tradesExecuted} trades | $${state.totalSpent.toFixed(2)} spent`);
  log(`📂 ${state.openPositions.length} open position(s)`);
  saveState();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (e) => {
  log(`💀 Uncaught exception: ${e.message}`);
  log(e.stack);
  saveState();
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  log(`💀 Unhandled rejection: ${e?.message || e}`);
  saveState();
});

main().catch(e => {
  log(`💥 Fatal: ${e.message}`);
  log(e.stack);
  saveState();
  process.exit(1);
});
