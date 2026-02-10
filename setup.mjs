import 'dotenv/config';
import { ethers } from 'ethers';
/*
 * Polymarket Trading Setup Script
 * ================================
 * 1. Check balances (POL, native USDC, USDC.e)
 * 2. Swap native USDC → USDC.e via QuickSwap V3 (Algebra)
 * 3. Set USDC.e allowances for Exchange contracts
 * 4. Set CTF (ERC1155) approvals for Exchange contracts
 * 5. Test CLOB API connection
 * 6. Final readiness check
 */

const RPC_URL = 'https://polygon.drpc.org';
const CHAIN_ID = 137;

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const CTF_TOKEN = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// QuickSwap V3 (Algebra fork) on Polygon
const QUICKSWAP_ROUTER = '0xf5b509bB0909a69B1c207E495f687a596C168E12';
const QUICKSWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice)) external payable returns (uint256 amountOut)',
];

const SPENDERS = [
  { name: 'Exchange', address: EXCHANGE },
  { name: 'NegRiskExchange', address: NEG_RISK_EXCHANGE },
  { name: 'NegRiskAdapter', address: NEG_RISK_ADAPTER },
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const CTF_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

// --- Setup ---
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const pk = process.env.POLYMARKET_PRIVATE_KEY;
if (!pk) {
  console.error('❌ POLYMARKET_PRIVATE_KEY not found in .env');
  process.exit(1);
}
const wallet = new ethers.Wallet(pk, provider);
const usdcEContract = new ethers.Contract(USDC_E, ERC20_ABI, wallet);
const nativeUsdcContract = new ethers.Contract(NATIVE_USDC, ERC20_ABI, wallet);
const ctfContract = new ethers.Contract(CTF_TOKEN, CTF_ABI, wallet);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, label, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i < retries - 1 && (e.message?.includes('Too many') || e.code === 'SERVER_ERROR')) {
        log(`  ⏳ Retry ${label} in ${(i+1)*10}s...`);
        await sleep((i+1) * 10000);
        continue;
      }
      throw e;
    }
  }
}

async function waitForTx(tx, label) {
  log(`    ⏳ TX: ${tx.hash}`);
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    try {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt) {
        if (receipt.status !== 1) {
          log(`    ❌ ${label} REVERTED`);
          log(`    https://polygonscan.com/tx/${tx.hash}`);
          process.exit(1);
        }
        log(`    ✅ ${label} confirmed (gas: ${receipt.gasUsed})`);
        return receipt;
      }
    } catch (e) {
      if (i >= 39) throw e;
    }
  }
  log(`    ⚠️  TX not confirmed after 2min: ${tx.hash}`);
  process.exit(1);
}

async function getGasOpts() {
  const gasPrice = await withRetry(() => provider.getGasPrice(), 'gasPrice');
  return { gasPrice: gasPrice.mul(130).div(100) };
}

