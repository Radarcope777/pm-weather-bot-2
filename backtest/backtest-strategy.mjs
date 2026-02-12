#!/usr/bin/env node

/**
 * Backtest Weather Trading Strategy
 * ==================================
 * 
 * Simulates our trading bot using historical data:
 * 1. For each market, determine if bot would have traded
 * 2. Calculate P&L based on actual outcomes
 * 3. Test different edge thresholds
 * 4. Analyze optimal position sizing
 */

import { readFileSync, writeFileSync } from 'fs';

const CONFIG = {
  maxPositionSize: 2,           // $2 per position
  defaultMinEdge: 0.15,         // 15% minimum edge
  edgePriceThreshold: 0.60,     // Only buy below 60%
  forecastConfidence: 0.80,     // Assume 80% forecast accuracy
  maxOpenPositions: 5,
};

function parseTemperatureRange(text) {
  if (!text) return null;
  
  let m = text.match(/(-?\d+)\s*-\s*(-?\d+)\s*°?\s*([FC])/i);
  if (m) return { type: 'range', min: parseInt(m[1]), max: parseInt(m[2]), unit: m[3].toUpperCase() };
  
  m = text.match(/(-?\d+)\s*°?\s*([FC])\s+or\s+(below|lower)/i);
  if (m) return { type: 'below', threshold: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  m = text.match(/(-?\d+)\s*°?\s*([FC])\s+or\s+(above|higher)/i);
  if (m) return { type: 'above', threshold: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  m = text.match(/^(-?\d+)\s*°?\s*([FC])$/i);
  if (m) return { type: 'exact', value: parseInt(m[1]), unit: m[2].toUpperCase() };
  
  return null;
}

function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }

function tempMatchesRange(tempF, range) {
  let temp = tempF;
  if (range.unit === 'C') temp = fahrenheitToCelsius(tempF);
  
  switch (range.type) {
    case 'range': return temp >= range.min && temp <= range.max;
    case 'below': return temp <= range.threshold;
    case 'above': return temp >= range.threshold;
    case 'exact': return Math.round(temp) === range.value;
    default: return false;
  }
}

function simulateForecast(actualTempF, city) {
  // Apply known forecast biases from meteorological literature
  // Generally, forecasts have a warm bias in winter and cool bias in summer
  // For simplicity, we'll apply city-specific biases based on empirical observation
  
  const biases = {
    // US cities (NOAA): slight warm bias in winter
    'nyc': 1.5,
    'dallas': 1.0,
    'seattle': 2.0,
    'miami': 0.5,
    'chicago': 1.8,
    'atlanta': 1.2,
    'toronto': 1.5,
    
    // International (Open-Meteo): variable
    'london': 1.0,
    'seoul': 0.8,
    'ankara': 1.2,
    'wellington': -0.5,
  };
  
  const bias = biases[city] || 1.0;
  return actualTempF + bias; // Forecast tends to be warmer than actual
}

function simulateTrade(event, forecastTempF, minEdgeThreshold) {
  // Find the bucket that matches the forecast
  let matchingMarket = null;
  let matchingRange = null;
  
  for (const market of event.markets) {
    const range = parseTemperatureRange(market.temperatureRange || market.question);
    if (!range) continue;
    
    if (tempMatchesRange(forecastTempF, range)) {
      matchingMarket = market;
      matchingRange = range;
      break;
    }
  }
  
  if (!matchingMarket) return null;
  
  // Get market price (simulate using outcome prices from the event)
  // In real Polymarket data, we'd use the order book at trade time
  // For backtest, we'll use final outcome prices as proxy
  const prices = event.markets[0].outcomePrices || [];
  const marketIdx = event.markets.indexOf(matchingMarket);
  const marketPrice = prices[marketIdx] || 0.5; // Default to 50% if no price data
  
  // Check if price is below threshold
  if (marketPrice >= CONFIG.edgePriceThreshold) return null;
  
  // Calculate edge
  const edge = (CONFIG.forecastConfidence - marketPrice) / marketPrice;
  if (edge < minEdgeThreshold) return null;
  
  // Calculate position
  const entryPrice = Math.min(marketPrice + 0.01, 0.99);
  const shares = CONFIG.maxPositionSize / entryPrice;
  const cost = entryPrice * shares;
  
  // Determine if we won (did actual temp match our bucket?)
  const won = tempMatchesRange(event.actualTempF, matchingRange);
  const payout = won ? shares : 0;
  const pnl = payout - cost;
  
  return {
    eventSlug: event.eventSlug,
    city: event.city,
    date: event.date,
    forecastTempF,
    actualTempF: event.actualTempF,
    bucket: matchingMarket.temperatureRange,
    entryPrice,
    shares,
    cost,
    won,
    payout,
    pnl,
    edge,
    marketPrice,
  };
}

function calculateStats(trades) {
  const totalCost = trades.reduce((sum, t) => sum + t.cost, 0);
  const totalPayout = trades.reduce((sum, t) => sum + t.payout, 0);
  const totalPnL = totalPayout - totalCost;
  const wins = trades.filter(t => t.won).length;
  const winRate = wins / trades.length;
  const avgPnL = totalPnL / trades.length;
  const roi = (totalPnL / totalCost) * 100;
  
  // Calculate Sharpe-like ratio (return / volatility)
  const pnls = trades.map(t => t.pnl);
  const meanPnL = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((sum, pnl) => sum + Math.pow(pnl - meanPnL, 2), 0) / pnls.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanPnL / stdDev) : 0;
  
  return {
    totalTrades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate,
    totalCost,
    totalPayout,
    totalPnL,
    avgPnL,
    roi,
    sharpe,
  };
}

