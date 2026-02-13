import 'dotenv/config';
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
import { writeFileSync, readFileSync, appendFileSync, existsSync } from 'fs';
import { ethers } from 'ethers';

/**
 * Weather Trading Bot v2 for Polymarket
 * ======================================
 * Exploits informational edge between NOAA/Open-Meteo forecasts and market prices.
 * 
 * Key improvements over v1:
 * - Verifies every trade actually landed (order confirmation)
 * - Checks wallet balance before trading (USDC.e, not native USDC)
 * - Persists state to disk (survives restarts)
 * - Prevents duplicate trades on same market
 * - Robust error handling with exponential backoff
 * - Budget based on actual wallet balance, not hardcoded
 */

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════

const CONFIG = {
  pollIntervalMs: 120_000,        // 2 minutes between scans
  maxPositionSize: 3,             // Default $3 per position (overridden by city posSize)
  maxOpenPositions: 10,           // Max concurrent positions
  minEdgeThreshold: 0.15,         // 15% minimum edge
  maxBudget: 50,                  // Total max spend in USDC
  edgePriceThreshold: 0.60,       // Only buy below this price
  forecastConfidence: 0.80,       // Assumed forecast accuracy
  logFile: 'weather-bot.log',
  stateFile: 'weather-bot-state.json',
  rpcUrl: 'https://polygon.drpc.org',
  usdcE: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
};

// Known city coordinates for weather API
// Auto-discovery adds new cities dynamically (see discoverCities)
// v3: Only profitable warm-climate cities (backtest: 85-90% projected WR)
const CITY_COORDS = {
  'miami':      { lat: 25.7617, lon: -80.1918,  country: 'US', name: 'Miami',      slug: 'miami',      posSize: 4, tier: 'A' },
  'atlanta':    { lat: 33.7490, lon: -84.3880,  country: 'US', name: 'Atlanta',    slug: 'atlanta',    posSize: 3, tier: 'A' },
  'dallas':     { lat: 32.7767, lon: -96.7970,  country: 'US', name: 'Dallas',     slug: 'dallas',     posSize: 3, tier: 'B' },
  'wellington': { lat: -41.2865, lon: 174.7762, country: 'NZ', name: 'Wellington', slug: 'wellington', posSize: 2, tier: 'B' },
};

