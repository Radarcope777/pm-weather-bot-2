import 'dotenv/config';
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
import { writeFileSync, appendFileSync } from 'fs';

/**
 * Weather Trading Bot for Polymarket
 * Exploits informational edge between NOAA/Open-Meteo forecasts and market prices
 */

const POLL_INTERVAL_MS = 120000; // 2 minutes
const MAX_POSITION_SIZE = 2; // Max $2 per position
const MAX_OPEN_POSITIONS = 5;
const MIN_EDGE_THRESHOLD = 0.15; // 15% edge minimum
const LOG_FILE = 'weather-bot.log';

// City coordinates for weather API
// Slug format: highest-temperature-in-{city}-on-{month}-{day}-{year}
const CITY_COORDS = {
  'nyc': { lat: 40.7128, lon: -74.0060, country: 'US', name: 'New York City', slug: 'nyc' },
  'london': { lat: 51.5074, lon: -0.1278, country: 'UK', name: 'London', slug: 'london' },
  'seoul': { lat: 37.5665, lon: 126.9780, country: 'KR', name: 'Seoul', slug: 'seoul' },
  'dallas': { lat: 32.7767, lon: -96.7970, country: 'US', name: 'Dallas', slug: 'dallas' },
  'seattle': { lat: 47.6062, lon: -122.3321, country: 'US', name: 'Seattle', slug: 'seattle' },
  'ankara': { lat: 39.9334, lon: 32.8597, country: 'TR', name: 'Ankara', slug: 'ankara' },
  'wellington': { lat: -41.2865, lon: 174.7762, country: 'NZ', name: 'Wellington', slug: 'wellington' },
};

let openPositions = [];
let stats = { 
  scans: 0, 
  marketsFound: 0, 
  edgesIdentified: 0, 
  tradesExecuted: 0, 
  totalSpent: 0 
};

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  console.log(line.trim());
  appendFileSync(LOG_FILE, line);
}

function ts() {
  return new Date().toLocaleTimeString('de-DE');
}

/**
 * Generate event slug for a city and date
 */
function generateSlug(city, date) {
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                      'july', 'august', 'september', 'october', 'november', 'december'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `highest-temperature-in-${city}-on-${month}-${day}-${year}`;
}

/**
 * Fetch event by slug from Gamma API
 */
async function fetchEventBySlug(slug) {
  try {
    const response = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const events = await response.json();
    
    if (!events || events.length === 0) {
      return null;
    }
    
    const event = events[0];
    
    // Extract markets from the event
    const markets = event.markets || [];
    return {
      eventSlug: slug,
      title: event.title,
      description: event.description,
      markets: markets.map(m => ({
        conditionId: m.conditionId,
        question: m.question,
        slug: m.slug,
        description: m.description,
        endDate: new Date(m.endDate),
        tokens: m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [],
        outcomes: typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []),
        volume: m.volume24hr,
        active: m.active,
        temperatureRange: m.groupItemTitle || m.outcome // The temperature range like "24-25°F"
      }))
    };
  } catch (e) {
    log(`⚠️  Error fetching event ${slug}: ${e.message}`);
    return null;
  }
}

/**
 * Search for weather markets by text search (backup method)
 */
async function searchWeatherMarkets() {
  try {
    const queries = ['temperature', 'precipitation'];
    const allEvents = [];
    
    for (const query of queries) {
      const response = await fetch(`https://gamma-api.polymarket.com/events?title=${query}&closed=false&limit=50`);
      const events = await response.json();
      allEvents.push(...events);
    }
    
    // Deduplicate by slug
    const uniqueEvents = [...new Map(allEvents.map(e => [e.slug, e])).values()];
    
    return uniqueEvents.map(event => ({
      eventSlug: event.slug,
      title: event.title,
      description: event.description,
      markets: (event.markets || []).map(m => ({
        conditionId: m.conditionId,
        question: m.question,
        slug: m.slug,
        description: m.description,
        endDate: new Date(m.endDate),
        tokens: m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [],
        outcomes: typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []),
        volume: m.volume24hr,
        active: m.active,
        temperatureRange: m.groupItemTitle || m.outcome
      }))
    }));
  } catch (e) {
    log(`❌ Error searching markets: ${e.message}`);
    return [];
  }
}

/**
 * Discover weather markets for known cities and dates
 */
