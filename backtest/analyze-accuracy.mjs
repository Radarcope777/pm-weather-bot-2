#!/usr/bin/env node

/**
 * Analyze Forecast Accuracy
 * ==========================
 * 
 * For each historical market:
 * 1. Get actual temperature from Open-Meteo Historical API
 * 2. Get what the forecast WOULD have been 1-3 days before
 * 3. Calculate forecast bias and accuracy per city
 */

import { readFileSync, writeFileSync } from 'fs';

const CITY_COORDS = {
  'nyc':        { lat: 40.7128, lon: -74.0060,  country: 'US', name: 'New York City' },
  'london':     { lat: 51.5074, lon: -0.1278,   country: 'UK', name: 'London' },
  'seoul':      { lat: 37.5665, lon: 126.9780,  country: 'KR', name: 'Seoul' },
  'dallas':     { lat: 32.7767, lon: -96.7970,  country: 'US', name: 'Dallas' },
  'seattle':    { lat: 47.6062, lon: -122.3321, country: 'US', name: 'Seattle' },
  'ankara':     { lat: 39.9334, lon: 32.8597,   country: 'TR', name: 'Ankara' },
  'wellington': { lat: -41.2865, lon: 174.7762, country: 'NZ', name: 'Wellington' },
  'miami':      { lat: 25.7617, lon: -80.1918,  country: 'US', name: 'Miami' },
  'chicago':    { lat: 41.8781, lon: -87.6298,  country: 'US', name: 'Chicago' },
  'toronto':    { lat: 43.6532, lon: -79.3832,  country: 'CA', name: 'Toronto' },
  'atlanta':    { lat: 33.7490, lon: -84.3880,  country: 'US', name: 'Atlanta' },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        console.log(`  ⚠️  HTTP ${resp.status} for ${url.substring(0, 80)}`);
        if (i < retries - 1) { await sleep(5000); continue; }
        return null;
      }
      return await resp.json();
    } catch (e) {
      console.log(`  ⚠️  Fetch error: ${e.message}`);
      if (i < retries - 1) { await sleep(5000); continue; }
      return null;
    }
  }
  return null;
}

async function getActualTemperature(citySlug, date) {
  const coords = CITY_COORDS[citySlug];
  if (!coords) return null;
  
  const url = `https://archive-api.open-meteo.com/v1/archive?` +
    `latitude=${coords.lat}&longitude=${coords.lon}&` +
    `start_date=${date}&end_date=${date}&` +
    `daily=temperature_2m_max&temperature_unit=fahrenheit`;
  
  const data = await fetchWithRetry(url);
  if (!data?.daily?.temperature_2m_max?.[0]) return null;
  
  return data.daily.temperature_2m_max[0];
}

async function getForecast(citySlug, forecastDate, targetDate) {
  const coords = CITY_COORDS[citySlug];
  if (!coords) return null;
  
  // Open-Meteo forecast API doesn't have historical forecasts
  // We'll use current forecast API as a proxy (which gives us forecast up to 7 days out)
  // For backtesting, we'll use the archive API and ASSUME perfect forecast accuracy
  // In reality, forecasts 1-3 days out have systematic biases we need to discover
  
  // For this backtest, we'll compare actual temps to determine if there's a pattern
  const url = `https://archive-api.open-meteo.com/v1/archive?` +
    `latitude=${coords.lat}&longitude=${coords.lon}&` +
    `start_date=${forecastDate}&end_date=${targetDate}&` +
    `daily=temperature_2m_max&temperature_unit=fahrenheit`;
  
  const data = await fetchWithRetry(url);
  if (!data?.daily?.temperature_2m_max) return null;
  
  // Find the target date in the response
  const targetIdx = data.daily.time.indexOf(targetDate);
  if (targetIdx === -1) return null;
  
  return {
    forecastDate,
    targetDate,
    forecastTemp: data.daily.temperature_2m_max[targetIdx],
    // Note: In real backtesting, this would be the FORECAST value from forecastDate
    // Since we don't have historical forecast data, we're using actual temps
    // This means we need to apply known forecast biases from literature
  };
}

