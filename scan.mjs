import 'dotenv/config';
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

async function main() {
  console.log('🔍 Polymarket DipArb Scanner\n');

  const sdk = new PolymarketSDK();

  // 1. Scan crypto short-term markets
  console.log('Scanning crypto short-term markets...\n');
  try {
    const cryptoMarkets = await sdk.markets.scanCryptoShortTermMarkets();
    console.log(`Found ${cryptoMarkets.length} crypto short-term markets`);
    for (const m of cryptoMarkets.slice(0, 10)) {
      console.log(`  📊 ${m.question || m.slug || m.conditionId}`);
      if (m.tokens) {
        for (const t of m.tokens) {
          console.log(`     ${t.outcome}: ${t.price}`);
        }
      }
    }
  } catch (e) {
    console.error('Crypto scan error:', e.message);
  }

  // 2. Scan upcoming DipArb markets
  console.log('\nScanning upcoming DipArb markets...\n');
  try {
    const upcoming = await sdk.dipArb.scanUpcomingMarkets();
    console.log(`Found ${upcoming.length} upcoming markets`);
    for (const m of upcoming.slice(0, 10)) {
      console.log(`  📊 ${m.name} | ${m.underlying} ${m.durationMinutes}m | ends: ${m.endTime}`);
    }
  } catch (e) {
    console.error('DipArb scan error:', e.message);
  }

  // 3. Check for arbitrage on trending markets
  console.log('\nChecking trending markets for arb...\n');
  try {
    const trending = await sdk.markets.getTrendingMarkets();
    for (const m of trending.slice(0, 5)) {
      const arb = await sdk.detectArbitrage(m.conditionId);
      const label = m.question?.slice(0, 60) || m.conditionId;
      if (arb) {
        console.log(`  🎯 ${label}`);
        console.log(`     ${arb.type} ARB: ${(arb.profit * 100).toFixed(2)}% | ${arb.action}`);
      }
    }
  } catch (e) {
    console.error('Trending scan error:', e.message);
  }

  // 4. Check wallet
  console.log('\n💰 Wallet check...');
  try {
    const pk = process.env.POLYMARKET_PRIVATE_KEY;
    if (pk) {
      const authSdk = await PolymarketSDK.create({ privateKey: pk });
      console.log('Wallet connected ✅');
      
      // Check open orders
      try {
        const orders = await authSdk.tradingService.getOpenOrders();
        console.log(`Open orders: ${orders.length}`);
      } catch (e) {
        console.log(`Orders check: ${e.message}`);
      }
      
      authSdk.stop();
    }
  } catch (e) {
    console.error('Wallet error:', e.message);
  }

  console.log('\n✅ Done');
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