async function findWeatherMarkets() {
  const events = [];
  
  // Generate dates: today, tomorrow, day after
  const dates = [
    new Date(),
    new Date(Date.now() + 86400000),
    new Date(Date.now() + 2 * 86400000)
  ];
  
  log(`🔍 Searching for temperature markets...`);
  
  // Try slug-based discovery for each city/date combo
  for (const [cityKey, cityInfo] of Object.entries(CITY_COORDS)) {
    for (const date of dates) {
      const slug = generateSlug(cityInfo.slug, date);
      const event = await fetchEventBySlug(slug);
      
      if (event && event.markets.length > 0) {
        log(`   ✅ Found: ${slug} (${event.markets.length} markets)`);
        events.push({
          ...event,
          city: cityKey,
          cityInfo,
          date: date
        });
      }
      
      // Rate limiting
      await new Promise(r => setTimeout(r, 300));
    }
  }
  
  // Also do text search as backup
  log(`🔍 Doing text search for additional markets...`);
  const searchResults = await searchWeatherMarkets();
  
  for (const event of searchResults) {
    // Check if we already have this event
    const exists = events.some(e => e.eventSlug === event.eventSlug);
    if (!exists && event.markets.length > 0) {
      log(`   ✅ Found via search: ${event.eventSlug} (${event.markets.length} markets)`);
      
      // Try to extract city from slug
      let city = null;
      let cityInfo = null;
      for (const [key, info] of Object.entries(CITY_COORDS)) {
        if (event.eventSlug.includes(info.slug)) {
          city = key;
          cityInfo = info;
          break;
        }
      }
      
      events.push({
        ...event,
        city,
        cityInfo
      });
    }
  }
  
  // Flatten to market list
  const markets = [];
  for (const event of events) {
    for (const market of event.markets) {
      markets.push({
        ...market,
        eventSlug: event.eventSlug,
        city: event.city,
        cityInfo: event.cityInfo,
        eventDate: event.date
      });
    }
  }
  
  return markets;
}

/**
 * Fetch NOAA weather forecast for US cities
 */
async function fetchNOAAForecast(lat, lon) {
  try {
    // Step 1: Get forecast URL for coordinates
    const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
    const pointsResp = await fetch(pointsUrl, {
      headers: { 'User-Agent': 'WeatherTradingBot/1.0' }
    });
    
    if (!pointsResp.ok) {
      throw new Error(`NOAA points API: ${pointsResp.status}`);
    }
    
    const pointsData = await pointsResp.json();
    const forecastUrl = pointsData.properties.forecast;
    
    // Step 2: Get actual forecast
    const forecastResp = await fetch(forecastUrl, {
      headers: { 'User-Agent': 'WeatherTradingBot/1.0' }
    });
    
    if (!forecastResp.ok) {
      throw new Error(`NOAA forecast API: ${forecastResp.status}`);
    }
    
    const forecastData = await forecastResp.json();
    const periods = forecastData.properties.periods;
    
    // Parse forecast periods
    const forecasts = periods.map(p => ({
      name: p.name,
      startTime: new Date(p.startTime),
      endTime: new Date(p.endTime),
      temperature: p.temperature,
      temperatureUnit: p.temperatureUnit,
      shortForecast: p.shortForecast,
      isDaytime: p.isDaytime
    }));
    
    return forecasts;
  } catch (e) {
    log(`❌ NOAA API error: ${e.message}`);
    return null;
  }
}

/**
 * Fetch Open-Meteo forecast for international cities
 */
async function fetchOpenMeteoForecast(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto`;
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Open-Meteo API: ${response.status}`);
    }
    
    const data = await response.json();
    const daily = data.daily;
    
    const forecasts = daily.time.map((date, i) => ({
      date: new Date(date),
      tempMax: daily.temperature_2m_max[i],
      tempMin: daily.temperature_2m_min[i],
      precipProb: daily.precipitation_probability_max[i]
    }));
    
    return forecasts;
  } catch (e) {
    log(`❌ Open-Meteo API error: ${e.message}`);
    return null;
  }
}

/**
 * Extract city and temperature/precipitation info from market question
 */
