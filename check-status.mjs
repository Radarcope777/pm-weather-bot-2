#!/usr/bin/env node
/**
 * Quick status check for weather bot
 */

import { existsSync, readFileSync, statSync } from 'fs';

console.log('🌤️  Polymarket Weather Bot Status Check\n');

// Check files
const files = [
  'weather-bot.mjs',
  'discover-weather-markets.mjs',
  'test-nyc-precip.mjs',
  '.env',
  'README-WEATHER.md'
];

console.log('📂 Files:');
files.forEach(f => {
  const exists = existsSync(f);
  const status = exists ? '✅' : '❌';
  const size = exists ? `(${(statSync(f).size / 1024).toFixed(1)}KB)` : '';
  console.log(`   ${status} ${f} ${size}`);
});
console.log();

// Check .env
if (existsSync('.env')) {
  const env = readFileSync('.env', 'utf-8');
  const hasKey = env.includes('POLYMARKET_PRIVATE_KEY=0x');
  console.log('🔑 Wallet:', hasKey ? '✅ Configured' : '❌ Missing key');
  console.log();
}

// Check log file
if (existsSync('weather-bot.log')) {
  const log = readFileSync('weather-bot.log', 'utf-8');
  const lines = log.split('\n').filter(l => l.trim());
  console.log(`📝 Log: ${lines.length} lines`);
  if (lines.length > 0) {
    console.log(`   Last entry: ${lines[lines.length - 1].substring(0, 80)}`);
  }
  console.log();
}

// Check for active markets
console.log('🔍 Checking for weather markets...');
try {
  const response = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200');
  const markets = await response.json();
  
  const weatherKeywords = ['precipitation', 'weather', 'snow', 'rain', 'storm', 'celsius', 'fahrenheit', '°c', '°f'];
  const weatherMarkets = markets.filter(m => {
    const text = (m.question + ' ' + (m.description || '')).toLowerCase();
    return weatherKeywords.some(kw => text.includes(kw)) && 
           !text.includes('screenplay') && 
           !text.includes('academy');
  });
  
  console.log(`   Found ${weatherMarkets.length} weather market(s)\n`);
  
  if (weatherMarkets.length > 0) {
    weatherMarkets.forEach(m => {
      console.log(`   📊 ${m.question.substring(0, 60)}...`);
      console.log(`      Volume: $${m.volume24hr || '0'} | Ends: ${new Date(m.endDate).toLocaleDateString()}`);
    });
  }
} catch (e) {
  console.log(`   ❌ Error: ${e.message}`);
}
console.log();

// Quick commands
console.log('🎮 Quick Commands:');
console.log('   node weather-bot.mjs          # Run the bot (simulation mode)');
console.log('   node discover-weather-markets.mjs  # Scan for markets');
console.log('   node test-nyc-precip.mjs      # Analyze NYC precipitation market');
console.log('   tail -f weather-bot.log       # Watch logs');
console.log();

console.log('📚 Documentation:');
console.log('   README-WEATHER.md             # User guide');
console.log('   WEATHER-BOT-STATUS.md         # Current status & roadmap');
console.log('   ANALYSIS-NYC-PRECIP.md        # NYC market analysis');
console.log();

console.log('💡 Next Steps:');
console.log('   1. Run discover-weather-markets.mjs to see current markets');
console.log('   2. Wait for temperature markets (easier than precipitation)');
console.log('   3. Add historical weather data API for precipitation markets');
console.log('   4. Enable real trading (uncomment line ~286 in weather-bot.mjs)');
