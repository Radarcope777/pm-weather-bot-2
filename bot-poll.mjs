import 'dotenv/config';
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

/**
 * DipArb Bot v3 - Pure REST Polling
 * No WebSocket dependency - direct CLOB REST API
 */

const POLL_MS = 2000;
const DIP_THRESHOLD = 0.15;
const SUM_TARGET = 0.95;
const SHARES = 10;
const WINDOW_MIN = 3;
const HIST_SIZE = 15;

let stats = { rounds: 0, signals: 0, leg1: 0, leg2: 0, profit: 0, spent: 0 };
const ts = () => new Date().toLocaleTimeString('de-DE');

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

async function getBook(tokenId) {
  return fetchJson(`https://clob.polymarket.com/book?token_id=${tokenId}`);
}

function bestAsk(book) {
  return book?.asks?.length ? Math.min(...book.asks.map(a => parseFloat(a.price))) : null;
}

function bestBid(book) {
  return book?.bids?.length ? Math.max(...book.bids.map(b => parseFloat(b.price))) : null;
}

async function findMarkets(coin = 'btc') {
  const now = Math.floor(Date.now() / 1000);
  const interval = 900; // 15m
  const results = [];
  
  // Generate slugs for next ~60 min
  const minSlot = Math.floor((now - interval) / interval) * interval;
  const maxSlot = Math.ceil((now + 3600) / interval) * interval;
  
  const slugs = [];
  for (let slot = minSlot; slot <= maxSlot; slot += interval) {
    slugs.push(`${coin}-updown-15m-${slot}`);
  }

  // Fetch in parallel
  const fetches = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const data = await fetchJson(`https://gamma-api.polymarket.com/markets?slug=${slug}&limit=1`);
        return data.length > 0 ? data[0] : null;
      } catch { return null; }
    })
  );

  for (const m of fetches) {
    if (!m || !m.active || m.closed) continue;
    const endDate = m.endDate ? new Date(m.endDate) : null;
    if (!endDate || endDate.getTime() < Date.now() + 60000) continue;
    
    const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
    if (tokens.length < 2) continue;
    
    results.push({
      name: m.question || m.slug,
      slug: m.slug,
      conditionId: m.conditionId,
      upTokenId: tokens[0],
      downTokenId: tokens[1],
      underlying: coin.toUpperCase(),
      endTime: endDate,
    });
  }

  return results.sort((a, b) => a.endTime - b.endTime);
}