function parseMarketQuestion(question) {
  const text = question.toLowerCase();
  
  // Try to find city
  let city = null;
  let cityInfo = null;
  for (const [key, info] of Object.entries(CITY_COORDS)) {
    if (text.includes(key)) {
      city = key;
      cityInfo = info;
      break;
    }
  }
  
  // Check for precipitation market
  const precipRegex = /(\d+(?:\.\d+)?)\s*(?:to|and|-)?\s*(\d+(?:\.\d+)?)\s*inches.*precipitation/i;
  const precipMatch = text.match(precipRegex);
  
  // Try to extract temperature threshold
  const tempRegex = /(\d+)\s*°?\s*(f|fahrenheit|c|celsius)?/gi;
  const tempMatches = [...text.matchAll(tempRegex)];
  
  // Try to determine if it's "above" or "below"
  const isAbove = text.includes('above') || text.includes('over') || text.includes('higher');
  const isBelow = text.includes('below') || text.includes('under') || text.includes('lower');
  
  // Try to determine if it's high or low temp
  const isHigh = text.includes('high') && !text.includes('low');
  const isLow = text.includes('low') && !text.includes('high');
  
  // Determine market type
  let marketType = 'unknown';
  if (precipMatch) marketType = 'precipitation';
  else if (tempMatches.length > 0) marketType = 'temperature';
  
  return {
    city,
    cityInfo,
    marketType,
    precipitation: precipMatch ? {
      min: parseFloat(precipMatch[1]),
      max: parseFloat(precipMatch[2] || precipMatch[1])
    } : null,
    tempThresholds: tempMatches.map(m => ({
      value: parseInt(m[1]),
      unit: m[2]?.toLowerCase() || 'f'
    })),
    isAbove,
    isBelow,
    isHigh,
    isLow
  };
}

/**
 * Fetch current market prices for a market
 */
async function getMarketPrices(tokenIds) {
  try {
    const books = await Promise.all(
      tokenIds.map(async tokenId => {
        const response = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        const book = await response.json();
        
        const bestAsk = book.asks?.length ? Math.min(...book.asks.map(a => parseFloat(a.price))) : null;
        const bestBid = book.bids?.length ? Math.max(...book.bids.map(b => parseFloat(b.price))) : null;
        
        return { tokenId, bestAsk, bestBid };
      })
    );
    
    return books;
  } catch (e) {
    log(`❌ Error fetching market prices: ${e.message}`);
    return null;
  }
}

/**
 * Convert Fahrenheit to Celsius
 */
function fahrenheitToCelsius(f) {
  return (f - 32) * 5 / 9;
}

/**
 * Convert Celsius to Fahrenheit
 */
function celsiusToFahrenheit(c) {
  return c * 9 / 5 + 32;
}

/**
 * Parse temperature range from outcome text
 * Returns range in the original unit (F or C) plus the unit indicator
 */
function parseTemperatureRange(outcome) {
  // Examples: "24-25°F", "23°F or below", "34°F or above"
  // Also handles: "10-11°C", "13°C or higher", "5°C or lower"
  // Also handles single degrees: "8°C", "9°C", "10°C"
  
  // Try Fahrenheit range
  let rangeMatch = outcome.match(/(\d+)-(\d+)\s*°?\s*F/i);
  if (rangeMatch) {
    return {
      type: 'range',
      min: parseInt(rangeMatch[1]),
      max: parseInt(rangeMatch[2]),
      unit: 'F'
    };
  }
  
  // Try Celsius range
  rangeMatch = outcome.match(/(\d+)-(\d+)\s*°?\s*C/i);
  if (rangeMatch) {
    return {
      type: 'range',
      min: parseInt(rangeMatch[1]),
      max: parseInt(rangeMatch[2]),
      unit: 'C'
    };
  }
  
  // Try Fahrenheit "or below" / "or lower"
  let belowMatch = outcome.match(/(\d+)\s*°?\s*F\s+or\s+(below|lower)/i);
  if (belowMatch) {
    return {
      type: 'below',
      threshold: parseInt(belowMatch[1]),
      unit: 'F'
    };
  }
  
  // Try Celsius "or below" / "or lower"
  belowMatch = outcome.match(/(\d+)\s*°?\s*C\s+or\s+(below|lower)/i);
  if (belowMatch) {
    return {
      type: 'below',
      threshold: parseInt(belowMatch[1]),
      unit: 'C'
    };
  }
  
  // Try Fahrenheit "or above" / "or higher"
  let aboveMatch = outcome.match(/(\d+)\s*°?\s*F\s+or\s+(above|higher)/i);
  if (aboveMatch) {
    return {
      type: 'above',
      threshold: parseInt(aboveMatch[1]),
      unit: 'F'
    };
  }
  
  // Try Celsius "or above" / "or higher"
  aboveMatch = outcome.match(/(\d+)\s*°?\s*C\s+or\s+(above|higher)/i);
  if (aboveMatch) {
    return {
      type: 'above',
      threshold: parseInt(aboveMatch[1]),
      unit: 'C'
    };
  }
  
  // Try single Fahrenheit degree (e.g., "25°F")
  let singleMatch = outcome.match(/^(\d+)\s*°?\s*F$/i);
  if (singleMatch) {
    return {
      type: 'exact',
      value: parseInt(singleMatch[1]),
      unit: 'F'
    };
  }
  
  // Try single Celsius degree (e.g., "10°C")
  singleMatch = outcome.match(/^(\d+)\s*°?\s*C$/i);
  if (singleMatch) {
    return {
      type: 'exact',
      value: parseInt(singleMatch[1]),
      unit: 'C'
    };
  }
  
  return null;
}