// ═══════════════════════════════════════════
async function main() {
  log('🔧 Polymarket Trading Setup');
  log(`   Wallet: ${wallet.address}\n`);

  // ── STEP 1: Balances ──
  log('══ STEP 1: Check Balances ══');
  const [pol, usdcEBal, nativeBal] = await Promise.all([
    provider.getBalance(wallet.address),
    usdcEContract.balanceOf(wallet.address),
    nativeUsdcContract.balanceOf(wallet.address),
  ]);
  
  const polNum = parseFloat(ethers.utils.formatEther(pol));
  const usdcENum = parseFloat(ethers.utils.formatUnits(usdcEBal, 6));
  const nativeNum = parseFloat(ethers.utils.formatUnits(nativeBal, 6));
  
  log(`  POL:         ${polNum.toFixed(4)}`);
  log(`  USDC.e:      ${usdcENum.toFixed(2)} (needed for Polymarket)`);
  log(`  Native USDC: ${nativeNum.toFixed(2)}`);
  
  if (polNum < 0.01) { log('  ❌ Not enough POL for gas!'); process.exit(1); }
  log('  ✅ POL OK\n');

  // ── STEP 2: Swap USDC → USDC.e via SDK ──
  if (usdcENum < 5 && nativeNum > 3) {
    log('══ STEP 2: Swap native USDC → USDC.e ══');
    const swapAmount = nativeNum - 2; // Keep $2 buffer
    const amountIn = ethers.utils.parseUnits(Math.floor(swapAmount * 1e6 ) / 1e6 + '', 6);
    log(`  Swapping ~$${swapAmount.toFixed(2)} native USDC → USDC.e via QuickSwap V3`);
    
    // 2a: Approve QuickSwap Router for native USDC
    const routerAllowance = await nativeUsdcContract.allowance(wallet.address, QUICKSWAP_ROUTER);
    if (routerAllowance.lt(amountIn)) {
      log('  Approving QuickSwap Router...');
      const gasOpts = await getGasOpts();
      const appTx = await nativeUsdcContract.approve(QUICKSWAP_ROUTER, ethers.constants.MaxUint256, { ...gasOpts, gasLimit: 100000 });
      await waitForTx(appTx, 'QuickSwap Approval');
      await sleep(2000);
    } else {
      log('  ✅ QuickSwap already approved');
    }
    
    // 2b: Execute swap (Algebra/QuickSwap V3 uses limitSqrtPrice, not sqrtPriceLimitX96)
    log('  Executing swap...');
    const router = new ethers.Contract(QUICKSWAP_ROUTER, QUICKSWAP_ROUTER_ABI, wallet);
    const gasOpts = await getGasOpts();
    const minOut = amountIn.mul(98).div(100); // 2% slippage for safety
    const deadline = Math.floor(Date.now() / 1000) + 300;
    
    const swapTx = await router.exactInputSingle(
      {
        tokenIn: NATIVE_USDC,
        tokenOut: USDC_E,
        recipient: wallet.address,
        deadline,
        amountIn,
        amountOutMinimum: minOut,
        limitSqrtPrice: 0,
      },
      { ...gasOpts, gasLimit: 500000 }
    );
    await waitForTx(swapTx, 'USDC→USDC.e swap');
    
    // Verify (direct RPC call to avoid ethers caching)
    await sleep(5000);
    const balData = await provider.call({
      to: USDC_E,
      data: '0x70a08231000000000000000000000000' + wallet.address.slice(2).toLowerCase(),
    });
    const newNum = parseInt(balData, 16) / 1e6;
    log(`  New USDC.e balance: $${newNum.toFixed(2)}`);
    if (newNum < 1) {
      log('  ❌ USDC.e still too low after swap — check TX on polygonscan');
      process.exit(1);
    }
    log('');
  } else if (usdcENum >= 5) {
    log('══ STEP 2: Swap ══');
    log(`  ℹ️  Already have $${usdcENum.toFixed(2)} USDC.e, skipping\n`);
  } else {
    log('══ STEP 2: Swap ══');
    log(`  ⚠️  Low USDC — continuing with approvals anyway\n`);
  }

  // ── STEP 3: USDC.e Allowances ──
  log('══ STEP 3: USDC.e Allowances ══');
  for (const spender of SPENDERS) {
    const current = await withRetry(
      () => usdcEContract.allowance(wallet.address, spender.address),
      `allowance ${spender.name}`
    );
    if (current.gt(0)) {
      log(`  ${spender.name}: ✅ Already approved`);
      continue;
    }
    log(`  ${spender.name}: Setting approval...`);
    const gasOpts = await getGasOpts();
    const tx = await usdcEContract.approve(spender.address, ethers.constants.MaxUint256, { ...gasOpts, gasLimit: 100000 });
    await waitForTx(tx, `USDC.e → ${spender.name}`);
    await sleep(3000); // let RPC catch up
  }
  log('');

  // ── STEP 4: CTF Token Approvals ──
  log('══ STEP 4: CTF Token Approvals ══');
  for (const spender of SPENDERS) {
    const approved = await withRetry(
      () => ctfContract.isApprovedForAll(wallet.address, spender.address),
      `ctf ${spender.name}`
    );
    if (approved) {
      log(`  ${spender.name}: ✅ Already approved`);
      continue;
    }
    log(`  ${spender.name}: Setting approval...`);
    const gasOpts = await getGasOpts();
    const tx = await ctfContract.setApprovalForAll(spender.address, true, { ...gasOpts, gasLimit: 100000 });
    await waitForTx(tx, `CTF → ${spender.name}`);
    await sleep(3000); // let RPC catch up
  }
  log('');

  // ── STEP 5: CLOB API ──
  log('══ STEP 5: Test CLOB API ══');
  try {
    const { PolymarketSDK } = await import('@catalyst-team/poly-sdk');
    const sdk = await PolymarketSDK.create({ privateKey: pk });
    await sdk.tradingService.initialize();
    log('  ✅ CLOB API keys derived/created');
    log('  ✅ Trading service initialized');
  } catch (e) {
    log(`  ⚠️  CLOB init issue: ${e.message}`);
    log('  (Bot may still work — it initializes its own connection)');
  }
  log('');

  // ── FINAL ──
  log('══ FINAL STATUS ══');
  const [fPol, fUsdcE, fNative] = await Promise.all([
    provider.getBalance(wallet.address),
    usdcEContract.balanceOf(wallet.address),
    nativeUsdcContract.balanceOf(wallet.address),
  ]);
  log(`  POL:         ${parseFloat(ethers.utils.formatEther(fPol)).toFixed(4)}`);
  log(`  USDC.e:      ${ethers.utils.formatUnits(fUsdcE, 6)} (trading)`);
  log(`  Native USDC: ${ethers.utils.formatUnits(fNative, 6)}`);
  
  let allOk = true;
  for (const s of SPENDERS) {
    const uOk = (await usdcEContract.allowance(wallet.address, s.address)).gt(0);
    const cOk = await ctfContract.isApprovedForAll(wallet.address, s.address);
    log(`  ${s.name}: USDC.e=${uOk?'✅':'❌'} CTF=${cOk?'✅':'❌'}`);
    if (!uOk || !cOk) allOk = false;
  }
  
  log('');
  if (allOk && parseFloat(ethers.utils.formatUnits(fUsdcE, 6)) > 1) {
    log('🎉 WALLET IS READY FOR TRADING!');
  } else {
    log('⚠️  Issues remain — check above');
  }
}

main().catch(e => {
  log(`\n❌ FATAL: ${e.message}`);
  if (e.code) log(`   Code: ${e.code}`);
  console.error(e.stack);
  process.exit(1);
});