async function monitorMarket(sdk, market) {
  console.log(`\n🚀 [${ts()}] ${market.name}`);
  console.log(`   ${market.underlying} | ends ${market.endTime.toLocaleTimeString('de-DE')}`);

  let priceHist = { up: [], down: [] };
  let phase = 'watching';
  let leg1 = null;
  stats.rounds++;

  const roundEnd = market.endTime.getTime();
  const roundStart = roundEnd - 15 * 60000;

  while (Date.now() < roundEnd - 30000) {
    try {
      const [upBook, downBook] = await Promise.all([
        getBook(market.upTokenId),
        getBook(market.downTokenId),
      ]);

      const uAsk = bestAsk(upBook);
      const dAsk = bestAsk(downBook);
      const uBid = bestBid(upBook);
      const dBid = bestBid(downBook);

      if (uAsk === null || dAsk === null) {
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }

      priceHist.up.push(uAsk);
      priceHist.down.push(dAsk);
      if (priceHist.up.length > HIST_SIZE * 2) {
        priceHist.up = priceHist.up.slice(-HIST_SIZE * 2);
        priceHist.down = priceHist.down.slice(-HIST_SIZE * 2);
      }

      const total = uAsk + dAsk;
      const elapsed = (Date.now() - roundStart) / 60000;

      // Log every 5 polls (~10s)
      if (priceHist.up.length <= 3 || priceHist.up.length % 5 === 0) {
        console.log(`[${ts()}] U:${uAsk.toFixed(2)}/${uBid?.toFixed(2)} D:${dAsk.toFixed(2)}/${dBid?.toFixed(2)} Σ${total.toFixed(3)} ${elapsed.toFixed(1)}m`);
      }

      // LEG 1
      if (phase === 'watching' && elapsed <= WINDOW_MIN) {
        for (const [side, hist, oppAsk] of [['UP', priceHist.up, dAsk], ['DOWN', priceHist.down, uAsk]]) {
          if (hist.length < 3) continue;
          const recent = hist[hist.length - 1];
          const ref = hist[Math.max(0, hist.length - HIST_SIZE)];
          const drop = ref > 0 ? (ref - recent) / ref : 0;

          if (drop >= DIP_THRESHOLD) {
            const estTotal = recent + oppAsk;
            const estProfit = estTotal < 1 ? (1 - estTotal) / estTotal : 0;

            console.log(`\n🎯 [${ts()}] DIP: ${side} -${(drop*100).toFixed(1)}% (${ref.toFixed(3)}→${recent.toFixed(3)}) Σ${estTotal.toFixed(3)} ~${(estProfit*100).toFixed(1)}%`);
            stats.signals++;

            if (estTotal <= SUM_TARGET && estProfit >= 0.03) {
              const tokenId = side === 'UP' ? market.upTokenId : market.downTokenId;
              try {
                console.log(`   ✅ BUY ${side} @ ${recent.toFixed(3)} x${SHARES}`);
                await sdk.tradingService.createLimitOrder({
                  tokenId, side: 'BUY',
                  price: Math.min(recent + 0.02, 0.99),
                  size: SHARES, orderType: 'GTC',
                });
                phase = 'leg1_filled';
                leg1 = { side, price: recent, tokenId };
                stats.leg1++;
                stats.spent += recent * SHARES;
              } catch (e) {
                console.log(`   ❌ ${e.message}`);
              }
            }
            break;
          }
        }
      }

      // LEG 2
      if (phase === 'leg1_filled') {
        const oppAsk = leg1.side === 'UP' ? dAsk : uAsk;
        const totalCost = leg1.price + oppAsk;

        if (totalCost <= SUM_TARGET) {
          const oppSide = leg1.side === 'UP' ? 'DOWN' : 'UP';
          const tokenId = leg1.side === 'UP' ? market.downTokenId : market.upTokenId;
          try {
            console.log(`🎯 [${ts()}] LEG2: BUY ${oppSide} @ ${oppAsk.toFixed(3)} Σ${totalCost.toFixed(3)}`);
            await sdk.tradingService.createLimitOrder({
              tokenId, side: 'BUY',
              price: Math.min(oppAsk + 0.02, 0.99),
              size: SHARES, orderType: 'GTC',
            });
            const profit = (1 - totalCost) * SHARES;
            stats.leg2++;
            stats.profit += profit;
            console.log(`   💰 $${profit.toFixed(2)} (${((1-totalCost)/totalCost*100).toFixed(1)}%)`);
            phase = 'completed';
          } catch (e) {
            console.log(`   ❌ ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.log(`[${ts()}] Error: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  console.log(`[${ts()}] Round done (${phase})`);
}

async function main() {
  console.log('🦞 DipArb Bot v3 (REST)\n');

  // Init SDK for trading only
  console.log('Initializing wallet...');
  const sdk = await PolymarketSDK.create({ privateKey: process.env.POLYMARKET_PRIVATE_KEY });
  await sdk.tradingService.initialize();
  console.log('✅ Ready\n');

  while (true) {
    console.log(`[${ts()}] Scanning markets...`);
    const btc = await findMarkets('btc');

    if (!btc.length) {
      console.log('No active BTC 15m markets. Waiting 30s...');
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    await monitorMarket(sdk, btc[0]);
    console.log(`\n📈 ${stats.rounds}r ${stats.signals}sig ${stats.leg1}/${stats.leg2}fills P&L:$${stats.profit.toFixed(2)}\n`);
    await new Promise(r => setTimeout(r, 3000));
  }
}

process.on('SIGINT', () => {
  console.log(`\n🛑 ${stats.rounds}r ${stats.signals}sig ${stats.leg1}/${stats.leg2}fills P&L:$${stats.profit.toFixed(4)}`);
  process.exit(0);
});

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