/**
 * Analyze all markets for a temperature event together
 */
async function analyzeTemperatureEvent(eventSlug, markets, cityInfo, eventDate) {
  if (!markets || markets.length === 0) return null;
  
  log(`\n🔍 Analyzing event: ${eventSlug}`);
  log(`   City: ${cityInfo.name}`);
  log(`   Date: ${eventDate ? eventDate.toLocaleDateString() : 'Unknown'}`);
  log(`   Markets: ${markets.length} temperature ranges`);
  
  // Fetch weather forecast
  let forecast;
  if (cityInfo.country === 'US') {
    forecast = await fetchNOAAForecast(cityInfo.lat, cityInfo.lon);
  } else {
    forecast = await fetchOpenMeteoForecast(cityInfo.lat, cityInfo.lon);
  }
  
  if (!forecast) {
    log(`   ❌ Could not fetch forecast`);
    return null;
  }
  
  // Get forecast high temp for the event date
  let forecastHigh;
  if (cityInfo.country === 'US') {
    const relevantPeriod = forecast.find(f => 
      f.isDaytime && 
      eventDate && 
      f.startTime.toDateString() === eventDate.toDateString()
    );
    forecastHigh = relevantPeriod?.temperature;
    
    log(`   📅 NOAA Forecast:`);
    const upcoming = forecast.slice(0, 4).filter(f => f.isDaytime);
    upcoming.forEach(f => {
      const marker = eventDate && f.startTime.toDateString() === eventDate.toDateString() ? '👉 ' : '   ';
      log(`   ${marker}${f.name}: ${f.temperature}°${f.temperatureUnit} - ${f.shortForecast}`);
    });
  } else {
    const relevantDay = forecast.find(f => 
      eventDate && 
      f.date.toDateString() === eventDate.toDateString()
    );
    forecastHigh = relevantDay?.tempMax;
    
    log(`   📅 Open-Meteo Forecast:`);
    const upcoming = forecast.slice(0, 3);
    upcoming.forEach(f => {
      const marker = eventDate && f.date.toDateString() === eventDate.toDateString() ? '👉 ' : '   ';
      log(`   ${marker}${f.date.toLocaleDateString()}: High ${f.tempMax}°F, Low ${f.tempMin}°F, Precip ${f.precipProb}%`);
    });
  }
  
  if (!forecastHigh) {
    log(`   ⚠️  Could not find forecast for event date`);
    return null;
  }
  
  log(`   🌡️  Forecast high: ${forecastHigh}°F`);
  log(`   💰 Available markets:`);
  
  // Fetch prices for all markets and parse their ranges
  const outcomes = [];
  let marketUnit = null; // Detect if markets use F or C
  
  for (const market of markets) {
    const range = parseTemperatureRange(market.temperatureRange || market.question);
    if (!range) {
      log(`      ⚠️  Could not parse: ${market.temperatureRange || market.question}`);
      continue;
    }
    
    // Detect unit from first valid range
    if (!marketUnit) {
      marketUnit = range.unit;
      log(`   📏 Markets using: ${marketUnit === 'C' ? 'Celsius' : 'Fahrenheit'}`);
    }
    
    const prices = await getMarketPrices(market.tokens);
    if (!prices || !prices[0]) {
      log(`      ⚠️  No prices for: ${market.temperatureRange}`);
      continue;
    }
    
    const yesPrice = prices[0];
    log(`      ${market.temperatureRange}: Ask ${yesPrice.bestAsk?.toFixed(3) || 'N/A'} / Bid ${yesPrice.bestBid?.toFixed(3) || 'N/A'}`);
    
    outcomes.push({
      market,
      range,
      price: yesPrice,
      tokenId: market.tokens[0]
    });
    
    // Rate limiting
    await new Promise(r => setTimeout(r, 200));
  }
  
  if (outcomes.length === 0) {
    log(`   ❌ No valid markets with prices found`);
    return null;
  }
  
  // Convert forecast to market unit if needed
  let forecastTemp = forecastHigh;
  let forecastTempDisplay = `${forecastHigh}°F`;
  
  if (marketUnit === 'C') {
    forecastTemp = fahrenheitToCelsius(forecastHigh);
    forecastTempDisplay = `${forecastHigh}°F (${forecastTemp.toFixed(1)}°C)`;
    log(`   🔄 Converting forecast: ${forecastTempDisplay}`);
  }
  
  // Find matching bucket
  let matchingOutcome = null;
  for (const outcome of outcomes) {
    const range = outcome.range;
    let isMatch = false;
    
    if (range.type === 'range') {
      // For ranges, check if forecast falls within (inclusive)
      isMatch = forecastTemp >= range.min && forecastTemp <= range.max;
    } else if (range.type === 'below') {
      isMatch = forecastTemp <= range.threshold;
    } else if (range.type === 'above') {
      isMatch = forecastTemp >= range.threshold;
    } else if (range.type === 'exact') {
      // For exact matches, round to nearest integer
      const rounded = Math.round(forecastTemp);
      isMatch = rounded === range.value;
    }
    
    if (isMatch) {
      matchingOutcome = outcome;
      break;
    }
  }
  
  if (!matchingOutcome) {
    log(`   ⚠️  Forecast ${forecastTempDisplay} doesn't match any available bucket`);
    log(`   📋 Available buckets: ${outcomes.map(o => o.market.temperatureRange).join(', ')}`);
    return null;
  }
  
  const askPrice = matchingOutcome.price?.bestAsk;
  if (!askPrice) {
    log(`   ⚠️  No ask price for matching bucket`);
    return null;
  }
  
  log(`   ✅ Forecast matches: ${matchingOutcome.market.temperatureRange}`);
  log(`   📊 Trading at: ${(askPrice * 100).toFixed(1)}%`);
  
  // Check for edge
  const EDGE_PRICE_THRESHOLD = 0.60;
  if (askPrice < EDGE_PRICE_THRESHOLD) {
    const impliedProbability = 0.80;
    const edgePercent = (impliedProbability - askPrice) / askPrice;
    
    stats.edgesIdentified++;
    log(`   🎯 EDGE DETECTED!`);
    log(`      Forecast: ${forecastTempDisplay} → ${matchingOutcome.market.temperatureRange}`);
    log(`      Market price: ${(askPrice * 100).toFixed(1)}%`);
    log(`      Edge: ${(edgePercent * 100).toFixed(1)}%`);
    
    return {
      market: matchingOutcome.market,
      tokenId: matchingOutcome.tokenId,
      marketPrice: askPrice,
      forecastValue: `${forecastTempDisplay} → ${matchingOutcome.market.temperatureRange}`,
      edgePercent: edgePercent,
      reasoning: `Forecast: ${forecastTempDisplay} in "${matchingOutcome.market.temperatureRange}" range, market only ${(askPrice * 100).toFixed(1)}%`,
      recommendation: `BUY "${matchingOutcome.market.temperatureRange}" @ ${(askPrice * 100).toFixed(1)}%`
    };
  }
  
  log(`   ℹ️  Fairly priced at ${(askPrice * 100).toFixed(1)}% (no edge)`);
  return null;
}