function parseTemperatureRange(text) {
  if (!text) return null;
  
  // "24-25°F", "10-11°C"
  let m = text.match(/(-?\d+)\s*-\s*(-?\d+)\s*°?\s*([FC])/i);
  if (m) return { type: 'range', min: parseInt(m[1]), max: parseInt(m[2]), unit: m[3].toUpperCase() };
  
  // "23°F or below"
  m = text.match(/(-?\d+)\s*°?\s*([FC])\s+or\s+(below|lower)/i);
  if (m) return { type: 'below', threshold: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  // "34°F or above"
  m = text.match(/(-?\d+)\s*°?\s*([FC])\s+or\s+(above|higher)/i);
  if (m) return { type: 'above', threshold: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  // Single degree "10°C"
  m = text.match(/^(-?\d+)\s*°?\s*([FC])$/i);
  if (m) return { type: 'exact', value: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  return null;
}

function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }

function findWinningBucket(actualTempF, markets) {
  for (const market of markets) {
    const range = parseTemperatureRange(market.temperatureRange || market.question);
    if (!range) continue;
    
    let temp = actualTempF;
    if (range.unit === 'C') temp = fahrenheitToCelsius(actualTempF);
    
    let matches = false;
    switch (range.type) {
      case 'range': matches = temp >= range.min && temp <= range.max; break;
      case 'below': matches = temp <= range.threshold; break;
      case 'above': matches = temp >= range.threshold; break;
      case 'exact': matches = Math.round(temp) === range.value; break;
    }
    
    if (matches) {
      return { market, range, actualTemp: temp, actualTempF };
    }
  }
  
  return null;
}

async function main() {
  console.log('📊 Analyzing forecast accuracy...\n');
  
  // Load historical markets
  const markets = JSON.parse(readFileSync('./backtest/historical-markets.json', 'utf-8'));
  console.log(`Loaded ${markets.length} historical markets\n`);
  
  const results = [];
  let processed = 0;
  
  for (const event of markets) {
    processed++;
    console.log(`[${processed}/${markets.length}] ${event.eventSlug}`);
    
    // Get actual temperature
    const actualTemp = await getActualTemperature(event.city, event.date);
    if (!actualTemp) {
      console.log(`   ⚠️  Could not get actual temp`);
      continue;
    }
    
    console.log(`   🌡️  Actual: ${actualTemp.toFixed(1)}°F`);
    
    // Find which bucket won
    const winner = findWinningBucket(actualTemp, event.markets);
    if (!winner) {
      console.log(`   ⚠️  Could not determine winning bucket`);
      continue;
    }
    
    console.log(`   ✅ Winner: ${winner.market.temperatureRange}`);
    
    // Get forecasts from 1, 2, 3 days before
    const eventDate = new Date(event.date);
    const forecasts = [];
    
    for (let daysBack = 1; daysBack <= 3; daysBack++) {
      const forecastDate = new Date(eventDate);
      forecastDate.setDate(forecastDate.getDate() - daysBack);
      const forecastDateStr = forecastDate.toISOString().split('T')[0];
      
      const forecast = await getForecast(event.city, forecastDateStr, event.date);
      if (forecast) {
        forecasts.push({ daysBack, ...forecast });
      }
      
      await sleep(300);
    }
    
    results.push({
      eventSlug: event.eventSlug,
      city: event.city,
      cityName: event.cityName,
      date: event.date,
      actualTempF: actualTemp,
      winningBucket: winner.market.temperatureRange,
      winningRange: winner.range,
      forecasts,
      markets: event.markets,
    });
    
    await sleep(500);
  }
  
  console.log(`\n\n📊 ANALYSIS COMPLETE`);
  console.log(`═══════════════════════════════════════`);
  console.log(`Events analyzed: ${results.length}`);
  
  // Save results
  writeFileSync('./backtest/accuracy-analysis.json', JSON.stringify(results, null, 2));
  console.log(`\n💾 Saved to backtest/accuracy-analysis.json`);
  
  // Calculate statistics by city
  console.log(`\n📍 By City:`);
  const byCity = {};
  
  for (const result of results) {
    if (!byCity[result.city]) {
      byCity[result.city] = { name: result.cityName, count: 0, temps: [] };
    }
    byCity[result.city].count++;
    byCity[result.city].temps.push(result.actualTempF);
  }
  
  for (const [city, data] of Object.entries(byCity)) {
    const avg = data.temps.reduce((a, b) => a + b, 0) / data.temps.length;
    const min = Math.min(...data.temps);
    const max = Math.max(...data.temps);
    console.log(`   ${data.name}: ${data.count} events, avg ${avg.toFixed(1)}°F (${min.toFixed(1)}-${max.toFixed(1)})`);
  }
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
