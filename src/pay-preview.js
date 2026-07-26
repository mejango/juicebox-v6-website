// src/pay-preview.js
// Shared pay preview used by both the Actions "Pay a project" component and the project-page pay card.
//
// One staticcall to JBMultiTerminal.previewPayFor (a `view`) returns everything the UI needs:
//   (ruleset, beneficiaryTokenCount, reservedTokenCount, hookSpecifications)
// It runs the same _computePayFrom path as a real payment, so the counts are authoritative
// (currency/decimals come from the on-chain accounting context). No simulate, no funds, no wallet.
//
// Routing (Issuance vs Swap) comes from the buyback hook's data-hook spec inside hookSpecifications.
// Its `noop` flag is the signal (true = mint at the ruleset weight, false = swap on Uniswap) and its
// `metadata` is the protocol's intentional public preview API (JBBuybackHook.beforePayRecordedWith).
// When the AMM route wins, the buyback hook returns weight 0, so the top-level counts are 0 and the
// real beneficiary/reserved counts live in the decoded metadata.

import { decodeAbiParameters, formatUnits } from 'viem';
import { getAddress, createPublicClientForChain, el, errMessage } from './component-base.js';

// Format an 18-decimal token count (bigint) for display, trimming to a few significant digits.
// Adaptive significant digits for a Number: big numbers drop decimals (and get thousands separators),
// small numbers keep more. Shared by formatTokenCount (18-dec tokens) and discover's formatBalance
// (arbitrary-decimal accounting tokens) so the precision rules live in exactly one place.
export function formatAdaptive(n) {
  if (!isFinite(n)) return '—';
  if (n === 0) return '0';
  // >= 1: thousands separators. Whole numbers show no decimals; if there's a fractional
  // part, show at least 2 (so a big supply reads "1,050,482.34", not "1,050,482").
  if (n >= 1) {
    if (n === Math.round(n)) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (n >= 0.0001) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return n.toPrecision(2);
}

// BigInt-safe companion for raw fixed-point amounts. Large supplies/balances must not pass through Number
// (which loses integer precision and eventually becomes Infinity). Values below one remain safely representable
// as Number for the existing adaptive small-value display; values at/above one are rounded with integer math.
export function formatRawAdaptive(raw, decimals) {
  if (raw === null || raw === undefined) return '—';
  var value;
  try { value = BigInt(raw); } catch (_) { return '—'; }
  decimals = Number(decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) return '—';
  if (value === 0n) return '0';
  var negative = value < 0n;
  var abs = negative ? -value : value;
  var scale = 10n ** BigInt(decimals);
  if (abs < scale) return formatAdaptive(Number(formatUnits(value, decimals)));
  var sign = negative ? '-' : '';
  var remainder = abs % scale;
  if (remainder === 0n || decimals === 0) return sign + (abs / scale).toLocaleString('en-US');
  // Match formatAdaptive's two-decimal display for values >= 1, using exact half-up rounding.
  var hundredths = (abs * 100n + scale / 2n) / scale;
  var whole = hundredths / 100n;
  var fraction = String(hundredths % 100n).padStart(2, '0');
  return sign + whole.toLocaleString('en-US') + '.' + fraction;
}

export function formatTokenCount(raw) {
  if (raw === null || raw === undefined) return '—';
  return formatRawAdaptive(raw, 18);
}

// Truncate a bytes32 pool id (or any hex) for compact display.
export function shortHex(hex) {
  if (!hex || hex.length < 14) return hex || '';
  return hex.slice(0, 8) + '…' + hex.slice(-4);
}

// Routing chip — "Issuance" (mint at the ruleset weight) or "Swap" (any AMM-backed route). Shared by both
// pay surfaces so the tag looks identical everywhere.
export function renderRoutingTag(routing) {
  var tag = el('span', 'pay-routing-tag' + (routing === 'amm' ? ' amm' : ''));
  tag.textContent = routing === 'amm' ? 'Swap' : 'Issuance';
  return tag;
}

// AMM subtext line, parsed from the buyback hook's diagnostic metadata. Returns null when not on the
// AMM route (nothing to show).
export function renderAmmSub(amm) {
  if (!amm) return null;
  var div = el('div', 'pay-amm-sub');
  var bits = ['via Uniswap pool ' + shortHex(amm.poolId)];
  if (amm.minOut) bits.push('~' + formatTokenCount(amm.minOut) + ' out (min)');
  bits.push(amm.hasUserSpecifiedQuote ? 'client quote' : 'TWAP quote');
  div.textContent = bits.join(' | ');
  return div;
}

// JBMultiTerminal.previewPayFor — JBRuleset + JBPayHookSpecification[] tuples spelled out so viem can
// decode the return without the full contract ABI.
var previewPayForAbi = [{
  type: 'function', name: 'previewPayFor', stateMutability: 'view',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
    { name: 'metadata', type: 'bytes' },
  ],
  outputs: [
    {
      name: 'ruleset', type: 'tuple', components: [
        { name: 'cycleNumber', type: 'uint48' },
        { name: 'id', type: 'uint48' },
        { name: 'basedOnId', type: 'uint48' },
        { name: 'start', type: 'uint48' },
        { name: 'duration', type: 'uint32' },
        { name: 'weight', type: 'uint112' },
        { name: 'weightCutPercent', type: 'uint32' },
        { name: 'approvalHook', type: 'address' },
        { name: 'metadata', type: 'uint256' },
      ],
    },
    { name: 'beneficiaryTokenCount', type: 'uint256' },
    { name: 'reservedTokenCount', type: 'uint256' },
    {
      name: 'hookSpecifications', type: 'tuple[]', components: [
        { name: 'hook', type: 'address' },
        { name: 'noop', type: 'bool' },
        { name: 'amount', type: 'uint256' },
        { name: 'metadata', type: 'bytes' },
      ],
    },
  ],
}];

