#!/usr/bin/env node

/**
 * Fetch Historical Resolved Weather Markets from Polymarket
 * ==========================================================
 * 
 * Queries Gamma API for temperature markets from late Jan - early Feb 2026
 * Focuses on cities we currently trade
 */

import { writeFileSync } from 'fs';

const GAMMA_HOST = 'https://gamma-api.polymarket.com';

const CITIES = {
  'nyc': 'New York City',
  'london': 'London',
  'seoul': 'Seoul',
  'dallas': 'Dallas',
  'seattle': 'Seattle',
  'ankara': 'Ankara',
  'wellington': 'Wellington',
  'miami': 'Miami',
  'chicago': 'Chicago',
  'toronto': 'Toronto',
  'atlanta': 'Atlanta',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      
      if (!resp.ok) {
        console.log(`  ⚠️  HTTP ${resp.status} for ${url}`);
        if (i < retries - 1) {
          await sleep(5000);
          continue;
        }
        return null;
      }
      
      return await resp.json();
    } catch (e) {
      console.log(`  ⚠️  Fetch error: ${e.message}`);
      if (i < retries - 1) {
        await sleep(5000);
        continue;
      }
      return null;
    }
  }
  return null;
}

function generateSlug(city, date) {
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                      'july', 'august', 'september', 'october', 'november', 'december'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `highest-temperature-in-${city}-on-${month}-${day}-${year}`;
}

function safeJsonParse(val, fallback) {
  if (typeof val !== 'string') return val || fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

async function fetchEventBySlug(slug) {
  const data = await fetchWithRetry(`${GAMMA_HOST}/events?slug=${slug}`);
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  
  const event = data[0];
  return {
    slug,
    title: event.title,
    closed: event.closed,
    endDate: event.endDate,
    markets: (event.markets || []).map(m => ({
      conditionId: m.conditionId,
      question: m.question,
      slug: m.slug,
      active: m.active,
      closed: m.closed,
      endDate: m.endDate,
      outcomes: safeJsonParse(m.outcomes, []),
      outcomePrices: safeJsonParse(m.outcomePrices, []),
      tokens: safeJsonParse(m.clobTokenIds, []),
      temperatureRange: m.groupItemTitle || m.outcome,
      volume: m.volume,
      liquidity: m.liquidity,
    }))
  };
}

async function main() {
  console.log('🔍 Fetching historical weather markets...\n');
  
  const allMarkets = [];
  
  // Date range: Jan 20 - Feb 12, 2026
  const startDate = new Date('2026-01-20');
  const endDate = new Date('2026-02-12');
  
  for (const [citySlug, cityName] of Object.entries(CITIES)) {
    console.log(`\n📍 ${cityName} (${citySlug})`);
    
    let foundCount = 0;
    
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const slug = generateSlug(citySlug, d);
      const event = await fetchEventBySlug(slug);
      
      if (event && event.closed) {
        console.log(`   ✅ ${slug} — ${event.markets.length} markets (CLOSED)`);
        
        allMarkets.push({
          city: citySlug,
          cityName,
          eventSlug: slug,
          date: d.toISOString().split('T')[0],
          ...event,
        });
        
        foundCount++;
      }
      
      await sleep(500); // Rate limiting
    }
    
    console.log(`   → Found ${foundCount} resolved markets`);
  }
  
  console.log(`\n\n📊 SUMMARY`);
  console.log(`═══════════════════════════════════════`);
  console.log(`Total resolved markets: ${allMarkets.length}`);
  console.log(`Cities covered: ${new Set(allMarkets.map(m => m.city)).size}`);
  console.log(`Date range: ${allMarkets[0]?.date || 'N/A'} to ${allMarkets[allMarkets.length - 1]?.date || 'N/A'}`);
  
  // Save results
  const outputPath = './backtest/historical-markets.json';
  writeFileSync(outputPath, JSON.stringify(allMarkets, null, 2));
  console.log(`\n💾 Saved to ${outputPath}`);
  
  // Summary by city
  console.log(`\n📍 By City:`);
  for (const city of Object.keys(CITIES)) {
    const count = allMarkets.filter(m => m.city === city).length;
    console.log(`   ${CITIES[city]}: ${count}`);
  }
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