/**
 * Analyze a market and determine if there's an edge (legacy single-market version)
 */
async function analyzeMarket(market) {
  if (!market.cityInfo) {
    log(`⚠️  No city info for market: "${market.question}"`);
    return null;
  }
  
  log(`🔍 Analyzing: ${market.question}`);
  log(`   Event: ${market.eventSlug}`);
  log(`   City: ${market.cityInfo.name}`);
  if (market.eventDate) {
    log(`   Date: ${market.eventDate.toLocaleDateString()}`);
  }
  
  // Fetch weather forecast
  let forecast;
  if (market.cityInfo.country === 'US') {
    forecast = await fetchNOAAForecast(market.cityInfo.lat, market.cityInfo.lon);
  } else {
    forecast = await fetchOpenMeteoForecast(market.cityInfo.lat, market.cityInfo.lon);
  }
  
  if (!forecast) {
    log(`   ❌ Could not fetch forecast`);
    return null;
  }
  
  // Get market prices
  const prices = await getMarketPrices(market.tokens);
  if (!prices) {
    log(`   ❌ Could not fetch market prices`);
    return null;
  }
  
  // Get forecast high temp for the event date
  let forecastHigh;
  if (market.cityInfo.country === 'US') {
    // NOAA forecast - find the daytime period for the event date
    const relevantPeriod = forecast.find(f => 
      f.isDaytime && 
      market.eventDate && 
      f.startTime.toDateString() === market.eventDate.toDateString()
    );
    forecastHigh = relevantPeriod?.temperature;
    
    log(`   📅 NOAA Forecast:`);
    const upcoming = forecast.slice(0, 4).filter(f => f.isDaytime);
    upcoming.forEach(f => {
      const marker = market.eventDate && f.startTime.toDateString() === market.eventDate.toDateString() ? '👉 ' : '   ';
      log(`   ${marker}${f.name}: ${f.temperature}°${f.temperatureUnit} - ${f.shortForecast}`);
    });
  } else {
    // Open-Meteo forecast - find matching date
    const relevantDay = forecast.find(f => 
      market.eventDate && 
      f.date.toDateString() === market.eventDate.toDateString()
    );
    forecastHigh = relevantDay?.tempMax;
    
    log(`   📅 Open-Meteo Forecast:`);
    const upcoming = forecast.slice(0, 3);
    upcoming.forEach(f => {
      const marker = market.eventDate && f.date.toDateString() === market.eventDate.toDateString() ? '👉 ' : '   ';
      log(`   ${marker}${f.date.toLocaleDateString()}: High ${f.tempMax}°F, Low ${f.tempMin}°F, Precip ${f.precipProb}%`);
    });
  }
  
  if (!forecastHigh) {
    log(`   ⚠️  Could not find forecast for event date`);
    return null;
  }
  
  log(`   🌡️  Forecast high: ${forecastHigh}°F`);
  log(`   💰 Market outcome: ${market.temperatureRange || 'Unknown'}`);
  log(`   💰 Market prices:`);
  
  // For temperature events, each market is a single outcome (Yes/No for a specific range)
  // The temperature range is in market.temperatureRange (e.g., "24-25°F")
  const range = parseTemperatureRange(market.temperatureRange || market.question);
  
  market.outcomes.forEach((outcome, i) => {
    const price = prices[i];
    log(`      ${outcome}: Ask ${price?.bestAsk?.toFixed(3) || 'N/A'} / Bid ${price?.bestBid?.toFixed(3) || 'N/A'}`);
  });
  
  if (!range) {
    log(`   ⚠️  Could not parse temperature range from: ${market.temperatureRange || market.question}`);
    return null;
  }
  
  // Build outcome object for the "Yes" outcome (first one)
  const yesOutcome = {
    outcome: market.temperatureRange || market.outcomes[0],
    range: range,
    price: prices[0], // "Yes" price
    tokenId: market.tokens[0] // "Yes" token
  };
  
  // Calculate edge
  const edge = calculateTemperatureEdge(forecastHigh, yesOutcome, market);
  
  if (edge) {
    stats.edgesIdentified++;
    log(`   🎯 EDGE DETECTED: ${edge.reasoning}`);
    log(`      Forecast says: ${edge.forecastValue}`);
    log(`      Market says: ${(edge.marketPrice * 100).toFixed(1)}%`);
    log(`      Edge: ${(edge.edgePercent * 100).toFixed(1)}%`);
    log(`      Recommendation: ${edge.recommendation}`);
    
    return edge;
  }
  
  return null;
}