async function main() {
  console.log('🎲 Backtesting trading strategy...\n');
  
  // Load analysis results
  const events = JSON.parse(readFileSync('./backtest/accuracy-analysis.json', 'utf-8'));
  console.log(`Loaded ${events.length} analyzed events\n`);
  
  // Simulate trades with default threshold
  console.log(`\n${'═'.repeat(60)}`);
  console.log('BASELINE STRATEGY (15% min edge)');
  console.log('═'.repeat(60));
  
  const baselineTrades = [];
  
  for (const event of events) {
    const forecastTemp = simulateForecast(event.actualTempF, event.city);
    const trade = simulateTrade(event, forecastTemp, CONFIG.defaultMinEdge);
    
    if (trade) {
      baselineTrades.push(trade);
      console.log(`${trade.won ? '✅' : '❌'} ${trade.eventSlug.substring(0, 50)} | ` +
        `${trade.bucket} @ ${(trade.entryPrice * 100).toFixed(1)}% | ` +
        `P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}`);
    }
  }
  
  const baselineStats = calculateStats(baselineTrades);
  
  console.log(`\n📊 BASELINE RESULTS:`);
  console.log(`   Trades: ${baselineStats.totalTrades}`);
  console.log(`   Wins: ${baselineStats.wins} (${(baselineStats.winRate * 100).toFixed(1)}%)`);
  console.log(`   Losses: ${baselineStats.losses}`);
  console.log(`   Total Cost: $${baselineStats.totalCost.toFixed(2)}`);
  console.log(`   Total Payout: $${baselineStats.totalPayout.toFixed(2)}`);
  console.log(`   Net P&L: ${baselineStats.totalPnL >= 0 ? '+' : ''}$${baselineStats.totalPnL.toFixed(2)}`);
  console.log(`   ROI: ${baselineStats.roi >= 0 ? '+' : ''}${baselineStats.roi.toFixed(1)}%`);
  console.log(`   Avg P&L per trade: ${baselineStats.avgPnL >= 0 ? '+' : ''}$${baselineStats.avgPnL.toFixed(2)}`);
  console.log(`   Sharpe-like ratio: ${baselineStats.sharpe.toFixed(2)}`);
  
  // Test different edge thresholds
  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('EDGE THRESHOLD OPTIMIZATION');
  console.log('═'.repeat(60));
  
  const thresholds = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30];
  const thresholdResults = [];
  
  for (const threshold of thresholds) {
    const trades = [];
    
    for (const event of events) {
      const forecastTemp = simulateForecast(event.actualTempF, event.city);
      const trade = simulateTrade(event, forecastTemp, threshold);
      if (trade) trades.push(trade);
    }
    
    if (trades.length > 0) {
      const stats = calculateStats(trades);
      thresholdResults.push({ threshold, ...stats });
      
      console.log(`\n${(threshold * 100).toFixed(0)}% min edge:`);
      console.log(`   Trades: ${stats.totalTrades} | Win rate: ${(stats.winRate * 100).toFixed(1)}% | ` +
        `P&L: ${stats.totalPnL >= 0 ? '+' : ''}$${stats.totalPnL.toFixed(2)} | ` +
        `ROI: ${stats.roi >= 0 ? '+' : ''}${stats.roi.toFixed(1)}%`);
    }
  }
  
  // Find optimal threshold
  const optimal = thresholdResults.reduce((best, curr) => 
    curr.roi > best.roi ? curr : best
  );
  
  console.log(`\n🎯 OPTIMAL: ${(optimal.threshold * 100).toFixed(0)}% edge → ` +
    `${optimal.totalTrades} trades, ${(optimal.winRate * 100).toFixed(1)}% win rate, ` +
    `${optimal.roi >= 0 ? '+' : ''}${optimal.roi.toFixed(1)}% ROI`);
  
  // Analyze by city
  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('PERFORMANCE BY CITY');
  console.log('═'.repeat(60));
  
  const byCity = {};
  
  for (const trade of baselineTrades) {
    if (!byCity[trade.city]) {
      byCity[trade.city] = [];
    }
    byCity[trade.city].push(trade);
  }
  
  const cityStats = Object.entries(byCity).map(([city, trades]) => {
    const stats = calculateStats(trades);
    return { city, ...stats };
  }).sort((a, b) => b.roi - a.roi);
  
  for (const stats of cityStats) {
    console.log(`\n${stats.city}:`);
    console.log(`   Trades: ${stats.totalTrades} | Wins: ${stats.wins} (${(stats.winRate * 100).toFixed(1)}%)`);
    console.log(`   P&L: ${stats.totalPnL >= 0 ? '+' : ''}$${stats.totalPnL.toFixed(2)} | ` +
      `ROI: ${stats.roi >= 0 ? '+' : ''}${stats.roi.toFixed(1)}%`);
  }
  
  // Save results
  const output = {
    baseline: { trades: baselineTrades, stats: baselineStats },
    thresholdTests: thresholdResults,
    optimal,
    byCity: cityStats,
    summary: {
      totalEvents: events.length,
      totalTrades: baselineTrades.length,
      tradeRate: (baselineTrades.length / events.length * 100).toFixed(1) + '%',
      overallPnL: baselineStats.totalPnL,
      overallROI: baselineStats.roi,
      bestCity: cityStats[0]?.city,
      worstCity: cityStats[cityStats.length - 1]?.city,
    }
  };
  
  writeFileSync('./backtest/backtest-results.json', JSON.stringify(output, null, 2));
  console.log(`\n\n💾 Saved to backtest/backtest-results.json`);
  
  return output;
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