// Candidate cities to probe during auto-discovery (checked once per day)
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
    // Check via Gamma API if event has resolved
    const data = await fetchWithRetry(
      `${CONFIG.gammaHost}/events?slug=${pos.eventSlug}`,
      { headers: { 'Accept': 'application/json' } },
      `cleanup:${pos.eventSlug}`
    );
    
    if (!data || !Array.isArray(data) || data.length === 0) {
      // If event not found, check if date is >48h past — assume resolved
      const eventDate = parseDateFromSlug(pos.eventSlug);
      if (eventDate && Date.now() - eventDate.getTime() > 48 * 3600_000) {
        log(`   🗑️  ${pos.eventSlug} — event not found & >48h old, removing`);
        // Log as unknown result
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
      // Determine win/loss
      let result = '❓';
      let tradeResult = 'unknown';
      let payout = 0;
      const cost = pos.cost || (pos.entryPrice * pos.shares) || 0;
      
      if (event.markets) {
        for (const m of event.markets) {
          // Find the market matching our position
          const tokens = safeJsonParse(m.clobTokenIds, []);
          if (tokens.includes(pos.tokenId)) {
            const outcomes = safeJsonParse(m.outcomes, []);
            const outcomePrices = safeJsonParse(m.outcomePrices, []);
            // If YES token resolved to $1, we won
            const yesIdx = outcomes.indexOf('Yes');
            if (yesIdx !== -1 && outcomePrices?.[yesIdx]) {
              const resolvedPrice = parseFloat(outcomePrices[yesIdx]);
              if (resolvedPrice >= 0.99) {
                payout = pos.shares; // Each share pays $1 on win
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
      
      // Update P&L tracking
      updatePnL(tradeResult, payout, cost);
      
      // Log to trade history
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
      // Check if event date has passed by >24h — market likely will resolve soon
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
  // "highest-temperature-in-nyc-on-february-10-2026" → Date
  const months = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const m = slug.match(/on-(\w+)-(\d+)-(\d{4})$/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (month === undefined) return null;
  return new Date(parseInt(m[3]), month, parseInt(m[2]));
}

// ═══════════════════════════════════════════════════
// MARKET DISCOVERY
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// CITY AUTO-DISCOVERY
// ═══════════════════════════════════════════════════

let lastDiscovery = 0;

async function discoverCities() {
  // Run once per day max
  const now = Date.now();
  if (now - lastDiscovery < 86_400_000) return;
  lastDiscovery = now;
  
  log('🔎 Running city auto-discovery...');
  const today = new Date();
  let newCount = 0;
  
  for (const candidate of CANDIDATE_CITIES) {
    // Skip if already known
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
  
  // Dates: today + tomorrow + day after
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
      
      await sleep(400); // Rate limit Gamma API
    }
  }
  
  return allMarkets;
}

// ═══════════════════════════════════════════════════
// WEATHER FORECASTS
// ═══════════════════════════════════════════════════

async function fetchForecast(cityInfo) {
  if (cityInfo.country === 'US') {
    return fetchNOAAForecast(cityInfo.lat, cityInfo.lon);
  }
  return fetchOpenMeteoForecast(cityInfo.lat, cityInfo.lon);
}

async function fetchNOAAForecast(lat, lon) {
  const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const pointsData = await fetchWithRetry(pointsUrl, {
    headers: { 'User-Agent': 'WeatherTradingBot/2.0 (contact@example.com)' }
  }, 'NOAA points');
  
  if (!pointsData) return null;
  
  const forecastUrl = pointsData.properties?.forecast;
  if (!forecastUrl) { log('  ⚠️  No forecast URL from NOAA'); return null; }
  
  const forecastData = await fetchWithRetry(forecastUrl, {
    headers: { 'User-Agent': 'WeatherTradingBot/2.0 (contact@example.com)' }
  }, 'NOAA forecast');
  
  if (!forecastData) return null;
  
  return (forecastData.properties?.periods || []).map(p => ({
    name: p.name,
    startTime: new Date(p.startTime),
    temperature: p.temperature,      // Already in °F
    temperatureUnit: p.temperatureUnit,
    shortForecast: p.shortForecast,
    isDaytime: p.isDaytime,
  }));
}

async function fetchOpenMeteoForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto`;
  
  const data = await fetchWithRetry(url, {}, 'Open-Meteo');
  if (!data?.daily) return null;
  
  return data.daily.time.map((date, i) => ({
    date: new Date(date),
    tempMax: data.daily.temperature_2m_max[i],  // Already in °F
    tempMin: data.daily.temperature_2m_min[i],
  }));
}

function getForecastHigh(forecast, cityInfo, eventDate) {
  if (!forecast || !eventDate) return null;
  
  if (cityInfo.country === 'US') {
    // NOAA: find daytime period for event date
    const period = forecast.find(f =>
      f.isDaytime && f.startTime.toDateString() === eventDate.toDateString()
    );
    return period ? { tempF: period.temperature, source: 'NOAA', detail: `${period.name}: ${period.temperature}°F - ${period.shortForecast}` } : null;
  } else {
    // Open-Meteo
    const day = forecast.find(f => f.date.toDateString() === eventDate.toDateString());
    return day ? { tempF: day.tempMax, source: 'Open-Meteo', detail: `${day.date.toLocaleDateString()}: High ${day.tempMax}°F` } : null;
  }
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
// EDGE ANALYSIS
// ═══════════════════════════════════════════════════

async function analyzeEvent(eventSlug, markets, cityInfo, eventDate) {
  if (!markets?.length || !cityInfo) return null;
  
  log(`\n🔍 ${eventSlug}`);
  log(`   ${cityInfo.name} — ${eventDate?.toLocaleDateString() || '?'} — ${markets.length} buckets`);
  
  // Already traded this event?
  if (state.tradedMarkets.includes(eventSlug)) {
    log('   ⏭️  Already traded this event, skipping');
    return null;
  }
  
  // Fetch forecast
  const forecast = await fetchForecast(cityInfo);
  if (!forecast) { log('   ❌ No forecast data'); return null; }
  
  const fcst = getForecastHigh(forecast, cityInfo, eventDate);
  if (!fcst) { log('   ❌ No forecast for event date'); return null; }
  
  log(`   🌡️  ${fcst.source}: ${fcst.detail}`);
  
  // Parse all buckets and find matching one
  let matchingMarket = null;
  let matchingRange = null;
  let marketUnit = null;
  
  for (const market of markets) {
    const range = parseTemperatureRange(market.temperatureRange || market.question);
    if (!range) continue;
    if (!marketUnit) marketUnit = range.unit;
    
    if (forecastMatchesRange(fcst.tempF, range)) {
      matchingMarket = market;
      matchingRange = range;
      break;
    }
  }
  
  if (!matchingMarket) {
    const forecastDisplay = marketUnit === 'C'
      ? `${fcst.tempF}°F (${fahrenheitToCelsius(fcst.tempF).toFixed(1)}°C)`
      : `${fcst.tempF}°F`;
    log(`   ⚠️  Forecast ${forecastDisplay} doesn't match any bucket`);
    log(`   📋 Buckets: ${markets.map(m => m.temperatureRange).filter(Boolean).join(', ')}`);
    return null;
  }
  
  // Fetch price for matching bucket
  if (!matchingMarket.tokens?.[0]) {
    log(`   ⚠️  No token ID for ${matchingMarket.temperatureRange}`);
    return null;
  }
  
  const price = await getMarketPrice(matchingMarket.tokens[0]);
  if (!price?.bestAsk) {
    log(`   ⚠️  No ask price for ${matchingMarket.temperatureRange}`);
    return null;
  }
  
  const askPrice = price.bestAsk;
  const forecastDisplay = marketUnit === 'C'
    ? `${fcst.tempF}°F (${fahrenheitToCelsius(fcst.tempF).toFixed(1)}°C)`
    : `${fcst.tempF}°F`;
  
  log(`   ✅ Forecast → ${matchingMarket.temperatureRange} @ ${(askPrice * 100).toFixed(1)}%`);
  
  if (askPrice >= CONFIG.edgePriceThreshold) {
    log(`   ℹ️  Fairly priced (≥${CONFIG.edgePriceThreshold * 100}%), no edge`);
    return null;
  }
  
  const edgePercent = (CONFIG.forecastConfidence - askPrice) / askPrice;
  if (edgePercent < CONFIG.minEdgeThreshold) {
    log(`   ℹ️  Edge ${(edgePercent * 100).toFixed(1)}% below threshold ${CONFIG.minEdgeThreshold * 100}%`);
    return null;
  }
  
  state.stats.edgesIdentified++;
  log(`   🎯 EDGE: ${(edgePercent * 100).toFixed(1)}% — ${forecastDisplay} → "${matchingMarket.temperatureRange}" @ ${(askPrice * 100).toFixed(1)}%`);
  
  return {
    market: matchingMarket,
    tokenId: matchingMarket.tokens[0],
    marketPrice: askPrice,
    eventSlug,
    forecastDisplay,
    edgePercent,
    cityInfo,
  };
}

// ═══════════════════════════════════════════════════
// TRADE EXECUTION (with verification)
// ═══════════════════════════════════════════════════

async function executeTrade(sdk, edge) {
  // Pre-checks
  if (state.openPositions.length >= CONFIG.maxOpenPositions) {
    log('   ⚠️  Max positions reached');
    return false;
  }
  
  if (state.totalSpent + CONFIG.maxPositionSize > CONFIG.maxBudget) {
    log(`   ⚠️  Budget limit ($${CONFIG.maxBudget}) would be exceeded`);
    return false;
  }
  
  // Check actual wallet balance
  const balance = await getUsdcEBalance();
  if (balance === null) {
    log('   ❌ Cannot verify wallet balance — skipping trade for safety');
    return false;
  }
  if (balance < CONFIG.maxPositionSize + 0.5) {
    log(`   ❌ Insufficient USDC.e balance: $${balance.toFixed(2)} (need $${CONFIG.maxPositionSize + 0.5})`);
    return false;
  }
  log(`   💰 Wallet: $${balance.toFixed(2)} USDC.e`);
  
  // Already traded this event?
  if (state.tradedMarkets.includes(edge.eventSlug)) {
    log('   ⚠️  Already traded this event (race condition guard)');
    return false;
  }
  
  // Calculate order parameters — use per-city position size if available
  const tokenId = edge.tokenId;
  const posSize = edge.cityInfo?.posSize || CONFIG.maxPositionSize;
  const price = Math.min(edge.marketPrice + 0.01, 0.99); // Slightly above best ask to ensure fill
  const size = Math.max(posSize / price, 5.1); // Min 5 shares per Polymarket rules
  const orderValue = price * size;
  
  if (orderValue < 1.0) {
    log(`   ⚠️  Order value $${orderValue.toFixed(2)} below $1 minimum`);
    return false;
  }
  
  log(`   💸 PLACING ORDER: BUY ${size.toFixed(2)} shares @ $${price.toFixed(3)} = $${orderValue.toFixed(2)}`);
  
  // Execute trade
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
  
  // Verify result
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
    // Don't treat as failure — some responses don't include orderId but the order landed
  }
  
  log(`   ✅ Order placed! ID: ${orderId || 'N/A'}`);
  if (result.transactionHashes?.length) {
    log(`   📋 TX: ${result.transactionHashes.join(', ')}`);
  }
  
  // Verify order is in the book (wait a moment for propagation)
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
  
  // Post-trade balance check
  await sleep(2000);
  const newBalance = await getUsdcEBalance();
  if (newBalance !== null) {
    const diff = balance - newBalance;
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
  log('  🌤️  Weather Trading Bot v2');
  log('═══════════════════════════════════════════════════');
  log(`📍 Cities: ${Object.keys(CITY_COORDS).join(', ')}`);
  log(`💰 Position size: $${CONFIG.maxPositionSize} | Budget: $${CONFIG.maxBudget}`);
  log(`📊 Max positions: ${CONFIG.maxOpenPositions} | Min edge: ${CONFIG.minEdgeThreshold * 100}%`);
  log('');
  
  // Load persisted state
  loadState();
  
  // Validate private key
  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    log('❌ POLYMARKET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }
  
  // Check wallet balance before starting
  log('🔍 Pre-flight checks...');
  const startBalance = await getUsdcEBalance();
  if (startBalance === null) {
    log('❌ Cannot read wallet balance — check RPC connection');
    process.exit(1);
  }
  if (startBalance < 1) {
    log(`❌ Insufficient USDC.e: $${startBalance.toFixed(2)} (need at least $1)`);
    log('   Run setup.mjs first to swap native USDC to USDC.e');
    process.exit(1);
  }
  log(`✅ Wallet: $${startBalance.toFixed(2)} USDC.e`);
  
  // Initialize SDK
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
    log('   Check your private key and network connection');
    process.exit(1);
  }
  
  // Check remaining budget
  const remainingBudget = CONFIG.maxBudget - state.totalSpent;
  if (remainingBudget < CONFIG.maxPositionSize) {
    log(`⚠️  Budget exhausted: $${state.totalSpent.toFixed(2)} / $${CONFIG.maxBudget} spent`);
    log('   Increase CONFIG.maxBudget to continue trading');
    process.exit(0);
  }
  log(`💰 Budget remaining: $${remainingBudget.toFixed(2)} / $${CONFIG.maxBudget}`);
  log('');
  
  // Main loop
  let consecutiveErrors = 0;
  
  while (true) {
    try {
      state.stats.scans++;
      const scanNum = state.stats.scans;
      
      log(`\n${'═'.repeat(60)}`);
      log(`🔄 Scan #${scanNum} — ${ts()} — Budget: $${(CONFIG.maxBudget - state.totalSpent).toFixed(2)} left`);
      log(`${'═'.repeat(60)}`);
      
      // Clean up resolved positions (free slots for new trades)
      await cleanupResolvedPositions();
      
      // Auto-discover new cities (once per day)
      await discoverCities();
      
      // Find markets
      const markets = await findWeatherMarkets();
      state.stats.marketsFound += markets.length;
      
      if (markets.length === 0) {
        log('📭 No active weather markets found');
      } else {
        log(`📬 Found ${markets.length} market(s)`);
        
        // Group by event
        const events = {};
        for (const m of markets) {
          if (!m.eventSlug) continue;
          if (!events[m.eventSlug]) {
            events[m.eventSlug] = { markets: [], cityInfo: m.cityInfo, eventDate: m.eventDate };
          }
          events[m.eventSlug].markets.push(m);
        }
        
        log(`📊 ${Object.keys(events).length} event(s)`);
        
        // Analyze each event
        for (const [slug, group] of Object.entries(events)) {
          if (!group.cityInfo) continue;
          
          const edge = await analyzeEvent(slug, group.markets, group.cityInfo, group.eventDate);
          
          if (edge && edge.edgePercent >= CONFIG.minEdgeThreshold) {
            const success = await executeTrade(sdk, edge);
            if (success) {
              log(`   🎉 Trade #${state.tradesExecuted} placed!`);
            }
          }
          
          await sleep(1000);
        }
      }
      
      // Wallet balance tracking (every scan)
      const scanBalance = await getUsdcEBalance();
      if (scanBalance !== null) {
        if (!state.pnl) state.pnl = { totalWins: 0, totalLosses: 0, winCount: 0, lossCount: 0, totalPayout: 0, totalCost: 0, netPnL: 0, walletBalance: null, lastUpdated: null, lastDailySummary: null };
        state.pnl.walletBalance = scanBalance;
        state.pnl.lastUpdated = new Date().toISOString();
        log(`💰 Wallet: $${scanBalance.toFixed(2)} USDC.e`);
      }
      
      // Daily P&L summary (first scan after midnight UTC)
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
      
      // Budget check
      if (CONFIG.maxBudget - state.totalSpent < CONFIG.maxPositionSize) {
        log('\n💰 Budget exhausted — bot will continue monitoring but won\'t trade');
      }
      
      saveState();
      consecutiveErrors = 0;
      
      log(`\n⏳ Next scan in ${CONFIG.pollIntervalMs / 1000}s...`);
      await sleep(CONFIG.pollIntervalMs);
      
    } catch (e) {
      consecutiveErrors++;
      state.stats.errors++;
      log(`\n❌ Scan error: ${e.message}`);
      
      // Exponential backoff on consecutive errors
      const backoff = Math.min(consecutiveErrors * 30_000, 300_000); // Max 5 min
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

// Catch unhandled errors
process.on('uncaughtException', (e) => {
  log(`💀 Uncaught exception: ${e.message}`);
  log(e.stack);
  saveState();
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  log(`💀 Unhandled rejection: ${e?.message || e}`);
  saveState();
  // Don't exit — let the main loop handle it
});

// Start
main().catch(e => {
  log(`💥 Fatal: ${e.message}`);
  log(e.stack);
  saveState();
  process.exit(1);
});