/**
 * Calculate edge between forecast and market
 */
function calculateEdge(forecast, parsed, prices, market) {
  // Handle precipitation markets
  if (parsed.marketType === 'precipitation' && parsed.precipitation) {
    return calculatePrecipitationEdge(forecast, parsed, prices, market);
  }
  
  // Handle temperature markets
  if (parsed.marketType === 'temperature') {
    return calculateTemperatureEdge(forecast, parsed, prices, market);
  }
  
  log(`   ℹ️  Unknown market type, cannot calculate edge`);
  return null;
}

/**
 * Calculate edge for precipitation markets
 */
function calculatePrecipitationEdge(forecast, parsed, prices, market) {
  // For precipitation markets, we need historical data to estimate probability
  // For now, we can use the forecast data and make a conservative estimate
  
  const targetMin = parsed.precipitation.min;
  const targetMax = parsed.precipitation.max;
  
  log(`   📊 Precipitation market: ${targetMin}-${targetMax} inches`);
  
  // If using Open-Meteo forecast (international or as backup)
  if (Array.isArray(forecast) && forecast[0]?.precipProb !== undefined) {
    const avgPrecipProb = forecast.slice(0, 7).reduce((sum, f) => sum + (f.precipProb || 0), 0) / 7;
    log(`   📈 Average precipitation probability: ${avgPrecipProb.toFixed(1)}%`);
  }
  
  // Historical NYC February precipitation average is ~3.5 inches
  // Range 5-6 inches is above average, probability ~20-25%
  // This would need historical data API or database for accuracy
  
  log(`   ⚠️  Precipitation edge calculation needs historical data (using conservative estimate)`);
  
  // Conservative: assume we don't have enough edge without historical data
  return null;
}