// Exact abi.encode order/types from JBBuybackHook.sol (the noop spec metadata). A non-buyback spec
// (e.g. a 721 hook) won't decode against this, which is how we identify the buyback spec.
var BUYBACK_META = [
  { name: 'projectTokenIs0', type: 'bool' },
  { name: 'amountToMintWith', type: 'uint256' },
  { name: 'minimumSwapAmountOut', type: 'uint256' },
  { name: 'hasUserSpecifiedQuote', type: 'bool' },
  { name: 'controller', type: 'address' },
  { name: 'tokenCountWithoutHook', type: 'uint256' },
  { name: 'weightRatio', type: 'uint256' },
  { name: 'quotedAmountToSwapWith', type: 'uint256' },
  { name: 'twapTick', type: 'int24' },
  { name: 'twapLiquidity', type: 'uint128' },
  { name: 'poolId', type: 'bytes32' },
  { name: 'minimumBeneficiaryTokenCount', type: 'uint256' },
  { name: 'minimumReservedTokenCount', type: 'uint256' },
  { name: 'rawSwapQuote', type: 'uint256' },
];

var PREVIEW_BENEFICIARY = '0x000000000000000000000000000000000000dEaD';

// Preview a payment. opts: { chainId, projectId, token (address), amount (bigint, raw), beneficiary?, metadata?, allowZero? }.
// Returns { received, reserved, routing: 'issuance'|'amm'|null, amm, unavailable, reason }.
// received/reserved are bigint token amounts (18 decimals) or null.
export async function computePayPreview(opts) {
  var result = {
    received: null, reserved: null, routing: null, amm: null, unavailable: false, reason: '',
  };

  var chainId = opts.chainId;
  var projectId = opts.projectId;
  var token = opts.token;
  var amount = opts.amount;
  var beneficiary = opts.beneficiary || PREVIEW_BENEFICIARY;

  if (!chainId || !projectId || !token || amount == null || (amount === 0n && !opts.allowZero)) return result;

  // opts.terminal lets the caller route through the router registry (for swap currencies like USDC);
  // both the router registry and JBMultiTerminal expose the same previewPayFor signature.
  var terminal = opts.terminal || getAddress('JBMultiTerminal', chainId);
  if (!terminal) { result.unavailable = true; result.reason = 'No terminal on this chain'; return result; }

  var client = createPublicClientForChain(chainId);
  if (!client) { result.unavailable = true; result.reason = 'No RPC for this chain'; return result; }

  try {
    var out = await client.readContract({
      address: terminal,
      abi: previewPayForAbi,
      functionName: 'previewPayFor',
      args: [BigInt(projectId), token, amount, beneficiary, opts.metadata || '0x'],
    });
    // out = [ruleset, beneficiaryTokenCount, reservedTokenCount, hookSpecifications]
    var beneficiaryTokenCount = out[1];
    var reservedTokenCount = out[2];
    var specs = out[3] || [];

    // Identify the buyback spec: the one whose metadata decodes to the buyback preview tuple.
    var buyback = null;
    var decoded = null;
    for (var i = 0; i < specs.length; i++) {
      var m = specs[i].metadata;
      if (!m || m === '0x') continue;
      try {
        decoded = decodeAbiParameters(BUYBACK_META, m);
        buyback = specs[i];
        break;
      } catch (_) {
        decoded = null; // not the buyback spec; keep scanning
      }
    }

    if (buyback && decoded && buyback.noop === false) {
      // AMM route chosen — tokens come from the swap, so the top-level counts are 0. Use the
      // swap-path split the hook computed via controller.previewMintOf.
      result.routing = 'amm';
      result.received = decoded[11]; // minimumBeneficiaryTokenCount
      result.reserved = decoded[12]; // minimumReservedTokenCount
      result.amm = {
        poolId: decoded[10],
        minOut: decoded[2],              // minimumSwapAmountOut (post-slippage)
        quote: decoded[13],              // rawSwapQuote (pre-slippage oracle)
        twapTick: decoded[8],
        twapLiquidity: decoded[9],
        hasUserSpecifiedQuote: decoded[3],
        wouldMintByIssuance: decoded[5], // tokenCountWithoutHook
        quotedAmountToSwapWith: decoded[7],
      };
    } else {
      // Issuance route (noop, or no buyback pool configured).
      result.routing = 'issuance';
      result.received = beneficiaryTokenCount;
      result.reserved = reservedTokenCount;
    }
    return result;
  } catch (err) {
    // previewPayFor reverts e.g. JBPrices_PriceFeedNotFound when a non-native currency lacks a feed.
    result.unavailable = true;
    result.reason = errMessage(err, 'preview unavailable');
    return result;
  }
}
