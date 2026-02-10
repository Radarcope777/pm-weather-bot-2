/**
 * Weather Market Discovery Tool
 * Scans Polymarket for any weather-related markets
 */

const WEATHER_KEYWORDS = [
  'weather', 'snow', 'rain', 'storm', 'precipitation',
  'celsius', 'fahrenheit', '°c', '°f',
  'humidity', 'drought', 'freeze', 'frost', 'hail',
  'blizzard', 'hurricane', 'tornado', 'cyclone'
];

// More specific patterns to avoid false positives
const WEATHER_PATTERNS = [
  /temperature.*degrees/i,
  /degrees.*temperature/i,
  /high.*temp/i,
  /low.*temp/i,
  /weather.*forecast/i,
  /climate/i
];

async function discoverWeatherMarkets() {
  console.log('🌤️  Scanning Polymarket for weather markets...\n');
  
  try {
    // Fetch recent active markets
    const response = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=volume24hr');
    
    if (!response.ok) {
      console.error(`❌ API error: ${response.status}`);
      return;
    }
    
    const markets = await response.json();
    console.log(`📊 Scanned ${markets.length} active markets\n`);
    
    // Filter for weather keywords and patterns
    const weatherMarkets = markets.filter(m => {
      const text = (m.question + ' ' + (m.description || '') + ' ' + m.slug).toLowerCase();
      const hasKeyword = WEATHER_KEYWORDS.some(kw => text.includes(kw));
      const hasPattern = WEATHER_PATTERNS.some(pattern => pattern.test(text));
      return hasKeyword || hasPattern;
    });
    
    if (weatherMarkets.length === 0) {
      console.log('📭 No weather markets found\n');
      console.log('Sample of active markets:');
      markets.slice(0, 10).forEach(m => {
        console.log(`   - ${m.question.substring(0, 80)}`);
      });
    } else {
      console.log(`📬 Found ${weatherMarkets.length} potential weather market(s):\n`);
      
      weatherMarkets.forEach((m, i) => {
        console.log(`${i + 1}. ${m.question}`);
        console.log(`   Slug: ${m.slug}`);
        console.log(`   End Date: ${m.endDate}`);
        console.log(`   Volume 24h: $${m.volume24hr || 'N/A'}`);
        console.log(`   Active: ${m.active}, Closed: ${m.closed}`);
        
        if (m.outcomes && Array.isArray(m.outcomes)) {
          console.log(`   Outcomes: ${m.outcomes.join(', ')}`);
        } else if (m.outcomes) {
          console.log(`   Outcomes: ${JSON.stringify(m.outcomes)}`);
        }
        
        if (m.clobTokenIds) {
          const tokens = JSON.parse(m.clobTokenIds);
          console.log(`   Token IDs: ${tokens.length} tokens`);
        }
        
        console.log();
      });
    }
    
    // Also search for specific city-based markets
    console.log('\n🏙️  Checking city-specific markets...\n');
    const cities = ['nyc', 'new york', 'chicago', 'london', 'paris', 'miami', 'boston'];
    
    for (const city of cities) {
      const cityMarkets = markets.filter(m => 
        m.question.toLowerCase().includes(city) || m.slug.toLowerCase().includes(city)
      );
      
      if (cityMarkets.length > 0) {
        console.log(`📍 ${city.toUpperCase()}: ${cityMarkets.length} market(s)`);
        cityMarkets.forEach(m => {
          console.log(`   - ${m.question.substring(0, 70)}`);
        });
      }
    }
    
  } catch (e) {
    console.error(`❌ Error: ${e.message}`);
  }
}

discoverWeatherMarkets();