/**
 * Calculate edge for temperature markets
 */
function calculateTemperatureEdge(forecastHigh, outcome, market) {
  if (!outcome || !outcome.range) {
    log(`   ⚠️  No valid outcome/range data`);
    return null;
  }
  
  const range = outcome.range;
  
  // Convert forecast to same unit as market range
  let forecastTemp = forecastHigh;
  let forecastTempDisplay = `${forecastHigh}°F`;
  
  if (range.unit === 'C') {
    forecastTemp = fahrenheitToCelsius(forecastHigh);
    forecastTempDisplay = `${forecastHigh}°F (${forecastTemp.toFixed(1)}°C)`;
  }
  
  let isMatch = false;
  
  // Check if forecast matches this range
  if (range.type === 'range') {
    isMatch = forecastTemp >= range.min && forecastTemp <= range.max;
  } else if (range.type === 'below') {
    isMatch = forecastTemp <= range.threshold;
  } else if (range.type === 'above') {
    isMatch = forecastTemp >= range.threshold;
  } else if (range.type === 'exact') {
    // For exact matches, round to nearest integer
    const rounded = Math.round(forecastTemp);
    isMatch = rounded === range.value;
  }
  
  const askPrice = outcome.price?.bestAsk;
  
  if (!askPrice) {
    log(`   ⚠️  No ask price available`);
    return null;
  }
  
  log(`   📊 Range "${outcome.outcome}" trading at: ${(askPrice * 100).toFixed(1)}%`);
  
  if (!isMatch) {
    log(`   ❌ Forecast ${forecastTempDisplay} doesn't match this range`);
    return null;
  }
  
  log(`   ✅ Forecast ${forecastTempDisplay} matches range: ${outcome.outcome}`);
  
  // Edge threshold: if forecast clearly says this bucket but market is below 60%, that's an edge
  const EDGE_PRICE_THRESHOLD = 0.60;
  
  if (askPrice < EDGE_PRICE_THRESHOLD) {
    const impliedProbability = 0.80; // Forecast confidence (could be more sophisticated)
    const edgePercent = (impliedProbability - askPrice) / askPrice;
    
    return {
      tokenId: outcome.tokenId,
      marketPrice: askPrice,
      forecastValue: `${forecastTempDisplay} → ${outcome.outcome}`,
      edgePercent: edgePercent,
      reasoning: `Forecast: ${forecastTempDisplay} falls in "${outcome.outcome}" range, market only at ${(askPrice * 100).toFixed(1)}%`,
      recommendation: `BUY "${outcome.outcome}" @ ${(askPrice * 100).toFixed(1)}%`
    };
  }
  
  log(`   ℹ️  Range already priced fairly at ${(askPrice * 100).toFixed(1)}% (no edge)`);
  return null;
}

/**
 * Execute a trade
 */
async function executeTrade(sdk, edge, market) {
  if (openPositions.length >= MAX_OPEN_POSITIONS) {
    log(`   ⚠️  Max positions (${MAX_OPEN_POSITIONS}) reached, skipping trade`);
    return false;
  }
  
  if (stats.totalSpent + MAX_POSITION_SIZE > 80) {
    log(`   ⚠️  Budget limit reached, skipping trade`);
    return false;
  }
  
  try {
    const tokenId = edge.tokenId;
    const price = edge.marketPrice;
    const shares = MAX_POSITION_SIZE / price;
    
    log(`   💸 EXECUTING: BUY ${shares.toFixed(2)} shares @ $${price.toFixed(3)}`);
    
    await sdk.tradingService.createLimitOrder({
      tokenId,
      side: 'BUY',
      price: Math.min(price + 0.01, 0.99),
      size: shares,
      orderType: 'GTC'
    });
    
    log(`   ✅ Trade executed (LIVE)`);
    
    openPositions.push({
      market: market.question,
      tokenId,
      shares,
      entryPrice: price,
      timestamp: new Date()
    });
    
    stats.tradesExecuted++;
    stats.totalSpent += MAX_POSITION_SIZE;
    
    return true;
  } catch (e) {
    log(`   ❌ Trade failed: ${e.message}`);
    return false;
  }
}

