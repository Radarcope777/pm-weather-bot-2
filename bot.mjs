import 'dotenv/config';
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

// Suppress the non-fatal ws-live-data errors
const origConsoleError = console.error;
console.error = (...args) => {
  const msg = args.join(' ');
  if (msg.includes('onMessage error') || msg.includes('CLOB messages are not supported')) return;
  origConsoleError(...args);
};

async function main() {
  console.log('🦞 Polymarket DipArb Bot v2');
  console.log('===========================\n');

  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });

  console.log('✅ SDK initialized\n');

  // Conservative settings
  sdk.dipArb.updateConfig({
    shares: 10,
    sumTarget: 0.95,
    dipThreshold: 0.15,
    slidingWindowMs: 3000,
    windowMinutes: 2,
    maxSlippage: 0.02,
    minProfitRate: 0.03,
    autoMerge: true,
    autoExecute: true,
    enableSurge: true,
    leg2TimeoutSeconds: 180,
    debug: true,
    logHandler: (msg) => {
      const ts = new Date().toLocaleTimeString('de-DE');
      console.log(`[${ts}] ${msg}`);
    },
  });

  // Event handlers
  sdk.dipArb.on('started', (market) => {
    console.log(`\n🚀 MONITORING: ${market.name} (${market.underlying} ${market.durationMinutes}m)\n`);
  });

  sdk.dipArb.on('newRound', (event) => {
    console.log(`📊 ROUND: UP=${event.upOpen.toFixed(2)} DOWN=${event.downOpen.toFixed(2)} | PtB=$${event.priceToBeat.toFixed(0)}`);
  });

  sdk.dipArb.on('signal', (signal) => {
    if (signal.type === 'leg1') {
      console.log(`\n🎯 LEG1: ${signal.dipSide} @ ${signal.currentPrice.toFixed(3)} (drop ${(signal.dropPercent*100).toFixed(1)}%) est.profit: ${(signal.estimatedProfitRate*100).toFixed(1)}%`);
    } else {
      console.log(`🎯 LEG2: ${signal.hedgeSide} | total: $${signal.totalCost.toFixed(3)} profit: ${(signal.expectedProfitRate*100).toFixed(1)}%`);
    }
  });

  sdk.dipArb.on('execution', (result) => {
    if (result.success) {
      console.log(`✅ ${result.leg}: ${result.side} @ $${result.price?.toFixed(4)} x${result.shares}`);
    } else {
      console.log(`❌ ${result.leg} FAILED: ${result.error}`);
    }
  });

  sdk.dipArb.on('roundComplete', (result) => {
    if (result.profit !== undefined) {
      console.log(`💰 ROUND DONE: cost=$${result.totalCost?.toFixed(3)} profit=$${result.profit.toFixed(3)} (${(result.profitRate*100).toFixed(1)}%)`);
    } else {
      console.log(`📋 ROUND DONE: ${result.status}`);
    }
  });

  sdk.dipArb.on('error', (err) => {
    // Filter out known non-fatal errors
    if (err.message?.includes('CLOB messages')) return;
    console.error(`⚠️ ${err.message}`);
  });

  // Auto-rotate between markets
  sdk.dipArb.enableAutoRotate({
    enabled: true,
    underlyings: ['BTC', 'ETH', 'SOL'],
    duration: '15m',
    preloadMinutes: 2,
    autoSettle: true,
    settleStrategy: 'redeem',
  });

  // Start
  console.log('🔍 Finding market...\n');
  try {
    await sdk.dipArb.findAndStart({ coin: 'BTC', preferDuration: '15m' });
  } catch (e) {
    console.log(`BTC not found (${e.message}), trying any...`);
    await sdk.dipArb.findAndStart({ preferDuration: '15m' });
  }

  // Stats every 5 min
  setInterval(() => {
    const s = sdk.dipArb.getStats();
    console.log(`\n📈 ${s.roundsMonitored}r ${s.signalsDetected}sig ${s.leg1Filled}/${s.leg2Filled}fills P&L:$${s.totalProfit.toFixed(2)}\n`);
  }, 5 * 60 * 1000);

  console.log('Bot running. Ctrl+C to stop.\n');

  process.on('SIGINT', () => {
    const s = sdk.dipArb.getStats();
    console.log(`\n🛑 Final: ${s.roundsMonitored}r ${s.signalsDetected}sig ${s.leg1Filled}/${s.leg2Filled}fills P&L:$${s.totalProfit.toFixed(4)}`);
    sdk.dipArb.stop();
    sdk.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
