/**
 * Test script to analyze the NYC precipitation market
 */

async function analyzeNYCPrecip() {
  console.log('🌧️  Analyzing NYC Precipitation Market\n');
  
  // Find the market
  const response = await fetch('https://gamma-api.polymarket.com/markets?slug=will-nyc-have-between-5-and-6-inches-of-precipitation-in-february');
  const markets = await response.json();
  
  if (markets.length === 0) {
    console.log('❌ Market not found');
    return;
  }
  
  const market = markets[0];
  console.log('📊 Market Details:');
  console.log(`   Question: ${market.question}`);
  console.log(`   End Date: ${market.endDate}`);
  console.log(`   Active: ${market.active}, Closed: ${market.closed}`);
  console.log(`   Outcomes: ${market.outcomes}`);
  console.log();
  
  // Get market prices
  const tokens = JSON.parse(market.clobTokenIds);
  console.log('💰 Current Market Prices:');
  
  for (let i = 0; i < tokens.length; i++) {
    const tokenId = tokens[i];
    const bookResp = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    const book = await bookResp.json();
    
    const bestAsk = book.asks?.length ? Math.min(...book.asks.map(a => parseFloat(a.price))) : null;
    const bestBid = book.bids?.length ? Math.max(...book.bids.map(b => parseFloat(b.price))) : null;
    
    const outcome = Array.isArray(market.outcomes) ? market.outcomes[i] : JSON.parse(market.outcomes)[i];
    
    console.log(`   ${outcome}:`);
    console.log(`      Ask: $${bestAsk?.toFixed(3) || 'N/A'} (${(bestAsk * 100).toFixed(1)}%)`);
    console.log(`      Bid: $${bestBid?.toFixed(3) || 'N/A'} (${(bestBid * 100).toFixed(1)}%)`);
  }
  console.log();
  
  // Get NOAA forecast for NYC
  console.log('☁️  Fetching NOAA Forecast for NYC...');
  try {
    const pointsResp = await fetch('https://api.weather.gov/points/40.7128,-74.0060', {
      headers: { 'User-Agent': 'WeatherTradingBot/1.0' }
    });
    const pointsData = await pointsResp.json();
    
    const forecastResp = await fetch(pointsData.properties.forecast, {
      headers: { 'User-Agent': 'WeatherTradingBot/1.0' }
    });
    const forecastData = await forecastResp.json();
    
    console.log('   Next 7 periods:');
    forecastData.properties.periods.slice(0, 7).forEach(p => {
      console.log(`   ${p.name}: ${p.shortForecast}`);
      if (p.shortForecast.toLowerCase().includes('rain') || 
          p.shortForecast.toLowerCase().includes('snow') ||
          p.shortForecast.toLowerCase().includes('precip')) {
        console.log(`      ⚠️  Precipitation expected!`);
      }
    });
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }
  console.log();
  
  // Get Open-Meteo precipitation forecast
  console.log('🌐 Fetching Open-Meteo Precipitation Forecast...');
  try {
    const meteoResp = await fetch('https://api.open-meteo.com/v1/forecast?latitude=40.7128&longitude=-74.0060&daily=precipitation_sum&timezone=America/New_York&start_date=2026-02-09&end_date=2026-02-28');
    const meteoData = await meteoResp.json();
    
    const totalPrecip = meteoData.daily.precipitation_sum.reduce((sum, val) => sum + (val || 0), 0);
    const precipInches = totalPrecip / 25.4; // Convert mm to inches
    
    console.log(`   Total February precipitation forecast: ${precipInches.toFixed(2)} inches`);
    console.log(`   Target range: 5-6 inches`);
    console.log();
    
    if (precipInches >= 5 && precipInches <= 6) {
      console.log('   ✅ Forecast is WITHIN target range!');
    } else if (precipInches < 5) {
      console.log(`   ⬇️  Forecast is BELOW target range (by ${(5 - precipInches).toFixed(2)} inches)`);
    } else {
      console.log(`   ⬆️  Forecast is ABOVE target range (by ${(precipInches - 6).toFixed(2)} inches)`);
    }
    console.log();
    
    // Simple edge calculation
    console.log('🎯 Edge Analysis:');
    console.log(`   If forecast says ${precipInches.toFixed(2)} inches and target is 5-6 inches:`);
    
    // This is oversimplified - real analysis needs historical distribution
    let forecastProb = 0;
    const diff = Math.abs(precipInches - 5.5); // Distance from middle of range
    
    if (precipInches >= 5 && precipInches <= 6) {
      forecastProb = 0.60; // Within range
    } else if (diff < 1) {
      forecastProb = 0.30; // Close to range
    } else if (diff < 2) {
      forecastProb = 0.15; // Moderately far
    } else {
      forecastProb = 0.05; // Very unlikely
    }
    
    console.log(`   Estimated forecast probability: ${(forecastProb * 100).toFixed(0)}%`);
    console.log(`   ⚠️  Note: This is a rough estimate. Real calculation needs:`);
    console.log(`      - Historical precipitation distribution for NYC in Feb`);
    console.log(`      - Forecast uncertainty/confidence intervals`);
    console.log(`      - Days remaining in month (already ${new Date().getDate()} days in)`);
    
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }
}

analyzeNYCPrecip();