/**
 * Main bot loop
 */
async function main() {
  log('🌤️  Weather Trading Bot Starting...');
  log(`📍 Monitoring ${Object.keys(CITY_COORDS).length} cities`);
  log(`💰 Max position size: $${MAX_POSITION_SIZE}`);
  log(`📊 Max open positions: ${MAX_OPEN_POSITIONS}`);
  log(`📈 Min edge threshold: ${(MIN_EDGE_THRESHOLD * 100).toFixed(0)}%`);
  log('');
  
  // Initialize SDK
  log('🔑 Initializing wallet...');
  const sdk = await PolymarketSDK.create({ 
    privateKey: process.env.POLYMARKET_PRIVATE_KEY 
  });
  await sdk.tradingService.initialize();
  log('✅ Wallet ready');
  log('');
  
  while (true) {
    try {
      stats.scans++;
      log(`\n${'='.repeat(60)}`);
      log(`🔄 Scan #${stats.scans} - ${ts()}`);
      log(`${'='.repeat(60)}\n`);
      
      // Find weather markets
      const markets = await findWeatherMarkets();
      stats.marketsFound += markets.length;
      
      if (markets.length === 0) {
        log('📭 No active weather markets found');
      } else {
        log(`📬 Found ${markets.length} total market(s)\n`);
        
        // Group markets by event
        const eventGroups = {};
        for (const market of markets) {
          if (!market.eventSlug) continue;
          if (!eventGroups[market.eventSlug]) {
            eventGroups[market.eventSlug] = {
              markets: [],
              cityInfo: market.cityInfo,
              eventDate: market.eventDate
            };
          }
          eventGroups[market.eventSlug].markets.push(market);
        }
        
        const events = Object.keys(eventGroups);
        log(`📊 Grouped into ${events.length} event(s)`);
        
        // Analyze each event (all temperature buckets together)
        for (const eventSlug of events) {
          const group = eventGroups[eventSlug];
          
          // Skip events without city info (from text search that we couldn't map)
          if (!group.cityInfo) {
            log(`\n⚠️  Skipping ${eventSlug}: no city info`);
            continue;
          }
          
          const edge = await analyzeTemperatureEvent(
            eventSlug,
            group.markets,
            group.cityInfo,
            group.eventDate
          );
          
          if (edge && edge.edgePercent >= MIN_EDGE_THRESHOLD) {
            await executeTrade(sdk, edge, edge.market);
          }
          
          // Rate limiting between events
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      
      // Log stats
      log(`\n📊 Stats: ${stats.scans} scans | ${stats.marketsFound} markets | ${stats.edgesIdentified} edges | ${stats.tradesExecuted} trades | $${stats.totalSpent.toFixed(2)} spent`);
      log(`📂 Open positions: ${openPositions.length}`);
      
      if (openPositions.length > 0) {
        openPositions.forEach((pos, i) => {
          log(`   ${i + 1}. ${pos.market.substring(0, 50)}... @ $${pos.entryPrice.toFixed(3)}`);
        });
      }
      
      // Wait before next scan
      log(`\n⏳ Waiting ${POLL_INTERVAL_MS / 1000}s until next scan...\n`);
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      
    } catch (e) {
      log(`❌ Error in main loop: ${e.message}`);
      log(e.stack);
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('\n🛑 Shutting down...');
  log(`📊 Final stats: ${stats.scans} scans | ${stats.marketsFound} markets | ${stats.edgesIdentified} edges | ${stats.tradesExecuted} trades`);
  log(`💰 Total spent: $${stats.totalSpent.toFixed(2)}`);
  log(`📂 Open positions: ${openPositions.length}`);
  process.exit(0);
});

// Start the bot
main().catch(e => {
  log(`💥 Fatal error: ${e.message}`);
  log(e.stack);
  process.exit(1);
});
