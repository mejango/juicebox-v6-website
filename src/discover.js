// src/discover.js
// Discover tab: live project cards + detail page, read directly from the V6 contracts.
// No indexer dependency — every value here is an on-chain read via component-base's
// executeRead. Projects 1–7 are the canonical V6 set deployed across the testnets.

import { createPublicClient, http, keccak256, encodeAbiParameters, encodeFunctionData, formatEther } from 'viem';
import { el, getAddress, formatAmount, parseAmount, truncAddr, getAccount, connect, executeTransaction, confirmTransactionModal, appendAuditPromptLink, getWalletClient, switchChain, onWalletChange, abiSignature, resolveContractName, renderDecodedTx, renderTxReview, decodeCallForDisplay, createPublicClientForChain, ZERO_ADDRESS, NATIVE_TOKEN, errMessage, isAddr, renderConfirmBody, makeStatusSetter, promptFoot, promptLinkButton, componentReproPrompt } from './component-base.js';
import { CHAINS, getChainTokens } from './chain.js';
import { computePayPreview, formatTokenCount, formatAdaptive, renderRoutingTag, shortHex } from './pay-preview.js';
import { bendystrawQuery, setBendystrawNetwork } from './bendystraw-client.js';
import { encodeCalldata } from './encoding.js';
import { buildForwardedTx, relayrPostBundle, relayrPay, relayrPoll } from './relayr.js';
import { proposeSafeTx, getSafeNextNonce, listPendingSafeTxs, confirmSafeTx, executeSafeTx, safeExecRelayrTx, safeQueueLink, safeTxLink, safeHomeLink } from './safe.js';
import { pinJson, pinFile, hasPinata, setPinataJwt, encodeIpfsUriToBytes32 } from './ipfs-pin.js';
import { openCreateFlow } from './create-flow.js';
import { launchProjectAbi } from './launch-component.js';
import { toggleRow, dz, currencySelect, cashOutSection, DURATION_PRESETS, FOREVER_SECONDS, renderStages, createStage, buildQueueRulesetConfigs, renderNfts, deploySalt, build721Config, DEPLOY_721_COMPONENTS, pinShopItemsMetadata } from './create-flow.js';

// Batched read clients come from the shared `createPublicClientForChain` (wallet.js, re-exported by
// component-base) — one cache for the whole app, keyed by chainId|customRpc so a custom RPC takes
// effect immediately (the old discover-local cache keyed by chainId only, ignoring RPC changes).
var clientFor = createPublicClientForChain;

// The V6 contracts are deployed (same CREATE2 addresses) on every chain below. Discover pivots between
// the two networks via the header dropdown; `DISCOVER_CHAINS` is the active set and is reassigned by
// setNetwork(). Every consumer reads it live, so reassigning + re-rendering is enough to switch.
var TESTNET_CHAINS = [
  { id: 11155111, name: 'Sepolia', short: 'Eth' },
  { id: 421614, name: 'Arbitrum Sepolia', short: 'Arb' },
  { id: 84532, name: 'Base Sepolia', short: 'Base' },
  { id: 11155420, name: 'OP Sepolia', short: 'OP' },
];
var MAINNET_CHAINS = [
  { id: 1, name: 'Ethereum', short: 'Eth' },
  { id: 42161, name: 'Arbitrum', short: 'Arb' },
  { id: 8453, name: 'Base', short: 'Base' },
  { id: 10, name: 'Optimism', short: 'OP' },
];
function getNetworkMode() {
  // Default to mainnet (the real network — 7 canonical revnets live). Project cards read on-chain;
  // indexer-backed feeds (activity/owners) populate once prod bendystraw indexes V6. Testnets via toggle.
  try { return localStorage.getItem('jb-network') === 'testnet' ? 'testnet' : 'mainnet'; } catch (_) { return 'mainnet'; }
}
var DISCOVER_CHAINS = getNetworkMode() === 'mainnet' ? MAINNET_CHAINS : TESTNET_CHAINS;
// Switch the active network: persist, swap the chain set + indexer host, drop caches + any open project
// route, and re-render the grid from scratch.
function setNetwork(mode) {
  mode = mode === 'mainnet' ? 'mainnet' : 'testnet';
  if (mode === getNetworkMode()) return;
  try { localStorage.setItem('jb-network', mode); } catch (_) {}
  DISCOVER_CHAINS = mode === 'mainnet' ? MAINNET_CHAINS : TESTNET_CHAINS;
  setBendystrawNetwork(mode);
  _groups = null; _cache = {}; _activeDetail = null;
  if (location.hash) { location.hash = ''; }
  renderDiscoverTab();
}

var IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

var LOGO_COLORS = ['#1a8a8a','#3d7a5a','#c43550','#2c2018','#b8602e','#6ec4c4','#82b89e'];
function logoColor(id) { return LOGO_COLORS[(id - 1) % LOGO_COLORS.length]; }
var BENDYSTRAW_VERSION = 6;
var OWNERS_PAGE_SIZE = 250;
var OWNERS_MAX_PARTICIPANTS = 1000;
var AUTO_ISSUE_PAGE_SIZE = 250;
var AUTO_ISSUE_MAX_EVENTS = 1000;
var PRICE_HISTORY_PAGE_SIZE = 1000;
var PRICE_HISTORY_MAX_POINTS = 3000;
var ACTIVITY_PAGE_SIZE = 10;
var BENDYSTRAW_PARENT_CHAIN_ID = {
  11155111: 1,
  11155420: 10,
  84532: 8453,
  421614: 42161,
};

// Inline chain logos (brand marks), keyed by chain family. Testnets reuse their parent chain's mark.
var CHAIN_LOGO_SVG = {
  eth: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="12" fill="#627EEA"/><path d="M12 4v5.9l5 2.25z" fill="#fff" fill-opacity=".6"/><path d="M12 4L7 12.15l5-2.25z" fill="#fff"/><path d="M12 16v3.99l5-6.92z" fill="#fff" fill-opacity=".6"/><path d="M12 19.99V16l-5-3.07z" fill="#fff"/><path d="M12 15.07l5-2.92-5-2.24z" fill="#fff" fill-opacity=".2"/><path d="M7 12.15l5 2.92v-5.16z" fill="#fff" fill-opacity=".6"/></svg>',
  op: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="12" fill="#FF0420"/><text x="12" y="15.6" font-size="8.5" font-weight="700" fill="#fff" text-anchor="middle" font-family="Helvetica,Arial,sans-serif">OP</text></svg>',
  base: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="12" fill="#0052FF"/><path d="M12 6.2A5.8 5.8 0 0 0 12 17.8V6.2z" fill="#fff"/></svg>',
  arb: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="12" fill="#2D374B"/><path d="M12 6l4.8 11h-2.4L12 11.2 9.6 17H7.2z" fill="#28A0F0"/><path d="M12 6l-1.05 2.45L12 11.2l1.05-2.75z" fill="#fff"/></svg>',
};
function chainFamily(chainId) {
  if (chainId === 1 || chainId === 11155111) return 'eth';
  if (chainId === 10 || chainId === 11155420) return 'op';
  if (chainId === 8453 || chainId === 84532) return 'base';
  if (chainId === 42161 || chainId === 421614) return 'arb';
  return null;
}
function chainLogo(chainId, titleName) {
  var fam = chainFamily(chainId);
  var span = el('span', 'chain-logo');
  if (titleName) span.title = titleName;
  if (fam && CHAIN_LOGO_SVG[fam]) span.innerHTML = CHAIN_LOGO_SVG[fam];
  else span.textContent = '◦';
  return span;
}

// An interactive chain logo for a project: hover shows the project's ID on that chain, click routes to
// the project on that chain (works from both the card and the detail header).
function projectChainLogo(project, chain) {
  var span = chainLogo(chain.id, null);
  span.classList.add('chain-logo-link');
  span.title = '#' + project.id + ' on ' + chain.name;
  span.addEventListener('click', function (e) {
    e.stopPropagation();
    var tab = _activeDetail ? _activeDetail.current : null;
    location.hash = '#' + slugForChain(chain.id) + ':' + project.id + (tab ? '/' + tab.toLowerCase() : '');
  });
  return span;
}

// URL chain slugs (and the default-chain priority order: eth → arb → base → op, testnets interleaved).
var CHAIN_SLUGS = [
  { slug: 'eth', id: 1 }, { slug: 'sep', id: 11155111 },
  { slug: 'arb', id: 42161 }, { slug: 'arbsep', id: 421614 },
  { slug: 'base', id: 8453 }, { slug: 'basesep', id: 84532 },
  { slug: 'op', id: 10 }, { slug: 'opsep', id: 11155420 },
];
function slugForChain(id) {
  for (var i = 0; i < CHAIN_SLUGS.length; i++) if (CHAIN_SLUGS[i].id === id) return CHAIN_SLUGS[i].slug;
  return String(id);
}
function chainForSlug(slug) {
  for (var i = 0; i < CHAIN_SLUGS.length; i++) if (CHAIN_SLUGS[i].slug === slug) return CHAIN_SLUGS[i].id;
  return null;
}
// Default URL chain for a project = first chain in priority order it's deployed on.
function defaultChainId(chains) {
  for (var i = 0; i < CHAIN_SLUGS.length; i++) {
    for (var j = 0; j < chains.length; j++) if (chains[j].id === CHAIN_SLUGS[i].id) return CHAIN_SLUGS[i].id;
  }
  return chains[0] ? chains[0].id : null;
}

// Set the location hash without retriggering the router (the hashchange handler honors this flag).
function routerSetHash(h) {
  if (location.hash === h) return;
  window.__suppressHash = true;
  location.hash = h;
}

// Router terminal registry (CREATE2-unified across testnets) — installed as a terminal on every revnet
// by REVDeployer. It exposes the standard pay/previewPayFor and swaps the payer's input token into the
// project's accounting token, so a payer can pay USDC into an ETH/USD-accounting revnet. Resolve the
// router from the manifest per-chain (JBRouterTerminalRegistry — deployed on all chains; it routes the
// swap-pay to the project's resolved terminal). The old hardcoded 0x986cda… was stale (not in the manifest,
// not even a JBRouterTerminal — no DIRECTORY()).
function routerTerminalFor(chainId) { return getAddress('JBRouterTerminalRegistry', chainId); }

// Canonical Circle testnet USDC (6 decimals), lowercased to avoid viem checksum validation. Offered as
// a pay currency on revnets (which have the router); previewPayFor reads "unavailable" where no pool.
var USDC_BY_CHAIN = {
  // Mainnets — native (Circle-issued) USDC.
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  // Testnets.
  84532: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  11155111: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  11155420: '0x5fd84259d66cd46123540766be93dfe6d43130d7',
  421614: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
};

// Minimal JBMultiTerminal.pay fragment for the inline pay card (preview reads go through pay-preview.js).
var payAbi = [{
  type: 'function', name: 'pay', stateMutability: 'payable',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
    { name: 'minReturnedTokens', type: 'uint256' },
    { name: 'memo', type: 'string' },
    { name: 'metadata', type: 'bytes' },
  ],
  outputs: [{ name: 'beneficiaryTokenCount', type: 'uint256' }],
}];

// addToBalanceOf — same shape on JBMultiTerminal and JBRouterTerminalRegistry. Adds funds to a project's
// balance WITHOUT minting tokens to anyone. shouldReturnHeldFees=false keeps it a plain top-up.
var addToBalanceAbi = [{
  type: 'function', name: 'addToBalanceOf', stateMutability: 'payable',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'shouldReturnHeldFees', type: 'bool' },
    { name: 'memo', type: 'string' },
    { name: 'metadata', type: 'bytes' },
  ],
  outputs: [],
}];

// What tokens a project's terminal accepts DIRECTLY (its accounting contexts). USD-based revnets accept
// USDC (token-keyed currency, 6 decimals) directly; ETH-based ones accept native ETH. Anything not
// accepted directly is offered as a swap-via-router currency instead.
var TERMINAL_CONTEXTS_ABI = [{
  type: 'function', name: 'accountingContextsOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }],
  outputs: [{ type: 'tuple[]', components: [
    { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }, { name: 'currency', type: 'uint32' },
  ] }],
}];
// JBMultiTerminal.addAccountingContextsFor — registers tokens the terminal accepts (gated by the ruleset's
// allowAddAccountingContext flag). JBAccountingContext.currency = uint32(uint160(token)).
var addAccountingContextsAbi = [{
  type: 'function', name: 'addAccountingContextsFor', stateMutability: 'nonpayable',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'accountingContexts', type: 'tuple[]', components: [
      { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }, { name: 'currency', type: 'uint32' },
    ] },
  ],
  outputs: [],
}];
var ERC20_DECIMALS_ABI = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }];
// Owner-power action ABIs (each gated by a ruleset metadata flag).
var mintTokensAbi = [{ type: 'function', name: 'mintTokensOf', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'tokenCount', type: 'uint256' }, { name: 'beneficiary', type: 'address' }, { name: 'memo', type: 'string' }, { name: 'useReservedPercent', type: 'bool' }], outputs: [] }];
var setControllerAbi = [{ type: 'function', name: 'setControllerOf', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'controller', type: 'address' }], outputs: [] }];
var setTerminalsAbi = [{ type: 'function', name: 'setTerminalsOf', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'terminals', type: 'address[]' }], outputs: [] }];
var migrateBalanceAbi = [{ type: 'function', name: 'migrateBalanceOf', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'token', type: 'address' }, { name: 'to', type: 'address' }], outputs: [{ type: 'uint256' }] }];
var addPriceFeedAbi = [{ type: 'function', name: 'addPriceFeedFor', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'pricingCurrency', type: 'uint256' }, { name: 'unitCurrency', type: 'uint256' }, { name: 'feed', type: 'address' }], outputs: [] }];
var setTokenAbi = [{ type: 'function', name: 'setTokenFor', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'token', type: 'address' }], outputs: [] }];

// ---- 721 NFT tiers (Shop). Verified against nana-721-hook-v6 + REVOwner.tiered721HookOf. ----
var REVO_TIERED_HOOK_ABI = [{ type: 'function', name: 'tiered721HookOf', stateMutability: 'view', inputs: [{ name: 'revnetId', type: 'uint256' }], outputs: [{ type: 'address' }] }];
// JBOmnichainDeployer.tiered721HookOf(projectId, rulesetId) — for omnichain (incl. custom) projects the ruleset
// dataHook is the deployer wrapper; the real 721 hook lives here, keyed per ruleset.
var OMNI_TIERED_HOOK_ABI = [{ type: 'function', name: 'tiered721HookOf', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'rulesetId', type: 'uint256' }], outputs: [{ name: 'hook', type: 'address' }, { name: 'useDataHookForCashOut', type: 'bool' }] }];
var HOOK_STORE_ABI = [{ type: 'function', name: 'STORE', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
var HOOK_METADATA_ID_TARGET_ABI = [{ type: 'function', name: 'METADATA_ID_TARGET', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
var TIER721_FLAGS = { name: 'flags', type: 'tuple', components: [
  { name: 'allowOwnerMint', type: 'bool' }, { name: 'transfersPausable', type: 'bool' }, { name: 'cantBeRemoved', type: 'bool' },
  { name: 'cantIncreaseDiscountPercent', type: 'bool' }, { name: 'cantBuyWithCredits', type: 'bool' }] };
var TIER721_TUPLE = { type: 'tuple[]', components: [
  { name: 'id', type: 'uint32' }, { name: 'price', type: 'uint104' }, { name: 'remainingSupply', type: 'uint32' }, { name: 'initialSupply', type: 'uint32' },
  { name: 'votingUnits', type: 'uint104' }, { name: 'reserveFrequency', type: 'uint16' }, { name: 'reserveBeneficiary', type: 'address' },
  { name: 'encodedIpfsUri', type: 'bytes32' }, { name: 'category', type: 'uint24' }, { name: 'discountPercent', type: 'uint8' },
  TIER721_FLAGS, { name: 'splitPercent', type: 'uint32' }, { name: 'resolvedUri', type: 'string' }] };
var TIER721_STORE_ABI = [
  { type: 'function', name: 'tiersOf', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256[]' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], outputs: [TIER721_TUPLE] },
  { type: 'function', name: 'tokenUriResolverOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }] },
];
var TIER721_RESOLVER_ABI = [{ type: 'function', name: 'tokenUriOf', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'string' }] }];

// bytes32 IPFS hash → "ipfs://Qm…" (CIDv0). Prepend the sha2-256/32-byte multihash prefix 0x1220, base58btc.
var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  var digits = [0];
  for (var i = 0; i < bytes.length; i++) {
    var carry = bytes[i];
    for (var j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  var out = '';
  for (var z = 0; z < bytes.length && bytes[z] === 0; z++) out += '1';
  for (var k = digits.length - 1; k >= 0; k--) out += B58[digits[k]];
  return out;
}
function decodeEncodedIpfs(b32) {
  if (!b32 || /^0x0+$/.test(b32)) return null;
  var hex = b32.slice(2);
  if (hex.length === 66) hex = hex.slice(2); // drop a leading version byte if present
  var bytes = [0x12, 0x20];
  for (var i = 0; i < 64; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  return 'ipfs://' + base58Encode(bytes);
}

// Permit2 swap-pay metadata: replaces the scary ERC20 "approve the router" tx with a one-time ERC20→Permit2
// approval + a GASLESS Permit2 signature. The router's `_acceptFundsFor` reads a JBSingleAllowance from the
// pay metadata (keyed to the router via getId("permit2", router)), calls PERMIT2.permit with it, then pulls
// via PERMIT2.transferFrom. Returns the metadata hex; signs along the way (one approve tx if Permit2 is short).
function permit2MetadataId(target) {
  var k = keccak256('0x7065726d697432'); // keccak256(utf8 "permit2")
  var a = target.slice(2, 10).toLowerCase(), b = k.slice(2, 10), out = '';
  for (var i = 0; i < 8; i += 2) out += (parseInt(a.substr(i, 2), 16) ^ parseInt(b.substr(i, 2), 16)).toString(16).padStart(2, '0');
  return out;
}
async function buildRouterPermit2Metadata(chainId, token, owner, spender, amount, onStatus) {
  var client = clientFor(chainId);
  var wallet = getWalletClient();
  // The Permit2 signTypedData domain pins chainId, and the ERC20 approve writes on the active chain — switch the
  // wallet to the pay chain first or the signature targets the wrong chain / the approve lands elsewhere.
  var wc0 = await wallet.getChainId().catch(function () { return null; });
  if (wc0 !== chainId) { if (onStatus) onStatus('Switching to ' + chainNameOf(chainId) + '…', 'pending'); await switchChain(chainId); wallet = getWalletClient(); }
  // 1. One-time ERC20→Permit2 approval (to the canonical, audited Permit2 — recognized by wallets), only when short.
  var erc20Allow = await client.readContract({ address: token, abi: lpErc20Abi, functionName: 'allowance', args: [owner, PERMIT2_ADDRESS] });
  if (BigInt(erc20Allow) < amount) {
    if (onStatus) onStatus('Approving token for Permit2 (one-time)…', 'pending');
    var maxU = (1n << 256n) - 1n;
    var ah = await wallet.writeContract({ account: owner, chain: CHAINS[chainId], address: token, abi: lpErc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, maxU] });
    await client.waitForTransactionReceipt({ hash: ah });
  }
  // 2. Read the current Permit2 allowance to get the next nonce for (owner, token, spender=router).
  var p2 = await client.readContract({ address: PERMIT2_ADDRESS, abi: lpPermit2Abi, functionName: 'allowance', args: [owner, token, spender] });
  var nonce = Number(p2[2]);
  var now = Math.floor(Date.now() / 1000);
  var expiration = now + 1800, sigDeadline = BigInt(now + 1800);
  // 3. Sign the exact, expiring Permit2 single-allowance (gasless) authorizing the router to pull `amount`.
  if (onStatus) onStatus('Sign the payment authorization…', 'pending');
  var signature = await wallet.signTypedData({
    account: owner,
    domain: { name: 'Permit2', chainId: chainId, verifyingContract: PERMIT2_ADDRESS },
    types: LP_PERMIT2_TYPES,
    primaryType: 'PermitSingle',
    message: { details: { token: token, amount: amount, expiration: expiration, nonce: nonce }, spender: spender, sigDeadline: sigDeadline },
  });
  // 4. Encode JBSingleAllowance as ONE dynamic tuple (the router does abi.decode(data,(JBSingleAllowance)),
  //    which expects a leading offset word — flat params would empty-revert). Order: sigDeadline, amount,
  //    expiration, nonce, signature.
  var data = encodeAbiParameters(
    [{ type: 'tuple', components: [{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }, { type: 'bytes' }] }],
    [[sigDeadline, amount, expiration, nonce, signature]]
  );
  // 5. JBMetadataResolver envelope, keyed to the router (the contract that calls PERMIT2.permit/transferFrom).
  return '0x' + '00'.repeat(32) + permit2MetadataId(spender) + '02' + '00'.repeat(27) + data.slice(2);
}

// JB721 pay-metadata id: bytes4(bytes20(hook) ^ bytes20(keccak256("pay"))) — V6 purpose is "pay".
// The 4-byte JBMetadataResolver id = bytes4(bytes20(target) ^ bytes20(keccak256("pay"))). `target` is the
// hook's METADATA_ID_TARGET (the 721 implementation address shared by all clones), NOT the clone hook.
function tier721MetadataId(idTarget) {
  var k = keccak256('0x706179'); // keccak256(utf8 "pay")
  var a = idTarget.slice(2, 10).toLowerCase(), b = k.slice(2, 10), out = '';
  for (var i = 0; i < 8; i += 2) out += (parseInt(a.substr(i, 2), 16) ^ parseInt(b.substr(i, 2), 16)).toString(16).padStart(2, '0');
  return out;
}
// JBMetadataResolver envelope: [reserved word][lookup: id(4B)+offset(0x02)+pad][data]. data = (bool allowOverspending, uint16[] tierIds).
function buildTierMintMetadata(idTarget, tierIds) {
  var nftId = tier721MetadataId(idTarget);
  var data = encodeAbiParameters([{ type: 'bool' }, { type: 'uint16[]' }], [true, tierIds]);
  return '0x' + '00'.repeat(32) + nftId + '02' + '00'.repeat(27) + data.slice(2);
}

// The project's 721 hook (revnets: REVOwner.tiered721HookOf). Null if none / empty.
function readShopHook(project) {
  var client = clientFor(project.chainId);
  var revo = getAddress('REVOwner', project.chainId);
  var revoP = revo
    ? client.readContract({ address: revo, abi: REVO_TIERED_HOOK_ABI, functionName: 'tiered721HookOf', args: [BigInt(project.id)] })
        .then(function (h) { return (h && !/^0x0+$/.test(h)) ? h : null; }).catch(function () { return null; })
    : Promise.resolve(null);
  return revoP.then(function (h) {
    if (h) return h; // revnets: REVOwner tracks the project's 721 hook directly
    // Custom projects aren't in REVOwner. Read the current ruleset: its dataHook is either the omnichain
    // deployer (omnichain — the real 721 hook is in the deployer's tiered721HookOf mapping) or, for a
    // single-chain custom project, the 721 hook itself. fetchProjectTiers then verifies via STORE().
    var jbc = getAddress('JBController', project.chainId);
    if (!jbc) return null;
    return client.readContract({ address: jbc, abi: currentRulesetAbi, functionName: 'currentRulesetOf', args: [BigInt(project.id)] }).then(function (r) {
      var rs = r ? (r[0] || r.ruleset) : null;
      var m = r ? (r[1] || r.metadata) : null;
      if (!m || !m.useDataHookForPay || !m.dataHook || /^0x0+$/.test(m.dataHook)) return null;
      var omni = getAddress('JBOmnichainDeployer', project.chainId);
      if (omni && rs && m.dataHook.toLowerCase() === omni.toLowerCase()) {
        return client.readContract({ address: omni, abi: OMNI_TIERED_HOOK_ABI, functionName: 'tiered721HookOf', args: [BigInt(project.id), BigInt(rs.id)] })
          .then(function (cfg) { var hk = cfg && (cfg.hook || cfg[0]); return (hk && !/^0x0+$/.test(hk)) ? hk : null; }).catch(function () { return null; });
      }
      return m.dataHook; // single-chain custom: the dataHook is the 721 hook
    }).catch(function () { return null; });
  });
}

// All sellable tiers for a project: { hook, idTarget, store, resolver, tiers:[...] }. Null if no shop.
// idTarget = the hook's METADATA_ID_TARGET — the address the 721 hook uses to derive the "pay" metadata id.
// It is NOT the clone hook address: METADATA_ID_TARGET is an immutable set to address(this) in the
// implementation's constructor, so for a delegatecall clone it reads back as the IMPLEMENTATION address.
// The mint metadata id MUST be keyed to this, or the hook never sees the tierIds and no NFT is minted.
// Memoized per chain:project — a single detail open calls this from the pay-card strip, the Shop tab,
// and the Shop section; without the cache that's the same ~5-read 721 scan fired 2–3× concurrently and
// again on every reopen. `bustTiersCache` clears it after an operator adds a tier.
var _tiersCache = {};
function fetchProjectTiers(project) {
  var k = project.chainId + ':' + project.id;
  if (_tiersCache[k]) return _tiersCache[k];
  return (_tiersCache[k] = fetchProjectTiersUncached(project));
}
function bustTiersCache(project) { delete _tiersCache[project.chainId + ':' + project.id]; }

// A tier's effective (discounted) price. Mirrors JB721TiersHookStore: effective = price - mulDiv(price,
// discountPercent, 200), where DISCOUNT_DENOMINATOR = 200 (so discountPercent 200 = 100% off). Integer-floor
// division matches the on-chain mulDiv, so the displayed/charged amount equals what the store charges at mint.
export function tierEffectivePrice(price, discountPercent) {
  var p = BigInt(price || 0);
  var d = BigInt(discountPercent || 0);
  if (d <= 0n) return p;
  if (d > 200n) d = 200n;
  return p - (p * d) / 200n;
}

// Human "% off" label for a tier's discount. discountPercent is out of 200, so the shopper-facing % off is
// discountPercent / 2 (e.g. discountPercent 40 → "20% off"). Returns null when there is no active discount.
export function tierDiscountLabel(tier) {
  var d = Number((tier && tier.discountPercent) || 0);
  if (d <= 0) return null;
  var pct = d / 2;
  return (Number.isInteger(pct) ? String(pct) : pct.toFixed(1)) + '% off';
}

// A shopper-facing "% off" (0–100) → the on-chain discountPercent (0–200, denominator 200). The operator
// edit form takes % off; the store stores discountPercent. round(pctOff/100 * 200) = round(pctOff * 2).
export function pctOffToDiscountPercent(pctOff) {
  var p = Number(pctOff) || 0;
  if (p < 0) p = 0; if (p > 100) p = 100;
  return Math.round(p / 100 * 200);
}
// One entry of setDiscountPercentsOf — {tierId, discountPercent} for the 721 hook.
export function buildSetDiscountConfig(tierId, pctOff) {
  return { tierId: Number(tierId), discountPercent: pctOffToDiscountPercent(pctOff) };
}

async function fetchProjectTiersUncached(project) {
  var hook = await readShopHook(project);
  if (!hook) return null;
  var client = clientFor(project.chainId);
  var store = await client.readContract({ address: hook, abi: HOOK_STORE_ABI, functionName: 'STORE', args: [] }).catch(function () { return null; });
  if (!store) return null;
  var idTarget = await client.readContract({ address: hook, abi: HOOK_METADATA_ID_TARGET_ABI, functionName: 'METADATA_ID_TARGET', args: [] }).catch(function () { return hook; });
  if (!idTarget || /^0x0+$/.test(idTarget)) idTarget = hook;
  var resolver = await client.readContract({ address: store, abi: TIER721_STORE_ABI, functionName: 'tokenUriResolverOf', args: [hook] }).catch(function () { return null; });
  if (resolver && /^0x0+$/.test(resolver)) resolver = null;
  var raw = await client.readContract({ address: store, abi: TIER721_STORE_ABI, functionName: 'tiersOf', args: [hook, [], false, 0n, 200n] }).catch(function () { return []; });
  var tiers = (raw || []).map(function (t) {
    return { id: Number(t.id), price: toBigInt(t.price), remaining: Number(t.remainingSupply), initial: Number(t.initialSupply),
      category: Number(t.category), encodedIpfsUri: t.encodedIpfsUri,
      discountPercent: Number(t.discountPercent || 0), // out of 200 (DISCOUNT_DENOMINATOR); see tierEffectivePrice
      reserveFrequency: Number(t.reserveFrequency || 0), votingUnits: toBigInt(t.votingUnits || 0),
      reserveBeneficiary: t.reserveBeneficiary, splitPercent: Number(t.splitPercent || 0),
      flags: t.flags || {}, allowOwnerMint: t.flags && t.flags.allowOwnerMint };
  }).filter(function (t) { return t.initial > 0; });
  return { hook: hook, idTarget: idTarget, store: store, resolver: resolver, tiers: tiers };
}

// Resolve a tier's display { name, image, category } — prefer the on-chain tokenUriResolver (it returns
// productName + categoryName + image uniformly for every tier, even ones that also carry an IPFS URI),
// falling back to the tier's IPFS metadata when no resolver is set. Best-effort.
function resolveTierMedia(shop, tier, chainId) {
  // The resolver sometimes returns an SVG that merely wraps an EXTERNAL <image href="…"> (Banny
  // accessories) — browsers block external loads inside an <img> data URI, so pull the href out and
  // load the bitmap directly. Inline-vector SVGs (Banny bodies) are self-contained and used as-is.
  var resolveImage = function (img) {
    if (!img) return '';
    var svg = /^data:image\/svg\+xml;base64,(.*)$/.exec(img);
    if (svg) {
      try { var m = /<image[^>]+href="([^"]+)"/.exec(decodeURIComponent(escape(atob(svg[1])))); if (m) return m[1]; } catch (_) {}
    }
    return ipfsToHttp(img);
  };
  var pick = function (j) {
    return {
      name: j.productName || j.name,
      image: resolveImage(j.image || j.imageUri),
      animationUrl: (j.animation_url || j.animationUrl) ? ipfsToHttp(j.animation_url || j.animationUrl) : '',
      mediaType: j.mediaType || '',
      category: j.categoryName,
    };
  };
  var fromIpfs = function () {
    var ipfs = decodeEncodedIpfs(tier.encodedIpfsUri);
    if (!ipfs) return {};
    return fetch(ipfsToHttp(ipfs)).then(function (r) { return r.json(); }).then(pick).catch(function () { return {}; });
  };
  if (shop.resolver) {
    return clientFor(chainId).readContract({ address: shop.resolver, abi: TIER721_RESOLVER_ABI, functionName: 'tokenUriOf', args: [shop.hook, BigInt(tier.id) * 1000000000n] })
      .then(function (uri) {
        var m = /^data:application\/json;base64,(.*)$/.exec(uri || '');
        if (!m) return fromIpfs();
        return pick(JSON.parse(decodeURIComponent(escape(atob(m[1])))));
      }).catch(fromIpfs);
  }
  return Promise.resolve(fromIpfs());
}

// Classify a tier's media so we render the right element. Prefer the stored MIME (`mediaType`), then the
// URL extension, defaulting to image (covers png/jpg/webp/gif/svg, which an <img> handles).
function tierMediaKind(m) {
  var t = (m.mediaType || '').toLowerCase();
  if (t.indexOf('image') === 0) return 'image';
  if (t.indexOf('video') === 0) return 'video';
  if (t.indexOf('audio') === 0) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  if (t.indexOf('text/') === 0 || t.indexOf('markdown') !== -1) return 'text';
  if (t) return 'file';
  var url = (m.animationUrl || m.image || '').toLowerCase().split('?')[0].split('#')[0];
  if (/\.(png|jpe?g|webp|gif|svg|avif|bmp)$/.test(url)) return 'image';
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(url)) return 'video';
  if (/\.(mp3|wav|ogg|flac|m4a|aac)$/.test(url)) return 'audio';
  if (/\.pdf$/.test(url)) return 'pdf';
  if (/\.(txt|md|markdown|json|csv)$/.test(url)) return 'text';
  return m.image ? 'image' : (m.animationUrl ? 'file' : '');
}
function tierMediaBadge(label, alt, url) {
  var safe = safeMediaUrl(url); // never let a javascript:/data:text URL become a clickable href
  var node = safe ? document.createElement('a') : el('div', 'tier-media-badge');
  node.className = 'tier-media-badge';
  if (safe) { node.href = safe; node.target = '_blank'; node.rel = 'noopener'; }
  var t = el('span', 'tier-media-badge-ext'); t.textContent = label; node.appendChild(t);
  node.title = alt || '';
  return node;
}
// Render a tier's media (any file type) into `container`. mode 'full' (card) or 'thumb' (small preview).
function renderTierMediaInto(container, m, alt, mode) {
  container.innerHTML = '';
  var kind = tierMediaKind(m);
  if (!kind) return false;
  var media = m.animationUrl || m.image;
  if (kind === 'image') {
    var img = document.createElement('img'); img.loading = 'lazy'; img.src = safeMediaUrl(m.image || media); img.alt = alt || ''; container.appendChild(img); return true;
  }
  if (kind === 'video') {
    var v = document.createElement('video'); v.src = safeMediaUrl(media); v.muted = true; v.loop = true; v.setAttribute('playsinline', ''); v.preload = 'metadata';
    if (mode === 'full') { v.controls = true; v.autoplay = true; } else { v.autoplay = true; }
    container.appendChild(v); return true;
  }
  if (kind === 'audio') {
    if (mode === 'thumb') { container.appendChild(tierMediaBadge('AUDIO', alt, media)); return true; }
    var wrapA = el('div', 'tier-media-audio');
    if (m.image) { var ai = document.createElement('img'); ai.loading = 'lazy'; ai.src = safeMediaUrl(m.image); ai.alt = alt || ''; wrapA.appendChild(ai); }
    var au = document.createElement('audio'); au.src = safeMediaUrl(media); au.controls = true; wrapA.appendChild(au);
    container.appendChild(wrapA); return true;
  }
  if (kind === 'pdf') {
    // An <iframe src> executes its target — a data:text/html or javascript: media URL would run script. Only
    // embed a real http(s) PDF; otherwise show a link badge (which itself sanitizes the href).
    var pdfSrc = httpUrlOnly(media);
    if (mode === 'thumb' || !pdfSrc) { container.appendChild(tierMediaBadge('PDF', alt, media)); return true; }
    var f = document.createElement('iframe'); f.src = pdfSrc; f.className = 'tier-media-frame'; f.setAttribute('loading', 'lazy'); f.setAttribute('sandbox', ''); container.appendChild(f); return true;
  }
  if (kind === 'text') {
    if (mode === 'thumb') { container.appendChild(tierMediaBadge('TXT', alt, media)); return true; }
    var pre = el('pre', 'tier-media-text'); pre.textContent = 'Loading…'; container.appendChild(pre);
    fetch(media).then(function (r) { return r.text(); }).then(function (txt) { pre.textContent = txt.slice(0, 6000); }).catch(function () { pre.textContent = 'Could not load file.'; });
    return true;
  }
  container.appendChild(tierMediaBadge('FILE', alt, media)); return true;
}

// Recommended max upload size — keeps IPFS-gateway load times reasonable. Over-limit images can be
// compressed client-side; other media can't (state the limit and ask for a smaller file).
var MAX_MEDIA_MB = 25;
var MAX_MEDIA_BYTES = MAX_MEDIA_MB * 1024 * 1024;
function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}
// Downscale + re-encode an image File until it fits under `maxBytes` (best effort). Returns a new File.
function compressImageFile(file, maxBytes) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      var canvas = document.createElement('canvas'); var ctx = canvas.getContext('2d');
      var attempts = [[1, 0.82], [1, 0.6], [0.8, 0.7], [0.8, 0.5], [0.6, 0.6], [0.6, 0.4], [0.45, 0.5], [0.35, 0.45]];
      var i = 0, last = null;
      var toFile = function (blob) { return new File([blob], (file.name.replace(/\.[^.]+$/, '') || 'image') + '.jpg', { type: 'image/jpeg' }); };
      function next() {
        if (i >= attempts.length) { URL.revokeObjectURL(url); return resolve(last ? toFile(last) : null); }
        var a = attempts[i++];
        canvas.width = Math.max(1, Math.round(w * a[0])); canvas.height = Math.max(1, Math.round(h * a[0]));
        ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (!blob) return next();
          last = blob;
          if (blob.size <= maxBytes) { URL.revokeObjectURL(url); resolve(toFile(blob)); } else next();
        }, 'image/jpeg', a[1]);
      }
      next();
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read image for compression')); };
    img.src = url;
  });
}

// Shared NFT "cart" for one project detail: selection (tierId→qty) + resolved names, with subscribers so
// the Pay-card strip and the Shop tab stay in sync (selecting in either place updates both). Qty changes
// notify `subscribe` listeners; name resolutions notify `onName` listeners (kept separate so a late name
// fetch re-renders labels without disturbing a user-typed pay amount).
function makeNftCart() {
  var sel = {}, names = {}, imgs = {}, subs = [], nameSubs = [];
  return {
    get: function (id) { return sel[id] || 0; },
    set: function (id, q) { q = Math.max(0, q || 0); if (!q) delete sel[id]; else sel[id] = q; subs.forEach(function (f) { try { f(id); } catch (_) {} }); },
    entries: function () { return sel; },
    setName: function (id, n) { names[id] = n; nameSubs.forEach(function (f) { try { f(id); } catch (_) {} }); },
    name: function (id) { return names[id]; },
    setImage: function (id, url) { if (url) imgs[id] = url; },
    image: function (id) { return imgs[id]; },
    subscribe: function (fn) { subs.push(fn); },
    onName: function (fn) { nameSubs.push(fn); },
  };
}

function renderShopSection(project, shop, cart) {
  var wrap = el('div', 'detail-section');
  var card = el('div', 'detail-card shop-card');
  var head = el('div', 'shop-card-head');
  var title = el('div', 'detail-card-title'); title.textContent = 'Shop'; head.appendChild(title);
  // Top-right "+ Add items" for the owner/operator (shown once the 721 hook resolves; gated on submit).
  var headAdd = el('a', 'operator-cta shop-head-add'); headAdd.href = '#'; headAdd.textContent = '+ Add items';
  headAdd.title = 'Add NFT items for sale (operator only)'; headAdd.style.display = 'none';
  head.appendChild(headAdd);
  card.appendChild(head);
  var body = el('div', 'shop-body'); card.appendChild(body);
  wrap.appendChild(card);

  // Instead of an intro blurb, surface the connected user's unclaimed credit balance for this project
  // (NFT overpayment becomes credits) as a key/value at the top — only when they actually hold some.
  function showCredits() {
    var acct = getAccount();
    if (!acct) return;
    read(project.chainId, 'JBTokens', creditBalanceOfAbi, 'creditBalanceOf', [acct, BigInt(project.id)]).then(toBigInt).then(function (credit) {
      if (!credit || credit <= 0n || !wrap.isConnected || card.querySelector('.shop-credits')) return;
      var row = el('div', 'about-link-row shop-credits');
      var k = el('span', 'about-link-key'); k.textContent = 'Your credits:'; row.appendChild(k);
      var v = el('span', 'token-line-val'); v.textContent = formatTokens(credit) + ' ' + (project.tokenSymbol || 'credits'); row.appendChild(v);
      card.insertBefore(row, body);
    }).catch(function () {});
  }

  // Operator: add an NFT tier (shown once we know the 721 hook). Appended after the body resolves.
  // Bottom-left also shows the 721 collection's contract address.
  // Footer shows the 721 collection's contract address. The "Add items" CTA lives top-right (headAdd) now.
  function appendAddTierFoot(s) {
    if (!s || !s.hook) return;
    headAdd.style.display = ''; // operator add control, top-right
    headAdd.onclick = function (e) { e.preventDefault(); openAddTierModal(project, s); };
    var foot = el('div', 'detail-about-foot shop-foot');
    var addr = el('div', 'shop-collection-addr');
    addr.appendChild(document.createTextNode('Address: '));
    addr.appendChild(addressLinkNode(s.hook, project.chainId));
    foot.appendChild(addr);
    card.appendChild(foot);
  }

  var ready = shop ? Promise.resolve(shop) : fetchProjectTiers(project);
  body.textContent = 'Loading items…';
  ready.then(function (s) {
    if (!wrap.isConnected) return;
    body.innerHTML = '';
    if (!s || !s.tiers.length) {
      body.className = 'detail-card-body owners-empty';
      body.textContent = s ? 'No items being sold yet' : 'No NFT store available.';
      appendAddTierFoot(s);
      return;
    }
    showCredits();
    appendAddTierFoot(s);
    body.className = 'shop-body';
    // Group tiers under category headings (juicy-vision layout), sorted by category number.
    var cats = [], seen = {};
    s.tiers.forEach(function (t) { if (!seen[t.category]) { seen[t.category] = true; cats.push(t.category); } });
    cats.sort(function (a, b) { return a - b; });
    var catNames = {}, headingEls = {}, refreshers = {}, chipEls = {};
    function catLabel(c) { return catNames[c] || (project.storeCategories && project.storeCategories[c]) || (c === 0 ? 'General' : 'Category ' + c); }

    // Lead with category filter chips: click to show only the selected categories (multi-select);
    // "All" (the default) shows everything.
    var selectedCats = null; // null = All
    function applyFilter() {
      cats.forEach(function (c) { var g = headingEls[c] && headingEls[c].parentElement; if (g) g.style.display = (!selectedCats || selectedCats.has(c)) ? '' : 'none'; });
      if (chipEls.all) chipEls.all.classList.toggle('active', !selectedCats);
      cats.forEach(function (c) { if (chipEls[c]) chipEls[c].classList.toggle('active', !!selectedCats && selectedCats.has(c)); });
    }
    if (cats.length > 1) {
      var chipRow = el('div', 'shop-cat-chips');
      var mkChip = function (label, onClick) { var b = el('button', 'shop-cat-chip'); b.textContent = label; b.addEventListener('click', onClick); return b; };
      chipEls.all = mkChip('All', function () { selectedCats = null; applyFilter(); });
      chipRow.appendChild(chipEls.all);
      cats.forEach(function (c) {
        chipEls[c] = mkChip(catLabel(c), function () {
          if (!selectedCats) selectedCats = new Set();
          if (selectedCats.has(c)) selectedCats.delete(c); else selectedCats.add(c);
          if (!selectedCats.size) selectedCats = null; // deselecting the last one returns to All
          applyFilter();
        });
        chipRow.appendChild(chipEls[c]);
      });
      body.appendChild(chipRow);
    }

    cats.forEach(function (c) {
      var group = el('div', 'shop-cat-group');
      var heading = el('div', 'shop-cat-heading'); heading.textContent = catLabel(c); group.appendChild(heading);
      headingEls[c] = heading;
      var grid = el('div', 'shop-grid'); group.appendChild(grid);
      s.tiers.filter(function (t) { return t.category === c; }).forEach(function (t) {
        grid.appendChild(renderTierCard(project, s, t, function (cat, name) {
          if (cat != null && name && !catNames[cat]) { catNames[cat] = name; if (headingEls[cat]) headingEls[cat].textContent = name; if (chipEls[cat]) chipEls[cat].textContent = name; }
        }, cart, refreshers));
      });
      body.appendChild(group);
    });
    applyFilter();
    if (cart) cart.subscribe(function (id) { if (refreshers[id]) refreshers[id](); });

    // Focus hook: clicking a tier in the Pay-card strip scrolls to (and briefly highlights) its card here.
    function focusTier(id) {
      var cardEl = body.querySelector('[data-tier-id="' + id + '"]');
      if (!cardEl) return;
      cardEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      cardEl.classList.add('shop-tier-focus');
      setTimeout(function () { cardEl.classList.remove('shop-tier-focus'); }, 1500);
    }
    if (_activeDetail) _activeDetail.shopFocus = focusTier;
  }).catch(function () { if (wrap.isConnected) { body.className = 'detail-card-body owners-empty'; body.textContent = 'Could not load the shop.'; } });

  // Mobile checkout bar — on phones the Pay card (where the purchase is completed) is a separate stacked
  // section above the tabs, so once items are in the cart show a bar that scrolls up to it. Hidden on
  // desktop, where the Pay card sits in the always-visible left column beside the shop.
  var checkoutBar = el('button', 'shop-checkout-bar');
  checkoutBar.addEventListener('click', function () {
    var pay = document.querySelector('.project-detail-left .paybox') || document.querySelector('.paybox');
    if (pay) pay.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  function updateCheckout() {
    if (!wrap.isConnected) return;
    var entries = cart ? cart.entries() : {};
    var n = 0; for (var k in entries) n += entries[k];
    checkoutBar.textContent = 'Checkout · ' + n + ' item' + (n === 1 ? '' : 's') + ' →';
    checkoutBar.classList.toggle('shown', n > 0);
  }
  if (cart) cart.subscribe(updateCheckout);
  updateCheckout();
  wrap.appendChild(checkoutBar);
  return wrap;
}

// JB721 tiers cap supply at one billion − 1; that maximum doubles as the "unlimited" sentinel.
var TIER_UNLIMITED_SUPPLY = 999999999;

// Resolve a project (by its id on `chainId`) to a display name + its projectId on each chain in its
// sucker group. Lets a tier split route to the SAME project on every chain it's offered on, and lets us
// confirm the project by name. Cached. Returns { name, byChain: { chainId: projectId } } or null.
var _splitProjCache = {};
function resolveSplitProject(projectId, chainId) {
  var key = chainId + ':' + projectId;
  if (_splitProjCache[key]) return _splitProjCache[key];
  var p = (async function () {
    var res = await bendystrawQuery(
      'query($projectId: Float!, $chainId: Float!, $version: Float!) { project(projectId: $projectId, chainId: $chainId, version: $version) { name handle suckerGroupId } }',
      { projectId: Number(projectId), chainId: Number(chainId), version: BENDYSTRAW_VERSION }
    ).catch(function () { return null; });
    var proj = res && res.project;
    if (!proj) return null;
    var byChain = {}; byChain[Number(chainId)] = Number(projectId);
    if (proj.suckerGroupId) {
      var g = await bendystrawQuery('query($id: String!) { suckerGroup(id: $id) { projects } }', { id: proj.suckerGroupId }).catch(function () { return null; });
      var list = g && g.suckerGroup && g.suckerGroup.projects;
      if (Array.isArray(list)) list.forEach(function (s) { var m = /^(\d+)-(\d+)-/.exec(String(s)); if (m) byChain[Number(m[1])] = Number(m[2]); });
    }
    return { name: proj.name || proj.handle || ('Project #' + projectId), byChain: byChain };
  })();
  _splitProjCache[key] = p;
  return p;
}

// Operator-only: add an NFT tier to the project's 721 hook on the chosen chains, via relayr.
function openAddTierModal(project, shop) {
  var authorityLabel = (projectAuthorityLabel(project) || 'Operator').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var allChains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('Chain ' + project.chainId) }];
  var baseUsd = project.metadata && Number(project.metadata.baseCurrency) === 2;
  var priceUnit = baseUsd ? 'USDC' : 'ETH';
  var priceDecimals = baseUsd ? 6 : 18;

  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode(authorityLabel, operatorAddr, 'to add an item.'));

  function fieldIn(parent, label, placeholder, attrs, topGap) {
    var l = el('div', 'operator-edit-label'); l.style.marginTop = (topGap == null ? 10 : topGap) + 'px'; l.textContent = label; parent.appendChild(l);
    var i = el('input', 'operator-edit-jwt'); i.type = (attrs && attrs.type) || 'text'; i.placeholder = placeholder || '';
    if (attrs && attrs.step) i.step = attrs.step; if (attrs && attrs.min) i.min = attrs.min;
    parent.appendChild(i); return i;
  }
  var nameInput = fieldIn(content, 'Name', 'My juicy thing', null, 0);

  var ilbl = el('div', 'operator-edit-label'); ilbl.style.marginTop = '10px'; ilbl.textContent = 'Media'; content.appendChild(ilbl);
  var isub = el('div', 'operator-edit-sub'); isub.textContent = 'Image, gif, video, audio, PDF, text… up to ' + MAX_MEDIA_MB + ' MB.'; content.appendChild(isub);
  var imgRow = el('div', 'operator-edit-logo');
  var imgPrev = document.createElement('img'); imgPrev.className = 'operator-edit-logo-prev'; imgPrev.style.display = 'none'; imgRow.appendChild(imgPrev);
  var mediaHint = el('span', 'operator-edit-hint'); mediaHint.style.display = 'none'; imgRow.appendChild(mediaHint);
  var imgFile = document.createElement('input'); imgFile.type = 'file'; imgFile.className = 'operator-edit-logo-file';
  // Any file type: image / gif / video / audio / pdf / markdown / text …
  imgFile.accept = 'image/*,video/*,audio/*,application/pdf,text/*,.md,.markdown';
  var mediaClear = el('a', 'operator-edit-logo-clear'); mediaClear.href = '#'; mediaClear.textContent = '✕'; mediaClear.title = 'Remove file'; mediaClear.style.display = 'none';
  var mediaMsg = el('div', 'operator-edit-mediamsg'); mediaMsg.style.display = 'none';
  var selectedMedia = null;
  function showPreview(f) {
    if ((f.type || '').indexOf('image') === 0) { imgPrev.style.display = ''; imgPrev.src = URL.createObjectURL(f); mediaHint.style.display = 'none'; }
    else { imgPrev.style.display = 'none'; mediaHint.style.display = ''; mediaHint.textContent = (f.type || 'file') + ' | ' + formatFileSize(f.size); }
    mediaClear.style.display = '';
  }
  function setMedia(f) { selectedMedia = f; showPreview(f); }
  function clearMedia() {
    selectedMedia = null;
    imgPrev.style.display = 'none'; imgPrev.removeAttribute('src');
    mediaHint.style.display = 'none'; mediaHint.textContent = '';
    mediaMsg.style.display = 'none';
    mediaClear.style.display = 'none';
  }
  function checkSize() {
    var f = selectedMedia; if (!f) { mediaMsg.style.display = 'none'; return; }
    if (f.size <= MAX_MEDIA_BYTES) { mediaMsg.style.display = 'none'; return; }
    mediaMsg.style.display = ''; mediaMsg.className = 'operator-edit-mediamsg warn'; mediaMsg.innerHTML = '';
    var over = document.createTextNode('This file is ' + formatFileSize(f.size) + ' — over the ' + MAX_MEDIA_MB + ' MB max. ');
    mediaMsg.appendChild(over);
    if ((f.type || '').indexOf('image') === 0) {
      var comp = el('a', 'operator-cta'); comp.href = '#'; comp.textContent = 'Compress to fit';
      comp.addEventListener('click', function (e) {
        e.preventDefault();
        mediaMsg.className = 'operator-edit-mediamsg'; mediaMsg.textContent = 'Compressing…';
        compressImageFile(f, MAX_MEDIA_BYTES).then(function (cf) {
          if (cf && cf.size <= MAX_MEDIA_BYTES) {
            setMedia(cf);
            mediaMsg.className = 'operator-edit-mediamsg ok'; mediaMsg.textContent = 'Compressed to ' + formatFileSize(cf.size) + '';
          } else {
            setMedia(cf || f); checkSize();
            if (cf) mediaMsg.innerHTML = 'Compressed to ' + formatFileSize(cf.size) + ', still over the limit — try a smaller source.';
          }
        }).catch(function () { mediaMsg.className = 'operator-edit-mediamsg warn'; mediaMsg.textContent = 'Could not compress this image — choose a smaller file.'; });
      });
      mediaMsg.appendChild(comp);
    } else {
      mediaMsg.appendChild(document.createTextNode('Video/audio/other files can’t be compressed here — choose a smaller file.'));
    }
  }
  imgFile.addEventListener('change', function () {
    var f = imgFile.files && imgFile.files[0];
    if (!f) { clearMedia(); return; } // picker dismissed / cleared — drop the stale preview
    setMedia(f); checkSize();
  });
  mediaClear.addEventListener('click', function (e) { e.preventDefault(); imgFile.value = ''; clearMedia(); });
  imgRow.appendChild(imgFile); imgRow.appendChild(mediaClear); content.appendChild(imgRow);
  content.appendChild(mediaMsg);

  var priceInput = fieldIn(content, 'Price (' + priceUnit + ')', '0.0', { type: 'number', step: 'any', min: '0' });

  // Split sales — opt-in checkbox under Price. When on, route a % of each sale to addresses/projects.
  var splitRefChain = (allChains[0] && allChains[0].id) || project.chainId; // chain the entered project IDs refer to
  // Wrap the checkbox + recipients in one section so it hugs the Price field above but keeps the standard
  // gap to Inventory below, regardless of whether the recipients are shown.
  var splitSection = el('div', 'operator-split-section'); content.appendChild(splitSection);
  var splitCbRow = el('label', 'operator-flag-row'); splitCbRow.style.marginTop = '0';
  var splitCb = document.createElement('input'); splitCb.type = 'checkbox'; splitCbRow.appendChild(splitCb);
  var scs = el('span'); scs.textContent = 'Split sales'; splitCbRow.appendChild(scs); splitSection.appendChild(splitCbRow);
  var splitWrap = el('div', 'operator-split-recipients'); splitWrap.style.display = 'none'; splitSection.appendChild(splitWrap);
  var splitSub = el('div', 'operator-edit-sub'); splitSub.textContent = 'Send part of each sale to other addresses or projects. The rest goes to this project.'; splitWrap.appendChild(splitSub);
  var splitRowsBox = el('div', 'splits-edit-rows'); splitWrap.appendChild(splitRowsBox);
  var splitRows = [];
  function addTierSplitRow() {
    var row = el('div', 'tier-split-row');
    var line = el('div', 'tier-split-line');
    var pct = el('input', 'splits-edit-pct'); pct.type = 'number'; pct.step = 'any'; pct.min = '0'; pct.placeholder = '10';
    var to = el('span', 'tier-split-to'); to.textContent = '% to';
    var recip = el('input', 'splits-edit-addr tier-split-recip'); recip.type = 'text'; recip.placeholder = '0x… or project ID';
    var rm = el('a', 'splits-edit-rm'); rm.href = '#'; rm.textContent = '✕';
    line.appendChild(pct); line.appendChild(to); line.appendChild(recip); line.appendChild(rm); row.appendChild(line);
    // Project-recipient extras: a confirmation of the project name + a token-beneficiary line.
    var nameHint = el('div', 'tier-split-projname'); nameHint.style.display = 'none'; row.appendChild(nameHint);
    var benefRow = el('div', 'tier-split-benef'); benefRow.style.display = 'none';
    var benef = el('input', 'splits-edit-addr'); benef.type = 'text'; benef.placeholder = '0x… who receives the project’s tokens'; benefRow.appendChild(benef);
    row.appendChild(benefRow);
    var rec = { pct: pct, recip: recip, benef: benef, nameHint: nameHint };
    function refresh() {
      var v = (recip.value || '').trim();
      if (/^[0-9]+$/.test(v) && Number(v) > 0) {
        benefRow.style.display = ''; nameHint.style.display = ''; nameHint.className = 'tier-split-projname'; nameHint.textContent = 'Looking up project #' + v + '…';
        resolveSplitProject(v, splitRefChain).then(function (info) {
          if ((recip.value || '').trim() !== v) return;
          if (info) { nameHint.textContent = '→ ' + info.name; }
          else { nameHint.className = 'tier-split-projname warn'; nameHint.textContent = 'No project #' + v + ' found on this chain.'; }
        });
      } else { benefRow.style.display = 'none'; nameHint.style.display = 'none'; }
    }
    recip.addEventListener('input', refresh);
    rm.addEventListener('click', function (e) { e.preventDefault(); splitRows = splitRows.filter(function (x) { return x !== rec; }); row.remove(); if (!splitRows.length) { splitCb.checked = false; splitWrap.style.display = 'none'; } });
    rec.isEmpty = function () { return !(recip.value || '').trim() && !(pct.value || '').trim(); };
    rec.parse = function () {
      var v = (recip.value || '').trim();
      if (isAddr(v)) return { projectId: 0, beneficiary: v };
      if (/^[0-9]+$/.test(v) && Number(v) > 0) {
        var b = (benef.value || '').trim();
        if (!isAddr(b)) throw new Error('Project #' + v + ' needs a token beneficiary address');
        return { projectId: Number(v), beneficiary: b };
      }
      throw new Error('Enter a 0x address or a project ID');
    };
    splitRowsBox.appendChild(row); splitRows.push(rec);
  }
  var addSplit = el('a', 'operator-cta splits-edit-add'); addSplit.href = '#'; addSplit.textContent = '+ Add recipient';
  addSplit.addEventListener('click', function (e) { e.preventDefault(); addTierSplitRow(); }); splitWrap.appendChild(addSplit);
  splitCb.addEventListener('change', function () {
    splitWrap.style.display = splitCb.checked ? '' : 'none';
    if (splitCb.checked && !splitRows.length) addTierSplitRow();
  });

  // Initial discount — opt-in checkbox under Split sales; sets the item's starting % off the price.
  var discCbRow = el('label', 'operator-flag-row');
  var discCb = document.createElement('input'); discCb.type = 'checkbox'; discCbRow.appendChild(discCb);
  var discS = el('span'); discS.textContent = 'Initial discount'; discCbRow.appendChild(discS); splitSection.appendChild(discCbRow);
  var discWrap = el('div', 'operator-disc-wrap'); discWrap.style.display = 'none'; splitSection.appendChild(discWrap);
  var discRow = el('div', 'operator-reserve-freqrow');
  var discInput = el('input', 'operator-edit-jwt operator-inline-num'); discInput.type = 'number'; discInput.step = 'any'; discInput.min = '0'; discInput.max = '100'; discInput.placeholder = '10';
  discRow.appendChild(discInput); discRow.appendChild(document.createTextNode(' % off the price'));
  discWrap.appendChild(discRow);
  discCb.addEventListener('change', function () { discWrap.style.display = discCb.checked ? '' : 'none'; if (!discCb.checked) discInput.value = ''; });

  // Splitting and discounting only make sense once there's a price — gate both checkboxes on a non-zero price.
  function syncSplitEnabled() {
    var hasPrice = parseFloat(priceInput.value) > 0;
    splitCb.disabled = !hasPrice; splitCbRow.classList.toggle('disabled', !hasPrice);
    if (!hasPrice && splitCb.checked) { splitCb.checked = false; splitWrap.style.display = 'none'; }
    discCb.disabled = !hasPrice; discCbRow.classList.toggle('disabled', !hasPrice);
    if (!hasPrice && discCb.checked) { discCb.checked = false; discWrap.style.display = 'none'; }
  }
  priceInput.addEventListener('input', syncSplitEnabled);
  syncSplitEnabled();

  // Inventory — unlimited by default; uncheck to cap the supply. Wrapped in a section so the gap to
  // Category stays a consistent 24px whether or not the quantity field is shown (the row ends in a
  // checkbox with no bottom margin, so without the wrapper the gap collapses to the label's 10px).
  var invSection = el('div', 'operator-inv-section'); content.appendChild(invSection);
  var invLbl = el('div', 'operator-edit-label'); invLbl.style.marginTop = '0'; invLbl.textContent = 'Inventory'; invSection.appendChild(invLbl);
  var unlimitedRow = el('label', 'operator-flag-row'); unlimitedRow.style.marginTop = '0';
  var unlimitedCb = document.createElement('input'); unlimitedCb.type = 'checkbox'; unlimitedCb.checked = true; unlimitedRow.appendChild(unlimitedCb);
  var us = el('span'); us.textContent = 'Unlimited'; unlimitedRow.appendChild(us); invSection.appendChild(unlimitedRow);
  var supplyWrap = el('div', 'operator-supply-wrap'); supplyWrap.style.display = 'none';
  var supplyLbl = el('div', 'operator-edit-sub'); supplyLbl.style.marginTop = '8px'; supplyLbl.textContent = 'Quantity'; supplyWrap.appendChild(supplyLbl);
  var supplyInput = el('input', 'operator-edit-jwt'); supplyInput.type = 'number'; supplyInput.step = '1'; supplyInput.min = '1'; supplyInput.placeholder = '100'; supplyWrap.appendChild(supplyInput);
  invSection.appendChild(supplyWrap);
  unlimitedCb.addEventListener('change', function () { supplyWrap.style.display = unlimitedCb.checked ? 'none' : ''; });

  // Category — pick from the operator's named store categories (or Default). Categories are named in the
  // project metadata (projectUri), so adding them costs a tx — let the operator add several in one go.
  var catLbl = el('div', 'operator-edit-label'); catLbl.style.marginTop = '10px'; catLbl.textContent = 'Category'; content.appendChild(catLbl);
  var catSub = el('div', 'operator-edit-sub'); catSub.textContent = 'Items being sold can be organized by category.'; content.appendChild(catSub);
  var categorySelect = el('select', 'operator-cat-select');
  function rebuildCatOptions() {
    categorySelect.innerHTML = '';
    var o0 = document.createElement('option'); o0.value = '0'; o0.textContent = 'Default'; categorySelect.appendChild(o0);
    Object.keys(project.storeCategories || {}).map(Number).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; })
      .forEach(function (n) { var o = document.createElement('option'); o.value = String(n); o.textContent = project.storeCategories[n] + ' (#' + n + ')'; categorySelect.appendChild(o); });
    var oAdd = document.createElement('option'); oAdd.value = '__add__'; oAdd.textContent = '+ Add category…'; categorySelect.appendChild(oAdd);
  }
  rebuildCatOptions(); content.appendChild(categorySelect);
  var lastCatValue = '0';
  var addCatBox = el('div', 'operator-cat-add'); addCatBox.style.display = 'none';
  var catNameRows = el('div', 'operator-cat-names'); addCatBox.appendChild(catNameRows);
  var catInputs = [];
  // New categories get the next free ids after the existing ones; show each row as "<id> is [name]".
  var catBaseId = Object.keys(project.storeCategories || {}).map(Number).reduce(function (m, n) { return n > m ? n : m; }, 0);
  function renumberCatRows() {
    var tags = catNameRows.querySelectorAll('.cat-id');
    for (var i = 0; i < tags.length; i++) tags[i].textContent = (catBaseId + i + 1) + ' is';
  }
  function addCatNameRow() {
    var row = el('div', 'operator-cat-namerow');
    var idTag = el('span', 'cat-id');
    var inp = el('input', 'splits-edit-addr'); inp.type = 'text'; inp.placeholder = 'category name';
    var rm = el('a', 'splits-edit-rm'); rm.href = '#'; rm.textContent = '✕';
    rm.addEventListener('click', function (e) {
      e.preventDefault();
      catInputs = catInputs.filter(function (x) { return x !== inp; });
      row.remove(); renumberCatRows();
      // Removing the last row cancels adding — restore the dropdown.
      if (!catInputs.length) { addCatBox.style.display = 'none'; categorySelect.style.display = ''; }
    });
    row.appendChild(idTag); row.appendChild(inp); row.appendChild(rm); catNameRows.appendChild(row); catInputs.push(inp);
    renumberCatRows();
  }
  addCatNameRow();
  var addAnother = el('a', 'operator-cta operator-cat-another'); addAnother.href = '#'; addAnother.textContent = '+ Add another';
  addAnother.addEventListener('click', function (e) { e.preventDefault(); addCatNameRow(); }); addCatBox.appendChild(addAnother);
  var addCatActions = el('div', 'operator-cat-actions');
  var addCatSave = el('a', 'operator-cta'); addCatSave.href = '#'; addCatSave.textContent = 'Save categories'; addCatActions.appendChild(addCatSave);
  addCatBox.appendChild(addCatActions);
  var addCatStatus = el('div', 'operator-edit-status'); addCatBox.appendChild(addCatStatus);
  content.appendChild(addCatBox);
  // Choosing "+ Add category…" swaps the dropdown itself for the text editor (revert selection first).
  categorySelect.addEventListener('change', function () {
    if (categorySelect.value === '__add__') { categorySelect.value = lastCatValue; categorySelect.style.display = 'none'; addCatBox.style.display = 'block'; }
    else { lastCatValue = categorySelect.value; }
  });
  addCatSave.addEventListener('click', function (e) {
    e.preventDefault();
    var names = catInputs.map(function (i) { return (i.value || '').trim(); }).filter(Boolean);
    var setS = makeStatusSetter(addCatStatus, 'operator-edit-status');
    if (!names.length) { setS('Enter at least one category name', 'error'); return; }
    if (jwtInput && jwtInput.value.trim()) setPinataJwt(jwtInput.value.trim());
    addStoreCategories(project, allChains, operatorAddr, names, setS).then(function (newIds) {
      if (!newIds || !newIds.length) return;
      rebuildCatOptions(); categorySelect.value = String(newIds[0]); lastCatValue = categorySelect.value;
      catNameRows.innerHTML = ''; catInputs = []; addCatNameRow();
      addCatBox.style.display = 'none'; categorySelect.style.display = '';
    }).catch(function (err) { setS(errMessage(err, 'Failed to add categories'), 'error'); });
  });

  // Extra options — reserved mints, tier-level splits, governance, flags.
  var advToggle = el('a', 'operator-cta operator-adv-toggle'); advToggle.href = '#'; advToggle.textContent = 'Extra options ▾';
  content.appendChild(advToggle);
  var adv = el('div', 'operator-edit-adv'); adv.style.display = 'none'; content.appendChild(adv);
  advToggle.addEventListener('click', function (e) { e.preventDefault(); var open = adv.style.display === 'none'; adv.style.display = open ? 'block' : 'none'; advToggle.textContent = 'Extra options ' + (open ? '▴' : '▾'); });

  // Reserve — opt-in checkbox; when on, set aside "1 of every N sold" for a chosen address.
  var reserveCbRow = el('label', 'operator-flag-row');
  var reserveCb = document.createElement('input'); reserveCb.type = 'checkbox'; reserveCbRow.appendChild(reserveCb);
  var rcs = el('span'); rcs.textContent = 'Reserve inventory'; reserveCbRow.appendChild(rcs);
  adv.appendChild(reserveCbRow);
  var rsub = el('div', 'operator-flag-sub'); rsub.textContent = 'Set aside items as they’re bought'; adv.appendChild(rsub);
  var reserveWrap = el('div', 'operator-reserve-wrap'); reserveWrap.style.display = 'none'; adv.appendChild(reserveWrap);
  // One inline line: "1 of [N] sold to [0x…]"
  var freqRow = el('div', 'operator-reserve-freqrow');
  freqRow.appendChild(document.createTextNode('1 of '));
  var reserveFreqInput = el('input', 'operator-edit-jwt operator-inline-num'); reserveFreqInput.type = 'number'; reserveFreqInput.step = '1'; reserveFreqInput.min = '1'; reserveFreqInput.placeholder = '10';
  freqRow.appendChild(reserveFreqInput);
  freqRow.appendChild(document.createTextNode(' sold to '));
  var reserveBenefInput = el('input', 'operator-edit-jwt operator-inline-addr'); reserveBenefInput.type = 'text'; reserveBenefInput.placeholder = '0x… address';
  freqRow.appendChild(reserveBenefInput);
  reserveWrap.appendChild(freqRow);
  reserveCb.addEventListener('change', function () { reserveWrap.style.display = reserveCb.checked ? '' : 'none'; });

  // Flags — one per row, each with a plain-language subtitle.
  function flagCheck(label, sub, checked) {
    var row = el('label', 'operator-flag-row'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!checked;
    row.appendChild(cb); var s = el('span'); s.textContent = label; row.appendChild(s); adv.appendChild(row);
    if (sub) { var d = el('div', 'operator-flag-sub'); d.textContent = sub; adv.appendChild(d); }
    return cb;
  }
  var allowOwnerMintCb = flagCheck('Owner privileged access', 'Owner can take from inventory for free');
  // Transfers can only be paused per-ruleset; revnets have fixed rulesets, so the option doesn't apply.
  var transfersPausableCb = project.isRevnet ? null : flagCheck('Transfers pausable per ruleset', 'Allow this item’s transfers to be paused during a ruleset.');
  var cantBeRemovedCb = flagCheck('Permanent', 'Lock this item so it can never be removed from the store.');
  // Credits: default on. cantBuyWithCredits is the inverse of this checkbox.
  var allowCreditsCb = flagCheck('Allow credit purchases', 'Payments that don’t buy items get credits equal to their payment, usable later to buy items that allow it.', true);
  // Discount: a capability flag only — no initial discount is set here. cantIncreaseDiscountPercent is the inverse.
  var ownerDiscountCb = flagCheck('Owner can edit discounts', 'The item can have its percent discount changed by the owner.', true);

  // Voting units — opt-in, last in the list. Default off; the price drives governance weight unless overridden.
  var votingCbRow = el('label', 'operator-flag-row');
  var votingCb = document.createElement('input'); votingCb.type = 'checkbox'; votingCbRow.appendChild(votingCb);
  var vcs = el('span'); vcs.textContent = 'Custom voting units'; votingCbRow.appendChild(vcs);
  adv.appendChild(votingCbRow);
  var vsub = el('div', 'operator-flag-sub'); vsub.textContent = 'Useful if you have custom governance needs.'; adv.appendChild(vsub);
  var votingWrap = el('div', 'operator-voting-wrap'); votingWrap.style.display = 'none'; adv.appendChild(votingWrap);
  var votingInput = el('input', 'operator-edit-jwt'); votingInput.type = 'number'; votingInput.step = '1'; votingInput.min = '0'; votingInput.placeholder = '0'; votingWrap.appendChild(votingInput);
  votingCb.addEventListener('change', function () { votingWrap.style.display = votingCb.checked ? '' : 'none'; if (!votingCb.checked) votingInput.value = ''; });

  // "+ Add another item" on its own line, divided from the current item's fields above; sits above the chain
  // selector (the chains apply to every staged item).
  var addAnother = el('a', 'operator-cta tier-add-another'); addAnother.href = '#'; addAnother.textContent = '+ Add another item';
  content.appendChild(addAnother);
  var clbl = el('div', 'operator-edit-label'); clbl.style.marginTop = '24px'; clbl.textContent = 'On'; content.appendChild(clbl);
  var chainBox = el('div', 'splits-edit-chains');
  var chainChecks = allChains.map(function (c) {
    var row = el('label', 'splits-edit-chain');
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.value = String(c.id);
    row.appendChild(cb); row.appendChild(chainLogo(c.id, c.name));
    var nm = el('span'); nm.textContent = c.name || ('Chain ' + c.id); row.appendChild(nm);
    chainBox.appendChild(row); return { chain: c, cb: cb };
  });
  content.appendChild(chainBox);

  var jwtInput = null;
  if (!hasPinata()) {
    var jlbl = el('div', 'operator-edit-label'); jlbl.style.marginTop = '12px';
    jlbl.innerHTML = 'Pinata JWT <span class="operator-edit-hint">— to pin the tier image + metadata to IPFS. '
      + '<a href="https://app.pinata.cloud/developers/api-keys" target="_blank" rel="noopener">Get one</a>; stored only in this browser.</span>';
    content.appendChild(jlbl);
    jwtInput = el('input', 'operator-edit-jwt'); jwtInput.type = 'password'; jwtInput.placeholder = 'pinata JWT'; jwtInput.autocomplete = 'off'; jwtInput.spellcheck = false;
    content.appendChild(jwtInput);
  }

  // Snapshot the current form (and its split rows, read into plain data) so it can be staged + reset.
  function snapshotSplits() {
    return splitRows.filter(function (r) { return !r.isEmpty(); }).map(function (r) {
      return { pct: (r.pct.value || '').trim(), recip: (r.recip.value || '').trim(), benef: (r.benef.value || '').trim() };
    });
  }
  function collectForm() {
    return {
      name: nameInput.value, price: priceInput.value, supply: unlimitedCb.checked ? '' : supplyInput.value, priceDecimals: priceDecimals,
      imageFile: selectedMedia,
      category: categorySelect.value, reserveFreq: reserveCb.checked ? reserveFreqInput.value : '', reserveBenef: reserveBenefInput.value,
      votingUnits: votingInput.value,
      splitOn: splitCb.checked, splits: snapshotSplits(), splitRefChain: splitRefChain,
      discountPct: discCb.checked ? discInput.value : '',
      flags: {
        allowOwnerMint: allowOwnerMintCb.checked, transfersPausable: transfersPausableCb ? transfersPausableCb.checked : false,
        cantBeRemoved: cantBeRemovedCb.checked,
        cantBuyWithCredits: !allowCreditsCb.checked,
        cantIncreaseDiscountPercent: !ownerDiscountCb.checked,
      },
    };
  }
  function formIsEmpty(f) { return !(f.name || '').trim() && !(f.price || '').trim() && !f.imageFile; }
  function resetForm() {
    nameInput.value = ''; priceInput.value = ''; clearMedia(); imgFile.value = '';
    splitCb.checked = false; splitWrap.style.display = 'none'; splitRowsBox.innerHTML = ''; splitRows = [];
    discCb.checked = false; discWrap.style.display = 'none'; discInput.value = '';
    unlimitedCb.checked = true; supplyWrap.style.display = 'none'; supplyInput.value = '';
    categorySelect.value = '0'; lastCatValue = '0';
    reserveCb.checked = false; reserveWrap.style.display = 'none'; reserveFreqInput.value = ''; reserveBenefInput.value = '';
    votingCb.checked = false; votingWrap.style.display = 'none'; votingInput.value = '';
    allowOwnerMintCb.checked = false; if (transfersPausableCb) transfersPausableCb.checked = false;
    cantBeRemovedCb.checked = false; allowCreditsCb.checked = true; ownerDiscountCb.checked = true;
    syncSplitEnabled();
  }

  // Staged items (multi-item) — fill an item, "+ Save & add another", repeat, then submit all in one tx.
  var staged = [];
  var stagedBox = el('div', 'tier-staged'); stagedBox.style.display = 'none'; content.appendChild(stagedBox);
  function renderStaged() {
    stagedBox.innerHTML = '';
    if (!staged.length) { stagedBox.style.display = 'none'; return; }
    stagedBox.style.display = '';
    var t = el('div', 'operator-edit-label'); t.style.marginTop = '0'; t.textContent = 'Items to add (' + staged.length + ')'; stagedBox.appendChild(t);
    staged.forEach(function (f, i) {
      var r = el('div', 'tier-staged-row');
      var nm = el('span'); nm.textContent = (i + 1) + '. ' + ((f.name || '').trim() || 'Untitled') + ' — ' + (f.price || '0') + ' ' + priceUnit; r.appendChild(nm);
      var x = el('a', 'splits-edit-rm'); x.href = '#'; x.textContent = '✕'; x.addEventListener('click', function (e) { e.preventDefault(); staged.splice(i, 1); renderStaged(); }); r.appendChild(x);
      stagedBox.appendChild(r);
    });
  }

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = 'Add items for sale'; actions.appendChild(submit);
  content.appendChild(actions);

  var modal = openModal('Add items for sale', content);
  var setStatus = makeStatusSetter(status, 'operator-edit-status');

  addAnother.addEventListener('click', function (e) {
    e.preventDefault();
    var f = collectForm();
    if (!(f.name || '').trim()) { setStatus('Enter a name for this item before adding another', 'error'); return; }
    staged.push(f); renderStaged(); resetForm();
    setStatus(staged.length + ' item' + (staged.length > 1 ? 's' : '') + ' ready — fill the next, or “Add items for sale”.', 'ok');
    if (content.parentNode) content.parentNode.scrollTop = 0;
  });

  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault();
    if (busy) return;
    if (jwtInput && jwtInput.value.trim()) setPinataJwt(jwtInput.value.trim());
    var selected = chainChecks.filter(function (c) { return c.cb.checked; }).map(function (c) { return c.chain; });
    var forms = staged.slice();
    var cur = collectForm();
    if (!formIsEmpty(cur)) forms.push(cur);
    if (!forms.length) { setStatus('Add at least one item', 'error'); return; }
    busy = true;
    submitAddTiers(project, selected, operatorAddr, forms, setStatus, modal).catch(function (err) {
      busy = false; setStatus(errMessage(err, 'Add items failed'), 'error');
    });
  });
}

// Parse a plain split row ({recip, benef}) → {projectId, beneficiary}. Mirrors the live-row parse().
function parsePlainSplit(s) {
  var v = (s.recip || '').trim();
  if (isAddr(v)) return { projectId: 0, beneficiary: v };
  if (/^[0-9]+$/.test(v) && Number(v) > 0) {
    var b = (s.benef || '').trim();
    if (!isAddr(b)) throw new Error('project #' + v + ' needs a token beneficiary address');
    return { projectId: Number(v), beneficiary: b };
  }
  throw new Error('enter a 0x address or a project ID');
}

// Add one or more NFT items (tiers) in a single adjustTiers tx per chain. `forms` is an array of plain
// form snapshots (see collectForm in openAddTierModal).
async function submitAddTiers(project, selectedChains, operatorAddr, forms, setStatus, modal) {
  if (!forms.length) { setStatus('Add at least one item', 'error'); return; }
  if (!selectedChains.length) { setStatus('Select at least one chain', 'error'); return; }
  if (!hasPinata()) { setStatus('Enter a Pinata JWT above to pin item media + metadata.', 'error'); return; }
  var account = await ensureOperatorAccount(project, operatorAddr, setStatus);
  if (!account) return;

  // Validate + pin + build a tier for each form.
  var built = [];
  for (var fi = 0; fi < forms.length; fi++) {
    var form = forms[fi];
    var label = forms.length > 1 ? ('Item ' + (fi + 1) + ': ') : '';
    var name = (form.name || '').trim();
    if (!name) { setStatus(label + 'enter a name', 'error'); return; }
    var price;
    try { price = parseAmount(form.price, form.priceDecimals); } catch (_) { setStatus(label + 'enter a valid price', 'error'); return; }
    var supplyStr = (form.supply || '').trim();
    var supply = supplyStr === '' ? TIER_UNLIMITED_SUPPLY : parseInt(supplyStr, 10);
    if (supplyStr !== '' && !(supply > 0)) { setStatus(label + 'enter a supply above 0, or leave empty for unlimited', 'error'); return; }
    var category = parseInt(form.category || '0', 10) || 0;
    var reserveFreq = parseInt(form.reserveFreq || '0', 10) || 0;
    var reserveBenef = (form.reserveBenef || '').trim();
    var votingUnits = parseInt(form.votingUnits || '0', 10) || 0;
    var discountPercent = 0;
    var discountStr = (form.discountPct || '').trim();
    if (discountStr !== '') {
      var dpct = parseFloat(discountStr);
      if (!(dpct >= 0) || dpct > 100) { setStatus(label + 'discount must be between 0 and 100%', 'error'); return; }
      discountPercent = Math.min(200, Math.round(dpct / 100 * 200));
    }
    if (reserveFreq > 0) {
      if (supply === 1) { setStatus(label + 'a reserved item needs a supply of at least 2 (or unlimited)', 'error'); return; }
      if (!isAddr(reserveBenef)) { setStatus(label + 'enter a reserve beneficiary address', 'error'); return; }
    }
    // Split sales — plain split data; resolve project recipients across chains.
    var splitDefs = [], splitTotalPct = 0;
    if (form.splitOn) {
      var sr = form.splits || [];
      for (var si = 0; si < sr.length; si++) {
        var sp = parseFloat(sr[si].pct);
        if (!(sp > 0)) { setStatus(label + 'recipient ' + (si + 1) + ': enter a percentage above 0', 'error'); return; }
        var parsedS;
        try { parsedS = parsePlainSplit(sr[si]); } catch (e) { setStatus(label + 'recipient ' + (si + 1) + ': ' + e.message, 'error'); return; }
        splitTotalPct += sp;
        splitDefs.push({ pct: sp, projectId: parsedS.projectId, beneficiary: parsedS.beneficiary });
      }
      if (!splitDefs.length) { setStatus(label + 'add a recipient, or turn off Split sales', 'error'); return; }
      if (splitTotalPct > 100.0001) { setStatus(label + 'recipients add up to ' + (Math.round(splitTotalPct * 100) / 100) + '% — must be 100% or less', 'error'); return; }
    }
    for (var di = 0; di < splitDefs.length; di++) {
      if (splitDefs[di].projectId > 0) {
        setStatus(label + 'resolving project #' + splitDefs[di].projectId + '…', 'pending');
        var info = await resolveSplitProject(splitDefs[di].projectId, form.splitRefChain);
        if (!info) { setStatus(label + 'couldn’t find project #' + splitDefs[di].projectId, 'error'); return; }
        for (var ci = 0; ci < selectedChains.length; ci++) {
          var scid = selectedChains[ci].id;
          if (!info.byChain[scid]) { setStatus(label + 'project #' + splitDefs[di].projectId + ' isn’t on ' + (selectedChains[ci].name || scid), 'error'); return; }
        }
        splitDefs[di].byChain = info.byChain;
      }
    }
    if (form.imageFile && form.imageFile.size > MAX_MEDIA_BYTES) { setStatus(label + 'media is over the ' + MAX_MEDIA_MB + ' MB max', 'error'); return; }
    var tierMeta = { name: name };
    if (form.imageFile) {
      setStatus(label + 'pinning media…', 'pending');
      var mediaUri = await pinFile(form.imageFile, name);
      var mt = (form.imageFile.type || '').toLowerCase();
      tierMeta.mediaType = mt;
      if (mt.indexOf('image') === 0) tierMeta.image = mediaUri; else tierMeta.animation_url = mediaUri;
    }
    setStatus(label + 'pinning metadata…', 'pending');
    var metaUri = await pinJson(tierMeta, name + '-tier');
    built.push({
      tierBase: {
        price: price, initialSupply: supply, votingUnits: votingUnits, reserveFrequency: reserveFreq,
        reserveBeneficiary: reserveFreq > 0 ? reserveBenef : ZERO_ADDRESS,
        encodedIpfsUri: encodeIpfsUriToBytes32(metaUri), category: category, discountPercent: discountPercent,
        flags: {
          allowOwnerMint: !!form.flags.allowOwnerMint, useReserveBeneficiaryAsDefault: false,
          transfersPausable: !!form.flags.transfersPausable, useVotingUnits: votingUnits > 0,
          cantBeRemoved: !!form.flags.cantBeRemoved, cantIncreaseDiscountPercent: !!form.flags.cantIncreaseDiscountPercent,
          cantBuyWithCredits: !!form.flags.cantBuyWithCredits,
        },
      },
      splitOn: form.splitOn, splitTotalPct: splitTotalPct, splitDefs: splitDefs,
    });
  }

  // The hook requires tiers added in ascending category order.
  built.sort(function (a, b) { return a.tierBase.category - b.tierBase.category; });

  setStatus('Reading 721 hooks…', 'pending');
  var hookMap = {};
  for (var i = 0; i < selectedChains.length; i++) {
    var cid = selectedChains[i].id;
    var h = await read(cid, 'REVOwner', REVO_TIERED_HOOK_ABI, 'tiered721HookOf', [BigInt(project.id)]).catch(function () { return null; });
    if (!h || /^0x0+$/.test(h)) throw new Error('No 721 hook on ' + (selectedChains[i].name || cid));
    hookMap[cid] = h;
  }

  function tiersFor(cid) {
    return built.map(function (b) {
      var splits = b.splitOn ? b.splitDefs.map(function (d) {
        return { percent: Math.round(d.pct / b.splitTotalPct * 1e9), projectId: d.projectId > 0 ? BigInt(d.byChain[cid]) : 0n, beneficiary: d.beneficiary, preferAddToBalance: false, lockedUntil: 0, hook: ZERO_ADDRESS };
      }) : [];
      return Object.assign({}, b.tierBase, { splitPercent: b.splitOn ? Math.round(b.splitTotalPct / 100 * 1e9) : 0, splits: splits });
    });
  }

  var n = built.length;
  await runRelayrAcrossChains(selectedChains, account, function (cid) {
    return { to: hookMap[cid], data: encodeFunctionData({ abi: adjustTiersAbi, functionName: 'adjustTiers', args: [tiersFor(cid), []] }) };
  }, (400000n + BigInt(n) * 400000n), setStatus, { label: 'Add items for sale', title: 'Confirm add items' });

  bustTiersCache(project);
  setStatus(n + ' item' + (n > 1 ? 's' : '') + ' added on ' + selectedChains.length + ' chain' + (selectedChains.length > 1 ? 's' : '') + '', 'success');
  setTimeout(function () { modal.close(); }, 1400);
}

// Operator-only: append one or more named store categories to the project metadata (projectUri) on every
// chain, via relayr — in a single tx. Returns the new categories' numeric ids (or null on bail). Category
// names live in projectUri; the 721 tiers reference them by number.
async function addStoreCategories(project, chains, operatorAddr, names, setStatus) {
  names = (names || []).map(function (n) { return (n || '').trim(); }).filter(Boolean);
  if (!names.length) { setStatus('Enter at least one category name', 'error'); return null; }
  var account = await ensureOperatorAccount(project, operatorAddr, setStatus);
  if (!account) return null;
  if (!hasPinata()) { setStatus('Add a Pinata JWT below to name categories.', 'error'); return null; }

  setStatus('Reading metadata…', 'pending');
  var pc = (chains[0] && chains[0].id) || project.chainId;
  var curUri = await clientFor(pc).readContract({ address: getAddress('JBController', pc), abi: uriOfAbi, functionName: 'uriOf', args: [BigInt(project.id)] }).catch(function () { return null; });
  var meta = curUri ? (await fetchMetadata(curUri)) : null;
  meta = meta ? Object.assign({}, meta) : {};
  var cats = (meta.storeCategories && typeof meta.storeCategories === 'object') ? Object.assign({}, meta.storeCategories) : {};
  var nextId = 1; Object.keys(cats).map(Number).forEach(function (n) { if (n >= nextId) nextId = n + 1; });
  var newIds = [];
  names.forEach(function (nm) { cats[nextId] = nm; newIds.push(nextId); nextId++; });
  meta.storeCategories = cats;

  setStatus('Pinning categories…', 'pending');
  var newUri = await pinJson(meta, (meta.name || 'project') + '-metadata');
  await runRelayrAcrossChains(chains, account, function (cid) {
    return { to: getAddress('JBController', cid), data: encodeFunctionData({ abi: setUriOfAbi, functionName: 'setUriOf', args: [BigInt(project.id), newUri] }) };
  }, 400000n, setStatus, { label: 'Add store categories', title: 'Confirm categories' });

  project.storeCategories = cats;
  setStatus(names.length + ' categor' + (names.length > 1 ? 'ies' : 'y') + ' added', 'success');
  return newIds;
}

function renderTierCard(project, shop, tier, onCat, cart, refreshers) {
  var soldOut = tier.remaining === 0;
  var cap = (tier.initial >= 999999999) ? Infinity : tier.remaining; // unlimited tiers have no per-tx cap
  var c = el('div', 'shop-tier');
  c.setAttribute('data-tier-id', String(tier.id));
  var imgWrap = el('div', 'shop-tier-img'); var ph = el('span', 'shop-tier-ph'); ph.textContent = '#' + tier.id; imgWrap.appendChild(ph); c.appendChild(imgWrap);
  // Discount badge — enticing, top-left over the art.
  var discLabel = tierDiscountLabel(tier);
  if (discLabel) { var badge = el('span', 'shop-tier-discount'); badge.textContent = discLabel; imgWrap.appendChild(badge); }

  var info = el('div', 'shop-tier-info');
  var nameEl = el('div', 'shop-tier-name'); nameEl.textContent = 'Tier ' + tier.id; info.appendChild(nameEl);
  var row = el('div', 'shop-tier-row');
  var left = el('div', 'shop-tier-pricecol');
  // Show the discounted price the buyer actually pays; strike through the original when discounted.
  var priceEl = el('span', 'shop-tier-price'); priceEl.textContent = formatEth(tierEffectivePrice(tier.price, tier.discountPercent)); left.appendChild(priceEl);
  if (discLabel) { var origEl = el('span', 'shop-tier-price-orig'); origEl.textContent = formatEth(tier.price); left.appendChild(origEl); }
  var supplyEl = el('span', 'shop-tier-supply');
  supplyEl.textContent = soldOut ? 'sold out' : (tier.initial >= 999999999 ? 'unlimited' : tier.remaining + ' left');
  left.appendChild(supplyEl);
  row.appendChild(left);

  // −/+ stepper bound to the shared cart (selecting here also updates the Pay-card strip + "You get").
  var step = el('div', 'shop-tier-step');
  var minus = el('button', 'shop-tier-stepbtn'); minus.textContent = '−';
  var qtyEl = el('span', 'shop-tier-qty');
  var plus = el('button', 'shop-tier-stepbtn'); plus.textContent = '+';
  step.appendChild(minus); step.appendChild(qtyEl); step.appendChild(plus); row.appendChild(step);
  info.appendChild(row);
  c.appendChild(info);

  function refresh() {
    var q = cart ? cart.get(tier.id) : 0;
    c.classList.toggle('selected', q > 0);
    qtyEl.textContent = String(q);
    minus.disabled = q <= 0;
    plus.disabled = soldOut || q >= cap;
  }
  function set(q) { if (cart) cart.set(tier.id, Math.max(0, Math.min(cap, q))); } // cart subscription redraws
  if (refreshers) refreshers[tier.id] = refresh;
  if (!soldOut) {
    minus.addEventListener('click', function () { set((cart ? cart.get(tier.id) : 0) - 1); });
    plus.addEventListener('click', function () { set((cart ? cart.get(tier.id) : 0) + 1); });
  } else { minus.disabled = true; plus.disabled = true; }
  refresh();

  resolveTierMedia(shop, tier, project.chainId).then(function (m) {
    if (!c.isConnected) return;
    var nm = m.name || ('Tier ' + tier.id);
    if (cart) { cart.setImage(tier.id, m.image); if (m.name) cart.setName(tier.id, nm); }
    if (m.name) nameEl.textContent = m.name;
    if (m.image || m.animationUrl) renderTierMediaInto(imgWrap, m, nm, 'full');
    if (m.category && onCat) onCat(tier.category, m.category);
  });

  // Click the art or name to open the full item detail (per-chain supply, config, operator edit/remove).
  function openDetail() { openTierDetail(project, shop, tier, cart, refreshers); }
  imgWrap.style.cursor = 'pointer'; imgWrap.addEventListener('click', openDetail);
  nameEl.style.cursor = 'pointer'; nameEl.addEventListener('click', openDetail);
  return c;
}

// Read a tier's supply on EVERY chain the project is deployed on — supply is strictly per-chain, and
// fetchProjectTiers only reads one chain, so resolve the 721 hook + store per chain and pull tiersOf.
function readTierSupplyAcrossChains(project, tierId) {
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  return Promise.all(chains.map(function (ch) {
    var cid = ch.id, revo = getAddress('REVOwner', cid);
    if (!revo) return Promise.resolve({ chainId: cid, name: ch.name, err: true });
    var client = clientFor(cid);
    return client.readContract({ address: revo, abi: REVO_TIERED_HOOK_ABI, functionName: 'tiered721HookOf', args: [BigInt(project.id)] })
      .then(function (hook) {
        if (!hook || /^0x0+$/.test(hook)) return { chainId: cid, name: ch.name, none: true };
        return client.readContract({ address: hook, abi: HOOK_STORE_ABI, functionName: 'STORE', args: [] }).then(function (store) {
          return client.readContract({ address: store, abi: TIER721_STORE_ABI, functionName: 'tiersOf', args: [hook, [], false, 0n, 200n] }).then(function (raw) {
            var t = (raw || []).filter(function (x) { return Number(x.id) === tierId; })[0];
            if (!t) return { chainId: cid, name: ch.name, none: true };
            return { chainId: cid, name: ch.name, remaining: Number(t.remainingSupply), initial: Number(t.initialSupply) };
          });
        });
      }).catch(function () { return { chainId: cid, name: ch.name, err: true }; });
  }));
}

// Item-detail popup: large art, name, price (+ discount), per-chain supply, and the full tier config.
function openTierDetail(project, shop, tier, cart, refreshers) {
  var content = el('div', 'tier-detail');
  var art = el('div', 'tier-detail-art'); var ph = el('span', 'shop-tier-ph'); ph.textContent = '#' + tier.id; art.appendChild(ph); content.appendChild(art);
  var nameEl = el('div', 'tier-detail-name'); nameEl.textContent = 'Tier ' + tier.id; content.appendChild(nameEl);
  resolveTierMedia(shop, tier, project.chainId).then(function (m) {
    if (m.name) nameEl.textContent = m.name;
    if (m.image || m.animationUrl) renderTierMediaInto(art, m, m.name || ('Tier ' + tier.id), 'full');
  }).catch(function () {});

  var priceRow = el('div', 'tier-detail-price');
  var disc = tierDiscountLabel(tier);
  var effEl = el('span', 'tier-detail-price-eff'); effEl.textContent = formatEth(tierEffectivePrice(tier.price, tier.discountPercent)); priceRow.appendChild(effEl);
  if (disc) {
    var origEl = el('span', 'tier-detail-price-orig'); origEl.textContent = formatEth(tier.price); priceRow.appendChild(origEl);
    var badge = el('span', 'tier-detail-discount'); badge.textContent = disc; priceRow.appendChild(badge);
  }
  content.appendChild(priceRow);

  // Buy controls — add this item to the shared cart right from the popup (stays in sync with the shop card +
  // pay strip via the cart subscription; sold-out tiers are inert; unlimited tiers have no per-tx cap).
  if (cart) {
    var soldOut = tier.remaining === 0;
    var cap = (tier.initial >= 999999999) ? Infinity : tier.remaining;
    var buyRow = el('div', 'tier-detail-buy');
    var minus = el('button', 'shop-tier-stepbtn'); minus.textContent = '−';
    var qtyEl = el('span', 'shop-tier-qty');
    var plus = el('button', 'shop-tier-stepbtn'); plus.textContent = '+';
    buyRow.appendChild(minus); buyRow.appendChild(qtyEl); buyRow.appendChild(plus);
    if (soldOut) { var soBadge = el('span', 'tier-detail-soldout'); soBadge.textContent = 'sold out'; buyRow.appendChild(soBadge); }
    content.appendChild(buyRow);
    var refreshBuy = function () { var q = cart.get(tier.id); qtyEl.textContent = String(q); minus.disabled = q <= 0; plus.disabled = soldOut || q >= cap; };
    minus.addEventListener('click', function () { cart.set(tier.id, Math.max(0, cart.get(tier.id) - 1)); });
    plus.addEventListener('click', function () { if (!soldOut) cart.set(tier.id, Math.min(cap, cart.get(tier.id) + 1)); });
    cart.subscribe(function (id) { if (id === tier.id && qtyEl.isConnected) refreshBuy(); });
    refreshBuy();
  }

  var sup = el('div', 'tier-detail-supply'); sup.textContent = 'Loading supply across chains…'; content.appendChild(sup);
  readTierSupplyAcrossChains(project, tier.id).then(function (rows) {
    if (!sup.isConnected) return;
    sup.innerHTML = '';
    var head = el('div', 'tier-detail-section-h'); head.textContent = 'Supply by chain'; sup.appendChild(head);
    rows.forEach(function (r) {
      var row = el('div', 'tier-detail-supply-row');
      var nm = el('span', 'tier-detail-supply-chain'); nm.appendChild(chainLogo(r.chainId, r.name)); var tn = el('span'); tn.textContent = ' ' + r.name; nm.appendChild(tn); row.appendChild(nm);
      var v = el('span', 'tier-detail-supply-val');
      v.textContent = r.none ? 'not on this chain' : r.err ? '—' : (r.initial >= 999999999 ? 'unlimited' : (r.remaining + ' / ' + r.initial + ' left'));
      row.appendChild(v); sup.appendChild(row);
    });
  }).catch(function () { if (sup.isConnected) sup.textContent = 'Could not read supply.'; });

  var cfg = el('div', 'tier-detail-cfg');
  var cfgH = el('div', 'tier-detail-section-h'); cfgH.textContent = 'Details'; cfg.appendChild(cfgH);
  function fact(label, val) { var r = el('div', 'tier-detail-fact'); var l = el('span', 'tier-detail-fact-l'); l.textContent = label; var v = el('span'); v.textContent = val; r.appendChild(l); r.appendChild(v); cfg.appendChild(r); }
  fact('Tier id', '#' + tier.id);
  fact('Category', String(tier.category));
  if (tier.reserveFrequency > 0) fact('Reserve mint', '1 per ' + tier.reserveFrequency + ' sold');
  if (tier.votingUnits && BigInt(tier.votingUnits) > 0n) fact('Voting units', String(tier.votingUnits));
  if (tier.splitPercent > 0) fact('Split', (tier.splitPercent / 1e7) + '% of sales');
  content.appendChild(cfg);

  // Each set flag on its own row with a plain-English explanation.
  var fl = tier.flags || {};
  var FLAG_DESCS = [
    ['allowOwnerMint', 'Owner can mint', 'The project owner can mint this item for free, without a payment.'],
    ['transfersPausable', 'Transfers pausable', 'The owner can pause transfers of this item.'],
    ['cantBeRemoved', 'Cannot be removed', 'This item can never be removed from the shop.'],
    ['cantBuyWithCredits', 'No credit buys', 'Buyers can’t use project credits to mint this item — only a fresh payment.'],
    ['cantIncreaseDiscountPercent', 'Discount capped', 'This item’s discount can only be lowered, never increased.'],
  ];
  var setFlags = FLAG_DESCS.filter(function (f) { return fl[f[0]]; });
  if (setFlags.length) {
    var flagsBox = el('div', 'tier-detail-cfg');
    var flagsH = el('div', 'tier-detail-section-h'); flagsH.textContent = 'Flags'; flagsBox.appendChild(flagsH);
    setFlags.forEach(function (f) {
      var r = el('div', 'tier-detail-flag');
      var n = el('div', 'tier-detail-flag-name'); n.textContent = f[1]; r.appendChild(n);
      var s = el('div', 'tier-detail-flag-sub'); s.textContent = f[2]; r.appendChild(s);
      flagsBox.appendChild(r);
    });
    content.appendChild(flagsBox);
  }

  // Operator controls — the project owner/operator can edit the discount or remove the tier. Per the contract
  // these are the ONLY mutable bits (price/supply/category/flags are immutable; any other change is remove +
  // re-add as a new id). Shown only when the connected wallet is the authority; gated again on submit.
  var authority = projectAuthorityAddress(project);
  var acct = getAccount && getAccount();
  if (acct && authority && acct.toLowerCase() === authority.toLowerCase()) {
    var opH = el('div', 'tier-detail-section-h'); opH.textContent = 'Operator'; content.appendChild(opH);
    var opBox = el('div', 'tier-detail-op');
    var opStatus = el('div', 'modal-status'); opStatus.style.display = 'none';
    var dRow = el('div', 'tier-detail-op-row');
    var dLab = el('span', 'tier-detail-fact-l'); dLab.textContent = 'Discount % off'; dRow.appendChild(dLab);
    var dInput = document.createElement('input'); dInput.type = 'number'; dInput.min = '0'; dInput.max = '100'; dInput.step = '1';
    dInput.value = String(Number(tier.discountPercent || 0) / 2); dInput.className = 'tier-detail-op-input'; dRow.appendChild(dInput);
    var dBtn = el('button', 'create-btn'); dBtn.textContent = 'Set';
    if (fl.cantIncreaseDiscountPercent) dBtn.title = 'This tier is discount-capped — you can only lower it.';
    dBtn.addEventListener('click', function () { submitSetTierDiscount(project, tier, Number(dInput.value), opStatus); });
    dRow.appendChild(dBtn); opBox.appendChild(dRow);
    var rmBtn = el('button', 'create-btn ghost tier-detail-remove'); rmBtn.textContent = fl.cantBeRemoved ? 'Cannot be removed' : 'Remove item';
    rmBtn.disabled = !!fl.cantBeRemoved;
    if (!fl.cantBeRemoved) rmBtn.addEventListener('click', function () { if (window.confirm('Remove item #' + tier.id + ' from the shop on every chain? Buyers can no longer mint it, and re-adding creates a NEW id (supply resets). Continue?')) submitRemoveTier(project, tier, opStatus); });
    opBox.appendChild(rmBtn);
    opBox.appendChild(opStatus);
    content.appendChild(opBox);
  }

  openModal('Shop item #' + tier.id, content);
}

function shopOpSetStatus(statusEl) {
  return function (m, kind) { statusEl.style.display = m ? '' : 'none'; statusEl.className = 'modal-status' + (kind ? ' ' + kind : ''); statusEl.textContent = m || ''; };
}
async function resolveHookMap(project, chains) {
  var hookMap = {};
  for (var i = 0; i < chains.length; i++) {
    var h = await read(chains[i].id, 'REVOwner', REVO_TIERED_HOOK_ABI, 'tiered721HookOf', [BigInt(project.id)]).catch(function () { return null; });
    if (h && !/^0x0+$/.test(h)) hookMap[chains[i].id] = h;
  }
  return hookMap;
}
function shopChainsOf(project) {
  return (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
}
// Operator: set a tier's discount on every chain (JB721TiersHook.setDiscountPercentsOf), via relayr.
async function submitSetTierDiscount(project, tier, pctOff, statusEl) {
  var setStatus = shopOpSetStatus(statusEl);
  var account = await ensureOperatorAccount(project, projectAuthorityAddress(project), setStatus);
  if (!account) return;
  var avail = shopChainsOf(project), hookMap = await resolveHookMap(project, avail);
  avail = avail.filter(function (c) { return hookMap[c.id]; });
  if (!avail.length) { setStatus('No 721 hook found on these chains', 'error'); return; }
  var cfg = buildSetDiscountConfig(tier.id, pctOff);
  await runRelayrAcrossChains(avail, account, function (cid) {
    return { to: hookMap[cid], data: encodeFunctionData({ abi: setDiscountPercentsOfAbi, functionName: 'setDiscountPercentsOf', args: [[cfg]] }) };
  }, 300000n, setStatus, { label: 'Set discount', title: 'Confirm discount' });
  bustTiersCache(project);
  setStatus('Discount set on ' + avail.length + ' chain' + (avail.length > 1 ? 's' : ''), 'success');
}
// Operator: remove a tier from the shop on every chain (JB721TiersHook.adjustTiers with tierIdsToRemove).
async function submitRemoveTier(project, tier, statusEl) {
  var setStatus = shopOpSetStatus(statusEl);
  var account = await ensureOperatorAccount(project, projectAuthorityAddress(project), setStatus);
  if (!account) return;
  var avail = shopChainsOf(project), hookMap = await resolveHookMap(project, avail);
  avail = avail.filter(function (c) { return hookMap[c.id]; });
  if (!avail.length) { setStatus('No 721 hook found on these chains', 'error'); return; }
  await runRelayrAcrossChains(avail, account, function (cid) {
    return { to: hookMap[cid], data: encodeFunctionData({ abi: adjustTiersAbi, functionName: 'adjustTiers', args: [[], [BigInt(tier.id)]] }) };
  }, 300000n, setStatus, { label: 'Remove item', title: 'Confirm remove' });
  bustTiersCache(project);
  setStatus('Removed on ' + avail.length + ' chain' + (avail.length > 1 ? 's' : ''), 'success');
}

// Compact mini-shop folded into the top of the Pay card: a horizontal strip of tier thumbnails backed by
// the shared `cart` (juicy-vision). Clicking a tier SELECTS it (green qty badge + −/+ stepper) and jumps to
// the Shop tab; the selection drives the Pay amount and "You get", and one Pay tx mints them all. Stays in
// sync with the Shop-tab steppers via the cart's subscription. opts = { onShop, focusInShop }.
function renderPayShopStrip(project, cart, opts) {
  opts = opts || {};
  var wrap = el('div', 'paybox-shop');
  wrap.style.display = 'none';
  fetchProjectTiers(project).then(function (shop) {
    if (!wrap.isConnected || !shop || !shop.tiers.length) return;
    if (opts.onShop) opts.onShop(shop);
    wrap.style.display = '';
    var head = el('div', 'paybox-shop-head');
    var lbl = el('span', 'paybox-shop-label'); lbl.textContent = 'Shop'; head.appendChild(lbl);
    var all = el('button', 'paybox-shop-all'); all.textContent = 'All →';
    all.addEventListener('click', function () { if (opts.onViewAll) opts.onViewAll(); });
    head.appendChild(all);
    wrap.appendChild(head);
    var strip = el('div', 'paybox-shop-strip'); wrap.appendChild(strip);
    var refreshers = {};
    shop.tiers.slice(0, 12).forEach(function (tier) {
      strip.appendChild(makePayShopItem(project, shop, tier, cart, refreshers, opts.focusInShop));
    });
    cart.subscribe(function (id) { if (refreshers[id]) refreshers[id](); });
  }).catch(function () {});
  return wrap;
}

// One selectable tier in the Pay-card strip: thumbnail + a footer that shows the price when unselected
// and a − [qty] + stepper once selected, plus a green count badge. Backed by the shared cart; sold-out
// tiers are inert. Registers its refresh in `refreshers` so cart changes from the Shop tab redraw it.
function makePayShopItem(project, shop, tier, cart, refreshers, focusInShop) {
  var soldOut = tier.remaining === 0;
  var it = el('div', 'paybox-shop-item' + (soldOut ? ' soldout' : ''));
  var badge = el('span', 'paybox-shop-badge'); it.appendChild(badge);
  var imgWrap = el('div', 'paybox-shop-thumb'); var ph = el('span'); ph.textContent = '#' + tier.id; imgWrap.appendChild(ph); it.appendChild(imgWrap);
  var discLabel = tierDiscountLabel(tier);
  if (discLabel) { var disc = el('span', 'paybox-shop-discount'); disc.textContent = discLabel; imgWrap.appendChild(disc); }

  var foot = el('div', 'paybox-shop-foot');
  // Discounted price the buyer pays (the original is implied by the badge; keep the strip compact).
  var price = el('span', 'paybox-shop-price'); price.textContent = formatEth(tierEffectivePrice(tier.price, tier.discountPercent)); foot.appendChild(price);
  var step = el('div', 'paybox-shop-step');
  var minus = el('button', 'paybox-shop-stepbtn'); minus.textContent = '−';
  var qtyEl = el('span', 'paybox-shop-qty');
  var plus = el('button', 'paybox-shop-stepbtn'); plus.textContent = '+';
  step.appendChild(minus); step.appendChild(qtyEl); step.appendChild(plus); foot.appendChild(step);
  it.appendChild(foot);

  var cap = (tier.initial >= 999999999) ? Infinity : tier.remaining; // unlimited tiers have no per-tx cap
  function refresh() {
    var q = cart.get(tier.id);
    it.classList.toggle('selected', q > 0);
    badge.style.display = q > 0 ? '' : 'none'; badge.textContent = String(q);
    price.style.display = q > 0 ? 'none' : '';
    step.style.display = q > 0 ? '' : 'none';
    qtyEl.textContent = String(q);
    plus.disabled = q >= cap;
  }
  function set(q) { cart.set(tier.id, Math.max(0, Math.min(cap, q))); } // cart subscription redraws
  if (refreshers) refreshers[tier.id] = refresh;
  if (!soldOut) {
    imgWrap.addEventListener('click', function () {
      if (cart.get(tier.id) === 0) set(1);
      if (focusInShop) focusInShop(tier.id); // jump to the Shop tab and scroll to this tier
    });
    minus.addEventListener('click', function (e) { e.stopPropagation(); set(cart.get(tier.id) - 1); });
    plus.addEventListener('click', function (e) { e.stopPropagation(); set(cart.get(tier.id) + 1); });
  }
  refresh();

  resolveTierMedia(shop, tier, project.chainId).then(function (m) {
    if (!it.isConnected) return;
    var nm = m.name || ('Tier ' + tier.id);
    cart.setImage(tier.id, m.image); cart.setName(tier.id, nm);
    it.title = nm + ' | ' + formatEth(tier.price);
    if (m.image || m.animationUrl) renderTierMediaInto(imgWrap, m, nm, 'thumb');
  });
  return it;
}

// -- ABIs (minimal, view-only) --

var uriOfAbi = [{
  type: 'function', name: 'uriOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }],
}];
// JBController.setUriOf — operator-only (SET_PROJECT_URI permission). Sent as an ERC-2771 meta-tx via relayr.
var setUriOfAbi = [{
  type: 'function', name: 'setUriOf', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'uri', type: 'string' }], outputs: [],
}];
// JBController.deployERC20For — operator-only (DEPLOY_ERC20). Sets the token name/symbol by deploying the
// ERC-20 (only possible while the project still uses credits). Same salt+sender => same address per chain.
var deployErc20Abi = [{
  type: 'function', name: 'deployERC20For', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'salt', type: 'bytes32' }],
  outputs: [{ name: 'token', type: 'address' }],
}];
// JBController.setTokenMetadataOf — operator-only (SET_TOKEN_METADATA). Renames a DEPLOYED token
// (JBERC20.setMetadata). Name and symbol are mutable after deployment, contrary to plain ERC-20s.
var setTokenMetadataAbi = [{
  type: 'function', name: 'setTokenMetadataOf', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }],
}];
// REVOwner.setOperatorOf — current-operator-only. Rotates the revnet's split operator (address(0)
// relinquishes permanently). Sent as an ERC-2771 meta-tx via relayr like the other operator actions.
var setOperatorOfAbi = [{
  type: 'function', name: 'setOperatorOf', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'revnetId', type: 'uint256' }, { name: 'newOperator', type: 'address' }],
}];
// JB721TiersHook.adjustTiers — operator-only (ADJUST_721_TIERS). Adds/removes NFT tiers. The hook is
// ERC-2771-aware, so this fans across chains via relayr like the other operator actions.
var JB721_TIER_CONFIG = { name: 'tiersToAdd', type: 'tuple[]', components: [
  { name: 'price', type: 'uint104' }, { name: 'initialSupply', type: 'uint32' }, { name: 'votingUnits', type: 'uint32' },
  { name: 'reserveFrequency', type: 'uint16' }, { name: 'reserveBeneficiary', type: 'address' }, { name: 'encodedIpfsUri', type: 'bytes32' },
  { name: 'category', type: 'uint24' }, { name: 'discountPercent', type: 'uint8' },
  { name: 'flags', type: 'tuple', components: [
    { name: 'allowOwnerMint', type: 'bool' }, { name: 'useReserveBeneficiaryAsDefault', type: 'bool' }, { name: 'transfersPausable', type: 'bool' },
    { name: 'useVotingUnits', type: 'bool' }, { name: 'cantBeRemoved', type: 'bool' }, { name: 'cantIncreaseDiscountPercent', type: 'bool' }, { name: 'cantBuyWithCredits', type: 'bool' } ] },
  { name: 'splitPercent', type: 'uint32' },
  { name: 'splits', type: 'tuple[]', components: [
    { name: 'percent', type: 'uint32' }, { name: 'projectId', type: 'uint64' }, { name: 'beneficiary', type: 'address' },
    { name: 'preferAddToBalance', type: 'bool' }, { name: 'lockedUntil', type: 'uint48' }, { name: 'hook', type: 'address' } ] },
] };
var adjustTiersAbi = [{
  type: 'function', name: 'adjustTiers', stateMutability: 'nonpayable', outputs: [],
  inputs: [JB721_TIER_CONFIG, { name: 'tierIdsToRemove', type: 'uint256[]' }],
}];
// JB721TiersHook.setDiscountPercentsOf — operator-only (SET_721_DISCOUNT_PERCENT). discountPercent is out of
// 200 (DISCOUNT_DENOMINATOR); see buildSetDiscountConfig. The only price-related field editable after a tier
// is added (price/supply/etc. are immutable — any other change is remove + re-add).
var setDiscountPercentsOfAbi = [{
  type: 'function', name: 'setDiscountPercentsOf', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'discountPercentConfigs', type: 'tuple[]', components: [{ name: 'tierId', type: 'uint32' }, { name: 'discountPercent', type: 'uint16' }] }],
}];
// JBController.setSplitGroupsOf — operator-only (SET_SPLIT_GROUPS). Replaces a ruleset's split groups.
var setSplitGroupsAbi = [{
  type: 'function', name: 'setSplitGroupsOf', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'rulesetId', type: 'uint256' },
    { name: 'splitGroups', type: 'tuple[]', components: [
      { name: 'groupId', type: 'uint256' },
      { name: 'splits', type: 'tuple[]', components: [
        { name: 'percent', type: 'uint32' }, { name: 'projectId', type: 'uint64' }, { name: 'beneficiary', type: 'address' },
        { name: 'preferAddToBalance', type: 'bool' }, { name: 'lockedUntil', type: 'uint48' }, { name: 'hook', type: 'address' } ] },
    ] },
  ],
}];
var ownerOfAbi = [{
  type: 'function', name: 'ownerOf', stateMutability: 'view',
  inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }],
}];
var countAbi = [{
  type: 'function', name: 'count', stateMutability: 'view',
  inputs: [], outputs: [{ name: '', type: 'uint256' }],
}];
var controllerOfAbi = [{
  type: 'function', name: 'controllerOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }],
}];
var tokenOfAbi = [{
  type: 'function', name: 'tokenOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }],
}];
var totalSupplyAbi = [{
  type: 'function', name: 'totalSupplyOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }],
}];
var pendingReservedAbi = [{
  type: 'function', name: 'pendingReservedTokenBalanceOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }],
}];
// Raw terminal balance of the native token. Unlike currentSurplusOf this needs no price
// feed, so it reads cleanly (0) for freshly-deployed projects instead of reverting.
var storeBalanceAbi = [{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [
    { name: 'terminal', type: 'address' },
    { name: 'projectId', type: 'uint256' },
    { name: 'token', type: 'address' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}];
var erc20SymbolAbi = [{
  type: 'function', name: 'symbol', stateMutability: 'view',
  inputs: [], outputs: [{ name: '', type: 'string' }],
}];
var erc20NameAbi = [{
  type: 'function', name: 'name', stateMutability: 'view',
  inputs: [], outputs: [{ name: '', type: 'string' }],
}];
var splitsOfAbi = [{
  type: 'function', name: 'splitsOf', stateMutability: 'view',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'rulesetId', type: 'uint256' },
    { name: 'groupId', type: 'uint256' },
  ],
  outputs: [{ name: 'splits', type: 'tuple[]', components: [
    { name: 'percent', type: 'uint32' },
    { name: 'projectId', type: 'uint64' },
    { name: 'beneficiary', type: 'address' },
    { name: 'preferAddToBalance', type: 'bool' },
    { name: 'lockedUntil', type: 'uint48' },
    { name: 'hook', type: 'address' },
  ]}],
}];
var sendReservedAbi = [{
  type: 'function', name: 'sendReservedTokensToSplitsOf', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' }],
  outputs: [{ type: 'uint256' }],
}];
var cashOutTokensAbi = [{
  type: 'function', name: 'cashOutTokensOf', stateMutability: 'nonpayable',
  inputs: [
    { name: 'holder', type: 'address' },
    { name: 'projectId', type: 'uint256' },
    { name: 'cashOutCount', type: 'uint256' },
    { name: 'tokenToReclaim', type: 'address' },
    { name: 'minTokensReclaimed', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
    { name: 'metadata', type: 'bytes' },
  ],
  outputs: [{ name: 'reclaimAmount', type: 'uint256' }],
}];
var borrowFromAbi = [{
  type: 'function', name: 'borrowFrom', stateMutability: 'nonpayable',
  inputs: [
    { name: 'revnetId', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'minBorrowAmount', type: 'uint256' },
    { name: 'collateralCount', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
    { name: 'prepaidFeePercent', type: 'uint256' },
    { name: 'holder', type: 'address' },
  ],
  outputs: [{ name: 'loanId', type: 'uint256' }, { name: 'loan', type: 'tuple', components: [{ name: 'amount', type: 'uint256' }] }],
}];
// REVLoans.REV_ID — the $REV revnet that receives the 1% loan fee. REVLoans.REV_PREPAID_FEE_PERCENT = 10 (1%).
var revLoanIdAbi = [{ type: 'function', name: 'REV_ID', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
// REVLoan struct (loanOf / determineSourceFeeAmount input) + repay.
var REVLOAN_COMPONENTS = [
  { name: 'amount', type: 'uint112' }, { name: 'collateral', type: 'uint112' }, { name: 'createdAt', type: 'uint48' },
  { name: 'prepaidFeePercent', type: 'uint16' }, { name: 'prepaidDuration', type: 'uint32' }, { name: 'sourceToken', type: 'address' },
];
var loanOfAbi = [{ type: 'function', name: 'loanOf', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: 'loan', type: 'tuple', components: REVLOAN_COMPONENTS }] }];
var determineSourceFeeAbi = [{ type: 'function', name: 'determineSourceFeeAmount', stateMutability: 'view', inputs: [{ name: 'loan', type: 'tuple', components: REVLOAN_COMPONENTS }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'uint256' }] }];
var repayLoanAbi = [{
  type: 'function', name: 'repayLoan', stateMutability: 'payable',
  inputs: [
    { name: 'loanId', type: 'uint256' }, { name: 'maxRepayBorrowAmount', type: 'uint256' },
    { name: 'collateralCountToReturn', type: 'uint256' }, { name: 'beneficiary', type: 'address' },
    { name: 'allowance', type: 'tuple', components: [
      { name: 'sigDeadline', type: 'uint256' }, { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }, { name: 'signature', type: 'bytes' },
    ]},
  ],
  outputs: [{ name: 'paidOffLoanId', type: 'uint256' }, { name: 'paidOffloan', type: 'tuple', components: REVLOAN_COMPONENTS }],
}];
var EMPTY_PERMIT2 = { sigDeadline: 0n, amount: 0n, expiration: 0, nonce: 0, signature: '0x' };
// Pure builder for REVLoans.borrowFrom. `o`: { chainId, loansAddr, revnetId, token, minBorrow (bigint),
// collateral (bigint), beneficiary, prepaidFeePercent, holder }. minBorrow is the floor on funds received.
export function buildBorrowArgs(o) {
  return {
    chainId: o.chainId, address: o.loansAddr, abi: borrowFromAbi, functionName: 'borrowFrom',
    args: [BigInt(o.revnetId), o.token, o.minBorrow || 0n, o.collateral, o.beneficiary, BigInt(o.prepaidFeePercent), o.holder],
  };
}
// Pure builder for REVLoans.repayLoan (payable). `o`: { chainId, loansAddr, loanId, maxRepay (bigint),
// collateralToReturn (bigint), beneficiary, value (bigint), allowance? (permit2 tuple) }.
export function buildRepayArgs(o) {
  return {
    chainId: o.chainId, address: o.loansAddr, abi: repayLoanAbi, functionName: 'repayLoan',
    args: [BigInt(o.loanId), o.maxRepay, o.collateralToReturn, o.beneficiary, o.allowance || EMPTY_PERMIT2],
    value: o.value || 0n,
  };
}
var LOAN_REV_FEE_PERCENT = 10; // 1% of the borrow, out of MAX_FEE (1000), to the $REV revnet
var _loanRevIdCache = {};
function loanRevIdOf(chainId) {
  if (_loanRevIdCache[chainId] !== undefined) return Promise.resolve(_loanRevIdCache[chainId]);
  var loans = getAddress('REVLoans', chainId);
  if (!loans) return Promise.resolve(null);
  return clientFor(chainId).readContract({ address: loans, abi: revLoanIdAbi, functionName: 'REV_ID', args: [] })
    .then(function (id) { _loanRevIdCache[chainId] = toBigInt(id); return _loanRevIdCache[chainId]; })
    .catch(function () { _loanRevIdCache[chainId] = null; return null; });
}

// Direct issuance estimate for paying `amount` of `token` into `projectId` — the beneficiary's minted
// token count. Used for fee-token previews (how many JB #1 / REV / source-project tokens a fee mints).
// Reads previewPayFor's beneficiaryTokenCount directly rather than going through computePayPreview, whose
// buyback-route branch returns the AMM minOut (often ~0 on illiquid testnet pools) when a revnet's data
// hook attaches a non-noop pay spec — which would otherwise hide the real issuance amount.
var feePreviewPayAbi = [{
  type: 'function', name: 'previewPayFor', stateMutability: 'view',
  inputs: [
    { name: 'projectId', type: 'uint256' }, { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' }, { name: 'beneficiary', type: 'address' }, { name: 'metadata', type: 'bytes' },
  ],
  outputs: [
    { name: 'ruleset', type: 'tuple', components: [
      { name: 'cycleNumber', type: 'uint256' }, { name: 'id', type: 'uint256' }, { name: 'basedOnId', type: 'uint256' },
      { name: 'start', type: 'uint256' }, { name: 'duration', type: 'uint256' }, { name: 'weight', type: 'uint256' },
      { name: 'weightCutPercent', type: 'uint256' }, { name: 'approvalHook', type: 'address' }, { name: 'metadata', type: 'uint256' },
    ]},
    { name: 'beneficiaryTokenCount', type: 'uint256' },
    { name: 'reservedTokenCount', type: 'uint256' },
    { name: 'hookSpecifications', type: 'tuple[]', components: [
      { name: 'hook', type: 'address' }, { name: 'noop', type: 'bool' }, { name: 'amount', type: 'uint256' }, { name: 'metadata', type: 'bytes' },
    ]},
  ],
}];
function feeTokenEstimate(chainId, projectId, token, amount, beneficiary) {
  var terminal = getAddress('JBMultiTerminal', chainId);
  if (!terminal || !amount || amount === 0n) return Promise.resolve(null);
  return clientFor(chainId).readContract({
    address: terminal, abi: feePreviewPayAbi, functionName: 'previewPayFor',
    args: [BigInt(projectId), token, amount, beneficiary || '0x0000000000000000000000000000000000000001', '0x'],
  }).then(function (o) { return toBigInt(o[1]); }).catch(function () { return null; });
}
// JBPermissions — opening a loan requires the holder to grant REVLoans BURN_TOKENS (11), since the loan
// burns the collateral via CONTROLLER.burnTokensOf(holder, …). Verified against nana-core-v6 + JBPermissionIds.
var JB_PERMISSION_BURN_TOKENS = 11;
var jbHasPermissionAbi = [{
  type: 'function', name: 'hasPermission', stateMutability: 'view',
  inputs: [
    { name: 'operator', type: 'address' }, { name: 'account', type: 'address' }, { name: 'projectId', type: 'uint256' },
    { name: 'permissionId', type: 'uint256' }, { name: 'includeRoot', type: 'bool' }, { name: 'includeWildcardProjectId', type: 'bool' },
  ], outputs: [{ type: 'bool' }],
}];
var jbSetPermissionsAbi = [{
  type: 'function', name: 'setPermissionsFor', stateMutability: 'nonpayable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'permissionsData', type: 'tuple', components: [
      { name: 'operator', type: 'address' }, { name: 'projectId', type: 'uint64' }, { name: 'permissionIds', type: 'uint8[]' }] },
  ], outputs: [],
}];
// Packed permissions bitmap an operator holds for (account, projectId). Bit N set → permission id N granted.
var jbPermissionsOfAbi = [{
  type: 'function', name: 'permissionsOf', stateMutability: 'view',
  inputs: [{ name: 'operator', type: 'address' }, { name: 'account', type: 'address' }, { name: 'projectId', type: 'uint256' }],
  outputs: [{ type: 'uint256' }],
}];
// JBPermissionIds (nana-permission-ids-v6) → human labels. id == bit position in the packed bitmap.
var JB_PERMISSION_LABELS = {
  1: 'Full control (root)', 2: 'Queue rulesets', 3: 'Launch rulesets', 4: 'Cash out tokens', 5: 'Send payouts',
  6: 'Migrate terminal', 7: 'Set project metadata', 8: 'Deploy ERC-20', 9: 'Set custom token', 10: 'Mint tokens',
  11: 'Burn tokens', 12: 'Claim tokens', 13: 'Transfer credits', 14: 'Set controller', 15: 'Set terminals',
  16: 'Add terminals', 17: 'Set primary terminal', 18: 'Use surplus allowance', 19: 'Set splits', 20: 'Add price feed',
  21: 'Add accounting tokens', 22: 'Set token metadata', 23: 'Sign for ERC-20 (permit)', 24: 'Adjust NFT tiers',
  25: 'Set NFT metadata', 26: 'Mint NFTs', 27: 'Set NFT discount', 28: 'Set buyback TWAP', 29: 'Set buyback pool',
  30: 'Set buyback hook', 31: 'Set router terminal', 32: 'Map sucker token', 33: 'Deploy suckers', 34: 'Set sucker peer',
  35: 'Sucker safety controls', 36: 'Set sucker deprecation', 37: 'Open loans', 38: 'Reallocate loans', 39: 'Repay loans',
};
var JB_PERMISSION_MAX_ID = 39;
// One-line plain-English explanation of what each permission lets the operator do.
var JB_PERMISSION_DESCS = {
  1: 'Grants every permission below — full control of the project.',
  2: 'Queue new rulesets (change duration, issuance, payouts, and rules).',
  3: 'Launch the project’s first rulesets.',
  4: 'Cash out (redeem) project tokens for a share of the project’s funds on a holder’s behalf.',
  5: 'Send the project’s scheduled payouts to its splits.',
  6: 'Move the project’s funds to a new terminal version.',
  7: 'Update the project’s metadata (name, logo, description).',
  8: 'Deploy the project’s ERC-20 token.',
  9: 'Replace the project token with a custom ERC-20.',
  10: 'Mint project tokens to any address without a payment.',
  11: 'Burn project tokens from a holder’s balance.',
  12: 'Claim a holder’s credits into the ERC-20 token.',
  13: 'Transfer a holder’s unclaimed token credits.',
  14: 'Swap the controller contract that manages rulesets and tokens.',
  15: 'Set the full list of the project’s payment terminals.',
  16: 'Add payment terminals to the project.',
  17: 'Set which terminal is primary for a given token.',
  18: 'Spend the project’s surplus allowance.',
  19: 'Edit the project’s payout and reserved-token splits.',
  20: 'Add a price feed used to convert between currencies.',
  21: 'Register new tokens the terminal accepts directly (e.g. an ERC-20 or USDC).',
  22: 'Set the project token’s name and symbol.',
  23: 'Sign permit (ERC-20 approval) messages on the project’s behalf.',
  24: 'Add or remove the project’s NFT tiers.',
  25: 'Update the NFT collection’s metadata.',
  26: 'Mint the project’s NFTs without a payment.',
  27: 'Set the discount applied to NFT prices.',
  28: 'Set the buyback hook’s TWAP window.',
  29: 'Set the buyback hook’s Uniswap pool.',
  30: 'Set the project’s buyback hook.',
  31: 'Set the router terminal used for swaps.',
  32: 'Map a token for cross-chain bridging via suckers.',
  33: 'Deploy the project’s cross-chain suckers.',
  34: 'Set a sucker’s peer on another chain.',
  35: 'Control sucker safety limits (caps, emergency hatch).',
  36: 'Deprecate a sucker (wind down a bridge).',
  37: 'Open loans against the project’s tokens.',
  38: 'Move collateral between the project’s loans.',
  39: 'Repay the project’s loans.',
};
function permissionLabel(id) { return JB_PERMISSION_LABELS[id] || ('Permission #' + id); }
function permissionDesc(id) { return JB_PERMISSION_DESCS[id] || ''; }
// Decode a packed permissions bitmap (uint256/BigInt) → sorted array of granted permission ids.
var totalBalanceOfAbi = [{
  type: 'function', name: 'totalBalanceOf', stateMutability: 'view',
  inputs: [{ name: 'holder', type: 'address' }, { name: 'projectId', type: 'uint256' }],
  outputs: [{ type: 'uint256' }],
}];
// Unclaimed credit balance (the portion of totalBalanceOf not yet claimed into an ERC-20).
var creditBalanceOfAbi = [{
  type: 'function', name: 'creditBalanceOf', stateMutability: 'view',
  inputs: [{ name: 'holder', type: 'address' }, { name: 'projectId', type: 'uint256' }],
  outputs: [{ type: 'uint256' }],
}];
// JBController.claimTokensFor — mint the holder's credits as transferable ERC-20s.
var claimTokensForAbi = [{
  type: 'function', name: 'claimTokensFor', stateMutability: 'nonpayable',
  inputs: [
    { name: 'holder', type: 'address' }, { name: 'projectId', type: 'uint256' },
    { name: 'tokenCount', type: 'uint256' }, { name: 'beneficiary', type: 'address' },
  ],
  outputs: [],
}];
// Pure builder for JBController.claimTokensFor (mint internal credits into the ERC-20). `o`: { chainId,
// controllerAddr, holder, projectId, tokenCount (bigint), beneficiary }.
export function buildClaimTokensArgs(o) {
  return {
    chainId: o.chainId, address: o.controllerAddr, abi: claimTokensForAbi, functionName: 'claimTokensFor',
    contractName: 'JBController', args: [o.holder, BigInt(o.projectId), o.tokenCount, o.beneficiary],
  };
}
// Uniswap V4 PoolManager per chain (from deploy-all-v6 Deploy.s.sol), lowercased. Used to read the
// buyback pool's current price (slot0) via extsload — the live AMM price for a revnet's token.
var POOL_MANAGER_BY_CHAIN = {
  1: '0x000000000004444c5dc75cb358380d2e3de08a90',
  11155111: '0xe03a1074c86cfedd5c142c4f04f1a1536e203543',
  10: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
  11155420: '0x000000000004444c5dc75cb358380d2e3de08a90',
  8453: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  84532: '0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408',
  42161: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  421614: '0xfb3e0c6f74eb1a21cc1da29aec80d2dfe6c9a317',
};
// Uniswap V4 PositionManager per chain (from deploy-all-v6). OP Sepolia (11155420) has none → no LP.
var POSITION_MANAGER_BY_CHAIN = {
  1: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
  11155111: '0x429ba70129df741b2ca2a85bc3a2a3328e5c09b4',
  10: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017',
  8453: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
  84532: '0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80',
  42161: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
  421614: '0xac631556d3d4019c95769033b5e719dd77124bac',
};
// Uniswap canonical Universal Router (v4-enabled) + V4 Quoter per chain. Authoritative values from
// hookmate (univ4-router-v6/lib/hookmate) — the same address book JB's own router uses. OP Sepolia
// (11155420) has no Uniswap v4 deployment → no direct swap there. Permit2 is the canonical singleton.
var UNIVERSAL_ROUTER_BY_CHAIN = {
  1: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
  10: '0x851116d9223fabed8e56c0e6b8ad0c31d98b3507',
  8453: '0x6ff5693b99212da76ad316178a184ab56d299b43',
  42161: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3',
  11155111: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b',
  84532: '0x492e6456d9528771018deb9e87ef7750ef184104',
  421614: '0xefd1d4bd4cf1e86da286bb4cb1b8bced9c10ba47',
};
var V4_QUOTER_BY_CHAIN = {
  1: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
  10: '0x1f3131a13296fb91c90870043742c3cdbff1a8d7',
  8453: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
  42161: '0x3972c00f7ed4885e145823eb7c655375d275a1c5',
  11155111: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227',
  84532: '0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba',
  421614: '0x7de51022d70a725b508085468052e25e22b5c4c9',
};
// v4-periphery Actions + Universal Router Commands (canonical byte values).
var V4_ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE: 0x0e };
var UR_CMD = { PERMIT2_PERMIT: 0x0a, V4_SWAP: 0x10 };
var v4QuoterAbi = [{
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
    ]},
    { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}];
var urExecuteAbi = [{
  type: 'function', name: 'execute', stateMutability: 'payable',
  inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }],
  outputs: [],
}];
function pad1(n) { return (n < 16 ? '0' : '') + n.toString(16); }

// The V4 PoolManager (singleton per chain) custodies all pooled tokens — so a buyback pool's REV shows up
// in the owners list under the PoolManager address. Flag those as the AMM.
var AMM_ADDRESSES = (function () { var m = {}; Object.keys(POOL_MANAGER_BY_CHAIN).forEach(function (k) { m[POOL_MANAGER_BY_CHAIN[k].toLowerCase()] = true; }); return m; })();
function isAmmAddress(addr) { return !!(addr && AMM_ADDRESSES[String(addr).toLowerCase()]); }

var poolKeyOfAbi = [{
  type: 'function', name: 'poolKeyOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'terminalToken', type: 'address' }],
  outputs: [{ name: 'key', type: 'tuple', components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
  ]}],
}];
var extsloadAbi = [{
  type: 'function', name: 'extsload', stateMutability: 'view',
  inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ type: 'bytes32' }],
}];
var POOLKEY_TUPLE = [{ type: 'tuple', components: [
  { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
]}];

// Current AMM price (ETH per project token) from the buyback pool's slot0. Returns null if no pool /
// price. Works even with zero liquidity (the pool is price-initialized at deploy at the issuance rate).
// The buyback pool's PAIR (terminal) token for a project on a chain — its Uniswap pool-currency address
// (native ETH = 0x0, else the ERC-20 e.g. USDC), decimals, and symbol. Mirrors the accounting token.
function lpPairFor(project, chainId) {
  return resolveAcctToken(chainId, BigInt(project.id)).then(function (a) {
    var native = a.address.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    return { addr: native ? ZERO_ADDRESS : a.address.toLowerCase(), decimals: a.decimals, symbol: native ? 'ETH' : a.symbol, isNative: native };
  }).catch(function () { return { addr: ZERO_ADDRESS, decimals: 18, symbol: 'ETH', isNative: true }; });
}

// Current AMM price as PAIR-token per project token (ETH/token for ETH pools, USDC/token for USDC pools).
async function readAmmPrice(project, chainId) {
  var hook = getAddress('JBBuybackHook', chainId);
  var pm = POOL_MANAGER_BY_CHAIN[chainId];
  if (!hook || !pm) return null;
  try {
    var pair = await lpPairFor(project, chainId);
    var client = clientFor(chainId);
    // The buyback hook keys its pool by (projectId, terminalToken) — pass the project's actual pair token,
    // not a hard-coded native 0x0, or a USDC pool is never found.
    var key = await client.readContract({ address: hook, abi: poolKeyOfAbi, functionName: 'poolKeyOf', args: [BigInt(project.id), pair.addr] });
    if (!key) return null;
    var c0 = (key.currency0 || ZERO_ADDRESS).toLowerCase();
    var c1 = (key.currency1 || ZERO_ADDRESS).toLowerCase();
    if (c0 === ZERO_ADDRESS && c1 === ZERO_ADDRESS) return null; // pool not set
    var poolId = keccak256(encodeAbiParameters(POOLKEY_TUPLE, [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
    var stateSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n])); // POOLS_SLOT = 6
    var slot0 = await client.readContract({ address: pm, abi: extsloadAbi, functionName: 'extsload', args: [stateSlot] });
    var sqrtP = BigInt(slot0) & ((1n << 160n) - 1n); // sqrtPriceX96 = lower 160 bits of slot0
    if (sqrtP === 0n) return null;
    var sp = Number(sqrtP) / Math.pow(2, 96);
    var rawP = sp * sp; // raw currency1 per currency0 (base units)
    // Convert raw → human pair-per-token. Project token is 18-dec; pair has pair.decimals.
    // raw_pair/raw_token = pairIsC0 ? 1/rawP : rawP ; human = raw_ratio × 10^(18 − pairDec).
    var pairIsC0 = (c0 === pair.addr);
    var rawRatio = pairIsC0 ? (rawP > 0 ? 1 / rawP : null) : rawP;
    if (rawRatio == null) return null;
    var human = rawRatio * Math.pow(10, 18 - pair.decimals);
    return (isFinite(human) && human > 0) ? human : null;
  } catch (e) { return null; }
}

// ── Direct AMM swap (bypass `pay`) ──────────────────────────────────────────────────────────────
// Paying through the buyback hook skims the reserved % even on the swap route. Swapping the pool
// directly via Uniswap's Universal Router instead lets the hook hand the swapper the BETTER of the
// full pool output (no reserved cut) or the JB issuance beneficiary — so the user keeps the "split tax"
// whenever the AMM wins. The hook intercepts every pool swap (no sender gate) and routes optimally.

// Resolve the buyback pool + swap direction for buying the project token with its pair token.
function directSwapPoolFor(project, chainId) {
  var hook = getAddress('JBBuybackHook', chainId);
  if (!hook || !UNIVERSAL_ROUTER_BY_CHAIN[chainId] || !V4_QUOTER_BY_CHAIN[chainId]) return Promise.resolve(null);
  return lpPairFor(project, chainId).then(function (pair) {
    return clientFor(chainId).readContract({ address: hook, abi: poolKeyOfAbi, functionName: 'poolKeyOf', args: [BigInt(project.id), pair.addr] })
      .then(function (key) {
        var c0 = (key.currency0 || ZERO_ADDRESS).toLowerCase();
        var c1 = (key.currency1 || ZERO_ADDRESS).toLowerCase();
        if (c0 === ZERO_ADDRESS && c1 === ZERO_ADDRESS) return null; // pool not set
        var pairAddr = pair.addr; // pool-currency form: native = 0x0
        // Buying the project token: input = pair token, output = the project token (the non-pair currency).
        var zeroForOne = (c0 === pairAddr); // swapping currency0(pair) → currency1(token)
        var tokenOut = zeroForOne ? key.currency1 : key.currency0;
        return { key: key, pair: pair, pairAddr: pairAddr, zeroForOne: zeroForOne, tokenOut: tokenOut };
      }).catch(function () { return null; });
  });
}

// True expected output of swapping `amountIn` of the pair token directly through the pool — runs the V4
// Quoter, which executes the hook's beforeSwap, so the result already reflects the hook's optimal routing
// (full AMM output when the AMM wins, JB issuance beneficiary otherwise). Null if the quote reverts.
function quoteDirectSwap(chainId, pool, amountIn) {
  var quoter = V4_QUOTER_BY_CHAIN[chainId];
  if (!quoter || !pool) return Promise.resolve(null);
  return clientFor(chainId).readContract({
    address: quoter, abi: v4QuoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: pool.key, zeroForOne: pool.zeroForOne, exactAmount: amountIn, hookData: '0x' }],
  }).then(function (r) { return toBigInt(Array.isArray(r) ? r[0] : r); }).catch(function () { return null; });
}

// Encode the V4_SWAP command input for an exact-in single swap (pair token → project token), output to
// the user. Actions: SWAP_EXACT_IN_SINGLE (amountOutMinimum enforces slippage) → SETTLE_ALL (pay the
// input; native from msg.value, ERC-20 pulled via the router's Permit2 allowance) → TAKE (output to user).
function encodeV4SwapInput(pool, amountIn, minOut, recipient) {
  var poolKeyParam = [pool.key.currency0, pool.key.currency1, pool.key.fee, pool.key.tickSpacing, pool.key.hooks];
  var swapParams = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] },
      { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' },
    ]}],
    [[poolKeyParam, pool.zeroForOne, amountIn, minOut, '0x']]
  );
  var settleParams = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [pool.pairAddr, amountIn]); // SETTLE_ALL(currencyIn, max)
  var takeParams = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [pool.tokenOut, recipient, 0n]); // TAKE(currencyOut, recipient, OPEN_DELTA)
  var actions = '0x' + pad1(V4_ACTION.SWAP_EXACT_IN_SINGLE) + pad1(V4_ACTION.SETTLE_ALL) + pad1(V4_ACTION.TAKE);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settleParams, takeParams]]);
}

// Native pair token → project token: single V4_SWAP, input paid via msg.value.
function buildDirectSwapNativeTx(chainId, pool, amountIn, minOut, recipient) {
  return {
    chainId: chainId, address: UNIVERSAL_ROUTER_BY_CHAIN[chainId], abi: urExecuteAbi, functionName: 'execute',
    args: ['0x' + pad1(UR_CMD.V4_SWAP), [encodeV4SwapInput(pool, amountIn, minOut, recipient)], BigInt(Math.floor(Date.now() / 1000) + 1800)],
    value: amountIn,
  };
}

// ERC-20 pair token (e.g. USDC for ART) → project token. Ensures a one-time USDC→Permit2 approval, signs a
// gasless Permit2 single-allowance for the Universal Router, then sends PERMIT2_PERMIT + V4_SWAP in one tx
// (the swap's SETTLE pulls the USDC via that allowance). Async: may send an approval tx + request a sig.
async function buildDirectSwapErc20Tx(chainId, pool, token, amountIn, minOut, recipient, onStatus) {
  var ur = UNIVERSAL_ROUTER_BY_CHAIN[chainId];
  var client = clientFor(chainId);
  var wallet = getWalletClient();
  // Switch to the swap chain before signing — the Permit2 domain + the approve write both bind to the active chain.
  var wc0 = await wallet.getChainId().catch(function () { return null; });
  if (wc0 !== chainId) { if (onStatus) onStatus('Switching to ' + chainNameOf(chainId) + '…', 'pending'); await switchChain(chainId); wallet = getWalletClient(); }
  // 1. One-time ERC20→Permit2 approval (canonical Permit2; wallets recognize it).
  var erc20Allow = await client.readContract({ address: token, abi: lpErc20Abi, functionName: 'allowance', args: [recipient, PERMIT2_ADDRESS] });
  if (BigInt(erc20Allow) < amountIn) {
    if (onStatus) onStatus('Approving for Permit2 (one-time)…', 'pending');
    var ah = await wallet.writeContract({ account: recipient, chain: CHAINS[chainId], address: token, abi: lpErc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, (1n << 256n) - 1n] });
    await client.waitForTransactionReceipt({ hash: ah });
  }
  // 2. Sign an expiring Permit2 single-allowance authorizing the Universal Router to pull `amountIn`.
  var p2 = await client.readContract({ address: PERMIT2_ADDRESS, abi: lpPermit2Abi, functionName: 'allowance', args: [recipient, token, ur] });
  var nonce = Number(p2[2]);
  var now = Math.floor(Date.now() / 1000);
  var expiration = now + 1800, sigDeadline = BigInt(now + 1800);
  if (onStatus) onStatus('Sign the swap authorization…', 'pending');
  var signature = await wallet.signTypedData({
    account: recipient,
    domain: { name: 'Permit2', chainId: chainId, verifyingContract: PERMIT2_ADDRESS },
    types: LP_PERMIT2_TYPES, primaryType: 'PermitSingle',
    message: { details: { token: token, amount: amountIn, expiration: expiration, nonce: nonce }, spender: ur, sigDeadline: sigDeadline },
  });
  // 3. PERMIT2_PERMIT input = (PermitSingle, signature); PermitSingle = (PermitDetails, spender, sigDeadline).
  var permitInput = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { type: 'tuple', components: [{ type: 'address' }, { type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }] },
      { type: 'address' }, { type: 'uint256' },
    ]}, { type: 'bytes' }],
    [[[token, amountIn, expiration, nonce], ur, sigDeadline], signature]
  );
  var commands = '0x' + pad1(UR_CMD.PERMIT2_PERMIT) + pad1(UR_CMD.V4_SWAP);
  return {
    chainId: chainId, address: ur, abi: urExecuteAbi, functionName: 'execute',
    args: [commands, [permitInput, encodeV4SwapInput(pool, amountIn, minOut, recipient)], BigInt(now + 1800)],
    value: 0n,
  };
}

// Current cash-out price (ETH reclaimed per token) — the price floor. Null when supply/surplus is 0.
async function readCashoutPrice(project, chainId) {
  var pid = BigInt(project.id);
  var terminal = getAddress('JBMultiTerminal', chainId);
  if (!terminal) return null;
  try {
    // supply and balance are independent — fetch together (one multicall round-trip) before the reclaim read.
    var res = await Promise.all([
      read(chainId, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]),
      read(chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, pid, NATIVE_TOKEN]),
    ]);
    var supply = res[0], bal = res[1];
    if (!supply || supply === 0n) return null;
    if (bal == null || bal === 0n) return null;
    var reclaim = await read(chainId, 'JBTerminalStore', reclaimableAbi, 'currentReclaimableSurplusOf', [pid, ONE_TOKEN, supply, bal]);
    return reclaim ? Number(reclaim) / 1e18 : null;
  } catch (e) { return null; }
}
var RULESET_OUTPUTS = [
  { name: 'ruleset', type: 'tuple', components: [
    { name: 'cycleNumber', type: 'uint256' },
    { name: 'id', type: 'uint256' },
    { name: 'basedOnId', type: 'uint256' },
    { name: 'start', type: 'uint256' },
    { name: 'duration', type: 'uint256' },
    { name: 'weight', type: 'uint256' },
    { name: 'weightCutPercent', type: 'uint256' },
    { name: 'approvalHook', type: 'address' },
    { name: 'metadata', type: 'uint256' },
  ]},
  { name: 'metadata', type: 'tuple', components: [
    { name: 'reservedPercent', type: 'uint256' }, { name: 'cashOutTaxRate', type: 'uint256' },
    { name: 'baseCurrency', type: 'uint256' }, { name: 'pausePay', type: 'bool' },
    { name: 'pauseCreditTransfers', type: 'bool' }, { name: 'allowOwnerMinting', type: 'bool' },
    { name: 'allowSetCustomToken', type: 'bool' }, { name: 'allowTerminalMigration', type: 'bool' },
    { name: 'allowSetTerminals', type: 'bool' }, { name: 'allowSetController', type: 'bool' },
    { name: 'allowAddAccountingContext', type: 'bool' }, { name: 'allowAddPriceFeed', type: 'bool' },
    { name: 'ownerMustSendPayouts', type: 'bool' }, { name: 'holdFees', type: 'bool' },
    { name: 'useTotalSurplusForCashOuts', type: 'bool' }, { name: 'useDataHookForPay', type: 'bool' },
    { name: 'useDataHookForCashOut', type: 'bool' }, { name: 'dataHook', type: 'address' },
    { name: 'metadata', type: 'uint256' },
  ]},
];
var upcomingRulesetAbi = [{
  type: 'function', name: 'upcomingRulesetOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }], outputs: RULESET_OUTPUTS,
}];
var payoutLimitsAbi = [{
  type: 'function', name: 'payoutLimitsOf', stateMutability: 'view',
  inputs: [
    { name: 'projectId', type: 'uint256' }, { name: 'rulesetId', type: 'uint256' },
    { name: 'terminal', type: 'address' }, { name: 'token', type: 'address' },
  ],
  outputs: [{ name: 'payoutLimits', type: 'tuple[]', components: [
    { name: 'amount', type: 'uint256' }, { name: 'currency', type: 'uint256' },
  ]}],
}];
var surplusAllowancesAbi = [{
  type: 'function', name: 'surplusAllowancesOf', stateMutability: 'view',
  inputs: [
    { name: 'projectId', type: 'uint256' }, { name: 'rulesetId', type: 'uint256' },
    { name: 'terminal', type: 'address' }, { name: 'token', type: 'address' },
  ],
  outputs: [{ name: 'surplusAllowances', type: 'tuple[]', components: [
    { name: 'amount', type: 'uint256' }, { name: 'currency', type: 'uint256' },
  ]}],
}];
// BannyLPSplitHook (JBUniswapV4LPSplitHook) — receives reserved project tokens, accumulates them, then
// anyone can deploy/seed a Uniswap V4 LP position and route its fees back to the project. Reads + the
// permissionless keeper actions used by the Market split-hook card.
var bannyHookAbi = [
  { type: 'function', name: 'accumulatedProjectTokens', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'hasDeployedPool', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'claimableFeeTokens', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimableFeeTokenOf', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenIdOf', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'terminalToken', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'activeTickLowerOf', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'terminalToken', type: 'address' }], outputs: [{ type: 'int24' }] },
  { type: 'function', name: 'activeTickUpperOf', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'terminalToken', type: 'address' }], outputs: [{ type: 'int24' }] },
  { type: 'function', name: 'deployPool', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'minCashOutReturn', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'addLiquidity', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'terminalToken', type: 'address' }, { name: 'minCashOutReturn', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'collectAndRouteLPFees', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'terminalToken', type: 'address' }], outputs: [] },
  { type: 'function', name: 'claimFeeTokensFor', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'beneficiary', type: 'address' }], outputs: [] },
];
var sendPayoutsAbi = [{
  type: 'function', name: 'sendPayoutsOf', stateMutability: 'nonpayable',
  inputs: [
    { name: 'projectId', type: 'uint256' }, { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' }, { name: 'currency', type: 'uint256' },
    { name: 'minTokensPaidOut', type: 'uint256' },
  ],
  outputs: [{ name: 'amountPaidOut', type: 'uint256' }],
}];
var useAllowanceAbi = [{
  type: 'function', name: 'useAllowanceOf', stateMutability: 'nonpayable',
  inputs: [
    { name: 'projectId', type: 'uint256' }, { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' }, { name: 'currency', type: 'uint256' },
    { name: 'minTokensPaidOut', type: 'uint256' }, { name: 'beneficiary', type: 'address' },
    { name: 'feeBeneficiary', type: 'address' }, { name: 'memo', type: 'string' },
  ],
  outputs: [{ name: 'amountPaidOut', type: 'uint256' }],
}];
var currentRulesetAbi = [{
  type: 'function', name: 'currentRulesetOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }],
  outputs: [
    { name: 'ruleset', type: 'tuple', components: [
      { name: 'cycleNumber', type: 'uint256' },
      { name: 'id', type: 'uint256' },
      { name: 'basedOnId', type: 'uint256' },
      { name: 'start', type: 'uint256' },
      { name: 'duration', type: 'uint256' },
      { name: 'weight', type: 'uint256' },
      { name: 'weightCutPercent', type: 'uint256' },
      { name: 'approvalHook', type: 'address' },
      { name: 'metadata', type: 'uint256' },
    ]},
    { name: 'metadata', type: 'tuple', components: [
      { name: 'reservedPercent', type: 'uint256' },
      { name: 'cashOutTaxRate', type: 'uint256' },
      { name: 'baseCurrency', type: 'uint256' },
      { name: 'pausePay', type: 'bool' },
      { name: 'pauseCreditTransfers', type: 'bool' },
      { name: 'allowOwnerMinting', type: 'bool' },
      { name: 'allowSetCustomToken', type: 'bool' },
      { name: 'allowTerminalMigration', type: 'bool' },
      { name: 'allowSetTerminals', type: 'bool' },
      { name: 'allowSetController', type: 'bool' },
      { name: 'allowAddAccountingContext', type: 'bool' },
      { name: 'allowAddPriceFeed', type: 'bool' },
      { name: 'ownerMustSendPayouts', type: 'bool' },
      { name: 'holdFees', type: 'bool' },
      { name: 'useTotalSurplusForCashOuts', type: 'bool' },
      { name: 'useDataHookForPay', type: 'bool' },
      { name: 'useDataHookForCashOut', type: 'bool' },
      { name: 'dataHook', type: 'address' },
      { name: 'metadata', type: 'uint256' },
    ]},
  ],
}];

var RESERVED_TOKEN_SPLIT_GROUP = 1n; // JBSplitGroupIds.RESERVED_TOKENS

// Queue rulesets. The JBRulesetConfig[] tuple is identical to launchProjectFor's — reuse that component
// (named to match buildRulesetConfigs' output so viem encodes by key) for both the controller and the
// omnichain deployer paths.
var RULESET_CFG_COMPONENT = launchProjectAbi[0].inputs.filter(function (i) { return i.name === 'rulesetConfigurations'; })[0];
var queueRulesetsAbi = [{
  type: 'function', name: 'queueRulesetsOf', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' }, RULESET_CFG_COMPONENT, { name: 'memo', type: 'string' }],
  outputs: [{ name: 'rulesetId', type: 'uint256' }],
}];
var omnichainQueueAbi = [{
  type: 'function', name: 'queueRulesetsOf', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' }, RULESET_CFG_COMPONENT, { name: 'memo', type: 'string' }],
  outputs: [{ name: 'rulesetId', type: 'uint256' }, { name: 'hook', type: 'address' }],
}];
// "Start a new shop" at queue time. Both overloads deploy a fresh 721 hook, transfer its ownership to the
// PROJECT, and queue a ruleset wired to it — in one owner-signed tx (no stranded-ownership EOA path).
// Single-chain: JB721TiersHookProjectDeployer.queueRulesetsOf(projectId, deployTiersHookConfig, rulesets, controller, salt).
var projectDeployer721QueueAbi = [{
  type: 'function', name: 'queueRulesetsOf', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'deployTiersHookConfig', type: 'tuple', components: DEPLOY_721_COMPONENTS },
    RULESET_CFG_COMPONENT, { name: 'controller', type: 'address' }, { name: 'salt', type: 'bytes32' }],
  outputs: [{ name: 'rulesetId', type: 'uint256' }, { name: 'hook', type: 'address' }],
}];
// Omnichain: JBOmnichainDeployer.queueRulesetsOf(projectId, deploy721Config, rulesets, memo) — non-empty tiers
// triggers the deploy-fresh branch (ownership → project).
var omnichainQueueDeploy721Abi = [{
  type: 'function', name: 'queueRulesetsOf', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' },
    { name: 'deploy721Config', type: 'tuple', components: [{ name: 'deployTiersHookConfig', type: 'tuple', components: DEPLOY_721_COMPONENTS }, { name: 'useDataHookForCashOut', type: 'bool' }, { name: 'salt', type: 'bytes32' }] },
    RULESET_CFG_COMPONENT, { name: 'memo', type: 'string' }],
  outputs: [{ name: 'rulesetId', type: 'uint256' }, { name: 'hook', type: 'address' }],
}];

// Pure builder for the "new shop" queue call — picks the right deployer + arg-order per chain mode so the
// money-path routing is unit-testable (mis-routing "new" to plain JBController.queueRulesetsOf would queue a
// ruleset with no shop). Returns { to, abi, functionName, args }.
export function buildNewShopQueueCall(o) {
  var pid = BigInt(o.projectId);
  if (o.isOmnichain) {
    return { to: o.omnichainDeployer, abi: omnichainQueueDeploy721Abi, functionName: 'queueRulesetsOf',
      args: [pid, { deployTiersHookConfig: o.deployConfig, useDataHookForCashOut: !!o.useDataHookForCashOut, salt: o.salt }, o.cfgs, o.memo || ''] };
  }
  return { to: o.projectDeployer, abi: projectDeployer721QueueAbi, functionName: 'queueRulesetsOf',
    args: [pid, o.deployConfig, o.cfgs, o.controller, o.salt] };
}
// Approval-hook (rule-change deadline) options — JBDeadline singletons, resolved per chain via getAddress.
var DEADLINE_OPTIONS = [
  { key: 'none', label: 'No deadline', contract: null },
  { key: '3hours', label: '3 hours', contract: 'JBDeadline3Hours' },
  { key: '1day', label: '1 day', contract: 'JBDeadline1Day' },
  { key: '3days', label: '3 days', contract: 'JBDeadline3Days' },
  { key: '7days', label: '7 days', contract: 'JBDeadline7Days' },
];
// Map an approval-hook address → friendly deadline label for the current chain ('Custom' if unknown).
function deadlineLabelOf(addr, chainId) {
  if (!addr || addr === ZERO_ADDRESS) return 'No deadline';
  for (var i = 0; i < DEADLINE_OPTIONS.length; i++) {
    var c = DEADLINE_OPTIONS[i].contract;
    if (c && (getAddress(c, chainId) || '').toLowerCase() === addr.toLowerCase()) return DEADLINE_OPTIONS[i].label;
  }
  return 'Custom';
}

// Revnet stages are just the project's queued rulesets. allOf walks the ruleset list.
var allOfAbi = [{
  type: 'function', name: 'allOf', stateMutability: 'view',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'startingId', type: 'uint256' },
    { name: 'size', type: 'uint256' },
  ],
  outputs: [{ name: 'rulesets', type: 'tuple[]', components: [
    { name: 'cycleNumber', type: 'uint48' },
    { name: 'id', type: 'uint48' },
    { name: 'basedOnId', type: 'uint48' },
    { name: 'start', type: 'uint48' },
    { name: 'duration', type: 'uint32' },
    { name: 'weight', type: 'uint112' },
    { name: 'weightCutPercent', type: 'uint32' },
    { name: 'approvalHook', type: 'address' },
    { name: 'metadata', type: 'uint256' },
  ]}],
}];
var totalBorrowedAbi = [{
  type: 'function', name: 'totalBorrowedFrom', stateMutability: 'view',
  inputs: [{ name: 'revnetId', type: 'uint256' }, { name: 'token', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}];
var totalCollateralAbi = [{
  type: 'function', name: 'totalCollateralOf', stateMutability: 'view',
  inputs: [{ name: 'revnetId', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
}];

var WEIGHT_CUT_SCALE = 1e7; // weightCutPercent is out of 1e9; /1e7 → percent.

// Auto-issuance lives on REVOwner. The amount is a public view (keyed by the stage's ruleset id
// and beneficiary); autoIssueFor distributes it.
var amountToAutoIssueAbi = [{
  type: 'function', name: 'amountToAutoIssue', stateMutability: 'view',
  inputs: [
    { name: 'revnetId', type: 'uint256' },
    { name: 'stageId', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}];
var autoIssueForAbi = [{
  type: 'function', name: 'autoIssueFor', stateMutability: 'nonpayable',
  inputs: [
    { name: 'revnetId', type: 'uint256' },
    { name: 'stageId', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
  ],
  outputs: [],
}];

// Decode reserved %, cash-out tax, and base currency from a ruleset's packed metadata uint.
// Layout per JBRulesetMetadataResolver: reservedPercent << 4, cashOutTaxRate << 20, baseCurrency << 36.
function decodeStageMetadata(packed) {
  var m = BigInt(packed);
  return {
    reservedPercent: Number((m >> 4n) & 0xFFFFn),
    cashOutTaxRate: Number((m >> 20n) & 0xFFFFn),
    baseCurrency: Number((m >> 36n) & 0xFFFFFFFFn),
  };
}

var ONE_TOKEN = 1000000000000000000n; // 1e18

// Reclaim value for a token count given raw supply + surplus — no currency conversion, so it reads
// without the price feed that the currency-converting overload (and currentSurplusOf) need.
var reclaimableAbi = [{
  type: 'function', name: 'currentReclaimableSurplusOf', stateMutability: 'view',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'cashOutCount', type: 'uint256' },
    { name: 'totalSupply', type: 'uint256' },
    { name: 'surplus', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}];
// The supply + surplus inputs the cash-out bonding curve runs on (for the "how it's calculated" breakdown).
// totalTokenSupplyWithReservedTokensOf = circulating + pending reserved (the curve's denominator).
var totalSupplyWithReservedAbi = [{ type: 'function', name: 'totalTokenSupplyWithReservedTokensOf', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ type: 'uint256' }] }];
// currentSurplusOf with empty terminals/tokens = surplus across ALL of a chain's terminals and accounting
// tokens, valued in `currency`/`decimals` (the cumulative surplus the cash-out curve prices against).
var currentSurplusOfAbi = [{ type: 'function', name: 'currentSurplusOf', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'terminals', type: 'address[]' }, { name: 'tokens', type: 'address[]' }, { name: 'decimals', type: 'uint256' }, { name: 'currency', type: 'uint256' }], outputs: [{ type: 'uint256' }] }];
// JBMultiTerminal.previewCashOutFrom — runs the project's cash-out data hook (for revnets, REVOwner's
// 2.5%-of-tokens fee + buyback routing), returning the bonding-curve reclaim NET of the hook but BEFORE
// the terminal's 2.5% protocol fee. This is the only way to price a revnet cash-out correctly — the REV
// fee math (cross-chain effective surplus, local-liquidity scaling) is infeasible to replicate client-side.
var previewCashOutAbi = [{
  type: 'function', name: 'previewCashOutFrom', stateMutability: 'view',
  inputs: [
    { name: 'holder', type: 'address' },
    { name: 'projectId', type: 'uint256' },
    { name: 'cashOutCount', type: 'uint256' },
    { name: 'tokenToReclaim', type: 'address' },
    { name: 'beneficiary', type: 'address' },
    { name: 'metadata', type: 'bytes' },
  ],
  outputs: [
    { name: 'ruleset', type: 'tuple', components: [
      { name: 'cycleNumber', type: 'uint256' }, { name: 'id', type: 'uint256' },
      { name: 'basedOnId', type: 'uint256' }, { name: 'start', type: 'uint256' },
      { name: 'duration', type: 'uint256' }, { name: 'weight', type: 'uint256' },
      { name: 'weightCutPercent', type: 'uint256' }, { name: 'approvalHook', type: 'address' },
      { name: 'metadata', type: 'uint256' },
    ]},
    { name: 'reclaimAmount', type: 'uint256' },
    { name: 'cashOutTaxRate', type: 'uint256' },
    { name: 'hookSpecifications', type: 'tuple[]', components: [
      { name: 'hook', type: 'address' }, { name: 'noop', type: 'bool' },
      { name: 'amount', type: 'uint256' }, { name: 'metadata', type: 'bytes' },
    ]},
  ],
}];
var borrowableAbi = [{
  type: 'function', name: 'borrowableAmountFrom', stateMutability: 'view',
  inputs: [
    { name: 'revnetId', type: 'uint256' },
    { name: 'collateralCount', type: 'uint256' },
    { name: 'decimals', type: 'uint256' },
    { name: 'currency', type: 'uint256' },
  ],
  // borrowableNow = min(capacity, live project surplus); 0 while the revnet's cash-out delay is active.
  outputs: [{ name: 'borrowableNow', type: 'uint256' }, { name: 'borrowableCapacity', type: 'uint256' }],
}];
// REVOwner (a revnet's data hook): when loans/cash-outs unlock. 0 = no delay; future = locked until then.
var cashOutDelayAbi = [{
  type: 'function', name: 'cashOutDelayOf', stateMutability: 'view',
  inputs: [{ name: 'revnetId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }],
}];

// -- Helpers --

function ipfsToHttp(uri) {
  if (!uri) return '';
  if (uri.indexOf('ipfs://') === 0) return IPFS_GATEWAY + uri.slice('ipfs://'.length);
  return uri;
}

// Tier media URLs (image / animation_url, or an href pulled out of a metadata SVG) are attacker-controlled.
// Block script-bearing schemes before they reach a src/href. safeMediaUrl keeps http(s)/ipfs-gateway and
// data:image|video|audio, dropping javascript:/vbscript:/blob: and data:text|application (HTML/script payloads).
export function safeMediaUrl(url) {
  var u = (url || '').trim();
  if (!u) return '';
  if (/^(javascript|vbscript|blob):/i.test(u)) return '';
  if (/^data:/i.test(u) && !/^data:(image|video|audio)\//i.test(u)) return '';
  return u;
}
// An <iframe> executes whatever its src resolves to — require a real http(s) URL (no data:/blob:/javascript:).
export function httpUrlOnly(url) { var u = (url || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }

// DOMParser is INERT — unlike `div.innerHTML = html`, the parsed document never loads <img src> (so an
// `<img onerror>` in untrusted on-chain text can't fire) and never runs script. Use it everywhere we parse
// project-controlled HTML to extract text/structure.
function parseInertHtml(html) { return new DOMParser().parseFromString(String(html || ''), 'text/html').body; }

function stripHtml(html) {
  if (!html) return '';
  return (parseInertHtml(html).textContent || '').replace(/\s+/g, ' ').trim();
}

// Like stripHtml, but PRESERVES paragraph/line breaks. Rich-text descriptions are HTML
// (`<p>…</p><p><br></p><p>…</p>`); textContent concatenates block elements with no whitespace, so
// sentences run together ("loans.$CPN"). Convert <br> and block boundaries to newlines first, then
// extract text — never inject the raw HTML into the live DOM (untrusted on-chain content).
function htmlToText(html) {
  if (!html) return '';
  var tmp = parseInertHtml(html);
  tmp.querySelectorAll('br').forEach(function (br) { br.replaceWith(document.createTextNode('\n')); });
  tmp.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr').forEach(function (b) { b.appendChild(document.createTextNode('\n\n')); });
  return (tmp.textContent || '')
    .replace(/[ \t]+/g, ' ')      // collapse runs of spaces
    .replace(/ *\n */g, '\n')      // trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')    // cap consecutive blank lines
    .trim();
}

// Render rich-text metadata (HTML from the editor) into `container` as paragraphs AND lists — so
// `<ul>`/`<ol>` keep their bullets/numbers instead of flattening to plain lines. Untrusted on-chain
// content: parse into a detached node and copy only text + list structure (never inject raw HTML).
function renderRichTextInto(container, html) {
  var tmp = parseInertHtml(html);
  var rendered = false;
  for (var i = 0; i < tmp.children.length; i++) {
    var b = tmp.children[i], tag = b.tagName;
    if (tag === 'UL' || tag === 'OL') {
      var list = el(tag === 'OL' ? 'ol' : 'ul', 'detail-about-list');
      var items = b.querySelectorAll('li');
      for (var j = 0; j < items.length; j++) { var li = el('li', 'detail-about-li'); li.textContent = htmlToText(items[j].innerHTML); list.appendChild(li); }
      if (items.length) { container.appendChild(list); rendered = true; }
    } else {
      var txt = htmlToText(b.innerHTML);
      if (txt) { var p = el('p', 'detail-about-para'); p.textContent = txt; container.appendChild(p); rendered = true; }
    }
  }
  // Fallback (no block children — plain text): split on blank lines.
  if (!rendered) {
    htmlToText(html).split(/\n{2,}/).forEach(function (para) {
      if (!para.trim()) return;
      var p = el('p', 'detail-about-para'); p.textContent = para.trim(); container.appendChild(p);
    });
  }
}

// addressNode wrapped in a link to the chain's block explorer (etherscan-style).
function addressLinkNode(address, chainId) {
  var node = addressNode(address);
  if (!address || address === ZERO_ADDRESS) return node;
  var chain = CHAINS[chainId];
  var base = chain && chain.blockExplorers && chain.blockExplorers.default && chain.blockExplorers.default.url;
  var inner = node;
  if (base) {
    var a = document.createElement('a');
    a.href = base.replace(/\/$/, '') + '/address/' + address;
    a.target = '_blank'; a.rel = 'noopener'; a.className = 'detail-address-link';
    a.appendChild(node);
    inner = a;
  }
  // Safe badge sits OUTSIDE the explorer link so its click opens the details modal, not the link.
  var wrap = el('span', 'address-with-safe');
  wrap.appendChild(inner);
  wrap.appendChild(safeBadge(address, chainId));
  return wrap;
}

function formatEth(wei) {
  if (wei === null || wei === undefined) return '—';
  return formatTokenCount(wei) + ' ETH';
}

// Format a raw token amount with its own decimals + symbol (e.g. USDC at 6 decimals, ETH at 18).
// Precision rules come from the shared formatAdaptive; '—' (null/non-finite) stays symbol-less.
function formatBalance(amount, decimals, symbol) {
  if (amount === null || amount === undefined) return '—';
  var s = formatAdaptive(Number(amount) / Math.pow(10, (decimals == null ? 18 : decimals)));
  return s === '—' ? s : s + (symbol ? ' ' + symbol : '');
}

// The project's primary accounting token (what its balance is denominated in). Reads the
// terminal's accounting contexts; defaults to native ETH when none are recorded.
function resolveAcctToken(chainId, pid) {
  var fallback = { address: NATIVE_TOKEN, decimals: 18, symbol: 'ETH' };
  if (!getAddress('JBMultiTerminal', chainId)) return Promise.resolve(fallback);
  return read(chainId, 'JBMultiTerminal', TERMINAL_CONTEXTS_ABI, 'accountingContextsOf', [pid]).then(function (ctxs) {
    if (!ctxs || !ctxs.length) return fallback;
    var primary = ctxs[0];
    if (primary.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return { address: primary.token, decimals: Number(primary.decimals), symbol: 'ETH' };
    var chainTokens = getChainTokens(chainId); var usdc = USDC_BY_CHAIN[chainId];
    var t = chainTokens.filter(function (x) { return x.address.toLowerCase() === primary.token.toLowerCase(); })[0];
    var sym = t ? t.symbol : ((usdc && primary.token.toLowerCase() === usdc.toLowerCase()) ? 'USDC' : truncAddr(primary.token));
    return { address: primary.token, decimals: Number(primary.decimals), symbol: sym };
  }).catch(function () { return fallback; });
}

// Shorter display names than the manifest's (Arbitrum One → Arbitrum, OP Mainnet → Optimism).
var SHORT_CHAIN_NAME = { 10: 'Optimism', 42161: 'Arbitrum' };
function chainNameOf(cid) {
  return SHORT_CHAIN_NAME[Number(cid)] || (CHAINS[cid] && CHAINS[cid].name) || ('Chain ' + cid);
}

// The unit a project's issuance/weight is denominated in — its ruleset baseCurrency (USD or ETH), NOT
// its accounting token. "625 ART / USD" means 625 tokens per dollar paid.
function baseUnitLabel(project) {
  return (project && project.metadata && Number(project.metadata.baseCurrency) === 2) ? 'USD' : 'ETH';
}

// USD value of a chosen amount of dollars (USDC is $1; ETH needs the live feed).
function formatUsd(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// The indexer's volumeUsd/*Usd fields are 18-decimal scaled USD (value of all intake regardless of the
// project's accounting token). Convert to a plain number; null/empty -> null so callers can show '—'.
function usdFromScaled(value) {
  if (value == null || value === '') return null;
  try { return Number(BigInt(String(value).split('.')[0]) / 1000000000000n) / 1e6; } catch (_) { return null; }
}

// ETH/USD spot from the protocol's own Chainlink feed (cached per chain). currentUnitPrice(18) returns
// USD-per-ETH scaled to 18 decimals; null when the feed is absent/reverting (testnet gaps).
var ETH_USD_CACHE = {};
var ETH_USD_FEED_ABI = [{ type: 'function', name: 'currentUnitPrice', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] }];
function fetchEthUsd(chainId) {
  if (ETH_USD_CACHE[chainId] !== undefined) return Promise.resolve(ETH_USD_CACHE[chainId]);
  if (!getAddress('JBChainlinkV3PriceFeed__ETH_USD', chainId)) { ETH_USD_CACHE[chainId] = null; return Promise.resolve(null); }
  return read(chainId, 'JBChainlinkV3PriceFeed__ETH_USD', ETH_USD_FEED_ABI, 'currentUnitPrice', [18n])
    .then(function (p) { var v = Number(p) / 1e18; ETH_USD_CACHE[chainId] = (isFinite(v) && v > 0) ? v : null; return ETH_USD_CACHE[chainId]; })
    .catch(function () { ETH_USD_CACHE[chainId] = null; return null; });
}

// One chain's balances across EVERY accounting token the terminal accepts (a project can hold
// both ETH and USDC). Falls back to the primary accounting token if no contexts are recorded.
function readChainBalances(chainId, pid) {
  var term = getAddress('JBMultiTerminal', chainId);
  if (!term) return Promise.resolve({ chainId: chainId, tokens: [] });
  return clientFor(chainId).readContract({ address: term, abi: TERMINAL_CONTEXTS_ABI, functionName: 'accountingContextsOf', args: [pid] }).then(function (ctxs) {
    if (!ctxs || !ctxs.length) {
      return resolveAcctToken(chainId, pid).then(function (acct) {
        return read(chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [term, pid, acct.address])
          .then(function (bal) { return { chainId: chainId, tokens: [{ token: acct.address, balance: bal, decimals: acct.decimals, symbol: acct.symbol }] }; })
          .catch(function () { return { chainId: chainId, tokens: [] }; });
      });
    }
    return Promise.all(ctxs.map(function (ctx) {
      return read(chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [term, pid, ctx.token])
        .then(function (bal) { return { token: ctx.token, balance: bal, decimals: Number(ctx.decimals), symbol: acctTokenLabel(ctx.token) }; })
        .catch(function () { return { token: ctx.token, balance: null, decimals: Number(ctx.decimals), symbol: acctTokenLabel(ctx.token) }; });
    })).then(function (toks) { return { chainId: chainId, tokens: toks }; });
  }).catch(function () { return { chainId: chainId, tokens: [] }; });
}

// Cross-chain balance breakdown across ALL accounting tokens + a single USD total. ETH converts via the
// live feed; USDC (and other non-ETH accounting tokens) are taken at $1. One row per (chain, token). Cached.
function fetchBalanceBreakdown(project) {
  if (project._balBreakdown) return Promise.resolve(project._balBreakdown);
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId }];
  var pid = BigInt(project.id);
  return Promise.all(chains.map(function (c) { return readChainBalances(c.id, pid); })).then(function (results) {
    var isEthTok = function (t) { return t.symbol === 'ETH' || (t.token || '').toLowerCase() === NATIVE_TOKEN.toLowerCase(); };
    var needEth = results.some(function (cr) { return cr.tokens.some(function (t) { return isEthTok(t) && t.balance && Number(t.balance) > 0; }); });
    return (needEth ? fetchEthUsd(project.chainId) : Promise.resolve(1)).then(function (ethUsd) {
      var rows = [], total = 0;
      results.forEach(function (cr) {
        cr.tokens.forEach(function (t) {
          var dec = t.decimals == null ? 18 : t.decimals;
          var amt = Number(t.balance || 0) / Math.pow(10, dec);
          var isEth = isEthTok(t);
          var usd = isEth ? (ethUsd ? amt * ethUsd : null) : amt; // non-ETH accounting tokens are USD-pegged (USDC)
          if (usd) total += usd;
          rows.push({ chainId: cr.chainId, name: chainNameOf(cr.chainId), balance: t.balance, decimals: dec, symbol: t.symbol, usd: usd, hasBalance: !!(t.balance && Number(t.balance) > 0) });
        });
      });
      rows.sort(function (a, b) { return (b.usd || 0) - (a.usd || 0); });
      var bd = { rows: rows, totalUsd: total, priced: !needEth || ethUsd != null };
      project._balBreakdown = bd;
      return bd;
    });
  });
}

// A balance shown as a USD total with a hover popup breaking it down per chain. Renders a loading
// placeholder immediately, then fills async. `opts.suffix` appends e.g. ' balance' after the figure.
function mountUsdBalance(project, opts) {
  opts = opts || {};
  var wrap = el('span', 'usd-balance');
  var fig = el('strong', 'usd-balance-fig');
  fig.textContent = '…';
  wrap.appendChild(fig);
  if (opts.suffix) wrap.appendChild(document.createTextNode(opts.suffix));

  fetchBalanceBreakdown(project).then(function (bd) {
    fig.textContent = bd.priced ? formatUsd(bd.totalUsd) : (formatBalance(project.balance, (project.acctToken || {}).decimals, (project.acctToken || {}).symbol || 'ETH'));
    if (!bd.rows.length) return;

    var pop = el('div', 'usd-balance-pop');
    bd.rows.forEach(function (r) {
      var row = el('div', 'usd-balance-pop-row' + (r.hasBalance ? '' : ' usd-balance-pop-row--empty'));
      var name = el('span', 'usd-balance-pop-chain'); name.textContent = r.name;
      var val = el('span', 'usd-balance-pop-amt'); val.textContent = formatBalance(r.balance, r.decimals, r.symbol);
      row.appendChild(name); row.appendChild(val);
      pop.appendChild(row);
    });
    // When every chain holds the same token, total in that token (the breakdown is "actual tokens",
    // so a single-currency project reads cleaner as "3 USDC" than "$3.00"). Mixed tokens → USD.
    var syms = {};
    bd.rows.forEach(function (r) { syms[r.symbol + '@' + r.decimals] = r; });
    var symKeys = Object.keys(syms);
    var totalText;
    if (symKeys.length === 1) {
      var one = syms[symKeys[0]];
      var sumRaw = bd.rows.reduce(function (a, r) { return a + Number(r.balance || 0); }, 0);
      totalText = formatBalance(sumRaw, one.decimals, one.symbol);
    } else {
      totalText = bd.priced ? formatUsd(bd.totalUsd) : '—';
    }
    var totalRow = el('div', 'usd-balance-pop-row usd-balance-pop-total');
    var tName = el('span', 'usd-balance-pop-chain'); tName.textContent = 'All chains';
    var tVal = el('span', 'usd-balance-pop-amt'); tVal.textContent = totalText;
    totalRow.appendChild(tName); totalRow.appendChild(tVal);
    pop.appendChild(totalRow);

    wrap.classList.add('usd-balance--has-pop');
    wrap.appendChild(pop);
  }).catch(function () {
    fig.textContent = formatBalance(project.balance, (project.acctToken || {}).decimals, (project.acctToken || {}).symbol || 'ETH');
  });

  return wrap;
}

function formatTokens(raw) {
  if (raw === null || raw === undefined) return '—';
  // Adaptive significant digits: big numbers drop decimals (and get thousands separators),
  // small numbers keep more — see formatTokenCount.
  return formatTokenCount(raw);
}

// The site's "|" stat separator.
function headSep() { var s = el('span', 'detail-head-sep'); s.textContent = '|'; return s; }

// Append indexed payments + (priced) volume to a header stat line. Bendystraw-derived, so it can trail
// the chain. "raised" is shown only when the USD volume is actually priced (>0) — otherwise it reads as a
// confusing "$0 raised" even though the live balance is non-zero. "contributors" is omitted here (it's the
// Owners/Token-holders count, shown on the card + Owners tab; it double-counts confusingly in the header).
function appendIndexedStats(statLine, stats) {
  if (!stats) return;
  statLine.appendChild(headSep());
  var pStrong = el('strong'); pStrong.textContent = String(stats.paymentsCount);
  statLine.appendChild(pStrong);
  statLine.appendChild(document.createTextNode(stats.paymentsCount === 1 ? ' payment' : ' payments'));
}

function formatCompactTokenAmount(raw) {
  if (raw === null || raw === undefined) return '—';
  var n = Number(formatAmount(raw, 18));
  if (!isFinite(n)) return formatTokens(raw);
  if (n === 0) return '0';
  if (n >= 1000000000) return (n / 1000000000).toFixed(n >= 10000000000 ? 0 : 1).replace(/\.0$/, '') + 'b';
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'm';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return formatTokenCount(raw);
}

function formatOwnerPortion(balance, total) {
  if (!total || total <= 0n || balance == null) return '0%';
  var b = Number(balance);
  var t = Number(total);
  if (!isFinite(b) || !isFinite(t) || t <= 0) return '0%';
  var pct = b / t * 100;
  if (pct >= 10) return pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '%';
  if (pct >= 1) return pct.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%';
  if (pct >= 0.01) return pct.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '%';
  return '<0.01%';
}

// reservedPercent / cashOutTaxRate are out of 10_000 (= 100%).
function percentFromRuleset(value) {
  if (value === null || value === undefined) return '—';
  return (Number(value) / 100).toFixed(Number(value) % 100 === 0 ? 0 : 2) + '%';
}
// The split-limit (as % of issuance) that an edit-splits group's percentages must sum to: the reserved
// group is capped at the ruleset's reserved rate (reservedPercent is out of 10000 → /100 = % of issuance);
// every other group (e.g. payouts) uses the full 100%.
function splitLimitPctFor(project, groupId) {
  if (groupId === RESERVED_TOKEN_SPLIT_GROUP && project.metadata && project.metadata.reservedPercent != null) {
    var rp = Number(project.metadata.reservedPercent);
    if (rp > 0) return rp / 100;
  }
  return 100;
}

function formatDuration(secs) {
  var s = Number(secs);
  if (s === 0) return 'No expiry';
  if (s >= 86400) return (s / 86400).toFixed(s % 86400 === 0 ? 0 : 1) + ' days';
  if (s >= 3600) return (s / 3600).toFixed(1) + ' hours';
  return s + ' seconds';
}

// -- ENS reverse resolution (mainnet only; primary names live on mainnet even for
// testnet projects). Cached per address; resolves "where possible", silent otherwise. --
var _ensCache = {};
function ensNameOf(address) {
  if (!address || address === ZERO_ADDRESS) return Promise.resolve(null);
  var key = address.toLowerCase();
  if (_ensCache[key]) return _ensCache[key];
  var p = (async function () {
    try {
      return await clientFor(1).getEnsName({ address: address });
    } catch (e) {
      return null;
    }
  })();
  _ensCache[key] = p;
  return p;
}

// Forward ENS resolution (name → address), mainnet, cached. Returns null for non-names / no record.
var _ensAddrCache = {};
function ensAddressOf(name) {
  var key = (name || '').trim().toLowerCase();
  if (!key || key.indexOf('.') === -1) return Promise.resolve(null);
  if (_ensAddrCache[key]) return _ensAddrCache[key];
  var p = (async function () {
    try { return await clientFor(1).getEnsAddress({ name: key }); } catch (e) { return null; }
  })();
  _ensAddrCache[key] = p;
  return p;
}

var _operatorCache = {};
function addressOrNull(address) {
  if (!address || String(address).toLowerCase() === ZERO_ADDRESS.toLowerCase()) return null;
  return address;
}

async function bendystrawRevnetOperatorOf(projectId, chainId) {
  // The revnet operator = the permissionHolder flagged `isRevnetOperator`. Bendystraw's V6 reindex sets this
  // flag (the v6-isrevnet-revowner PR), so filter on it directly — no REVOwner-address lookup needed.
  //
  // Bendystraw can return MORE THAN ONE flagged row: when REVOwner.setOperatorOf reassigns the operator, the
  // indexer currently leaves `isRevnetOperator: true` on the prior operator (its `permissions` array is
  // emptied, but the flag is stale). Taking `items[0]` blindly surfaces whichever the indexer returns first —
  // for BAN (project 4 / Sepolia) that's the old Sphinx Safe with an empty permission set, not team.banny.eth.
  // Disambiguate using authoritative per-row data: the live operator is the flagged holder that still HOLDS
  // permissions. The prior operator's row carries `permissions: []`. Once the indexer clears the stale flag
  // this filter collapses to a single row and is a no-op.
  var data = await bendystrawQuery(BENDYSTRAW_PROJECT_OPERATOR_QUERY, {
    chainId: Number(chainId),
    projectId: Number(projectId),
    version: BENDYSTRAW_VERSION,
  });
  var rows = (data && data.permissionHolders && data.permissionHolders.items) || [];
  var live = rows.filter(function (r) { return r && r.permissions && r.permissions.length > 0; });
  var pick = (live.length ? live[0] : rows[0]) || null;
  return addressOrNull(pick && pick.operator);
}

async function revnetOperatorOf(projectId, chainId) {
  var key = chainId + ':' + projectId;
  if (_operatorCache[key]) return _operatorCache[key];
  // Bendystraw only — no deploy-script fallback. If the indexer fails or has nothing, return null
  // (the UI then hides the operator rather than showing fabricated data).
  _operatorCache[key] = bendystrawRevnetOperatorOf(projectId, chainId).catch(function () { return null; });
  return _operatorCache[key];
}

function projectAuthorityLabel(project) {
  return project && project.isRevnet ? 'Operator' : 'Owner';
}

function projectAuthorityAddress(project) {
  return project && project.isRevnet ? project.operator : project.owner;
}

function projectOwnerRecipientLabel(project) {
  return project && project.isRevnet ? 'REVOwner' : 'Project owner';
}

// Render the "Account" cell for a single JBSplit. Precedence matches the JBSplit struct's own routing:
//   projectId > 0          → reserved tokens are minted to that project
//   beneficiary != 0       → tokens go to that address
//   hook != 0              → tokens are forwarded to a split hook (e.g. BannyLPSplitHook for LP'ing)
//   otherwise              → the project owner / REVOwner
// The hook check MUST come before the owner fallback: a hook-routed split has beneficiary == 0 by design,
// so without this the row mislabels the LP split hook as the project owner. Returns a fresh node.
function splitAccountNode(sp, project, chainId) {
  var node = el('span', 'splits-acct-inner');
  if (Number(sp.projectId) > 0) { node.textContent = 'Project #' + sp.projectId; return node; }
  if (sp.beneficiary && sp.beneficiary !== ZERO_ADDRESS) { node.appendChild(addressNode(sp.beneficiary, chainId)); return node; }
  if (sp.hook && sp.hook !== ZERO_ADDRESS) {
    var label = el('span', 'split-hook-label'); label.textContent = 'Split hook'; label.title = 'Reserved tokens are forwarded to a split hook';
    node.appendChild(label);
    node.appendChild(document.createTextNode(' '));
    node.appendChild(addressNode(sp.hook, chainId));
    return node;
  }
  node.textContent = projectOwnerRecipientLabel(project);
  return node;
}


function chainById(chainId) {
  var cid = Number(chainId);
  return CHAINS[cid] ? { id: cid, name: CHAINS[cid].name } : { id: cid, name: 'Chain ' + cid };
}

// A span that shows the truncated address immediately, then upgrades to the ENS name
// (keeping the address as a tooltip) if one resolves.
function addressNode(address, chainId) {
  var span = el('span', 'detail-address');
  if (!address || address === ZERO_ADDRESS) { span.textContent = '—'; return span; }
  var label = el('span', 'detail-address-label'); label.textContent = truncAddr(address); span.appendChild(label);
  // Custom tooltip (shows the full address) so it reveals INSTANTLY on hover — native `title` has a delay.
  var tip = el('span', 'addr-tip'); tip.textContent = address; span.appendChild(tip);
  ensNameOf(address).then(function (name) { if (name) { label.textContent = name; tip.textContent = address; } });
  // Click the truncated address (or ENS) to copy the full address.
  label.style.cursor = 'pointer';
  label.title = 'Click to copy';
  label.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var prevTip = tip.textContent;
    copyText(address).then(function () { tip.textContent = 'Copied!'; setTimeout(function () { tip.textContent = prevTip; }, 1200); }).catch(function () {});
  });
  if (chainId) span.appendChild(safeBadge(address, chainId));
  return span;
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);

  var textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  } finally {
    textarea.remove();
  }
}

function fullAddressNode(address, resolveEns, chainId) {
  var wrap = el('span', 'detail-address-copy');
  var value = el('span', 'detail-full-address');
  value.textContent = address || '—';
  wrap.appendChild(value);
  if (resolveEns && address && address !== ZERO_ADDRESS) {
    value.title = address;
    ensNameOf(address).then(function (n) { if (n) value.textContent = n; }).catch(function () {});
  }

  if (!address || address === ZERO_ADDRESS) return wrap;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'address-copy-btn';
  btn.title = 'Copy address';
  btn.setAttribute('aria-label', 'Copy address');
  btn.appendChild(el('span', 'copy-icon'));
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    copyText(address).then(function () {
      btn.classList.add('copied');
      btn.title = 'Copied';
      setTimeout(function () {
        btn.classList.remove('copied');
        btn.title = 'Copy address';
      }, 1200);
    }).catch(function () {});
  });
  wrap.appendChild(btn);
  if (chainId) wrap.appendChild(safeBadge(address, chainId));
  return wrap;
}

// ── Safe (Gnosis Safe) detection + details ───────────────────────────────────
var SAFE_ABI = [
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
];
// Safe wallet-app chain prefixes (https://app.safe.global) for the "Open in Safe" link. Best-effort.
var SAFE_CHAIN_PREFIX = { 1: 'eth', 10: 'oeth', 8453: 'base', 42161: 'arb1', 11155111: 'sep' };
var SAFE_ICON_SVG = '<svg viewBox="0 0 661.62 661.47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="m531.98 330.7h-49.42c-14.76 0-26.72 11.96-26.72 26.72v71.73c0 14.76-11.96 26.72-26.72 26.72h-196.61c-14.76 0-26.72 11.96-26.72 26.72v49.42c0 14.76 11.96 26.72 26.72 26.72h207.99c14.76 0 26.55-11.96 26.55-26.72v-39.65c0-14.76 11.96-25.23 26.72-25.23h38.2c14.76 0 26.72-11.96 26.72-26.72v-83.3c0-14.76-11.96-26.41-26.72-26.41zm-326.2-98.18c0-14.76 11.96-26.72 26.72-26.72h196.49c14.76 0 26.72-11.96 26.72-26.72v-49.42c0-14.76-11.96-26.72-26.72-26.72h-207.88c-14.76 0-26.72 11.96-26.72 26.72v38.08c0 14.76-11.96 26.72-26.72 26.72h-38.03c-14.76 0-26.72 11.96-26.72 26.72v83.39c0 14.76 12.01 26.12 26.77 26.12h49.42c14.76 0 26.72-11.96 26.72-26.72l-.05-71.44zm101.77 46.23h47.47c15.47 0 28.02 12.56 28.02 28.02v47.47c0 15.47-12.56 28.02-28.02 28.02h-47.47c-15.47 0-28.02-12.56-28.02-28.02v-47.47c0-15.47 12.56-28.02 28.02-28.02z" fill="currentColor"></path></svg>';

var _safeCache = {};
// Return { owners, threshold } if `address` is a Safe on `chainId`, else null. On-chain (works any chain).
function fetchSafeInfo(address, chainId) {
  if (!address || address === ZERO_ADDRESS || !chainId) return Promise.resolve(null);
  var key = chainId + ':' + address.toLowerCase();
  if (_safeCache[key]) return _safeCache[key];
  var p = (async function () {
    try {
      var client = clientFor(chainId);
      var threshold = await client.readContract({ address: address, abi: SAFE_ABI, functionName: 'getThreshold', args: [] });
      var owners = await client.readContract({ address: address, abi: SAFE_ABI, functionName: 'getOwners', args: [] });
      if (owners && owners.length && BigInt(threshold) > 0n) return { owners: owners, threshold: Number(threshold) };
      return null;
    } catch (_) { return null; }
  })();
  _safeCache[key] = p;
  return p;
}
// A slot that fills with a small Safe icon (opening the details modal) once we confirm the address is a Safe.
function safeBadge(address, chainId) {
  var slot = el('span', 'safe-badge-slot');
  fetchSafeInfo(address, chainId).then(function (info) {
    if (!info || !slot.isConnected) return;
    var btn = el('button', 'safe-badge'); btn.type = 'button';
    btn.title = 'Safe | ' + info.threshold + ' of ' + info.owners.length + ' signers — view details';
    btn.innerHTML = SAFE_ICON_SVG;
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openSafeModal(address, chainId, info); });
    slot.appendChild(btn);
  }).catch(function () {});
  return slot;
}
function openSafeModal(address, chainId, info) {
  var content = el('div', 'modal-body safe-modal');
  var policy = el('div', 'safe-policy');
  policy.innerHTML = 'Requires <strong>' + info.threshold + ' of ' + info.owners.length + '</strong> signatures';
  content.appendChild(policy);

  var addrRow = el('div', 'safe-addr'); addrRow.appendChild(fullAddressNode(address, true)); content.appendChild(addrRow);

  var lbl = el('div', 'safe-signers-label'); lbl.textContent = 'Signers'; content.appendChild(lbl);
  var list = el('div', 'safe-signers');
  info.owners.forEach(function (o) { var row = el('div', 'safe-signer'); row.appendChild(addressNode(o, chainId)); list.appendChild(row); });
  content.appendChild(list);

  var prefix = SAFE_CHAIN_PREFIX[chainId];
  if (prefix) {
    var link = document.createElement('a'); link.className = 'safe-applink';
    link.href = 'https://app.safe.global/home?safe=' + prefix + ':' + address;
    link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open in Safe ↗';
    content.appendChild(link);
  }
  openModal('Safe', content);
}

// -- On-chain fetch --

async function fetchMetadata(uri) {
  var url = ipfsToHttp(uri);
  if (!url) return null;
  try {
    var res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function read(chainId, contractName, abi, functionName, args) {
  var address = getAddress(contractName, chainId);
  if (!address) throw new Error('No ' + contractName + ' on chain ' + chainId);
  return clientFor(chainId).readContract({ address: address, abi: abi, functionName: functionName, args: args });
}

// Fetch the full project record from chain (+ IPFS metadata). Never throws — missing
// pieces come back null so a single failed read can't blank the whole card.
async function fetchProject(id, chainId) {
  var pid = BigInt(id);
  var project = {
    id: id,
    chainId: chainId,
    name: null,
    description: null,
    tagline: null,
    logoUri: null,
    infoUri: null,
    tags: [],
    owner: null,
    operator: null,
    tokenAddress: null,
    tokenSymbol: null,
    metaSymbol: null, // off-chain display symbol from projectUri (custom credits-only projects)
    tokenName: null,
    totalSupply: null,
    pendingReserved: null,
    balance: null,
    ruleset: null,
    metadata: null,
    reservedSplits: null,
    isRevnet: false,
    stages: null,
    loanBorrowed: null,
    loanCollateral: null,
    indexedStats: null,
  };

  var jobs = [];

  // Indexed volume / payments / contributors from Bendystraw (cross-chain aggregate when available).
  jobs.push(fetchProjectIndexedStats(id, chainId)
    .then(function (s) { if (s) project.indexedStats = s; }));

  jobs.push(read(chainId, 'JBController', uriOfAbi, 'uriOf', [pid])
    .then(async function (uri) {
      if (!uri) return;
      var meta = await fetchMetadata(uri);
      if (!meta) return;
      project.name = meta.name || null;
      project.description = htmlToText(meta.description);
      project.descriptionHtml = meta.description || null; // raw rich-text (HTML) — rendered with list/paragraph structure
      project.tagline = stripHtml(meta.projectTagline || meta.tagline) || null;
      project.logoUri = meta.logoUri ? ipfsToHttp(meta.logoUri) : null;
      project.infoUri = meta.infoUri || null;
      project.twitter = meta.twitter || null;
      project.discord = meta.discord || null;
      project.telegram = meta.telegram || null;
      project.tags = Array.isArray(meta.tags) ? meta.tags : [];
      // Off-chain display symbol from the project URI (custom projects with no ERC-20 yet). Used only as
      // a fallback — a deployed ERC-20's on-chain symbol wins (resolved after all reads, below).
      project.metaSymbol = (meta.symbol || meta.ticker || '').toString().trim() || null;
      // Operator-defined names for 721 store categories: { "1": "Memberships", … } (category 0 = Default).
      project.storeCategories = (meta.storeCategories && typeof meta.storeCategories === 'object') ? meta.storeCategories : {};
    }).catch(function () {}));

  var revOwnerAddr = getAddress('REVOwner', chainId);
  jobs.push(read(chainId, 'JBProjects', ownerOfAbi, 'ownerOf', [pid])
    .then(function (o) {
      project.owner = o;
      // A revnet's project NFT is held by the REVOwner contract.
      if (o && revOwnerAddr && o.toLowerCase() === revOwnerAddr.toLowerCase()) project.isRevnet = true;
    }).catch(function () {}));

  // Stages = the project's queued rulesets (revnet stage timeline).
  jobs.push(read(chainId, 'JBRulesets', allOfAbi, 'allOf', [pid, 0n, 8n])
    .then(function (rs) { project.stages = rs; }).catch(function () {}));

  // Loan exposure (RevLoans). Reverts for non-loan-source projects — caught.
  jobs.push(read(chainId, 'REVLoans', totalBorrowedAbi, 'totalBorrowedFrom', [pid, NATIVE_TOKEN])
    .then(function (v) { project.loanBorrowed = v; }).catch(function () {}));
  jobs.push(read(chainId, 'REVLoans', totalCollateralAbi, 'totalCollateralOf', [pid])
    .then(function (v) { project.loanCollateral = v; }).catch(function () {}));

  jobs.push(read(chainId, 'JBTokens', tokenOfAbi, 'tokenOf', [pid])
    .then(async function (tokenAddr) {
      if (!tokenAddr || tokenAddr === ZERO_ADDRESS) return;
      project.tokenAddress = tokenAddr;
      var c = clientFor(chainId);
      project.tokenSymbol = await c.readContract({
        address: tokenAddr, abi: erc20SymbolAbi, functionName: 'symbol', args: [],
      }).catch(function () { return null; });
      // The ERC-20 name is the authoritative on-chain project name (set from the deploy config,
      // e.g. "Bananapus (Juicebox V6)") — fresher than the reused IPFS metadata JSON.
      project.tokenName = await c.readContract({
        address: tokenAddr, abi: erc20NameAbi, functionName: 'name', args: [],
      }).catch(function () { return null; });
    }).catch(function () {}));

  jobs.push(read(chainId, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid])
    .then(function (s) { project.totalSupply = s; }).catch(function () {}));

  jobs.push(read(chainId, 'JBController', pendingReservedAbi, 'pendingReservedTokenBalanceOf', [pid])
    .then(function (s) { project.pendingReserved = s; }).catch(function () {}));

  var terminalAddr = getAddress('JBMultiTerminal', chainId);
  if (terminalAddr) {
    jobs.push(resolveAcctToken(chainId, pid).then(function (acct) {
      project.acctToken = acct;
      return read(chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminalAddr, pid, acct.address])
        .then(function (s) { project.balance = s; }).catch(function () {});
    }));
  }

  jobs.push(read(chainId, 'JBController', currentRulesetAbi, 'currentRulesetOf', [pid])
    .then(async function (result) {
      project.ruleset = result[0];
      project.metadata = result[1];
      // A project whose first ruleset hasn't started yet has no current ruleset (start 0). Fall back
      // to the upcoming/queued ruleset so the pay card's issuance and the start countdown are correct.
      if (!project.ruleset || Number(project.ruleset.start || 0) === 0) {
        try {
          var up = await read(chainId, 'JBController', upcomingRulesetAbi, 'upcomingRulesetOf', [pid]);
          if (up && up[0] && Number(up[0].start || 0) > 0) { project.ruleset = up[0]; project.metadata = up[1]; }
        } catch (e) { /* keep current */ }
      }
      // Reserved-token splits are keyed by the ruleset id.
      try {
        var splits = await read(chainId, 'JBSplits', splitsOfAbi, 'splitsOf', [pid, BigInt(project.ruleset.id), RESERVED_TOKEN_SPLIT_GROUP]);
        project.reservedSplits = splits || [];
      } catch (e) { /* leave null */ }
    }).catch(function () {}));

  await Promise.all(jobs);

  if (project.isRevnet) {
    project.operator = await revnetOperatorOf(id, chainId);
  }

  // Symbol priority: deployed ERC-20 symbol (authoritative) → off-chain projectUri symbol (credits-only
  // custom projects). Resolved here, after both the token-of read and the metadata fetch have settled.
  if (!project.tokenSymbol && project.metaSymbol) project.tokenSymbol = project.metaSymbol;
  // Name priority: on-chain ERC-20 name (V6, authoritative) → IPFS metadata name → symbol → id.
  if (project.tokenName) project.name = project.tokenName;
  else if (!project.name) project.name = project.tokenSymbol ? (project.tokenSymbol) : ('Project #' + id);
  return project;
}

// -- State --
var _container = null;
var _gridWrapper = null;
var _cache = {}; // "<chainId>-<projectId>" -> projectData
var _groups = null; // cached buildGroups result
var _activeDetail = null; // { key, showTab, project, isMobile } for the currently open project detail

// Activity-card-vs-tab and the column stacking are decided at build time from the viewport width. If the
// window is resized ACROSS the 600px breakpoint while a detail is open, re-render it so Activity moves
// between the left column (wide) and the first subtab (narrow). Debounced; only fires on an actual cross.
if (typeof window !== 'undefined') {
  var _resizeT = null;
  window.addEventListener('resize', function () {
    if (!_activeDetail || !_activeDetail.project) return;
    if (_resizeT) clearTimeout(_resizeT);
    _resizeT = setTimeout(function () {
      if (!_activeDetail || !_activeDetail.project) return;
      var nowMobile = !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches);
      if (nowMobile === _activeDetail.isMobile) return; // breakpoint not crossed
      showProjectDetail(_activeDetail.project, _activeDetail.current, true, _activeDetail.subtab);
    }, 150);
  });
}

function ensureGroups() {
  if (_groups) return Promise.resolve(_groups);
  return buildGroups().then(function (g) { _groups = g; return g; });
}

export function renderDiscoverTab() {
  _container = document.getElementById('tab-discover');
  if (!_container) return;
  _container.innerHTML = '';
  renderGrid();
}

// Open whatever project route is in the hash (called on load and on back/forward). null → grid.
export function applyDiscoverRoute(route) {
  if (!route) {
    if (_activeDetail) showProjectGrid(true);
    return;
  }
  var m = /^([a-z0-9]+):(\d+)(?:\/([a-z0-9]+))?(?:\/([a-z0-9]+))?$/i.exec(route);
  if (!m) { showProjectGrid(true); return; }
  // Hide the grid immediately (before the async fetch) so it doesn't flash before the detail loads.
  if (_gridWrapper) _gridWrapper.style.display = 'none';
  var chainId = chainForSlug(m[1].toLowerCase());
  var id = Number(m[2]);
  var tab = m[3] ? m[3].toLowerCase() : null;
  var sub = m[4] ? m[4].toLowerCase() : null; // nested subtab (e.g. Tokens → Settlement)
  var key = m[1].toLowerCase() + ':' + id;

  // Same project already open → just switch the tab (no re-fetch / re-render).
  if (_activeDetail && _activeDetail.key === key) {
    if (tab) _activeDetail.showTab(tab);
    if (sub && _activeDetail.showSubTab) _activeDetail.showSubTab(sub);
    return;
  }

  // Show a ghost detail immediately so a direct route load isn't blank during the fetch.
  // showProjectDetail() later removes this `.project-detail` and swaps in the real page.
  if (_container) {
    var stale = _container.querySelector('.project-detail');
    if (stale) stale.remove();
    _container.appendChild(renderDetailSkeleton());
  }

  ensureGroups().then(function (groups) {
    var g = null;
    for (var i = 0; i < groups.length; i++) if (groups[i].id === id) { g = groups[i]; break; }
    if (!g) { showProjectGrid(true); return; }
    var urlChain = (chainId && g.chains.some(function (c) { return c.id === chainId; })) ? chainId : defaultChainId(g.chains);
    var fk = urlChain + '-' + id;
    var p = _cache[fk] ? Promise.resolve(_cache[fk]) : fetchProject(id, urlChain).then(function (d) { _cache[fk] = d; return d; });
    p.then(function (project) {
      project.chains = g.chains;
      project._urlChainId = urlChain;
      showProjectDetail(project, tab, true, sub);
    }).catch(function () { showProjectGrid(true); });
  });
}

function renderGrid() {
  _gridWrapper = el('div', 'discover-grid-wrapper');

  // Top row: subtle network text-toggle on the left; Create button top-right.
  var topRow = el('div', 'discover-top');
  // Network pivot: mainnet ⇄ testnet. Switches the queried chains + the indexer host.
  var netSel = el('select', 'discover-net-select');
  [['mainnet', 'Mainnets'], ['testnet', 'Testnets']].forEach(function (o) {
    var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; netSel.appendChild(opt);
  });
  netSel.value = getNetworkMode();
  netSel.title = 'Switch between mainnet and testnet deployments';
  netSel.addEventListener('change', function () { setNetwork(netSel.value); });
  topRow.appendChild(netSel);
  setTimeout(function () { fitSelectWidth(netSel); }, 0);
  var rightCtrls = el('div', 'discover-top-ctrls');
  var createBtn = el('button', 'tab-create'); createBtn.textContent = 'New project';
  createBtn.title = 'Create — in tuning before launch';
  createBtn.addEventListener('click', function () { openCreateFlow(); });
  rightCtrls.appendChild(createBtn);
  topRow.appendChild(rightCtrls);
  _gridWrapper.appendChild(topRow);

  var grid = el('div', 'discover-grid');
  _gridWrapper.appendChild(grid);
  var gridFoot = discoverPromptFoot('Discover explorer (project grid)'); // [copy build prompt] for the grid
  gridFoot.classList.add('comp-prompt-foot--left');
  _gridWrapper.appendChild(gridFoot);
  _container.appendChild(_gridWrapper);

  var status = el('div', 'discover-card-desc');
  status.textContent = 'Discovering projects across chains…';
  grid.appendChild(status);

  ensureGroups().then(function (groups) {
    grid.innerHTML = '';
    if (!groups.length) { grid.textContent = 'No projects found.'; return; }
    groups.forEach(function (g) {
      var card = renderSkeletonCard(g.id);
      grid.appendChild(card);
      loadGroupCard(g, card, grid);
    });
  }).catch(function () {
    grid.innerHTML = '';
    var e = el('div', 'discover-card-desc');
    e.textContent = 'Could not read projects from chain.';
    grid.appendChild(e);
  });
}

function hasDirectoryController(chainId, id) {
  return read(chainId, 'JBDirectory', controllerOfAbi, 'controllerOf', [BigInt(id)])
    .then(function (controller) {
      return !!(controller && controller !== ZERO_ADDRESS);
    })
    .catch(function () { return false; });
}

// Enumerate projects across every chain and dedup omnichain copies. JBProjects.count is only the upper
// bound: a project NFT can exist on a chain before the project has any JBDirectory state there. Treat a
// chain as live for a project only once JBDirectory.controllerOf(projectId) is set.
function buildGroups() {
  return Promise.all(DISCOVER_CHAINS.map(function (c) {
    return read(c.id, 'JBProjects', countAbi, 'count', [])
      .then(function (n) { return { chain: c, count: Number(n) }; })
      .catch(function () { return { chain: c, count: 0 }; });
  })).then(async function (counts) {
    var max = 0;
    counts.forEach(function (x) { if (x.count > max) max = x.count; });
    var groups = await Promise.all(Array.from({ length: max }, async function (_, i) {
      var id = i + 1;
      var candidates = counts.filter(function (x) { return id <= x.count; });
      var live = await Promise.all(candidates.map(function (x) {
        return hasDirectoryController(x.chain.id, id).then(function (ok) {
          return ok ? x.chain : null;
        });
      }));
      var chains = live.filter(Boolean);
      return chains.length ? { id: id, chains: chains, primary: chains[0] } : null;
    }));
    groups = groups.filter(Boolean);
    return groups;
  });
}

function loadGroupCard(g, skeleton, grid) {
  var key = g.primary.id + '-' + g.id;
  var promise = _cache[key] ? Promise.resolve(_cache[key]) : fetchProject(g.id, g.primary.id).then(function (data) {
    _cache[key] = data;
    return data;
  });
  promise.then(function (project) {
    project.chains = g.chains;
    if (skeleton.parentNode !== grid) return;
    grid.replaceChild(renderProjectCard(project), skeleton);
  }).catch(function () {
    if (skeleton.parentNode === grid) {
      skeleton.classList.remove('discover-card--loading');
      skeleton.innerHTML = '';
      var err = el('div', 'discover-card-desc'); err.textContent = 'Could not load this project from chain.';
      skeleton.appendChild(err);
    }
  });
}

function renderSkeletonCard() {
  // Shimmer ghost in the same shape as a real card (logo + name, two meta lines, a description line).
  var card = el('div', 'discover-card discover-card--loading');
  var head = el('div', 'discover-card-header');
  head.appendChild(skel('28px', '28px'));
  head.appendChild(skel('46%', '15px'));
  card.appendChild(head);
  var m1 = skel('62%', '11px'); m1.style.marginTop = '12px'; card.appendChild(m1);
  var m2 = skel('40%', '11px'); m2.style.marginTop = '8px'; card.appendChild(m2);
  var d = skel('85%', '11px'); d.style.marginTop = '14px'; card.appendChild(d);
  return card;
}

function renderProjectCard(project) {
  var card = el('div', 'discover-card');
  card.style.cursor = 'pointer';
  card.addEventListener('click', function () { showProjectDetail(project); });

  var cardLbl = function (text) { var s = el('span', 'discover-card-lbl'); s.textContent = text; return s; };

  // Line 1: logo + name + #id.
  var head = el('div', 'discover-card-header');
  head.appendChild(renderLogo(project, 'discover-card-logo'));
  var name = el('span', 'discover-card-name');
  name.textContent = project.name;
  head.appendChild(name);
  card.appendChild(head);

  // Line 2: Type | On (chain logos). Each label+value is a nowrap pair joined by a breakable space;
  // the "|" is drawn by CSS ::after inside the pair so it trails the previous line on a wrap.
  var meta1 = el('div', 'discover-card-meta');
  var flavorPair = el('span', 'discover-card-pair');
  flavorPair.appendChild(cardLbl('Flavor: '));
  var typeVal = el('span', 'discover-card-val'); typeVal.textContent = project.isRevnet ? 'REVNET' : 'CUSTOM';
  flavorPair.appendChild(typeVal);
  meta1.appendChild(flavorPair);
  if (project.chains && project.chains.length) {
    meta1.appendChild(document.createTextNode(' '));
    var onPair = el('span', 'discover-card-pair');
    onPair.appendChild(cardLbl('On: '));
    var cardLogos = el('span', 'discover-chain-logos');
    project.chains.forEach(function (c) { cardLogos.appendChild(projectChainLogo(project, c)); });
    onPair.appendChild(cardLogos);
    meta1.appendChild(onPair);
  }
  card.appendChild(meta1);

  // Line 3: owner/operator authority.
  var meta2 = el('div', 'discover-card-meta discover-card-on');
  meta2.appendChild(cardLbl(projectAuthorityLabel(project) + ': '));
  meta2.appendChild(addressNode(projectAuthorityAddress(project)));
  card.appendChild(meta2);

  var desc = el('div', 'discover-card-desc');
  desc.textContent = project.tagline || project.description || 'No description set onchain.';
  card.appendChild(desc);

  var stats = el('div', 'discover-card-stats');
  stats.appendChild(statItem('Balance', mountUsdBalance(project)));
  if (project.indexedStats) {
    stats.appendChild(statItem('Volume', formatUsd(usdFromScaled(project.indexedStats.volumeUsd))));
    stats.appendChild(statItem('Payments', String(project.indexedStats.paymentsCount)));
    // Token-holder count — revnets call them "Owners", custom projects "Token holders".
    // contributorsCount only counts addresses that paid; holders who received tokens via
    // auto-issuance / reserved mint (ART has one) are missed. Seed with it, then correct to
    // the real current-holder count (same aggregation the detail header uses).
    var ownersVal = el('span', ''); ownersVal.textContent = String(project.indexedStats.contributorsCount);
    stats.appendChild(statItem(project.isRevnet ? 'Owners' : 'Token holders', ownersVal));
    fetchOwnersCount(project).then(function (n) {
      if (n != null && ownersVal.isConnected) ownersVal.textContent = String(n);
    }).catch(function () {});
  }
  card.appendChild(stats);

  return card;
}

function renderLogo(project, className) {
  if (project.logoUri) {
    var img = document.createElement('img');
    img.className = className + ' discover-logo-img';
    img.src = project.logoUri;
    img.alt = project.name;
    img.loading = 'lazy';
    img.addEventListener('error', function () {
      var fallback = renderLetterLogo(project, className);
      if (img.parentNode) img.parentNode.replaceChild(fallback, img);
    });
    return img;
  }
  return renderLetterLogo(project, className);
}

function renderLetterLogo(project, className) {
  var logo = el('div', className);
  logo.textContent = (project.name || '#').charAt(0).toUpperCase();
  logo.style.background = logoColor(project.id);
  return logo;
}

function statItem(label, value) {
  var item = el('div', 'discover-stat');
  var lbl = el('div', 'discover-stat-label');
  lbl.textContent = label;
  item.appendChild(lbl);
  var val = el('div', 'discover-stat-value');
  if (value && value.nodeType) val.appendChild(value); else val.textContent = value;
  item.appendChild(val);
  return item;
}

// -- Navigation --

// URL-safe slug for a detail tab name (e.g. "Rulesets & Funds" → "rulesetsfunds").
function tabSlug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function projectHash(project, tabName, subTab) {
  var h = '#' + slugForChain(project._urlChainId) + ':' + project.id;
  if (tabName) { h += '/' + tabSlug(tabName); if (subTab) h += '/' + tabSlug(subTab); }
  return h;
}

function showProjectDetail(project, initialTab, fromRoute, initialSubTab) {
  if (project._urlChainId == null) {
    project._urlChainId = defaultChainId(project.chains || [{ id: project.chainId }]);
  }
  _gridWrapper.style.display = 'none';
  var existing = _container.querySelector('.project-detail');
  if (existing) existing.remove();
  _container.appendChild(renderProjectDetail(project, initialTab, initialSubTab));
  if (!fromRoute) routerSetHash(projectHash(project, _activeDetail && _activeDetail.current, _activeDetail && _activeDetail.subtab));
}

function showProjectGrid(fromRoute) {
  var detail = _container.querySelector('.project-detail');
  if (detail) detail.remove();
  _activeDetail = null;
  _gridWrapper.style.display = '';
  if (!fromRoute) routerSetHash('#discover');
}

// -- Detail Page --

function renderProjectDetail(project, initialTab, initialSubTab) {
  // `detail-spacious`: juicy-vision-style low-border layout — drop the boxed cards in favor of whitespace,
  // a single column divider, and thin section separators.
  var wrap = el('div', 'project-detail detail-spacious');
  var nftCart = makeNftCart(); // shared between the Pay-card strip and the Shop tab

  var back = document.createElement('button');
  back.className = 'detail-back';
  back.textContent = '←';
  back.title = 'Back to projects';
  back.addEventListener('click', function () { showProjectGrid(false); });
  wrap.appendChild(back);

  var headerEl = renderDetailHeader(project);
  wrap.appendChild(headerEl);

  // Auto-refresh balance/supply (+ owners via the rebuilt header) and the activity feed when a tx
  // confirms in this view — a bubbling 'jb:project-updated' event is dispatched by the
  // pay/cash-out/distribute flows. `activityCardEl` is assigned just below, before any tx can fire.
  var activityCardEl = null;
  wrap.addEventListener('jb:project-updated', function () {
    var pid = BigInt(project.id);
    var terminal = getAddress('JBMultiTerminal', project.chainId);
    var acctAddr = (project.acctToken && project.acctToken.address) || NATIVE_TOKEN;
    Promise.all([
      terminal ? read(project.chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, pid, acctAddr]).catch(function () { return null; }) : Promise.resolve(null),
      read(project.chainId, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return null; }),
    ]).then(function (res) {
      if (res[0] != null) project.balance = res[0];
      if (res[1] != null) project.totalSupply = res[1];
      var fresh = renderDetailHeader(project);
      if (headerEl.parentNode) { headerEl.parentNode.replaceChild(fresh, headerEl); headerEl = fresh; }
    });
    if (activityCardEl && activityCardEl._refresh) activityCardEl._refresh();
  });

  var columns = el('div', 'project-detail-columns');

  var leftCol = el('div', 'project-detail-left');
  leftCol.appendChild(renderPayCard(project, nftCart));
  // On phones, Activity becomes the first detail subtab (added below, and default) instead of a tall
  // always-on card wedged between Pay and the tabs; on wider screens it stays in the left column.
  var activityAsTab = !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches);
  activityCardEl = renderActivityCard(project, { asTab: activityAsTab });
  if (!activityAsTab) leftCol.appendChild(activityCardEl);
  columns.appendChild(leftCol);

  var rightCol = el('div', 'project-detail-right');
  // Sections build lazily on first view so the cross-chain "Ops" fan-out only fires when opened.
  // The price chart (revnets' issuance-price ladder) lives at the top of the About tab.
  var builders = {
    Overview: function () {
      var wrap = el('div');
      if (project.isRevnet && project.stages && project.stages.length) wrap.appendChild(renderPriceChart(project, project.stages));
      wrap.appendChild(renderAboutSection(project));
      return wrap;
    },
    Owners: function () { return renderOwnersSection(project, { tabName: 'Owners', initialSubTab: initialSubTab }); },
    Ops: function () { return renderOpsSection(project); },
  };
  // The Safe/queue tab: signers approve + execute queued owner-only txs. Labeled "Operator" for revnets
  // (the controlling account is the operator) and "Owner" for custom projects. Shown only when that
  // account is actually a Safe (the tab button is hidden async otherwise).
  var ownerTabName = project.isRevnet ? 'Operator' : 'Owner';
  builders[ownerTabName] = function () { return renderBackOfficeSection(project); };
  var tabs;
  if (project.isRevnet) {
    // Revnets express rules through stages (Terms) and holders through Owners (splits + auto-issuance).
    builders.Terms = function () { return renderStagesSection(project); };
    // Revnets carry the wallet actions in the Owners → "You" card, so no separate Ops tab.
    // The Operator tab goes after Shop (added below).
    tabs = ['Overview', 'Terms', 'Owners'];
  } else {
    // Custom projects get the same subtabbed holders view as revnets, minus the revnet-only concepts
    // (Auto Issuance, Loans). The cross-chain composition that used to live in "Ops" now sits under
    // Settlement, so there's no separate Ops tab. Rulesets and Funds are their own tabs.
    builders.Rulesets = function () { return renderRulesetsFundsSection(project); };
    builders.Funds = function () { return renderFundsSection(project); };
    builders.Tokens = function () {
      return renderOwnersSection(project, {
        subtabs: ['Accounts', 'Market', 'Settlement', 'Reserved'],
        noLoans: true,
        tabName: 'Tokens',
        initialSubTab: initialSubTab,
      });
    };
    tabs = ['Overview', 'Rulesets', 'Funds', 'Tokens', 'Owner'];
  }
  // Shop tab: shown optimistically (assume the project can sell items) so a #shop route resolves and the
  // tab doesn't pop in late. Once the 721-hook read resolves it's either filled with real content or removed
  // (no hook yet — a custom project can add one via Rulesets → Queue → "Sell NFT items").
  var shopState = { shop: null, loaded: false };
  builders.Shop = function () {
    if (shopState.loaded && shopState.shop) return renderShopSection(project, shopState.shop, nftCart);
    var wrap = el('div', 'detail-section'); var card = el('div', 'detail-card shop-card');
    var t = el('div', 'detail-card-title'); t.textContent = 'Shop'; card.appendChild(t);
    var b = el('div', 'shop-body'); b.textContent = 'Loading…'; card.appendChild(b);
    wrap.appendChild(card); return wrap;
  };
  tabs.push('Shop');
  if (project.isRevnet) tabs.push(ownerTabName); // Operator sits to the right of Shop
  // Phones: Activity is the first subtab and the default (the left-column card is omitted above).
  if (activityAsTab) { builders.Activity = function () { return activityCardEl; }; tabs.unshift('Activity'); }
  var tabRow = el('div', 'project-detail-tabs');
  var contentArea = el('div', 'project-detail-content');
  attachCardPromptLinks(wrap); // every card across the whole detail (tabs + activity + side cards) gets a link
  var built = {};
  // Resolve the initial tab (from a deep link) case-insensitively; fall back to the first tab.
  var startTab = tabs[0];
  if (initialTab) {
    for (var k = 0; k < tabs.length; k++) if (tabSlug(tabs[k]) === tabSlug(initialTab)) { startTab = tabs[k]; break; }
  }
  var detailKey = slugForChain(project._urlChainId) + ':' + project.id;
  function showTab(tabName) {
    // Accept slugified route names too (e.g. "rulesetsfunds").
    for (var t = 0; t < tabs.length; t++) if (tabSlug(tabs[t]) === tabSlug(tabName)) { tabName = tabs[t]; break; }
    if (!builders[tabName]) return;
    // Set `current` BEFORE building so a subtabbed section's show() (which fires during build) reads the
    // right top tab. Reset subtab state on every tab switch; the section re-registers it if it has subtabs.
    if (_activeDetail) { _activeDetail.current = tabName; _activeDetail.subtab = null; _activeDetail.showSubTab = null; }
    if (!built[tabName]) built[tabName] = builders[tabName]();
    contentArea.innerHTML = '';
    contentArea.appendChild(built[tabName]);
    var btns = tabRow.querySelectorAll('.detail-tab-btn');
    for (var b = 0; b < btns.length; b++) btns[b].classList.toggle('active', btns[b].textContent === tabName);
  }
  for (var i = 0; i < tabs.length; i++) {
    (function (tabName) {
      var btn = document.createElement('button');
      btn.className = 'detail-tab-btn';
      btn.textContent = tabName;
      btn.addEventListener('click', function () {
        showTab(tabName);
        // A subtabbed section sets _activeDetail.subtab during build; include it so refresh restores both.
        routerSetHash(projectHash(project, tabName, _activeDetail && _activeDetail.subtab));
      });
      tabRow.appendChild(btn);
    })(tabs[i]);
  }
  // Resolve the 721 hook: fill the optimistic Shop tab with real content, or remove it if the project
  // has no hook and can't get one (revnets always keep it — operators can add tiers even before any exist).
  fetchProjectTiers(project).then(function (shop) {
    if (!wrap.isConnected) return;
    // Show the Shop whenever a 721 hook is attached (fetchProjectTiers only returns non-null when STORE()
    // confirms a real 721 hook) — even with 0 tiers, so an operator can add items to an empty shop.
    var show = !!shop;
    if (show) {
      shopState.shop = shop; shopState.loaded = true;
      built.Shop = null; // drop the loading placeholder so the real section rebuilds
      if (_activeDetail && _activeDetail.current === 'Shop') showTab('Shop');
    } else {
      tabs = tabs.filter(function (t) { return t !== 'Shop'; });
      delete builders.Shop; delete built.Shop;
      var btns = tabRow.querySelectorAll('.detail-tab-btn');
      for (var b = 0; b < btns.length; b++) if (btns[b].textContent === 'Shop') { btns[b].remove(); break; }
      if (_activeDetail && _activeDetail.current === 'Shop') showTab(tabs[0]);
    }
  }).catch(function () {});

  // Drop the Owner/Operator tab unless the project's controlling account is actually a Safe.
  fetchSafeInfo(projectAuthorityAddress(project), project.chainId).then(function (info) {
    if (info || !tabRow.isConnected) return; // it IS a Safe → keep the tab
    tabs = tabs.filter(function (t) { return t !== ownerTabName; });
    delete builders[ownerTabName]; delete built[ownerTabName];
    var bb = tabRow.querySelectorAll('.detail-tab-btn');
    for (var b = 0; b < bb.length; b++) if (bb[b].textContent === ownerTabName) { bb[b].remove(); break; }
    if (_activeDetail && _activeDetail.current === ownerTabName) showTab(tabs[0]);
  }).catch(function () {});

  rightCol.appendChild(tabRow);
  _activeDetail = { key: detailKey, showTab: showTab, current: startTab, project: project, isMobile: activityAsTab };
  showTab(startTab);
  rightCol.appendChild(contentArea);
  columns.appendChild(rightCol);

  wrap.appendChild(columns);
  return wrap;
}

// Display label for a pay currency — drop the "(native)" suffix so ETH reads as just "ETH".
function currencyLabel(symbol) {
  return (symbol || '').replace(/\s*\(native\)\s*/i, '') || symbol || '';
}

// Size an inline (appearance:none) select to its CURRENTLY selected option's text, so the caret hugs
// the name regardless of which option is chosen (a native select otherwise sizes to its widest option).
// fontPx must match the select's CSS font-size (chain 11, currency 13). We measure with an explicit
// font rather than getComputedStyle so it's correct even before the element is attached to the DOM
// (computed style returns defaults for a detached node, which made the caret tight on first render).
function sizeSelectToText(sel, fontPx) {
  var opt = sel.options[sel.selectedIndex];
  if (!opt) return;
  if (!sizeSelectToText.ctx) sizeSelectToText.ctx = document.createElement('canvas').getContext('2d');
  sizeSelectToText.ctx.font = 'bold ' + (fontPx || 11) + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  var w = sizeSelectToText.ctx.measureText(opt.textContent).width;
  sel.style.width = Math.ceil(w + 18) + 'px'; // text + caret gap (border-box: includes padding-right)
}

// Inline pay card (revnet.app-style) for the project detail page. The project is already known, so it
// only needs a chain (when omnichain), a currency, and an amount. Live feedback — tokens received,
// reserved/splits, and the Issuance-vs-AMM routing tag — comes from the shared computePayPreview.
function renderPayCard(project, cart) {
  var sym = project.tokenSymbol ? project.tokenSymbol : 'tokens';
  cart = cart || makeNftCart();
  var chains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('Chain ' + project.chainId) }];

  // Pay currencies for a chain. The DIRECT tokens are whatever the project's terminal actually accepts
  // (its accounting contexts) — for an ETH-based project that's native ETH; for a USD-based project (e.g.
  // ART) that's USDC. Tokens the project does NOT accept directly (native ETH and/or USDC) are offered as
  // swap-via-router currencies. The accepted set needs an on-chain read, so we start from a sensible sync
  // default and refine once `loadAcceptedTokens` resolves.
  var _tokenCache = {}; // chainId -> resolved token list

  function defaultTokensForChain(chainId) {
    var base = getChainTokens(chainId).map(function (t) {
      return { address: t.address, symbol: t.symbol, decimals: t.decimals, viaRouter: false };
    });
    var usdc = USDC_BY_CHAIN[chainId];
    if (project.isRevnet && usdc && !base.some(function (t) { return t.address.toLowerCase() === usdc.toLowerCase(); })) {
      base.push({ address: usdc, symbol: 'USDC', decimals: 6, viaRouter: true });
    }
    return base;
  }
  function tokensForChain(chainId) { return _tokenCache[chainId] || defaultTokensForChain(chainId); }

  // Read the project's accounting contexts and rebuild the currency list: accepted tokens are direct,
  // native ETH + USDC that aren't accepted directly are added as swap-via-router options.
  function loadAcceptedTokens(chainId) {
    var term = getAddress('JBMultiTerminal', chainId);
    if (!term) return;
    clientFor(chainId).readContract({ address: term, abi: TERMINAL_CONTEXTS_ABI, functionName: 'accountingContextsOf', args: [BigInt(project.id)] })
      .then(function (ctxs) {
        if (!ctxs || !ctxs.length) return; // no contexts recorded — keep the sync default
        var chainTokens = getChainTokens(chainId);
        var usdc = USDC_BY_CHAIN[chainId];
        var symbolFor = function (addr) {
          var t = chainTokens.filter(function (x) { return x.address.toLowerCase() === addr.toLowerCase(); })[0];
          if (t) return t.symbol;
          if (usdc && addr.toLowerCase() === usdc.toLowerCase()) return 'USDC';
          return truncAddr(addr);
        };
        var list = ctxs.map(function (ctx) {
          return { address: ctx.token, symbol: symbolFor(ctx.token), decimals: Number(ctx.decimals), viaRouter: false };
        });
        var has = function (a) { return list.some(function (t) { return t.address.toLowerCase() === a.toLowerCase(); }); };
        // Swap-via-router convenience currencies the project doesn't take directly.
        if (!has(NATIVE_TOKEN)) list.push({ address: NATIVE_TOKEN, symbol: chainTokens[0].symbol, decimals: 18, viaRouter: true });
        if (usdc && !has(usdc)) list.push({ address: usdc, symbol: 'USDC', decimals: 6, viaRouter: true });
        _tokenCache[chainId] = list;
        if (state.chainId !== chainId) return;
        state.tokens = list;
        var keep = list.filter(function (t) { return state.token && t.address.toLowerCase() === state.token.address.toLowerCase() && t.viaRouter === state.token.viaRouter; })[0];
        state.token = keep || list[0] || null;
        rebuildCurrency();
        schedulePreview();
      }).catch(function () {});
  }

  var state = {
    chainId: chains[0].id,
    tokens: tokensForChain(chains[0].id),
    token: null,
    amount: '',
    memo: '',
    phase: 'idle',
    preview: null,
    directSwap: null, // { pool, out } when a direct AMM swap beats paying (no split-tax)
    slippageBps: 100, // AMM-route max slippage (default 1%)
    shop: null,       // { hook, tiers, ... } once the strip loads
    mode: 'pay',      // 'pay' (mint tokens) | 'addbalance' (top up balance, mint nothing)
    conversion: null, // { sym, units } router-swap landed amount for add-to-balance
  };
  state.token = state.tokens[0] || null;
  loadAcceptedTokens(state.chainId); // refine direct-vs-router from the project's accounting contexts

  var previewTimer = null;
  var previewGen = 0;

  function nativeToken() { return state.tokens.filter(function (t) { return t.address.toLowerCase() === NATIVE_TOKEN.toLowerCase(); })[0]; }
  // The project's directly-accepted token (the swap target a router top-up lands in).
  function acceptedToken() { return state.tokens.filter(function (t) { return !t.viaRouter; })[0]; }
  function acceptedTokenSym() { var t = acceptedToken(); return t ? (t.symbol || '').replace(/\s*\(native\)/i, '') : ''; }
  function formatSwapUnits(n) {
    if (!isFinite(n) || n <= 0) return '0';
    if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 0.0001) return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return n.toPrecision(2);
  }
  // Per-(chain, accepted-token) issuance rate: project tokens minted per 1 whole accepted-token unit.
  // Cached because it's constant on the issuance route; used to back the router swap output out of a pay
  // preview (swap output is identical whether the follow-on op is pay or addToBalance).
  var _rateCache = {};
  function loadAcceptedRate(chainId, acc) {
    var key = chainId + ':' + acc.address.toLowerCase();
    if (_rateCache[key]) return Promise.resolve(_rateCache[key]);
    var unit = 10n ** BigInt(acc.decimals || 18);
    return computePayPreview({ chainId: chainId, projectId: project.id, token: acc.address, amount: unit, beneficiary: getAccount() || undefined })
      .then(function (r) {
        if (r && !r.unavailable && r.received != null) {
          var per = (r.received || 0n) + (r.reserved || 0n);
          // Both legs (router input + this reference) pass through the same issuance/buyback curve, so the
          // ratio recovers the landed accepted-token amount on either route — keep the route to compare.
          if (per > 0n) { _rateCache[key] = { per: per, unit: unit, decimals: acc.decimals || 18, routing: r.routing }; return _rateCache[key]; }
        }
        return null;
      }).catch(function () { return null; });
  }
  function nftTierById(id) { return state.shop ? state.shop.tiers.filter(function (t) { return t.id === id; })[0] : null; }
  function nftTotalWei() {
    var s = 0n, sel = cart.entries();
    // Charge the DISCOUNTED price the store actually applies at mint, not the raw tier price.
    Object.keys(sel).forEach(function (id) { var t = nftTierById(Number(id)); if (t) s += tierEffectivePrice(t.price, t.discountPercent) * BigInt(sel[id]); });
    return s;
  }
  function selectedTierIds() {
    var a = [], sel = cart.entries();
    Object.keys(sel).forEach(function (id) { for (var i = 0; i < sel[id]; i++) a.push(Number(id)); });
    return a;
  }
  function nftSelectionList() {
    var sel = cart.entries();
    return Object.keys(sel).map(function (id) { return { id: Number(id), qty: sel[id], name: cart.name(id) || ('Tier ' + id) }; });
  }
  // Selecting NFTs drives the pay flow: tier prices are ETH-denominated, so force native ETH and set the
  // amount to the NFT total (the floor the holder must pay; they can still type more to overpay → tokens).
  function onNftChange() {
    var total = nftTotalWei();
    if (total > 0n) {
      var nat = nativeToken();
      if (nat && state.token !== nat) { state.token = nat; rebuildCurrency(); }
      amtInput.value = formatAmount(total, 18);
      state.amount = amtInput.value.trim();
    }
    schedulePreview();
  }

  var card = el('div', 'detail-card paybox');

  // Absolute start of the project's first ruleset. When in the future, the Pay button idles
  // behind a live countdown (paying before start reverts in the terminal).
  var startsAt = Number((project.ruleset && project.ruleset.start) || 0);

  // Open the Shop tab (and scroll it into view). Used by the strip's "All →" link.
  function openShopTab() {
    if (!_activeDetail || !_activeDetail.showTab) return;
    _activeDetail.showTab('Shop');
    routerSetHash(projectHash(project, 'Shop'));
    requestAnimationFrame(function () {
      var sec = document.querySelector('.project-detail-content');
      if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  // Clicking a strip item switches to the Shop tab (without scrolling — the user stays where they are).
  function focusShopTier(id) {
    if (!_activeDetail || !_activeDetail.showTab) return;
    _activeDetail.showTab('Shop');
    routerSetHash(projectHash(project, 'Shop'));
  }

  // Mini-shop first: if the project has 721 tiers, surface a compact selectable strip atop the Pay card.
  // Both the strip and the Shop tab share `cart`; keep the pay amount/feedback in sync with either.
  cart.subscribe(function () { onNftChange(); });
  cart.onName(function () { renderFeedback(); });
  card.appendChild(renderPayShopStrip(project, cart, {
    onShop: function (shop) { state.shop = shop; },
    focusInShop: focusShopTier,
    onViewAll: openShopTab,
  }));

  // Row 1: "[Pay ▾] on <chain>" — the leading word is the action toggle (Pay / Add to balance).
  var topRow = el('div', 'paybox-top');
  var payOn = el('div', 'paybox-payon');
  // Action picker as the sentence's first word.
  var modeSel = el('select', 'paybox-select paybox-mode');
  [['pay', 'Pay'], ['addbalance', 'Add to balance']].forEach(function (m) {
    var o = document.createElement('option'); o.value = m[0]; o.textContent = m[1]; modeSel.appendChild(o);
  });
  modeSel.value = state.mode;
  modeSel.addEventListener('change', function () {
    state.mode = modeSel.value;
    sizeSelectToText(modeSel);
    updateModeUi();
    schedulePreview();
  });
  payOn.appendChild(modeSel);
  var payOnLabel = el('span', 'paybox-payon-label');
  payOnLabel.textContent = 'on';
  payOn.appendChild(payOnLabel);
  payOn.appendChild(document.createTextNode(' ')); // real space so it reads as a sentence
  if (chains.length > 1) {
    var chainSel = el('select', 'paybox-select');
    chains.forEach(function (c) {
      var o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = c.name;
      chainSel.appendChild(o);
    });
    chainSel.addEventListener('change', function () {
      state.chainId = Number(chainSel.value);
      state.tokens = tokensForChain(state.chainId);
      state.token = state.tokens[0] || null;
      sizeSelectToText(chainSel);
      rebuildCurrency();
      schedulePreview();
      loadAcceptedTokens(state.chainId); // refine for the newly-selected chain
    });
    payOn.appendChild(chainSel);
    sizeSelectToText(chainSel);
  } else {
    var chainStatic = el('span', 'paybox-chain-static');
    chainStatic.textContent = chains[0].name;
    payOn.appendChild(chainStatic);
  }
  topRow.appendChild(payOn);
  card.appendChild(topRow);
  sizeSelectToText(modeSel);

  // Currency control lives inline inside the amount field (appended to the amount row below).
  var currWrap = el('div', 'paybox-curr-wrap');

  function rebuildCurrency() {
    currWrap.innerHTML = '';
    if (state.tokens.length > 1) {
      var sel = el('select', 'paybox-select');
      state.tokens.forEach(function (t) {
        var o = document.createElement('option');
        o.value = t.address;
        o.textContent = currencyLabel(t.symbol);
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        for (var i = 0; i < state.tokens.length; i++) {
          if (state.tokens[i].address === sel.value) { state.token = state.tokens[i]; break; }
        }
        sizeSelectToText(sel, 13);
        schedulePreview();
      });
      currWrap.appendChild(sel);
      sizeSelectToText(sel, 13);
    } else {
      var s = el('span', 'paybox-curr-static');
      s.textContent = state.token ? currencyLabel(state.token.symbol) : 'ETH';
      currWrap.appendChild(s);
    }
  }
  rebuildCurrency();

  // Row 2: [ amount  currency ▾ ] [ Pay ] — amount auto-sizes so the currency hugs the number.
  var amountRow = el('div', 'paybox-amount-row');
  var field = el('div', 'paybox-field');
  var amtInput = el('input', 'paybox-amount');
  amtInput.type = 'number';
  amtInput.placeholder = '0.00';
  amtInput.addEventListener('input', function () { state.amount = amtInput.value.trim(); schedulePreview(); });
  field.appendChild(amtInput);
  field.appendChild(currWrap); // currency dropdown, stuck to the right of the field, left of Pay
  amountRow.appendChild(field);
  var payBtn = el('button', 'paybox-btn');
  payBtn.textContent = 'Pay';
  payBtn.addEventListener('click', doPay);
  amountRow.appendChild(payBtn);
  card.appendChild(amountRow);

  // Reflect the selected action across the button label (Pay → Add) and feedback. NFTs only mint on a Pay.
  function updateModeUi() {
    if (startsAt > Math.floor(Date.now() / 1000)) { payBtn.textContent = 'Not started'; renderFeedback(); return; }
    payBtn.textContent = state.mode === 'addbalance' ? 'Add' : 'Pay';
    renderFeedback();
  }

  // Memo — subtle, optional, directly under the amount/Pay row.
  var memo = el('input', 'paybox-memo');
  memo.type = 'text';
  memo.placeholder = 'Add a note (optional)';
  memo.addEventListener('input', function () { state.memo = memo.value; });
  card.appendChild(memo);

  // Feedback block — "You get" / routing tag / AMM subtext / "Splits get".
  var feedback = el('div', 'paybox-feedback');
  card.appendChild(feedback);

  var status = el('div', 'paybox-status');
  card.appendChild(status);

  // The selected NFTs, listed under "You get" with a small preview thumbnail (juicy-vision "+ Original").
  function nftBlock() {
    var sel = nftSelectionList();
    if (!sel.length) return null;
    var box = el('div', 'paybox-nft-list');
    sel.forEach(function (s) {
      var row = el('div', 'paybox-nft-row');
      var plus = el('span', 'paybox-nft-plus'); plus.textContent = '+'; row.appendChild(plus);
      var thumb = el('span', 'paybox-nft-thumb');
      var url = cart.image(s.id);
      if (url) { var im = document.createElement('img'); im.loading = 'lazy'; im.src = url; im.alt = s.name; thumb.appendChild(im); }
      row.appendChild(thumb);
      var label = el('span', 'paybox-nft-label'); label.textContent = s.name + (s.qty > 1 ? ' ×' + s.qty : ''); row.appendChild(label);
      box.appendChild(row);
    });
    return box;
  }

  function renderFeedback() {
    feedback.innerHTML = '';
    var p = state.preview;
    var isAmm = !!(p && p.routing === 'amm');

    // Add-to-balance mints nothing — funds land in the project balance. "You get" is always 0; for a
    // swap-via-router top-up, show how much of the project's accepted token lands on-chain after the swap.
    if (state.mode === 'addbalance') {
      var aline = el('div', 'paybox-yg-zero'); aline.textContent = 'You get 0 ' + sym; feedback.appendChild(aline);
      if (state.token && state.token.viaRouter) {
        var conv = el('div', 'paybox-conv');
        if (state.phase === 'previewing') conv.textContent = 'Estimating swap…';
        else if (state.conversion) conv.textContent = '≈ ' + state.conversion.amount + ' ' + state.conversion.sym + ' lands on-chain after the swap';
        else if (p && p.unavailable) { conv.className = 'paybox-conv muted'; conv.textContent = 'Swaps into ' + (acceptedTokenSym() || 'the project token') + ' on-chain'; }
        else { conv.className = 'paybox-conv muted'; conv.textContent = 'Swaps into ' + (acceptedTokenSym() || 'the project token') + ' on-chain'; }
        feedback.appendChild(conv);
      }
      var abal = el('div', 'paybox-splits');
      abal.textContent = 'Adds to the project balance — nothing else.';
      feedback.appendChild(abal);
      return;
    }

    // Direct AMM swap beats paying: the buyback hook would skim the reserved % even on its swap route, so
    // we route the buy through Uniswap directly — the user keeps 100% of the output, splits get nothing.
    var ds = state.directSwap;
    if (ds && state.phase === 'ready' && p && p.received != null) {
      var dLabel = el('div', 'paybox-yg-label'); dLabel.textContent = 'You get at least'; feedback.appendChild(dLabel);
      var dRow = el('div', 'paybox-yg-row');
      var dVal = el('div', 'paybox-yg-val');
      dVal.textContent = formatTokenCount(ds.out * BigInt(10000 - (state.slippageBps || 0)) / 10000n) + ' ' + sym;
      dRow.appendChild(dVal);
      var dTag = el('span', 'paybox-route-tag paybox-route-direct'); dTag.textContent = 'SWAP';
      dTag.title = 'Bought straight from the Uniswap pool, bypassing pay — so the reserved % / splits take nothing';
      dRow.appendChild(dTag);
      feedback.appendChild(dRow);
      var dNote = el('div', 'paybox-splits');
      var extra = ds.out > p.received ? ' (+' + formatTokenCount(ds.out - p.received) + ' vs paying)' : '';
      dNote.textContent = 'Swapped from the market — splits take 0 ' + sym + extra + '.';
      feedback.appendChild(dNote);
      return;
    }

    var label = el('div', 'paybox-yg-label');
    label.textContent = isAmm ? 'You get at least' : 'You get';
    feedback.appendChild(label);

    var valRow = el('div', 'paybox-yg-row');
    var val = el('div', 'paybox-yg-val');
    if (p && p.unavailable) {
      val.className = 'paybox-yg-val muted';
      val.textContent = 'preview unavailable';
      valRow.appendChild(val);
      feedback.appendChild(valRow);
      var nbU = nftBlock(); if (nbU) feedback.appendChild(nbU);
      return;
    }
    if (state.phase === 'previewing') val.textContent = '…';
    else if (p && p.received != null) val.textContent = formatTokenCount(payMinTokens(p, state.slippageBps)) + ' ' + sym;
    else val.textContent = '0.00 ' + sym;
    valRow.appendChild(val);
    if (p && p.routing) valRow.appendChild(renderRoutingTag(p.routing));
    feedback.appendChild(valRow);

    var nb = nftBlock(); if (nb) feedback.appendChild(nb);

    var splits = el('div', 'paybox-splits');
    splits.textContent = 'Splits get ' + (p && p.reserved != null ? formatTokenCount(p.reserved) : '0') + ' ' + sym;
    feedback.appendChild(splits);

    // AMM route: where it filled + how the AMM quote compares to plain issuance (why this route won).
    if (isAmm && p.amm) {
      var fill = el('div', 'paybox-amm-fill');
      fill.appendChild(document.createTextNode('Filled via Uniswap pool '));
      // A Uniswap V4 poolId is a hash, not a contract — link to the chain's V4 PoolManager (where the pool
      // lives) on the block explorer.
      var pmAddr = POOL_MANAGER_BY_CHAIN[state.chainId];
      var explorer = CHAINS[state.chainId] && CHAINS[state.chainId].blockExplorers && CHAINS[state.chainId].blockExplorers.default && CHAINS[state.chainId].blockExplorers.default.url;
      if (pmAddr && explorer) {
        var a = document.createElement('a');
        a.href = explorer.replace(/\/$/, '') + '/address/' + pmAddr;
        a.target = '_blank'; a.rel = 'noopener';
        a.textContent = shortHex(p.amm.poolId);
        a.title = 'Uniswap V4 PoolManager ' + pmAddr + ' — V4 pools live in the singleton (the poolId is a hash, not an address)';
        fill.appendChild(a);
      } else {
        fill.appendChild(document.createTextNode(shortHex(p.amm.poolId)));
      }
      feedback.appendChild(fill);
      if (p.amm.wouldMintByIssuance != null) {
        // Both sides as the BENEFICIARY's "You get" (excludes splits). The AMM side already is
        // (p.received = minimumBeneficiaryTokenCount); `wouldMintByIssuance` is GROSS issuance (incl.
        // reserved), so scale it by the same beneficiary fraction the swap split exposes.
        var benef = p.received || 0n, reserved = p.reserved || 0n, swapTotal = benef + reserved;
        var issuanceBenef = swapTotal > 0n ? (p.amm.wouldMintByIssuance * benef / swapTotal) : p.amm.wouldMintByIssuance;
        var cmp = el('div', 'paybox-amm-cmp');
        cmp.textContent = 'AMM: ' + formatTokenCount(payMinTokens(p, state.slippageBps)) + ' ' + sym
          + ' vs. Issuance: ' + formatTokenCount(issuanceBenef) + ' ' + sym;
        feedback.appendChild(cmp);
      }
    }
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    state.preview = null;
    state.directSwap = null;
    state.phase = 'idle';
    renderFeedback();
    previewTimer = setTimeout(loadPreview, 400);
  }

  // Decide whether a direct AMM swap beats paying (which skims the reserved % even on the swap route).
  // Only for plain native-token buys (no NFTs, not add-to-balance) where a buyback pool exists. When
  // previewPay already routed AMM, the full output = received + reserved (pay would split it); otherwise
  // the V4 Quoter gives the true hook-routed output (null at 0 liquidity → stays on pay, no change).
  function maybeOfferDirectSwap(gen, amt, p) {
    if (state.mode === 'addbalance' || selectedTierIds().length) return;
    // Input must be a directly-accepted token (a swap-via-router currency isn't the pool's pair).
    if (!state.token || state.token.viaRouter) return;
    if (!p || p.unavailable || p.received == null) return;
    var payOut = p.received;
    var isNativeIn = state.token.address.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    var inputCur = isNativeIn ? ZERO_ADDRESS : state.token.address.toLowerCase();
    directSwapPoolFor(project, state.chainId).then(function (pool) {
      // Only when the paid token IS the pool's pair token (native for ETH pools, USDC for USDC pools).
      if (gen !== previewGen || !pool || pool.pairAddr !== inputCur) return;
      function decide(directOut) {
        if (gen !== previewGen) return;
        if (directOut != null && directOut > payOut) { state.directSwap = { pool: pool, out: directOut }; renderFeedback(); }
      }
      var ammFull = (p.routing === 'amm' && p.reserved != null) ? (p.received + p.reserved) : null;
      if (ammFull != null && ammFull > payOut) { decide(ammFull); return; }
      quoteDirectSwap(state.chainId, pool, amt).then(decide);
    }).catch(function () {});
  }

  function loadPreview() {
    if (!state.amount || !state.token) return;
    var amt;
    try { amt = parseAmount(state.amount, state.token.decimals || 18); } catch (_) { return; }
    if (amt === 0n) { state.preview = null; renderFeedback(); return; }

    state.phase = 'previewing';
    renderFeedback();

    var gen = ++previewGen;
    computePayPreview({
      chainId: state.chainId,
      projectId: project.id,
      token: state.token.address,
      amount: amt,
      beneficiary: getAccount() || undefined,
      terminal: state.token.viaRouter ? routerTerminalFor(state.chainId) : undefined,
    }).then(function (p) {
      if (gen !== previewGen) return;
      state.phase = 'ready';
      state.preview = p;
      state.conversion = null;
      state.directSwap = null;
      renderFeedback();
      maybeOfferDirectSwap(gen, amt, p);
      // Add-to-balance via router: derive the accepted-token amount that lands after the swap. The
      // simulated pay's total mint ÷ the per-unit issuance rate = the swap output (route must be issuance).
      var acc = acceptedToken();
      if (state.mode === 'addbalance' && state.token.viaRouter && acc && p && !p.unavailable && p.received != null) {
        var accSym = (acc.symbol || '').replace(/\s*\(native\)/i, '');
        var accUnit = Number(10n ** BigInt(acc.decimals || 18));
        if (p.routing === 'amm' && p.amm && p.amm.quotedAmountToSwapWith != null) {
          // AMM route: the buyback's swap input IS the accepted-token amount that landed from the router swap.
          state.conversion = { sym: accSym, amount: formatSwapUnits(Number(p.amm.quotedAmountToSwapWith) / accUnit) };
          renderFeedback();
        } else if (p.routing === 'issuance') {
          // Issuance route: recover the landed amount from the per-unit mint rate (same route both sides).
          var total = (p.received || 0n) + (p.reserved || 0n);
          loadAcceptedRate(state.chainId, acc).then(function (rate) {
            if (gen !== previewGen || !rate || rate.per === 0n || rate.routing !== 'issuance') return;
            state.conversion = { sym: accSym, amount: formatSwapUnits(Number(total) / Number(rate.per)) };
            renderFeedback();
          });
        }
      }
    }).catch(function () {
      if (gen !== previewGen) return;
      state.phase = 'ready';
      state.preview = null;
      state.conversion = null;
      renderFeedback();
    });
  }

  function doPay() {
    status.className = 'paybox-status';
    status.textContent = '';
    // Idle until the project's first ruleset starts — paying earlier reverts in the terminal.
    if (startsAt > Math.floor(Date.now() / 1000)) { return; }
    if (!state.amount || !state.token) { status.textContent = 'Enter an amount'; return; }
    var amt;
    try { amt = parseAmount(state.amount, state.token.decimals || 18); } catch (_) { status.textContent = 'Invalid amount'; return; }

    var addBalance = state.mode === 'addbalance';

    // Selected 721 tiers mint via the pay metadata; the amount must cover their ETH total (overpay → tokens).
    // Add-to-balance mints nothing, so NFTs are ignored entirely on that path.
    var tierIds = addBalance ? [] : selectedTierIds();
    var metadata = '0x';
    if (tierIds.length && state.shop) {
      var nftFloor = nftTotalWei();
      if (amt < nftFloor) { amt = nftFloor; state.amount = formatAmount(amt, 18); }
      metadata = buildTierMintMetadata(state.shop.idTarget || state.shop.hook, tierIds);
    }
    if (amt === 0n) { status.textContent = 'Enter an amount'; return; }

    var beneficiary = getAccount();
    if (!beneficiary) { connect().then(function () { doPay(); }).catch(function () {}); return; }

    // USDC and other swap currencies route through the router (JBRouterTerminalRegistry); direct tokens go to the terminal.
    var terminal = state.token.viaRouter ? routerTerminalFor(state.chainId) : getAddress('JBMultiTerminal', state.chainId);
    if (!terminal) { status.textContent = 'No router terminal on this chain'; return; }

    var isNative = state.token.address.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    var viaRouter = !!state.token.viaRouter; // swap currency → authorize via a gasless Permit2 signature, not a router approve

    // Pre-flight: block amounts the wallet can't cover before sending the user to confirm / their wallet.
    var preSym = (state.token.symbol || '').replace(/\s*\(native\)/i, '');
    var preChain = (chains.find(function (c) { return c.id === state.chainId; }) || {}).name || ('Chain ' + state.chainId);
    status.className = 'paybox-status pending'; status.textContent = 'Checking your balance…';
    readWalletTokenBalance(state.chainId, state.token.address, beneficiary).then(function (walletBal) {
      if (walletBal != null && amt > walletBal) {
        status.className = 'paybox-status error';
        status.textContent = 'Not enough ' + preSym + ' — you have ' + formatBalance(walletBal, state.token.decimals || 18, preSym) + ' on ' + preChain + '.';
        return;
      }
      status.className = 'paybox-status'; status.textContent = '';
      proceed();
    }).catch(function () { status.className = 'paybox-status'; status.textContent = ''; proceed(); }); // balance read failed → don't block
    return;

    function proceed() {
    // Direct AMM swap: bypass `pay` (which skims the reserved % even on its swap route) and swap the pool
    // directly via Uniswap's Universal Router, so the user keeps 100% of the output. Only for plain native
    // buys with no NFTs; the buyback hook still routes the swap at the best of AMM vs issuance. The swap's
    // amountOutMinimum makes an adverse move revert (not lose funds).
    if (state.directSwap && !addBalance && !tierIds.length) {
      var ds = state.directSwap;
      var dsMinOut = ds.out * BigInt(10000 - (state.slippageBps || 0)) / 10000n;
      var dChain = (chains.find(function (c) { return c.id === state.chainId; }) || {}).name || ('Chain ' + state.chainId);
      var dSymClean = (state.token.symbol || (isNative ? 'ETH' : 'token')).replace(/\s*\(native\)/i, '');
      var dHuman = state.amount + ' ' + dSymClean;
      openPayConfirm({
        chain: dChain,
        chainId: state.chainId,
        contract: 'Uniswap Universal Router',
        address: UNIVERSAL_ROUTER_BY_CHAIN[state.chainId],
        'function': 'execute',
        abi: abiSignature(urExecuteAbi, 'execute'),
        value: isNative ? (amt.toString() + ' wei (' + dHuman + ')') : '0',
        erc20Approval: isNative ? null : { token: state.token.address, authorize: 'Permit2 signature (gasless); one-time approval to Permit2 only if needed', spender: UNIVERSAL_ROUTER_BY_CHAIN[state.chainId] },
        args: {
          action: 'Direct AMM swap — bypasses pay so splits/reserved take nothing',
          buy: sym,
          amountIn: amt.toString() + ' (' + dHuman + ')',
          minReturnedTokens: dsMinOut.toString() + ' (' + formatTokenCount(dsMinOut) + ' ' + sym + ', ' + (state.slippageBps / 100) + '% max slippage)',
          beneficiary: beneficiary,
          note: 'Swaps the buyback pool directly via the Universal Router; the hook fills at the best of AMM vs issuance.',
        },
      }, function send() {
        if (isNative) { sendPay(buildDirectSwapNativeTx(state.chainId, ds.pool, amt, dsMinOut, beneficiary)); return; }
        // ERC-20 (USDC) input → Permit2 approval/signature, then PERMIT2_PERMIT + V4_SWAP in one tx.
        var statusCb = function (m, kind) { status.className = 'paybox-status' + (kind === 'pending' ? ' pending' : ''); status.textContent = m; };
        buildDirectSwapErc20Tx(state.chainId, ds.pool, state.token.address, amt, dsMinOut, beneficiary, statusCb)
          .then(function (tx) { sendPay(tx); })
          .catch(function (e) { status.className = 'paybox-status error'; status.textContent = errMessage(e, 'Swap authorization failed'); });
      });
      return;
    }

    // Require back what the user was quoted (issuance exact; AMM minus chosen slippage). Only when the
    // preview matches the current amount; otherwise leave unprotected rather than risk a stale floor.
    var minTokens = (!addBalance && state.phase === 'ready') ? payMinTokens(state.preview, state.slippageBps) : 0n;

    // pay(projectId, token, amount, beneficiary, minReturnedTokens, memo, metadata) — metadata at index 6.
    // addToBalanceOf(projectId, token, amount, shouldReturnHeldFees, memo, metadata) — metadata at index 5.
    var fnName = addBalance ? 'addToBalanceOf' : 'pay';
    var fnAbi = addBalance ? addToBalanceAbi : payAbi;
    var args = addBalance
      ? [BigInt(project.id), state.token.address, amt, false, state.memo || '', metadata]
      : [BigInt(project.id), state.token.address, amt, beneficiary, minTokens, state.memo || '', metadata];
    var metaIdx = addBalance ? 5 : 6;
    var txParams = {
      chainId: state.chainId,
      address: terminal,
      abi: fnAbi,
      functionName: fnName,
      args: args,
      value: isNative ? amt : 0n,
      // Direct ERC20 pays approve the terminal inline; swap-via-router pays authorize through Permit2 (below).
      tokenAddr: (isNative || viaRouter) ? null : state.token.address,
      spenderAddr: (isNative || viaRouter) ? null : terminal,
      approvalAmount: (isNative || viaRouter) ? null : amt,
    };

    // Confirm the exact data before signing.
    var chainName = (chains.find(function (c) { return c.id === state.chainId; }) || {}).name || ('Chain ' + state.chainId);
    var symClean = (state.token.symbol || '').replace(/\s*\(native\)/i, '');
    var human = state.amount + ' ' + symClean;
    // Human-readable summary of the NFTs this pay will mint (the raw `metadata` hex below is unreadable),
    // surfaced near the top of the args so the NFT purchase is clearly visible in the confirm preview.
    // selectedTierIds() repeats each id by qty, so tierIds.length is the total NFT count.
    var confirmArgs = { projectId: project.id, token: state.token.address };
    if (tierIds.length) {
      confirmArgs.mints = nftSelectionList().map(function (s) { return s.name + ' ×' + s.qty; }).join(', ')
        + ' — ' + tierIds.length + ' NFT' + (tierIds.length > 1 ? 's' : '') + ' minted by the 721 hook';
    }
    confirmArgs.amount = amt.toString() + ' (' + human + ')';
    if (addBalance) {
      confirmArgs.shouldReturnHeldFees = false;
      if (viaRouter && state.conversion) confirmArgs.landsOnChain = '≈ ' + state.conversion.amount + ' ' + state.conversion.sym + ' after swap';
    } else {
      confirmArgs.beneficiary = beneficiary;
      confirmArgs.minReturnedTokens = minTokens.toString() + (minTokens > 0n
        ? ' (' + formatTokenCount(minTokens) + ' ' + sym
          + (state.preview && state.preview.routing === 'amm' ? ', ' + (state.slippageBps / 100) + '% max slippage' : '')
          + ')'
        : '');
    }
    confirmArgs.memo = state.memo || '';
    confirmArgs.metadata = (viaRouter && !isNative) ? 'Permit2 single-allowance signature (added when you sign)' : metadata;
    openPayConfirm({
      chain: chainName,
      chainId: state.chainId,
      contract: viaRouter ? 'JBRouterTerminalRegistry' : 'JBMultiTerminal',
      address: terminal,
      'function': fnName,
      abi: abiSignature(fnAbi, fnName),
      value: isNative ? (amt.toString() + ' wei (' + human + ')') : '0',
      erc20Approval: isNative ? null
        : (viaRouter
          ? { token: state.token.address, authorize: 'Permit2 signature (gasless); one-time approval to Permit2 only if needed', spender: terminal }
          : { token: state.token.address, spender: terminal, amount: amt.toString() }),
      args: confirmArgs,
    }, function send() {
      // Native ETH (even via the router) is paid with msg.value — no Permit2. Only ERC20 swap currencies
      // authorize through Permit2; reading allowance on the native pseudo-address returns "0x".
      if (!viaRouter || isNative) { sendPay(txParams); return; }
      // Swap-via-router: authorize with a Permit2 signature (replaces the scary router-approve tx), then send.
      var statusCb = function (m, kind) { status.className = 'paybox-status' + (kind === 'pending' ? ' pending' : ''); status.textContent = m; };
      buildRouterPermit2Metadata(state.chainId, state.token.address, beneficiary, terminal, amt, statusCb)
        .then(function (meta) { var p = Object.assign({}, txParams); p.args = args.slice(); p.args[metaIdx] = meta; sendPay(p); })
        .catch(function (e) { status.className = 'paybox-status error'; status.textContent = errMessage(e, 'Permit2 authorization failed'); });
    });
    } // proceed()
  }

  // Render a pay status line with an Etherscan tx link once a hash exists; plain text otherwise.
  function setPayStatus(cls, message, meta) {
    status.className = cls;
    if (meta && meta.hash) {
      status.innerHTML = '';
      status.appendChild(document.createTextNode(message + ' | TX: '));
      status.appendChild(renderExplorerTxLink(meta.chainId, meta.hash, truncAddr(meta.hash)));
    } else {
      status.textContent = message;
    }
  }

  function sendPay(txParams) {
    var add = state.mode === 'addbalance';
    var processing = add ? 'Adding to balance' : 'Payment processing';
    var confirmed = add ? 'Added to balance' : 'Payment confirmed';
    executeTransaction(Object.assign({}, txParams, {
      skipConfirm: true, // already confirmed via openPayConfirm
      onStatus: function (m, kind, meta) {
        var cls = 'paybox-status' + (kind === 'pending' ? ' pending' : '');
        if (meta && meta.phase === 'submitted') setPayStatus(cls, processing, meta);
        else { status.className = cls; status.textContent = m; }
      },
      onSuccess: function (m, meta) {
        setPayStatus('paybox-status success', confirmed, meta);
        status.dispatchEvent(new CustomEvent('jb:project-updated', { bubbles: true }));
      },
      onError: function (m) { status.className = 'paybox-status error'; status.textContent = m; },
    }));
  }

  // Countdown banner above the pay box for projects whose first ruleset hasn't started.
  // The Pay button idles ("Not started") and doPay early-returns until the start passes.
  if (startsAt > Math.floor(Date.now() / 1000)) {
    var countdown = el('div', 'paybox-countdown');
    var cdLabel = el('span', 'paybox-countdown-label');
    cdLabel.textContent = 'Starts in';
    var cdTime = el('span', 'paybox-countdown-time');
    countdown.appendChild(cdLabel);
    countdown.appendChild(cdTime);
    card.insertBefore(countdown, card.firstChild);
    payBtn.disabled = true;
    payBtn.classList.add('paybox-btn-idle');
    payBtn.textContent = 'Not started';

    var cdTimer = setInterval(function () {
      if (!card.isConnected) { clearInterval(cdTimer); return; }
      var rem = startsAt - Math.floor(Date.now() / 1000);
      if (rem <= 0) {
        clearInterval(cdTimer);
        if (countdown.parentNode) countdown.parentNode.removeChild(countdown);
        payBtn.disabled = false;
        payBtn.classList.remove('paybox-btn-idle');
        updateModeUi();
        return;
      }
      cdTime.textContent = fmtCountdown(rem);
    }, 1000);
    cdTime.textContent = fmtCountdown(startsAt - Math.floor(Date.now() / 1000));
  }

  renderFeedback();
  card.appendChild(promptFoot('Pay', 'pay'));
  return card;
}

// Minimum project tokens to require back from a pay (the `minReturnedTokens` arg). Issuance is exact
// (the quote is deterministic); the AMM route discounts the quote by the chosen slippage. The terminal
// enforces this against the beneficiary's realized balance delta (mint OR swap output), so it's a valid
// floor for both routes.
function payMinTokens(p, slippageBps) {
  if (!p || p.received == null) return 0n;
  if (p.routing === 'amm') return p.received * BigInt(10000 - (slippageBps || 0)) / 10000n;
  return p.received;
}

// Compact rich header: symbol + name + chains, a balance/supply stat line, and an owner/operator/site line.
function renderDetailHeader(project) {
  var header = el('div', 'project-detail-header');

  // Top: logo + project title, vertically centered to each other.
  var topRow = el('div', 'detail-head-top');
  topRow.appendChild(renderLogo(project, 'detail-logo'));
  var titleCol = el('div', 'detail-head-titlecol');

  var nameRow = el('div', 'detail-name-row');
  if (project.tokenSymbol) {
    var symEl = el('span', 'detail-sym');
    symEl.textContent = project.tokenSymbol;
    nameRow.appendChild(symEl);
  }
  var name = el('span', 'detail-name');
  name.textContent = project.name;
  nameRow.appendChild(name);
  titleCol.appendChild(nameRow);

  // Tagline between the title and the stat line (when set).
  if (project.tagline) {
    var tagEl = el('div', 'detail-tagline'); tagEl.textContent = project.tagline; titleCol.appendChild(tagEl);
  }

  // Stat line: balance | supply (under the title). Balance is the cross-chain USD total; hover breaks
  // it down into the actual tokens stored on each chain.
  var statLine = el('div', 'detail-head-stats');
  statLine.appendChild(mountUsdBalance(project, { suffix: ' balance' }));
  if (project.isRevnet) {
    // Revnet header: just Balance | Owners (unique holders, matching the Owners tab).
    var sepSpan = el('span', 'detail-head-sep'); sepSpan.textContent = '|'; statLine.appendChild(sepSpan);
    var oStrong = el('strong'); oStrong.textContent = '…'; statLine.appendChild(oStrong);
    var oLabel = document.createTextNode(' owners'); statLine.appendChild(oLabel);
    fetchOwnersCount(project).then(function (n) {
      n = (n == null) ? 0 : n;
      oStrong.textContent = String(n);
      oLabel.textContent = n === 1 ? ' owner' : ' owners';
    }).catch(function () { oStrong.textContent = '0'; });
  } else {
    // Indexed activity (Bendystraw): volume raised + payment/contributor counts.
    appendIndexedStats(statLine, project.indexedStats);
  }
  titleCol.appendChild(statLine);
  topRow.appendChild(titleCol);
  header.appendChild(topRow);

  // Meta line: type | chains | owner/operator | site.
  var lbl = function (text) { var s = el('span', 'detail-head-lbl'); s.textContent = text; return s; };
  var mkPair = function (labelText, nodes) {
    var p = el('span', 'detail-head-pair');
    p.appendChild(lbl(labelText));
    nodes.forEach(function (n) { p.appendChild(n); });
    return p;
  };
  // "Flavor | On | Operator | Site" on one row (the "|" is a ::after bar BETWEEN pairs); each pair is inline +
  // nowrap as a UNIT, so the row stays on one line on desktop and only wraps whole key:val pairs to the next
  // line when the viewport is too narrow (mobile) — a label never separates from its value.
  var ownerWarn = el('span', 'detail-head-ownerwarn');
  var row1 = el('div', 'detail-head-meta');
  var typeVal = el('span', 'detail-head-val'); typeVal.textContent = project.isRevnet ? 'REVNET' : 'CUSTOM';
  row1.appendChild(mkPair('Flavor: ', [typeVal]));
  if (project.chains && project.chains.length) {
    row1.appendChild(document.createTextNode(' '));
    var logos = el('span', 'detail-chain-logos');
    for (var c = 0; c < project.chains.length; c++) logos.appendChild(projectChainLogo(project, project.chains[c]));
    row1.appendChild(mkPair('On: ', [logos]));
  }
  row1.appendChild(document.createTextNode(' '));
  row1.appendChild(mkPair(projectAuthorityLabel(project) + ': ', [addressLinkNode(projectAuthorityAddress(project), project.chainId || (project.chains && project.chains[0] && project.chains[0].id)), ownerWarn]));
  if (project.infoUri) {
    var href = project.infoUri.indexOf('http') === 0 ? project.infoUri : ('https://' + project.infoUri);
    var a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'detail-head-url';
    a.textContent = project.infoUri.replace(/^https?:\/\//, '');
    row1.appendChild(document.createTextNode(' '));
    row1.appendChild(mkPair('Site: ', [a]));
  }
  header.appendChild(row1);
  // Flag when the on-chain owner isn't the same on every chain (a per-chain ownership split).
  if (!project.isRevnet && (project.chains || []).length > 1) {
    fetchOwnersPerChain(project).then(function (res) { if (res.diverged && ownerWarn.isConnected) ownerWarn.textContent = ' differs by chain'; }).catch(function () {});
  }
  return header;
}

// About tab: the editable project profile (logo, tagline, description, links — one Edit), then Other
// info (per-chain IDs + operator). The Token card now lives atop the holders view (Tokens/Owners tab).
function renderAboutSection(project) {
  var section = el('div', 'detail-section');
  section.appendChild(renderAboutCard(project));
  section.appendChild(renderOtherInfoPanel(project));
  return section;
}

// Unified project profile — everything the "Edit project" modal writes, stacked, with a single Edit CTA.
function renderAboutCard(project) {
  var card = el('div', 'detail-card');
  var t = el('div', 'detail-card-title'); t.textContent = 'About'; card.appendChild(t);
  var body = el('div', 'detail-card-body');

  if (project.logoUri) {
    var logo = document.createElement('img'); logo.className = 'detail-about-logo'; logo.src = project.logoUri; logo.alt = project.name || '';
    logo.addEventListener('error', function () { logo.style.display = 'none'; });
    body.appendChild(logo);
  }
  if (project.tagline) {
    var tag = el('div', 'detail-about-tagline'); tag.textContent = project.tagline; body.appendChild(tag);
  }
  var d = el('div', 'detail-about-desc');
  if (project.descriptionHtml) {
    renderRichTextInto(d, project.descriptionHtml);
  } else if (project.description) {
    project.description.split(/\n{2,}/).forEach(function (para) {
      if (!para.trim()) return;
      var p = el('p', 'detail-about-para'); p.textContent = para.trim(); d.appendChild(p);
    });
  } else {
    var empty = el('p', 'detail-about-para detail-about-empty'); empty.textContent = 'No description yet.'; d.appendChild(empty);
  }
  body.appendChild(d);

  var links = renderProjectLinks(project);
  if (links) body.appendChild(links);
  card.appendChild(body);

  var foot = el('div', 'detail-about-foot');
  var edit = el('a', 'operator-cta'); edit.textContent = 'Edit'; edit.href = '#';
  edit.title = 'Edit the project — logo, tagline, description, links (operator only)';
  edit.addEventListener('click', function (e) { e.preventDefault(); openEditProjectModal(project); });
  foot.appendChild(edit);
  card.appendChild(foot);
  return card;
}

// Website + socials as a row of small underlined links. Returns null when none are set.
function renderProjectLinks(project) {
  var entries = [];
  if (project.infoUri) entries.push(['Website', project.infoUri.indexOf('http') === 0 ? project.infoUri : ('https://' + project.infoUri)]);
  if (project.twitter) { var h = String(project.twitter).replace(/^@/, ''); entries.push(['X', /^https?:/.test(h) ? h : ('https://x.com/' + h)]); }
  if (project.discord) entries.push(['Discord', /^https?:/.test(project.discord) ? project.discord : ('https://' + String(project.discord).replace(/^\/+/, ''))]);
  if (project.telegram) { var tg = String(project.telegram); entries.push(['Telegram', /^https?:/.test(tg) ? tg : (tg.indexOf('t.me') === 0 ? 'https://' + tg : 'https://t.me/' + tg.replace(/^@/, ''))]); }
  if (!entries.length) return null;
  var row = el('div', 'detail-about-links');
  entries.forEach(function (e) {
    var item = el('div', 'about-link-row');
    var k = el('span', 'about-link-key'); k.textContent = e[0] + ':'; item.appendChild(k);
    var a = document.createElement('a'); a.className = 'about-link-url'; a.href = e[1]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = e[1];
    item.appendChild(a);
    row.appendChild(item);
  });
  return row;
}

// Token card — "TOKEN" header, then a single content line (name | symbol | type | truncated address,
// full on hover | on-chains), then its operator Edit (deploy or rename the ERC-20) beneath.
function renderTokenPanel(project) {
  var card = el('div', 'detail-card token-line-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Token'; card.appendChild(title);
  var row = el('div', 'token-line');

  // Each value is preceded by its key label.
  function seg(key, valNode) {
    var s = el('span', 'token-line-seg');
    var k = el('span', 'token-line-key'); k.textContent = key + ':'; s.appendChild(k);
    if (typeof valNode === 'string') { var v = el('span', 'token-line-val'); v.textContent = valNode; s.appendChild(v); }
    else { valNode.classList.add('token-line-val'); s.appendChild(valNode); }
    return s;
  }

  var name = el('span'); name.textContent = project.tokenName || project.tokenSymbol || 'Token';
  row.appendChild(seg('Name', name));

  if (project.tokenSymbol) {
    row.appendChild(boSep());
    row.appendChild(seg('Symbol', project.tokenSymbol));
  }

  // Type: until an ERC-20 is deployed, holdings are non-transferable credits.
  row.appendChild(boSep());
  row.appendChild(seg('Type', project.tokenAddress ? 'ERC-20' : 'Credits'));

  // Address — truncated, full address reveals instantly on hover. JB omnichain ERC-20s share a
  // deterministic CREATE2 address, so this one applies on every chain.
  if (project.tokenAddress) {
    row.appendChild(boSep());
    row.appendChild(seg('Address', addressNode(project.tokenAddress)));
    // "On" — the chains the token lives on, each linking to its address on that chain's explorer.
    var onIds = orderedProjectChainIds(project);
    if (onIds.length) {
      row.appendChild(boSep());
      var onWrap = el('span', 'token-on-chains token-line-on');
      onIds.forEach(function (id) { onWrap.appendChild(chainAddrBubble(id, project.tokenAddress)); });
      row.appendChild(seg('On', onWrap));
    }
  }
  card.appendChild(row);

  var foot = el('div', 'detail-about-foot');
  var edit = el('a', 'operator-cta'); edit.textContent = 'Edit'; edit.href = '#';
  edit.title = 'Edit the token name & symbol (operator only)';
  edit.addEventListener('click', function (e) { e.preventDefault(); openEditTokenModal(project); });
  foot.appendChild(edit);
  card.appendChild(foot);
  return card;
}

// Read JBProjects.ownerOf(projectId) on every chain and report whether the owner diverges. Custom
// projects only (revnet authority is the operator, a different read). { rows:[{chainId,name,owner}], diverged }.
function fetchOwnersPerChain(project) {
  var pid = BigInt(project.id);
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  return Promise.all(chains.map(function (c) {
    return read(c.id, 'JBProjects', ownerOfAbi, 'ownerOf', [pid])
      .then(function (o) { return { chainId: c.id, name: c.name, owner: o }; })
      .catch(function () { return { chainId: c.id, name: c.name, owner: null }; });
  })).then(function (rows) {
    var known = rows.filter(function (r) { return r.owner; });
    var first = known.length ? known[0].owner.toLowerCase() : null;
    var diverged = known.some(function (r) { return r.owner.toLowerCase() !== first; });
    return { rows: rows, diverged: diverged };
  });
}

// Other info — per-chain project IDs + the operator/owner address. Read-only.
function renderOtherInfoPanel(project) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Other info'; card.appendChild(title);
  var grid = el('div', 'detail-info-grid');

  var idChains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('chain ' + project.chainId) }];
  var idsHead = el('div', 'detail-info-head');
  idsHead.textContent = idChains.length > 1 ? 'Project IDs' : 'Project ID';
  grid.appendChild(idsHead);
  idChains.forEach(function (ch) {
    var item = el('div', 'detail-info-chainrow detail-info-chain');
    item.appendChild(chainLogo(ch.id, null));
    var nm = el('span', 'detail-info-chainname'); nm.textContent = ch.name; item.appendChild(nm);
    var idv = el('span', 'detail-info-chainid'); idv.textContent = '#' + project.id; item.appendChild(idv);
    item.title = 'Open #' + project.id + ' on ' + ch.name;
    item.addEventListener('click', function () {
      var tab = _activeDetail ? _activeDetail.current : null;
      location.hash = '#' + slugForChain(ch.id) + ':' + project.id + (tab ? '/' + tab.toLowerCase() : '');
    });
    grid.appendChild(item);
  });

  // Token info — read-only here (the editable copy lives atop the holders view). Name / symbol / type /
  // address / on-chains, no Edit.
  var tnVal = el('span', 'info-token-name'); tnVal.textContent = project.tokenName || '—';
  grid.appendChild(infoItem('Token name', tnVal));
  var tsVal = el('span', 'info-token-symbol'); tsVal.textContent = project.tokenSymbol || 'credits';
  grid.appendChild(infoItem('Token symbol', tsVal));
  if (project.tokenAddress) {
    // "Token on" sits above "Token address"; "Token type" drops to the row beside Operator.
    var onIds = orderedProjectChainIds(project);
    if (onIds.length) {
      var onWrap = el('span', 'token-on-chains');
      onIds.forEach(function (id) { onWrap.appendChild(chainAddrBubble(id, project.tokenAddress)); });
      grid.appendChild(infoItem('Token on', onWrap));
    }
    grid.appendChild(infoItem('Token address', fullAddressNode(project.tokenAddress)));
    grid.appendChild(infoItem('Token type', 'ERC-20'));
  } else {
    grid.appendChild(infoItem('Token type', 'Credits'));
  }

  // Operator/owner — ENS-resolved, with a transfer CTA below (revnets only — REVOwner.setOperatorOf).
  var opItem = el('div', 'detail-info-item');
  var opLbl = el('div', 'detail-info-label'); opLbl.textContent = projectAuthorityLabel(project); opItem.appendChild(opLbl);
  var opVal = el('div', 'detail-info-value info-operator-val'); opVal.appendChild(fullAddressNode(projectAuthorityAddress(project), true, project.chainId)); opItem.appendChild(opVal);
  // If ownership isn't uniform across chains, replace the single value with a per-chain breakdown.
  if (!project.isRevnet && idChains.length > 1) {
    fetchOwnersPerChain(project).then(function (res) {
      if (!res.diverged || !opVal.isConnected) return;
      opVal.innerHTML = '';
      var warn = el('div', 'detail-owner-warn'); warn.textContent = 'Owner differs by chain'; opVal.appendChild(warn);
      res.rows.forEach(function (r) {
        var row = el('div', 'detail-owner-chainrow');
        row.appendChild(chainLogo(r.chainId, r.name));
        var nm = el('span', 'detail-info-chainname'); nm.textContent = ' ' + r.name + ' '; row.appendChild(nm);
        if (r.owner) row.appendChild(fullAddressNode(r.owner, false, r.chainId)); else { var dash = el('span'); dash.textContent = '—'; row.appendChild(dash); }
        opVal.appendChild(row);
      });
    }).catch(function () {});
  }
  // (Transfer operator/ownership lives in the Owner/Operator tab's Account card now.)
  grid.appendChild(opItem);
  card.appendChild(grid);
  return card;
}

// Operator-only: rotate the revnet's operator on the chosen chains, via relayr (REVOwner.setOperatorOf).
function openTransferOperatorModal(project) {
  var authorityLabel = (projectAuthorityLabel(project) || 'Operator').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var allChains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('Chain ' + project.chainId) }];

  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode(authorityLabel, operatorAddr, 'to transfer the operator role.'));

  var warn = el('div', 'operator-edit-across');
  warn.textContent = 'Hands over operator control on the selected chains. Use the zero address to relinquish operator powers permanently. This does not move funds or change the rulesets.';
  content.appendChild(warn);

  var nlbl = el('div', 'operator-edit-label'); nlbl.style.marginTop = '12px'; nlbl.textContent = 'New operator'; content.appendChild(nlbl);
  var addrInput = el('input', 'operator-edit-jwt'); addrInput.type = 'text'; addrInput.placeholder = '0x… new operator address'; content.appendChild(addrInput);

  var clbl = el('div', 'operator-edit-label'); clbl.style.marginTop = '12px'; clbl.textContent = 'Apply on'; content.appendChild(clbl);
  var chainBox = el('div', 'splits-edit-chains');
  var chainChecks = allChains.map(function (c) {
    var row = el('label', 'splits-edit-chain');
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.value = String(c.id);
    row.appendChild(cb);
    row.appendChild(chainLogo(c.id, c.name));
    var nm = el('span'); nm.textContent = c.name || ('Chain ' + c.id); row.appendChild(nm);
    chainBox.appendChild(row);
    return { chain: c, cb: cb };
  });
  content.appendChild(chainBox);

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = 'Transfer operator';
  actions.appendChild(submit);
  content.appendChild(actions);

  var modal = openModal('Transfer operator', content);
  var setStatus = makeStatusSetter(status, 'operator-edit-status');
  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault();
    if (busy) return;
    var selected = chainChecks.filter(function (c) { return c.cb.checked; }).map(function (c) { return c.chain; });
    submitTransferOperator(project, selected, operatorAddr, addrInput.value, setStatus, modal).catch(function (err) {
      busy = false; setStatus(errMessage(err, 'Transfer failed'), 'error');
    });
    busy = true;
  });
}

// JBProjects is an ERC-721; project ownership transfers by moving the NFT.
var jbProjectsTransferAbi = [{
  type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
}];

// Run an owner/operator-only action across chains, routing by the authority's account type: a Safe →
// propose to its per-chain queue (multichain, one payment to execute later); an EOA → Relayr (sign per
// chain, pay once). Returns { queued, skipped, cancelled } for the Safe path, { relayr:true } for EOA, or null.
async function runAuthorityActionAcrossChains(project, chains, authorityAddr, buildCall, opts, setStatus) {
  var safeInfo = await fetchSafeInfo(authorityAddr, project.chainId).catch(function () { return null; });
  if (safeInfo) {
    var signer = getAccount();
    if (!signer) { setStatus('Connecting wallet…', 'pending'); signer = await connect().then(getAccount).catch(function () { return null; }); }
    if (!signer) { setStatus('Connect a wallet to continue', 'error'); return null; }
    if (!safeInfo.owners.some(function (o) { return o.toLowerCase() === signer.toLowerCase(); })) {
      setStatus('Connected wallet isn’t a signer of the Safe (' + truncAddr(authorityAddr) + ').', 'error'); return null;
    }
    return proposeSafeAcrossChains(project, authorityAddr, signer, buildCall, { title: opts.title });
  }
  var account = await ensureOperatorAccount(project, authorityAddr, setStatus);
  if (!account) return null;
  await runRelayrAcrossChains(chains, account, buildCall, opts.gas || 500000n, setStatus, { label: opts.label, title: opts.title });
  return { relayr: true };
}

// Transfer operator (revnet) / ownership (custom) across every chain, routed by authority type.
function openTransferAuthorityModal(project) {
  var isRev = project.isRevnet;
  var authorityAddr = projectAuthorityAddress(project);
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode((projectAuthorityLabel(project) || (isRev ? 'Operator' : 'Owner')).toLowerCase(), authorityAddr, isRev ? 'to transfer the operator role.' : 'to transfer ownership.', project.chainId));
  var warn = el('div', 'operator-edit-across');
  warn.textContent = isRev
    ? 'Hands over operator control on every chain. Use the zero address to relinquish operator powers permanently. Does not move funds or change rulesets.'
    : 'Transfers project ownership (the JBProjects NFT) on every chain. The new owner controls all owner-only actions. Does not move funds or change rulesets.';
  content.appendChild(warn);
  var nlbl = el('div', 'operator-edit-label'); nlbl.style.marginTop = '12px'; nlbl.textContent = isRev ? 'New operator' : 'New owner'; content.appendChild(nlbl);
  var addrInput = el('input', 'operator-edit-jwt'); addrInput.type = 'text'; addrInput.placeholder = '0x… new ' + (isRev ? 'operator' : 'owner') + ' address'; content.appendChild(addrInput);
  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = isRev ? 'Transfer operator' : 'Transfer ownership';
  actions.appendChild(submit); content.appendChild(actions);
  var modal = openModal(isRev ? 'Transfer operator' : 'Transfer ownership', content);
  function setStatus(m, k) { status.className = 'operator-edit-status' + (k ? ' ' + k : ''); status.textContent = m; }
  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault(); if (busy) return; busy = true;
    var to = (addrInput.value || '').trim();
    (async function () {
      if (!isAddr(to)) { setStatus('Enter a valid 0x address', 'error'); busy = false; return; }
      var buildCall = isRev
        ? function (cid) { var revOwner = getAddress('REVOwner', cid); if (!revOwner) throw new Error('No REVOwner on ' + chainNameOf(cid)); return { to: revOwner, data: encodeFunctionData({ abi: setOperatorOfAbi, functionName: 'setOperatorOf', args: [BigInt(project.id), to] }) }; }
        : function (cid) { var jbp = getAddress('JBProjects', cid); if (!jbp) throw new Error('No JBProjects on ' + chainNameOf(cid)); return { to: jbp, data: encodeFunctionData({ abi: jbProjectsTransferAbi, functionName: 'transferFrom', args: [authorityAddr, to, BigInt(project.id)] }) }; };
      var res = await runAuthorityActionAcrossChains(project, chains, authorityAddr, buildCall, { label: isRev ? 'Transfer operator' : 'Transfer ownership', title: isRev ? 'Transfer operator' : 'Transfer ownership' }, setStatus)
        .catch(function (err) { setStatus(errMessage(err, 'Transfer failed'), 'error'); return null; });
      busy = false;
      if (!res) return;
      if (res.cancelled) { setStatus('Cancelled', ''); return; }
      if (res.relayr) { setStatus((isRev ? 'Operator' : 'Ownership') + ' transferred on ' + chains.length + ' chain' + (chains.length > 1 ? 's' : '') + '.', 'success'); if (isRev) project.operator = to; setTimeout(function () { modal.close(); }, 1400); return; }
      setStatus('Queued on ' + res.queued + ' chain' + (res.queued === 1 ? '' : 's') + (res.skipped && res.skipped.length ? ' (skipped ' + res.skipped.join(', ') + ')' : '') + ' — confirm + execute in the ' + (isRev ? 'Operator' : 'Owner') + ' tab.', 'success');
      setTimeout(function () { modal.close(); }, 2400);
    })();
  });
}

async function submitTransferOperator(project, selectedChains, operatorAddr, newOperator, setStatus, modal) {
  newOperator = (newOperator || '').trim();
  if (!isAddr(newOperator)) { setStatus('Enter a valid 0x operator address', 'error'); return; }
  if (!selectedChains.length) { setStatus('Select at least one chain', 'error'); return; }
  var account = await ensureOperatorAccount(project, operatorAddr, setStatus);
  if (!account) return;

  await runRelayrAcrossChains(selectedChains, account, function (cid) {
    var revOwner = getAddress('REVOwner', cid);
    if (!revOwner) throw new Error('No REVOwner on ' + (CHAINS[cid] && CHAINS[cid].name || cid));
    return { to: revOwner, data: encodeFunctionData({ abi: setOperatorOfAbi, functionName: 'setOperatorOf', args: [BigInt(project.id), newOperator] }) };
  }, 500000n, setStatus, { label: 'Transfer operator', title: 'Confirm transfer operator' });

  setStatus('Operator transferred on ' + selectedChains.length + ' chain' + (selectedChains.length > 1 ? 's' : '') + '', 'success');
  project.operator = newOperator;
  var liveOp = document.querySelector('.info-operator-val'); if (liveOp) { liveOp.innerHTML = ''; liveOp.appendChild(fullAddressNode(newOperator, true, project.chainId)); }
  setTimeout(function () { modal.close(); }, 1400);
}

// Operator-only: edit the project's identity metadata — name, tagline, logo, description, website and
// socials — then push the new IPFS URI to every chain via relayr (one ERC-2771 `setUriOf` per chain).
function openEditProjectModal(project) {
  var authorityLabel = (projectAuthorityLabel(project) || 'Operator').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var chains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('Chain ' + project.chainId) }];

  var content = el('div', 'modal-body operator-edit');

  content.appendChild(operatorGateNode(authorityLabel, operatorAddr, 'to edit the project.'));

  function field(label, placeholder, value, topGap) {
    var l = el('div', 'operator-edit-label'); l.style.marginTop = (topGap == null ? 10 : topGap) + 'px'; l.textContent = label; content.appendChild(l);
    var i = el('input', 'operator-edit-jwt'); i.type = 'text'; i.placeholder = placeholder || ''; i.value = value || '';
    content.appendChild(i);
    return i;
  }

  var nameInput = field('Name', 'Project name', project.name || '', 0);
  var taglineInput = field('Tagline', 'One-line summary', project.tagline || '');

  // Logo — current preview + replace-with-file. Pinned on submit only if a new file is chosen.
  var logoLbl = el('div', 'operator-edit-label'); logoLbl.style.marginTop = '10px'; logoLbl.textContent = 'Logo'; content.appendChild(logoLbl);
  var logoRow = el('div', 'operator-edit-logo');
  var logoPrev = document.createElement('img'); logoPrev.className = 'operator-edit-logo-prev';
  if (project.logoUri) logoPrev.src = project.logoUri; else logoPrev.style.visibility = 'hidden';
  logoRow.appendChild(logoPrev);
  var logoFile = document.createElement('input'); logoFile.type = 'file'; logoFile.accept = 'image/*'; logoFile.className = 'operator-edit-logo-file';
  logoFile.addEventListener('change', function () {
    var f = logoFile.files && logoFile.files[0];
    if (f) { logoPrev.style.visibility = 'visible'; logoPrev.src = URL.createObjectURL(f); }
  });
  logoRow.appendChild(logoFile);
  content.appendChild(logoRow);

  var dlbl = el('div', 'operator-edit-label'); dlbl.style.marginTop = '10px'; dlbl.textContent = 'Description'; content.appendChild(dlbl);
  var ta = el('textarea', 'operator-edit-textarea'); ta.rows = 6; ta.value = project.description || ''; content.appendChild(ta);

  var websiteInput = field('Website', 'https://…', project.infoUri || '');
  var twitterInput = field('X / Twitter', 'handle (without @)', '');
  var discordInput = field('Discord', 'invite or handle', '');
  var telegramInput = field('Telegram', 'handle or link', '');

  // Store categories — names for the 721 store's category numbers (category 0 is always "Default").
  // Each row keeps a stable id so existing tier→category links don't shift when rows are added/removed.
  var catLbl = el('div', 'operator-edit-label'); catLbl.style.marginTop = '10px';
  catLbl.innerHTML = 'Store categories <span class="operator-edit-hint">— label the shop item categories.</span>';
  content.appendChild(catLbl);
  var catRowsBox = el('div', 'splits-edit-rows'); content.appendChild(catRowsBox);
  var catRows = [];
  function nextCatId() { var mx = 0; catRows.forEach(function (r) { if (r.id > mx) mx = r.id; }); return mx + 1; }
  function addCatRow(id, name) {
    var row = el('div', 'splits-edit-row');
    var idTag = el('span', 'cat-id'); idTag.textContent = id + ' is'; row.appendChild(idTag);
    var nameIn = el('input', 'splits-edit-addr'); nameIn.type = 'text'; nameIn.placeholder = 'category name'; nameIn.value = name || '';
    var rm = el('a', 'splits-edit-rm'); rm.href = '#'; rm.textContent = '✕'; rm.title = 'Remove';
    var rec = { id: id, name: nameIn };
    rm.addEventListener('click', function (e) { e.preventDefault(); catRows = catRows.filter(function (x) { return x !== rec; }); row.remove(); });
    row.appendChild(nameIn); row.appendChild(rm);
    catRowsBox.appendChild(row); catRows.push(rec);
  }
  Object.keys(project.storeCategories || {}).map(Number).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; })
    .forEach(function (n) { addCatRow(n, project.storeCategories[n]); });
  var addCat = el('a', 'operator-cta splits-edit-add'); addCat.href = '#'; addCat.textContent = '+ Add category';
  addCat.addEventListener('click', function (e) { e.preventDefault(); addCatRow(nextCatId(), ''); }); content.appendChild(addCat);

  // Backfill socials/tagline from the live metadata (project.* doesn't carry them) so we don't wipe values.
  var loadedMeta = null;
  (function () {
    var pc = (chains[0] && chains[0].id) || project.chainId;
    clientFor(pc).readContract({ address: getAddress('JBController', pc), abi: uriOfAbi, functionName: 'uriOf', args: [BigInt(project.id)] })
      .then(function (uri) { return uri ? fetchMetadata(uri) : null; })
      .then(function (m) {
        if (!m) return; loadedMeta = m;
        if (!twitterInput.value) twitterInput.value = m.twitter || '';
        if (!discordInput.value) discordInput.value = m.discord || '';
        if (!telegramInput.value) telegramInput.value = m.telegram || '';
        if (!taglineInput.value) taglineInput.value = m.projectTagline || m.tagline || '';
      }).catch(function () {});
  })();

  var across = el('div', 'operator-edit-across'); across.style.marginTop = '12px';
  across.textContent = 'Saves across ' + chains.length + ' chain' + (chains.length > 1 ? 's' : '')
    + ': ' + chains.map(function (c) { return c.name || ('Chain ' + c.id); }).join(', ') + '.';
  content.appendChild(across);

  var jwtInput = null;
  if (!hasPinata()) {
    var jlbl = el('div', 'operator-edit-label'); jlbl.style.marginTop = '12px';
    jlbl.innerHTML = 'Pinata JWT <span class="operator-edit-hint">— to pin the updated metadata to IPFS. '
      + '<a href="https://app.pinata.cloud/developers/api-keys" target="_blank" rel="noopener">Get one</a>; stored only in this browser.</span>';
    content.appendChild(jlbl);
    jwtInput = el('input', 'operator-edit-jwt');
    jwtInput.type = 'password'; jwtInput.placeholder = 'pinata JWT'; jwtInput.autocomplete = 'off'; jwtInput.spellcheck = false;
    content.appendChild(jwtInput);
  }

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = 'Save changes';
  actions.appendChild(submit);
  content.appendChild(actions);

  var modal = openModal('Edit project', content);
  var setStatus = makeStatusSetter(status, 'operator-edit-status');
  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault();
    if (busy) return;
    if (jwtInput && jwtInput.value.trim()) setPinataJwt(jwtInput.value.trim());
    var form = {
      name: nameInput.value, tagline: taglineInput.value, description: ta.value, website: websiteInput.value,
      twitter: twitterInput.value, discord: discordInput.value, telegram: telegramInput.value,
      storeCategories: (function () { var m = {}; catRows.forEach(function (r) { var n = (r.name.value || '').trim(); if (n) m[r.id] = n; }); return m; })(),
      logoFile: (logoFile.files && logoFile.files[0]) || null, preloadedMeta: loadedMeta,
    };
    submitProjectEdit(project, chains, operatorAddr, form, setStatus, modal).catch(function (err) {
      busy = false;
      setStatus(errMessage(err, 'Edit failed'), 'error');
    });
    busy = true;
  });
}

// Shared operator-gate banner: "You must be the operator (ens-or-0x…) <action>." Resolves the ENS
// name asynchronously, falling back to the truncated address.
function operatorGateNode(authorityLabel, operatorAddr, actionText, chainId) {
  var gate = el('div', 'operator-gate');
  gate.appendChild(document.createTextNode('You must be the ' + authorityLabel + ' ('));
  var addrSpan = el('span', 'operator-gate-addr'); addrSpan.textContent = operatorAddr ? truncAddr(operatorAddr) : '…';
  if (operatorAddr) {
    addrSpan.title = operatorAddr;
    ensNameOf(operatorAddr).then(function (n) { if (n) addrSpan.textContent = n; }).catch(function () {});
  }
  gate.appendChild(addrSpan);
  gate.appendChild(document.createTextNode(') ' + actionText));
  // Safe-aware: if the owner is a Safe, the action is QUEUED for the Safe (not blocked on a single wallet).
  if (operatorAddr && chainId) {
    fetchSafeInfo(operatorAddr, chainId).then(function (info) {
      if (!info || !gate.isConnected) return;
      var acc = getAccount && getAccount();
      var isSigner = acc && info.owners.some(function (o) { return o.toLowerCase() === acc.toLowerCase(); });
      gate.className = 'operator-gate' + (isSigner ? ' ok' : '');
      gate.textContent = isSigner
        ? 'Owner is a ' + info.threshold + '-of-' + info.owners.length + ' Safe — you’re a signer, so this is proposed to the Safe’s queue (approve + execute in the Owner tab).'
        : 'Owner is a ' + info.threshold + '-of-' + info.owners.length + ' Safe (' + truncAddr(operatorAddr) + '). Connect one of its signers to propose this.';
    }).catch(function () {});
  }
  return gate;
}

// Plain text -> minimal rich-text HTML (paragraphs), matching the format other Juicebox clients render.
function descriptionTextToHtml(text) {
  var esc = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var paras = String(text || '').split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
  if (!paras.length) return '';
  return paras.map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
}

// Shared: require a connected wallet equal to the project's operator/owner. Returns the account or null.
async function ensureOperatorAccount(project, operatorAddr, setStatus) {
  var account = getAccount();
  if (!account) { setStatus('Connecting wallet…', 'pending'); account = await connect().then(getAccount).catch(function () { return null; }); }
  if (!account) { setStatus('Connect a wallet to continue', 'error'); return null; }
  if (operatorAddr && account.toLowerCase() !== operatorAddr.toLowerCase()) {
    setStatus('Connected wallet is not the ' + (projectAuthorityLabel(project) || 'operator').toLowerCase() + '. Switch to ' + truncAddr(operatorAddr) + '.', 'error');
    return null;
  }
  return account;
}

// Shared: sign one ERC-2771 call per chain, quote the relayr bundle, take one payment, poll to completion.
// buildCall(chainId) -> { to, data }. Resolves when every chain reports Success.
async function runRelayrAcrossChains(chains, account, buildCall, gas, setStatus, confirmOpts) {
  confirmOpts = confirmOpts || {};
  // Build each chain's call first so we can show the exact on-chain target + calldata before anything is signed.
  var calls = [];
  for (var i = 0; i < chains.length; i++) {
    var cid = chains[i].id;
    var call = buildCall(cid);
    if (!call || !call.to) throw new Error('No target contract on ' + (chains[i].name || cid));
    calls.push({ cid: cid, name: chains[i].name || ('chain ' + cid), to: call.to, data: call.data });
  }
  var ok = await confirmTransactionModal({
    via: 'relayr — one prepaid payment relays the same change to every chain below',
    action: confirmOpts.label || 'Cross-chain update',
    chains: calls.map(function (c) { var nm = resolveContractName(c.to, c.cid); return nm ? { chain: c.name, contract: nm, address: c.to, calldata: c.data } : { chain: c.name, contract: c.to, calldata: c.data }; }),
  }, { title: confirmOpts.title || 'Confirm cross-chain transaction', confirmText: 'Confirm & send' });
  if (!ok) { setStatus('Transaction cancelled', ''); throw new Error('Transaction cancelled'); }

  setStatus('Sign the change for ' + chains.length + ' chain' + (chains.length > 1 ? 's' : '') + '…', 'pending');
  var txs = [];
  for (var j = 0; j < calls.length; j++) {
    txs.push(await buildForwardedTx(calls[j].cid, account, calls[j].to, calls[j].data, gas || 400000n));
  }
  setStatus('Requesting relayr quote…', 'pending');
  var bundle = await relayrPostBundle(txs);
  var payments = bundle.payment_info || [];
  if (!payments.length) throw new Error('relayr returned no payment option');
  var connectedChainId = await getWalletClient().getChainId().catch(function () { return null; });
  var payment = payments.filter(function (p) { return p.chain === connectedChainId; })[0] || payments[0];
  if (payment.chain !== connectedChainId) {
    setStatus('Switch your wallet to ' + (CHAINS[payment.chain] && CHAINS[payment.chain].name || payment.chain) + ' to pay…', 'pending');
    await switchChain(payment.chain);
  }
  setStatus('Confirm the relayr payment…', 'pending');
  await relayrPay(payment);
  setStatus('Payment sent — relaying to ' + chains.length + ' chain' + (chains.length > 1 ? 's' : '') + '…', 'pending');
  await relayrPoll(bundle.bundle_uuid, function (records) {
    var done = records.filter(function (t) { return t.status && t.status.state === 'Success'; }).length;
    setStatus('Relaying… ' + done + '/' + records.length + ' chains confirmed', 'pending');
  });
}

async function submitProjectEdit(project, chains, operatorAddr, form, setStatus, modal) {
  var account = await ensureOperatorAccount(project, operatorAddr, setStatus);
  if (!account) return;
  if (!hasPinata()) { setStatus('Enter a Pinata JWT above to pin the updated metadata.', 'error'); return; }

  // Start from the live metadata so every field we don't edit (tags, payDisclosure, version, …) is preserved.
  var primaryChain = (chains[0] && chains[0].id) || project.chainId;
  var meta = form.preloadedMeta;
  if (!meta) {
    setStatus('Reading current metadata…', 'pending');
    var curUri = await clientFor(primaryChain).readContract({
      address: getAddress('JBController', primaryChain), abi: uriOfAbi, functionName: 'uriOf', args: [BigInt(project.id)],
    }).catch(function () { return null; });
    meta = curUri ? (await fetchMetadata(curUri)) : null;
  }
  meta = meta ? Object.assign({}, meta) : {};

  // New logo (if chosen) is pinned first, then referenced by the metadata JSON.
  var newLogoUri = null;
  if (form.logoFile) {
    setStatus('Pinning logo…', 'pending');
    newLogoUri = await pinFile(form.logoFile, (form.name || project.name || 'logo'));
    meta.logoUri = newLogoUri;
  }
  var trim = function (s) { return (s || '').trim(); };
  meta.name = trim(form.name);
  meta.projectTagline = trim(form.tagline);
  meta.description = descriptionTextToHtml(form.description);
  meta.infoUri = trim(form.website);
  meta.twitter = trim(form.twitter);
  meta.discord = trim(form.discord);
  meta.telegram = trim(form.telegram);
  if (form.storeCategories) { if (Object.keys(form.storeCategories).length) meta.storeCategories = form.storeCategories; else delete meta.storeCategories; }

  setStatus('Pinning updated metadata…', 'pending');
  var newUri = await pinJson(meta, (meta.name || 'project') + '-metadata');

  await runRelayrAcrossChains(chains, account, function (cid) {
    return { to: getAddress('JBController', cid), data: encodeFunctionData({ abi: setUriOfAbi, functionName: 'setUriOf', args: [BigInt(project.id), newUri] }) };
  }, 400000n, setStatus, { label: 'Edit project details', title: 'Confirm edit' });

  setStatus('Project updated across ' + chains.length + ' chain' + (chains.length > 1 ? 's' : '') + '', 'success');
  // Reflect changes in memory + the live card without a reload.
  project.name = meta.name; project.tagline = meta.projectTagline;
  project.descriptionHtml = meta.description || null; project.description = htmlToText(meta.description);
  project.infoUri = meta.infoUri || null;
  project.storeCategories = meta.storeCategories || {};
  if (newLogoUri) project.logoUri = ipfsToHttp(newLogoUri);
  var liveDesc = document.querySelector('.detail-about-desc');
  if (liveDesc) { liveDesc.innerHTML = ''; renderRichTextInto(liveDesc, meta.description); }
  var liveName = document.querySelector('.detail-name'); if (liveName && meta.name) liveName.textContent = meta.name;
  var liveLogo = document.querySelector('img.detail-logo'); if (liveLogo && project.logoUri) liveLogo.src = project.logoUri;
  setTimeout(function () { modal.close(); }, 1400);
}

// Operator-only: set the project token's name & symbol on every chain, via relayr. If the ERC-20 is
// already deployed it's renamed (setTokenMetadataOf → JBERC20.setMetadata — name/symbol ARE mutable);
// if the project still uses credits, the ERC-20 is deployed (deployERC20For) with the chosen name/symbol.
function openEditTokenModal(project) {
  var authorityLabel = (projectAuthorityLabel(project) || 'Operator').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var chains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('Chain ' + project.chainId) }];
  var deployed = !!project.tokenAddress;

  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode(authorityLabel, operatorAddr, 'to edit the token.', project.chainId));

  var nlbl = el('div', 'operator-edit-label'); nlbl.textContent = 'Token name'; content.appendChild(nlbl);
  var nameInput = el('input', 'operator-edit-jwt'); nameInput.type = 'text'; nameInput.placeholder = 'e.g. My Project Token';
  nameInput.value = project.tokenName || project.name || '';
  content.appendChild(nameInput);

  var slbl = el('div', 'operator-edit-label'); slbl.style.marginTop = '10px'; slbl.textContent = 'Symbol'; content.appendChild(slbl);
  var symInput = el('input', 'operator-edit-jwt'); symInput.type = 'text'; symInput.placeholder = 'e.g. TOKEN'; symInput.maxLength = 11;
  symInput.value = project.tokenSymbol || '';
  content.appendChild(symInput);

  var across = el('div', 'operator-edit-across');
  across.textContent = deployed
    ? 'Renames the ERC-20 on ' + chains.length + ' chain' + (chains.length > 1 ? 's' : '')
      + ': ' + chains.map(function (c) { return c.name || ('Chain ' + c.id); }).join(', ')
      + '. Only the name & symbol change — the contract address stays the same on every chain.'
    : 'Deploys one ERC-20 (same address) across ' + chains.length + ' chain' + (chains.length > 1 ? 's' : '')
      + ': ' + chains.map(function (c) { return c.name || ('Chain ' + c.id); }).join(', ') + '.';
  content.appendChild(across);

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = deployed ? 'Save token' : 'Deploy token';
  actions.appendChild(submit);
  content.appendChild(actions);

  var modal = openModal(deployed ? 'Edit token name & symbol' : 'Set token name & symbol', content);
  var setStatus = makeStatusSetter(status, 'operator-edit-status');
  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault();
    if (busy) return;
    submitTokenEdit(project, chains, operatorAddr, deployed, nameInput.value, symInput.value, setStatus, modal).catch(function (err) {
      busy = false;
      setStatus((err && (err.shortMessage || err.message)) || (deployed ? 'Edit failed' : 'Deploy failed'), 'error');
    });
    busy = true;
  });
}

async function submitTokenEdit(project, chains, operatorAddr, deployed, name, symbol, setStatus, modal) {
  name = (name || '').trim(); symbol = (symbol || '').trim();
  if (!name || !symbol) { setStatus('Enter a token name and symbol', 'error'); return; }

  // The deterministic salt makes the ERC-20 deploy to the same address on every chain.
  var salt = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [BigInt(project.id), symbol]));
  var buildCall = function (cid) {
    return deployed
      ? { to: getAddress('JBController', cid), data: encodeFunctionData({ abi: setTokenMetadataAbi, functionName: 'setTokenMetadataOf', args: [BigInt(project.id), name, symbol] }) }
      : { to: getAddress('JBController', cid), data: encodeFunctionData({ abi: deployErc20Abi, functionName: 'deployERC20For', args: [BigInt(project.id), name, symbol, salt] }) };
  };

  // If the owner is a Safe, Relayr can't sign for it — propose the call to each chain's Safe queue instead.
  var safeInfo = await fetchSafeInfo(operatorAddr, project.chainId).catch(function () { return null; });
  if (safeInfo) {
    var signer = getAccount();
    if (!signer) { setStatus('Connecting wallet…', 'pending'); signer = await connect().then(getAccount).catch(function () { return null; }); }
    if (!signer) { setStatus('Connect a wallet to continue', 'error'); return; }
    if (!safeInfo.owners.some(function (o) { return o.toLowerCase() === signer.toLowerCase(); })) {
      setStatus('Connected wallet isn’t a signer of the owner Safe (' + truncAddr(operatorAddr) + ').', 'error'); return;
    }
    var res = await proposeSafeAcrossChains(project, operatorAddr, signer, buildCall, { title: deployed ? 'Queue token rename on Safe' : 'Queue token deploy on Safe' });
    if (!res || res.cancelled) { setStatus('Cancelled', ''); return; }
    setStatus('Queued on ' + res.queued + ' chain' + (res.queued === 1 ? '' : 's') + (res.skipped.length ? ' (skipped ' + res.skipped.join(', ') + ' — add the Safe there first)' : '') + ' — confirm + execute in Back office or the Safe app.', 'success');
    setTimeout(function () { modal.close(); }, 2400);
    return;
  }

  // EOA owner → the existing Relayr cross-chain path (the wallet itself is the owner).
  var account = await ensureOperatorAccount(project, operatorAddr, setStatus);
  if (!account) return;
  await runRelayrAcrossChains(chains, account, buildCall, deployed ? 300000n : 1500000n, setStatus,
    { label: deployed ? 'Rename token' : 'Deploy ERC-20 token', title: deployed ? 'Confirm token rename' : 'Confirm token deploy' });

  setStatus((deployed ? 'Token renamed on ' : 'Token deployed across ') + chains.length + ' chain' + (chains.length > 1 ? 's' : '') + '', 'success');
  project.tokenName = name; project.tokenSymbol = symbol;
  var liveName = document.querySelector('.info-token-name'); if (liveName) liveName.textContent = name;
  var liveSym = document.querySelector('.info-token-symbol'); if (liveSym) liveSym.textContent = symbol;
  var headSym = document.querySelector('.detail-sym'); if (headSym) headSym.textContent = symbol;
  setTimeout(function () { modal.close(); }, 1400);
}

// Run a set of pre-built Relayr entries ({chain,target,data,value}) as one bundle: quote → user picks a
// pay chain → pay once → poll. Used to execute many Safe txs across chains in a single payment. Resolves
// { done, cancelled }.
function runRelayrBundle(entries, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var wrap = el('div', 'modal-body');
    var pvStatus = []; // per-chain status spans, indexed in submission order (matches relayr poll order)
    // Preview of what will run on each chain (opts.preview: [{chain,label}]), so it's not a black box.
    if (opts.preview && opts.preview.length) {
      var pv = el('div', 'relayr-preview');
      opts.preview.forEach(function (p) {
        var r = el('div', 'relayr-preview-row');
        r.appendChild(chainLogo(p.cid || 0, p.chain));
        var s = el('span'); s.textContent = ' ' + p.chain + ' '; r.appendChild(s);
        r.appendChild(boSep());
        var l = el('span', 'relayr-preview-label'); l.textContent = p.label; r.appendChild(l);
        var st = el('span', 'relayr-preview-status'); r.appendChild(st); // per-chain execution status (filled on poll)
        pvStatus.push(st);
        pv.appendChild(r);
      });
      wrap.appendChild(pv);
    }
    var status = el('div', 'modal-status pending'); status.textContent = 'Requesting a Relayr quote…'; wrap.appendChild(status);
    var choiceWrap = el('div', 'relayr-choice'); choiceWrap.style.display = 'none'; wrap.appendChild(choiceWrap);
    var foot = el('div', 'modal-foot');
    var cancel = el('button', 'create-btn ghost'); cancel.textContent = 'Cancel'; foot.appendChild(cancel);
    wrap.appendChild(foot);
    var modal = openModal(opts.title || 'Pay once, execute on all chains', wrap);
    var done = false; function finish(r) { if (done) return; done = true; modal.close(); resolve(r); }
    cancel.addEventListener('click', function () { finish({ done: false, cancelled: true }); });

    relayrPostBundle(entries).then(function (quote) {
      var options = (quote.payment_info || []).slice().sort(function (a, b) { return BigInt(a.amount) < BigInt(b.amount) ? -1 : 1; });
      if (!options.length) { status.className = 'modal-status'; status.textContent = 'Relayr returned no payment option.'; return; }
      status.className = 'modal-status';
      status.textContent = 'Pay gas once on a chain of your choice — relayers then execute on all ' + entries.length + ' chains.';
      choiceWrap.style.display = '';
      var sel = el('select', 'field create-input');
      options.forEach(function (o, i) { var op = el('option'); op.value = String(i); op.textContent = chainNameOf(o.chain) + ' — ~' + (+formatEther(BigInt(o.amount))).toFixed(5) + ' ETH'; sel.appendChild(op); });
      choiceWrap.appendChild(sel);
      var pay = el('button', 'modal-submit'); pay.textContent = 'Pay & execute'; foot.appendChild(pay);
      pay.addEventListener('click', function () {
        var o = options[Number(sel.value) || 0];
        pay.disabled = true; cancel.disabled = true; sel.disabled = true;
        (async function () {
          try {
            status.className = 'modal-status pending';
            var wallet = getWalletClient(); var cur = await wallet.getChainId().catch(function () { return null; });
            if (cur !== o.chain) { status.textContent = 'Switching to ' + chainNameOf(o.chain) + '…'; await switchChain(o.chain); }
            status.textContent = 'Confirm the payment in your wallet…';
            var payHash = await relayrPay(o);
            status.textContent = 'Paid | ' + truncAddr(payHash) + ' — relayers executing on each chain…';
            await relayrPoll(quote.bundle_uuid, function (txList) {
              // Relayr returns results in submission order → index maps to our preview rows.
              (txList || []).forEach(function (t, i) {
                if (!pvStatus[i]) return;
                var s = t.status && t.status.state;
                if (s === 'Success' || s === 'Completed') { pvStatus[i].textContent = 'done'; pvStatus[i].className = 'relayr-preview-status ok'; }
                else if (s === 'Failed') { pvStatus[i].textContent = 'failed'; pvStatus[i].className = 'relayr-preview-status err'; }
                else { pvStatus[i].textContent = 'executing…'; pvStatus[i].className = 'relayr-preview-status pending'; }
              });
              var n = (txList || []).filter(function (t) { return t.status && (t.status.state === 'Success' || t.status.state === 'Completed'); }).length;
              status.textContent = 'Executing… ' + n + '/' + entries.length;
            });
            status.className = 'modal-status success'; status.textContent = 'Executed on ' + entries.length + ' chains.';
            document.dispatchEvent(new CustomEvent('jb:bridge-updated'));
            setTimeout(function () { finish({ done: true }); }, 1600);
          } catch (e) { pay.disabled = false; cancel.disabled = false; sel.disabled = false; status.className = 'modal-status'; status.textContent = (e && (e.shortMessage || e.message)) || String(e); }
        })();
      });
    }).catch(function (e) { status.className = 'modal-status'; status.textContent = 'Relayr quote failed: ' + ((e && e.message) || e); });
  });
}

// Open a Safe-proposal modal: per chain, show the decoded call + a nonce picker, queue on each chain the
// Safe is actually deployed on (same address), and clearly flag chains where it isn't yet. Resolves with
// { queued, skipped:[names], cancelled }.
function proposeSafeAcrossChains(project, safe, signer, buildCall, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
    var wrap = el('div', 'modal-body');
    var intro = el('div', 'modal-balance');
    intro.textContent = 'Review and queue this on each chain’s Safe. Pick the nonce per chain — reusing a nonce already in the queue replaces that pending transaction.';
    wrap.appendChild(intro);
    if (chains.length > 1) {
      var sigBanner = el('div', 'create-banner');
      sigBanner.textContent = 'Your wallet will prompt once per chain — ' + chains.length + ' signatures, one for each chain’s Safe.';
      wrap.appendChild(sigBanner);
    }
    var listEl = el('div', 'safe-propose-list'); wrap.appendChild(listEl);
    var status = el('div', 'modal-status'); wrap.appendChild(status);
    var foot = el('div', 'modal-foot');
    var cancel = el('button', 'create-btn ghost'); cancel.textContent = 'Cancel';
    var btn = el('button', 'modal-submit'); btn.textContent = 'Sign & queue';
    foot.appendChild(cancel); foot.appendChild(btn); wrap.appendChild(foot);
    var modal = openModal(opts.title || 'Queue on Safe', wrap);
    var done = false;
    function finish(res) { if (done) return; done = true; modal.close(); resolve(res); }

    var rows = [];
    chains.forEach(function (c) {
      var call = buildCall(c.id);
      var block = el('div', 'safe-propose-chain');
      var head = el('div', 'safe-propose-head'); head.appendChild(chainLogo(c.id, c.name)); var nm = el('span'); nm.textContent = ' ' + c.name; head.appendChild(nm); block.appendChild(head);
      block.appendChild(renderTxReview({ chain: c.name, contract: resolveContractName(call.to, c.id) || call.to, address: call.to, calldata: call.data, value: '0' }));
      var nrow = el('div', 'safe-propose-nonce');
      var nlbl = el('span', 'safe-propose-noncelbl'); nlbl.textContent = 'Nonce '; nrow.appendChild(nlbl);
      var nInput = el('input', 'safe-nonce-input'); nInput.type = 'number'; nInput.min = '0'; nInput.disabled = true; nInput.placeholder = '…'; nrow.appendChild(nInput);
      var hint = el('span', 'safe-propose-hint'); hint.textContent = ' checking Safe…'; nrow.appendChild(hint);
      block.appendChild(nrow);
      listEl.appendChild(block);
      var rec = { cid: c.id, chain: c.name, to: call.to, data: call.data, deployed: false, nInput: nInput };
      rows.push(rec);

      fetchSafeInfo(safe, c.id).then(function (info) {
        var isSigner = info && info.owners.some(function (o) { return o.toLowerCase() === signer.toLowerCase(); });
        if (!info) {
          block.classList.add('safe-propose-skip');
          hint.innerHTML = '';
          var w = el('span'); w.textContent = ' Safe not deployed on ' + c.name + ' — '; hint.appendChild(w);
          var a = document.createElement('a'); a.href = safeHomeLink(c.id, safe); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'add it (same address) in the Safe app ↗'; hint.appendChild(a);
          var w2 = el('span'); w2.textContent = ', then reopen. Skipped for now.'; hint.appendChild(w2);
          return;
        }
        if (!isSigner) { block.classList.add('safe-propose-skip'); hint.textContent = ' You’re not a signer of this Safe — skipped.'; return; }
        rec.deployed = true; nInput.disabled = false;
        return Promise.all([getSafeNextNonce(c.id, safe), listPendingSafeTxs(c.id, safe).catch(function () { return []; })]).then(function (r) {
          var next = r[0] || 0;
          var queued = (r[1] || []).map(function (t) { return Number(t.nonce); }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
          var def = queued.length ? Math.max(next, queued[queued.length - 1] + 1) : next;
          nInput.value = String(def);
          hint.textContent = queued.length ? (' next: ' + def + ' | queued: #' + queued.join(', #') + ' (reuse one to replace it)') : (' next nonce: ' + def);
        });
      }).catch(function () { block.classList.add('safe-propose-skip'); hint.textContent = ' Could not read the Safe here — skipped.'; });
    });

    cancel.addEventListener('click', function () { finish({ queued: 0, skipped: [], cancelled: true }); });
    btn.addEventListener('click', function () {
      var live = rows.filter(function (r) { return r.deployed; });
      var skipped = rows.filter(function (r) { return !r.deployed; }).map(function (r) { return r.chain; });
      if (!live.length) { status.textContent = 'The owner Safe isn’t deployed on any selected chain yet (or you’re not a signer). Add it on those chains in the Safe app first.'; return; }
      btn.disabled = true; cancel.disabled = true;
      (async function () {
        var queued = 0;
        try {
          for (var i = 0; i < live.length; i++) {
            var r = live[i];
            status.className = 'modal-status pending';
            status.textContent = 'Queueing on ' + r.chain + ' (' + (i + 1) + '/' + live.length + ') — sign in your wallet…';
            var nonce = Number(r.nInput.value);
            if (!(nonce >= 0)) throw new Error('Enter a valid nonce for ' + r.chain);
            await proposeSafeTx({ chainId: r.cid, safe: safe, to: r.to, data: r.data, value: 0, signer: signer, nonce: nonce });
            queued++;
          }
          document.dispatchEvent(new CustomEvent('jb:safe-queued'));
          status.className = 'modal-status success';
          status.textContent = 'Queued on ' + queued + ' chain' + (queued > 1 ? 's' : '') + (skipped.length ? ' | skipped ' + skipped.join(', ') : '') + '.';
          setTimeout(function () { finish({ queued: queued, skipped: skipped, cancelled: false }); }, 1600);
        } catch (e) {
          btn.disabled = false; cancel.disabled = false; status.className = 'modal-status';
          status.textContent = (e && (e.shortMessage || e.message)) || String(e);
        }
      })();
    });
  });
}

// A label-over-value cell for the onchain info grid.
function infoItem(label, valueNode) {
  var item = el('div', 'detail-info-item');
  var lbl = el('div', 'detail-info-label'); lbl.textContent = label; item.appendChild(lbl);
  var val = el('div', 'detail-info-value');
  if (typeof valueNode === 'string') val.textContent = valueNode; else val.appendChild(valueNode);
  item.appendChild(val);
  return item;
}

// ── Skeleton loaders ────────────────────────────────────────────────────────
// Ghost blocks that shimmer in the same layout the real data will fill — graceful, low-jank loading.
function skel(w, h, cls) {
  var b = el('div', 'skel' + (cls ? ' ' + cls : ''));
  if (w) b.style.width = w;
  if (h) b.style.height = h;
  return b;
}
// Whole-page detail ghost — mirrors renderProjectDetail's layout (header + two columns) so a direct
// project-route load shows the page shape immediately instead of a blank screen during the fetch.
function renderDetailSkeleton() {
  var wrap = el('div', 'project-detail detail-spacious');
  var back = el('button', 'detail-back'); back.textContent = '←'; back.title = 'Back to projects';
  back.addEventListener('click', function () { showProjectGrid(false); });
  wrap.appendChild(back);

  // Header: logo + two lines (name, then a wider subtitle) — kept minimal to avoid a noisy stack.
  var header = el('div', 'project-detail-header');
  var top = el('div', 'detail-head-top');
  top.appendChild(skel('64px', '64px'));
  var titleCol = el('div', 'detail-head-titlecol');
  titleCol.style.flex = '1'; titleCol.style.minWidth = '0'; // skel blocks are % width, so the column needs to claim the row
  titleCol.appendChild(skel('38%', '22px'));
  var tg = skel('64%', '12px'); tg.style.marginTop = '10px'; titleCol.appendChild(tg);
  top.appendChild(titleCol);
  header.appendChild(top);
  wrap.appendChild(header);

  var cols = el('div', 'project-detail-columns');

  // Left column: the Pay card as ONE block + a couple activity rows (avatar + single line).
  var left = el('div', 'project-detail-left');
  var payGhost = el('div', 'detail-card'); payGhost.appendChild(skel('100%', '170px')); left.appendChild(payGhost);
  var actGhost = el('div'); actGhost.style.marginTop = '22px';
  for (var a = 0; a < 3; a++) {
    var row = el('div'); row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '10px'; row.style.margin = '14px 0';
    var av = skel('24px', '24px', 'skel-circle'); av.style.flex = '0 0 24px'; row.appendChild(av);
    row.appendChild(skel((58 - a * 8) + '%', '12px'));
    actGhost.appendChild(row);
  }
  left.appendChild(actGhost);
  cols.appendChild(left);

  // Right column: tab row + 3 price chips + one big chart block (dropped the noisy range-button row).
  var right = el('div', 'project-detail-right');
  var tabs = el('div', 'project-detail-tabs');
  for (var i = 0; i < 4; i++) { var t = skel('56px', '14px'); t.style.marginRight = '20px'; tabs.appendChild(t); }
  right.appendChild(tabs);
  var content = el('div', 'project-detail-content');
  var chips = el('div'); chips.style.display = 'flex'; chips.style.gap = '10px';
  for (var k = 0; k < 3; k++) { chips.appendChild(skel('32%', '46px')); }
  content.appendChild(chips);
  var chart = skel('100%', '320px'); chart.style.marginTop = '16px'; content.appendChild(chart);
  right.appendChild(content);
  cols.appendChild(right);
  wrap.appendChild(cols);
  return wrap;
}
// Ops-style table ghost: real header text up top, shimmer cells below (You / Settlement).
function skelOpsTable(headers, nRows) {
  var table = el('div', 'detail-ops-table skel-table');
  var head = el('div', 'detail-ops-row detail-ops-head');
  headers.forEach(function (h) { var c = el('span', 'detail-ops-cell'); c.textContent = h; head.appendChild(c); });
  table.appendChild(head);
  for (var i = 0; i < nRows; i++) {
    var row = el('div', 'detail-ops-row');
    headers.forEach(function (_, j) { var c = el('span', 'detail-ops-cell'); c.appendChild(skel(j === 0 ? '52%' : '60%', '11px')); row.appendChild(c); });
    table.appendChild(row);
  }
  return table;
}
// Owner-distribution ghost: a donut placeholder beside the holder table.
function skelOwnersDistribution() {
  var w = el('div', 'owners-distribution');
  var panel = el('div', 'owners-chart-panel');
  var donut = skel('170px', '170px', 'skel-circle'); donut.style.margin = '0 auto';
  panel.appendChild(donut);
  w.appendChild(panel);
  var wrap = el('div', 'owners-table-wrap');
  var table = el('div', 'owners-table');
  var head = el('div', 'owners-row owners-head');
  ['Account', 'Share', 'Chains', 'Paid'].forEach(function (h) { var c = el('span'); c.textContent = h; head.appendChild(c); });
  table.appendChild(head);
  for (var i = 0; i < 4; i++) {
    var row = el('div', 'owners-row');
    ['58%', '40%', '34%', '48%'].forEach(function (cw) { var c = el('span'); c.appendChild(skel(cw, '11px')); row.appendChild(c); });
    table.appendChild(row);
  }
  wrap.appendChild(table); w.appendChild(wrap);
  return w;
}
// Activity-feed ghost rows (avatar circle + meta + description). Returns a fragment to drop into the feed.
function skelActivityRows(n) {
  var frag = document.createDocumentFragment();
  for (var i = 0; i < n; i++) {
    var row = el('div', 'activity-row');
    var av = skel('24px', '24px', 'skel-circle'); av.style.flex = '0 0 24px'; av.style.marginTop = '2px';
    row.appendChild(av);
    var main = el('div', 'activity-main');
    main.appendChild(skel('26%', '9px'));
    var d = skel((62 - (i % 3) * 9) + '%', '11px'); d.style.marginTop = '7px'; main.appendChild(d);
    row.appendChild(main);
    frag.appendChild(row);
  }
  return frag;
}
// Generic class-driven table ghost (Auto issue / Bridges / Movement).
function skelGenericTable(tableCls, rowCls, headCls, headers, widths, nRows) {
  var table = el('div', tableCls);
  var head = el('div', rowCls + ' ' + headCls);
  headers.forEach(function (h) { var c = el('span'); c.textContent = h; head.appendChild(c); });
  table.appendChild(head);
  for (var i = 0; i < nRows; i++) {
    var row = el('div', rowCls);
    widths.forEach(function (cw) { var c = el('span'); c.appendChild(skel(cw, '11px')); row.appendChild(c); });
    table.appendChild(row);
  }
  return table;
}

// Friendly labels for the activity event-type filter (keyed by the `type` set in activityRowFromEvent).
var ACTIVITY_TYPE_LABELS = {
  pay: 'Payments', cash_out: 'Cash outs', bridge: 'Bridges', payout: 'Payouts',
  reserved: 'Reserved distributions', auto_issue: 'Auto-issuance', borrow: 'Loans',
  repay: 'Loan repayments', liquidate: 'Liquidations', mint_nft: 'NFT mints',
  deploy_erc20: 'Token deploys', create: 'Project creation', add_to_balance: 'Add to balance',
  queue_ruleset: 'Ruleset changes',
};
function activityTypeLabel(t) { return ACTIVITY_TYPE_LABELS[t] || String(t || 'activity').replace(/_/g, ' '); }

// A native <select> sizes to its WIDEST option, so a short selected label leaves a big gap before the
// caret. Shrink the select to fit just the selected option's text (+ room for the custom caret).
function fitSelectWidth(sel) {
  var opt = sel.options[sel.selectedIndex];
  if (!opt) return;
  var cs = getComputedStyle(sel);
  var meas = document.createElement('span');
  meas.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
  meas.style.fontFamily = cs.fontFamily; meas.style.fontSize = cs.fontSize;
  meas.style.fontWeight = cs.fontWeight; meas.style.letterSpacing = cs.letterSpacing;
  meas.textContent = opt.text;
  document.body.appendChild(meas);
  var w = meas.getBoundingClientRect().width;
  document.body.removeChild(meas);
  sel.style.width = (Math.ceil(w) + 15) + 'px';
}

// Multi-select chain filter for the activity feed: a caret trigger that opens a checkbox popover, one
// row per chain the project is deployed on. `selected()` returns null when all (or none) are checked
// — the caller treats null as "no chain filter". onChange fires on every toggle.
// Generic checkbox-dropdown multi-select for the activity filters. config:
//   { allLabel, unit, trigger: 'logos'|'text', onChange }
// items (set via setItems) are { value, label, logo?:()=>node }. Defaults to all-selected; `selected()`
// returns null when all (or none) are checked — the caller treats null as "no filter". Selections are
// preserved by value across setItems() calls so a post-tx refresh doesn't reset the user's picks.
function makeMultiselect(config) {
  var items = [];
  var sel = {};
  var wrap = el('div', 'activity-ms');
  var trigger = el('button', 'activity-filter-select activity-ms-trigger');
  var menu = el('div', 'activity-chain-menu'); menu.style.display = 'none';
  wrap.appendChild(trigger); wrap.appendChild(menu);

  function count() { var n = 0; items.forEach(function (it) { if (sel[it.value]) n++; }); return n; }
  function isAll() { var n = count(); return n === 0 || n === items.length; }
  function refreshTrigger() {
    var chosen = isAll() ? items : items.filter(function (it) { return sel[it.value]; });
    trigger.title = isAll() ? config.allLabel : (chosen.length === 1 ? chosen[0].label : chosen.length + ' ' + config.unit);
    trigger.innerHTML = '';
    if (config.trigger === 'logos') {
      var stack = el('span', 'activity-chain-stack');
      chosen.forEach(function (it, i) {
        var logo = it.logo ? it.logo() : el('span');
        logo.style.position = 'relative';
        logo.style.zIndex = String(chosen.length - i); // leftmost on top
        stack.appendChild(logo);
      });
      trigger.appendChild(stack);
    } else {
      trigger.textContent = isAll() ? config.allLabel : (chosen.length === 1 ? chosen[0].label : chosen.length + ' ' + config.unit);
    }
  }
  function buildMenu() {
    menu.innerHTML = '';
    var all = el('label', 'activity-chain-opt activity-chain-all');
    var allCb = el('input', ''); allCb.type = 'checkbox'; allCb.checked = count() === items.length;
    allCb.addEventListener('change', function () {
      items.forEach(function (it) { sel[it.value] = allCb.checked; });
      buildMenu(); refreshTrigger(); config.onChange();
    });
    all.appendChild(allCb);
    var allTxt = el('span', ''); allTxt.textContent = config.allLabel; all.appendChild(allTxt);
    menu.appendChild(all);
    items.forEach(function (it) {
      var row = el('label', 'activity-chain-opt');
      var cb = el('input', ''); cb.type = 'checkbox'; cb.checked = !!sel[it.value];
      cb.addEventListener('change', function () { sel[it.value] = cb.checked; refreshTrigger(); config.onChange(); allCb.checked = count() === items.length; });
      row.appendChild(cb);
      if (it.logo) row.appendChild(it.logo());
      var nm = el('span', ''); nm.textContent = it.label; row.appendChild(nm);
      menu.appendChild(row);
    });
  }
  function outside(e) { if (!wrap.contains(e.target)) close(); }
  function open() { buildMenu(); menu.style.display = 'block'; document.addEventListener('mousedown', outside); }
  function close() { menu.style.display = 'none'; document.removeEventListener('mousedown', outside); }
  trigger.addEventListener('click', function (e) {
    e.preventDefault();
    if (menu.style.display === 'none') open(); else close();
  });

  refreshTrigger();
  return {
    el: wrap,
    setItems: function (newItems) {
      var prev = sel;
      items = newItems;
      sel = {};
      items.forEach(function (it) { sel[it.value] = (it.value in prev) ? prev[it.value] : true; });
      refreshTrigger();
    },
    selected: function () {
      if (isAll()) return null;
      return items.filter(function (it) { return sel[it.value]; }).map(function (it) { return it.value; });
    },
  };
}

function renderActivityCard(project, opts) {
  var card = el('div', 'detail-card');
  // Header row: title on the left, filter controls right-aligned.
  var head = el('div', 'activity-head');
  var title = el('div', 'detail-card-title');
  // When the card IS the "Activity" subtab (phones), the tab already says ACTIVITY — name the card "Recent".
  title.textContent = (opts && opts.asTab) ? 'Recent' : 'Activity';
  head.appendChild(title);
  // Filter controls (chain + event-type combos). Hidden until rows load and there's >1 value to pick.
  // Chain filter is a MULTI-select over every chain the project is deployed on; type is single-select.
  var filters = el('div', 'activity-filters'); filters.style.display = 'none';
  var typeMs = makeMultiselect({ allLabel: 'All', unit: 'events', trigger: 'text', onChange: function () { applyFilters(); } });
  var chainMs = makeMultiselect({ allLabel: 'All chains', unit: 'chains', trigger: 'logos', onChange: function () { applyFilters(); } });
  // Chain options follow the canonical order (DISCOVER_CHAINS / the project "On:" logos), deduped.
  var projChainIds = orderedProjectChainIds(project);
  chainMs.setItems(projChainIds.map(function (id) {
    return { value: id, label: chainById(id).name, logo: function () { return chainLogo(id, chainById(id).name); } };
  }));
  filters.appendChild(typeMs.el);
  filters.appendChild(chainMs.el);
  head.appendChild(filters);
  card.appendChild(head);

  var body = el('div', 'activity-feed');
  body.appendChild(skelActivityRows(5));
  card.appendChild(body);

  var allRows = [];

  function rebuildFilterOptions() {
    var types = [];
    allRows.forEach(function (r) { if (types.indexOf(r.type) === -1) types.push(r.type); });
    typeMs.setItems(types.map(function (t) { return { value: t, label: activityTypeLabel(t) }; }));
    typeMs.el.style.display = types.length > 1 ? '' : 'none';
    var multiChain = projChainIds.length > 1;
    chainMs.el.style.display = multiChain ? '' : 'none';
    filters.style.display = (multiChain || types.length > 1) ? '' : 'none';
  }

  function applyFilters() {
    var chainsSel = chainMs.selected(); // null = all chains
    var typesSel = typeMs.selected();   // null = all events
    // Type filter is per-row; group across chains FIRST so each merged row keeps its FULL chain set,
    // then keep groups that fired on at least one selected chain — the row still shows every chain it
    // ran on (including chains not in the filter), since the point is "this happened on my chain(s)".
    var typed = allRows.filter(function (r) { return !typesSel || typesSel.indexOf(r.type) !== -1; });
    var rows = groupActivityRows(typed).filter(function (g) {
      return !chainsSel || g.chains.some(function (c) { return chainsSel.indexOf(c.chainId) !== -1; });
    });
    body.innerHTML = '';
    if (!rows.length) {
      body.className = 'detail-card-body activity-empty';
      body.textContent = allRows.length ? 'No activity matches this filter.' : 'No indexed V6 activity yet.';
      return;
    }
    body.className = 'activity-feed';
    rows.forEach(function (row) { body.appendChild(renderActivityRow(row, project)); });
  }

  // Load the sucker map first so the feed can relabel under-the-hood sucker cash-outs as bridges.
  // `keepOnEmpty` (used by refreshes) leaves existing rows in place when a refetch returns nothing
  // yet — the indexer lags the chain by a few seconds after a tx confirms.
  function load(keepOnEmpty) {
    return fetchProjectSuckerMap(project).then(function (map) {
      project._suckerMap = map;
      return fetchProjectActivity(project);
    }).then(function (rows) {
      if (!body.isConnected) return rows;
      if (!rows.length) {
        if (keepOnEmpty) return rows;
        allRows = [];
        filters.style.display = 'none';
        body.innerHTML = '';
        body.className = 'detail-card-body activity-empty';
        body.textContent = 'No indexed V6 activity yet.';
        return rows;
      }
      allRows = rows;
      rebuildFilterOptions();
      applyFilters();
      return rows;
    }).catch(function () {
      if (!body.isConnected || keepOnEmpty) return [];
      body.className = 'detail-card-body activity-empty';
      body.textContent = 'Could not load activity from Bendystraw.';
      return [];
    });
  }

  // Refresh after a tx confirms. The indexer trails the chain, so retry a few times with backoff
  // until a new top row appears (or the attempts run out).
  card._refresh = function () {
    var before = body.querySelector('.activity-row');
    var beforeKey = before ? before.getAttribute('data-tx') : null;
    var attempt = 0;
    function poll() {
      attempt++;
      load(true).then(function () {
        var first = body.querySelector('.activity-row');
        var changed = first && first.getAttribute('data-tx') !== beforeKey;
        if (!changed && attempt < 5 && body.isConnected) setTimeout(poll, 2500);
      });
    }
    poll();
  };

  load(false);
  return card;
}

// Canonical chain display order — matches DISCOVER_CHAINS (the project "On:" logos and the filter).
// Chains not in the active network list sort last (by id) so nothing is ever dropped.
function chainOrderIndex(chainId) {
  for (var i = 0; i < DISCOVER_CHAINS.length; i++) if (DISCOVER_CHAINS[i].id === Number(chainId)) return i;
  return DISCOVER_CHAINS.length + Number(chainId);
}
// Project's chain ids in canonical order, deduped (project.chains is already DISCOVER_CHAINS-ordered).
function orderedProjectChainIds(project) {
  var ids = (project.chains || []).map(function (c) { return c.id; });
  if (!ids.length && project.chainId) ids = [Number(project.chainId)];
  var seen = {};
  return ids.filter(function (id) { if (seen[id]) return false; seen[id] = true; return true; })
    .sort(function (a, b) { return chainOrderIndex(a) - chainOrderIndex(b); });
}

// Collapse the same logical event replicated across chains (omnichain project creation, token deploy,
// etc.) into ONE row carrying many chain bubbles. Two rows merge when every display field matches AND
// they're on DIFFERENT chains — so genuinely-distinct same-chain events stay separate. Rows arrive
// timestamp-desc; first-fit bucketing preserves that order and the merged row shows the latest time.
function groupActivityRows(rows) {
  var buckets = {}, order = [];
  rows.forEach(function (r) {
    var key = [r.type, (r.account || r.from || '').toLowerCase(), r.action, r.tokenAmount || '', r.baseAmount || '', r.memo || ''].join('|');
    var list = buckets[key] || (buckets[key] = []);
    var g = null;
    for (var i = 0; i < list.length; i++) { if (!list[i]._seen[r.chainId]) { g = list[i]; break; } }
    if (!g) { g = { row: r, chains: [], _seen: {}, timestamp: r.timestamp }; list.push(g); order.push(g); }
    g.chains.push({ chainId: r.chainId, txHash: r.txHash });
    g._seen[r.chainId] = true;
    if (Number(r.timestamp) > Number(g.timestamp)) g.timestamp = r.timestamp;
  });
  order.forEach(function (g) { g.chains.sort(function (a, b) { return chainOrderIndex(a.chainId) - chainOrderIndex(b.chainId); }); });
  order.sort(function (a, b) { return Number(b.timestamp) - Number(a.timestamp); });
  return order.map(function (g) { g.row.chains = g.chains; g.row.timestamp = g.timestamp; return g.row; });
}

// A chain logo that links to this event's tx on that chain's explorer (plain logo if no explorer/tx).
function chainTxBubble(chainId, txHash) {
  var logo = chainLogo(chainId, chainById(chainId).name + (txHash ? ' — view transaction' : ''));
  var url = txUrl(chainId, txHash);
  if (!url) return logo;
  var a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.className = 'activity-chain-link';
  a.appendChild(logo);
  return a;
}

// A chain logo that links to an address on that chain's explorer (plain logo if no explorer/address).
function chainAddrBubble(chainId, address) {
  var logo = chainLogo(chainId, chainById(chainId).name + (address ? ' — view on explorer' : ''));
  var base = CHAINS[chainId] && CHAINS[chainId].blockExplorers && CHAINS[chainId].blockExplorers.default && CHAINS[chainId].blockExplorers.default.url;
  if (!base || !address) return logo;
  var a = document.createElement('a');
  a.href = base.replace(/\/$/, '') + '/address/' + address;
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.className = 'activity-chain-link';
  a.appendChild(logo);
  return a;
}

function renderActivityRow(row, project) {
  var item = el('div', 'activity-row');
  var chains = (row.chains && row.chains.length) ? row.chains : [{ chainId: row.chainId, txHash: row.txHash }];
  // Identity key for refresh diffing — all tx hashes in this (possibly merged) row.
  item.setAttribute('data-tx', chains.map(function (c) { return (c.txHash || '') + ':' + c.chainId; }).join(','));
  var avatar = el('span', 'activity-avatar');
  avatar.style.background = identGradient(row.account || row.from || row.txHash || String(row.timestamp || '0'));
  item.appendChild(avatar);

  var main = el('div', 'activity-main');
  var meta = el('div', 'activity-meta');
  // Single chain: the time itself links to the tx. Multiple: time is plain text (bubbles carry the links).
  if (chains.length === 1) {
    meta.appendChild(renderExplorerTxLink(chains[0].chainId, chains[0].txHash, timeAgo(row.timestamp)));
  } else {
    var t = el('span', 'activity-time'); t.textContent = timeAgo(row.timestamp); meta.appendChild(t);
  }
  var side = el('span', 'activity-side');
  if (row.baseAmount) {
    var amt = el('span', 'activity-base-amount');
    amt.textContent = row.baseAmount;
    side.appendChild(amt);
  }
  // Only fund flows get an in/out tag: IN = inbound payments & fees, OUT = outbound funds
  // (cash outs, loans). Token-only events (issuance, reserved, ERC20 deploy, project create) get none.
  if (row.direction === 'in' || row.direction === 'out') {
    var tag = el('span', 'activity-tag activity-tag--' + row.direction);
    tag.textContent = row.direction;
    side.appendChild(tag);
  }
  // One chain bubble per chain this event fired on, each linking to its own tx — packed side-by-side.
  var chainsWrap = el('span', 'activity-chains');
  chains.forEach(function (c) { chainsWrap.appendChild(chainTxBubble(c.chainId, c.txHash)); });
  side.appendChild(chainsWrap);
  meta.appendChild(side);
  main.appendChild(meta);

  var line = el('div', 'activity-line');
  // Until the ERC-20 is deployed, the project's tokens are non-transferable credits — say so.
  var unit = (project.tokenSymbol || 'tokens') + (project.tokenAddress ? '' : ' credits');
  if (row.system) {
    // No actor (synthesized from chain state, e.g. ruleset queueing) — the action stands alone.
    line.appendChild(document.createTextNode(row.action + (row.tokenAmount ? (' ' + row.tokenAmount + ' ' + unit) : '')));
  } else {
    line.appendChild(addressNode(row.account || row.from));
    line.appendChild(document.createTextNode(' ' + row.action + (row.tokenAmount ? (' ' + row.tokenAmount + ' ' + unit) : '')));
  }
  main.appendChild(line);

  if (row.memo) {
    var memo = el('div', 'activity-memo');
    memo.textContent = row.memo;
    main.appendChild(memo);
  }

  item.appendChild(main);
  return item;
}

function activityRowFromEvent(event, project) {
  var sym = project.tokenSymbol || 'tokens';
  var acct = project.acctToken || { decimals: 18, symbol: 'ETH' }; // amounts are in the accounting token
  var chainId = Number(event.chainId);
  if (event.payEvent) {
    var pay = event.payEvent;
    var minted = toBigInt(pay.newlyIssuedTokenCount);
    return {
      type: 'pay',
      direction: 'in',
      chainId: chainId,
      txHash: pay.txHash || event.txHash,
      timestamp: Number(pay.timestamp || event.timestamp),
      account: pay.beneficiary || event.from || pay.from,
      from: pay.from || event.from,
      // Show the raw token paid (ETH or USDC), inferred from amount vs USD since the event omits the token.
      baseAmount: inferActivityAmount(pay.amount, pay.amountUsd, acct),
      tokenAmount: minted > 0n ? formatCompactTokenAmount(minted) : '',
      action: minted > 0n ? 'got' : 'paid into ' + sym,
      memo: pay.memo || '',
    };
  }
  if (event.cashOutTokensEvent) {
    var cash = event.cashOutTokensEvent;
    // A sucker cashes out under the hood when it bridges (prepare()). Relabel that as a bridge so users
    // don't see a confusing "cashed out" — the cash-out is an internal abstraction. Detect by the actor
    // being one of the project's local suckers; the map value is the destination chain.
    // Bendystraw may set `from` to the EOA caller while holder/beneficiary are the sucker — so test ALL.
    // Key by this event's chain (suckers share addresses across chains; the remote differs per source chain).
    var smap = (project._suckerMap && project._suckerMap[chainId]) || {};
    var bridgeRemote = null, bridgeActor = null;
    [cash.holder, cash.beneficiary, cash.from, event.from].forEach(function (cand) {
      if (bridgeRemote == null && cand && smap[cand.toLowerCase()] != null) { bridgeRemote = smap[cand.toLowerCase()]; bridgeActor = cand; }
    });
    if (bridgeRemote != null) {
      return {
        type: 'bridge', direction: 'out', chainId: chainId,
        txHash: cash.txHash || event.txHash, timestamp: Number(cash.timestamp || event.timestamp),
        account: bridgeActor, from: bridgeActor, baseAmount: '', tokenAmount: '',
        // This event is the bridge PREPARE (the under-the-hood cash-out) — the tokens are queued, not yet
        // shipped. The actual send happens on toRemote (tracked in the Movement table). Label accordingly.
        action: 'sending ' + formatCompactTokenAmount(toBigInt(cash.cashOutCount)) + ' ' + sym + ' to ' + moveChainName(bridgeRemote),
        memo: '',
      };
    }
    return {
      type: 'cash_out',
      direction: 'out',
      chainId: chainId,
      txHash: cash.txHash || event.txHash,
      timestamp: Number(cash.timestamp || event.timestamp),
      account: cash.beneficiary || cash.holder || cash.from || event.from,
      from: cash.from || event.from,
      baseAmount: inferActivityAmount(cash.reclaimAmount, cash.reclaimAmountUsd, acct),
      tokenAmount: formatCompactTokenAmount(toBigInt(cash.cashOutCount)),
      action: 'cashed out',
      memo: '',
    };
  }
  if (event.mintTokensEvent) {
    // mintTokensOf fires for pays too; only surface the ones a SUCKER caller minted — those are the
    // destination side of a bridge ("received from {source}"). Skip the rest (pays already show via payEvent).
    var mt = event.mintTokensEvent;
    var msmap = (project._suckerMap && project._suckerMap[chainId]) || {};
    var mintCaller = (mt.caller || mt.from || event.from || '').toLowerCase();
    var bridgeSrc = msmap[mintCaller];
    if (bridgeSrc == null) return null;
    return {
      type: 'bridge', direction: 'in', chainId: chainId,
      txHash: mt.txHash || event.txHash, timestamp: Number(mt.timestamp || event.timestamp),
      account: mt.beneficiary || event.from, from: mt.beneficiary || event.from, baseAmount: '', tokenAmount: '',
      action: 'got ' + formatCompactTokenAmount(toBigInt(mt.beneficiaryTokenCount)) + ' ' + sym + ' from ' + moveChainName(bridgeSrc),
      memo: '',
    };
  }
  if (event.sendPayoutsEvent) {
    var po = event.sendPayoutsEvent;
    return {
      type: 'payout', direction: 'out', chainId: chainId,
      txHash: po.txHash || event.txHash, timestamp: Number(po.timestamp || event.timestamp),
      account: po.caller || po.from || event.from, from: po.from || event.from,
      baseAmount: formatActivityAmount(po.amountPaidOut || po.amount, acct.symbol, acct.decimals),
      tokenAmount: '', action: 'paid out', memo: '',
    };
  }
  if (event.sendReservedTokensToSplitsEvent) {
    var rs = event.sendReservedTokensToSplitsEvent;
    return {
      type: 'reserved', direction: '', chainId: chainId,
      txHash: rs.txHash || event.txHash, timestamp: Number(rs.timestamp || event.timestamp),
      account: rs.from || event.from, from: rs.from || event.from,
      baseAmount: '', tokenAmount: formatCompactTokenAmount(toBigInt(rs.tokenCount)),
      action: 'distributed reserved', memo: '',
    };
  }
  if (event.autoIssueEvent) {
    var ai = event.autoIssueEvent;
    return {
      // Token-only mint (no fund flow) → no in/out tag, like issuance/reserved.
      type: 'auto_issue', direction: null, chainId: chainId,
      txHash: ai.txHash || event.txHash, timestamp: Number(ai.timestamp || event.timestamp),
      account: ai.beneficiary || ai.from || event.from, from: ai.from || event.from,
      baseAmount: '', tokenAmount: formatCompactTokenAmount(toBigInt(ai.count)),
      action: 'auto-issued', memo: '',
    };
  }
  if (event.borrowLoanEvent) {
    var bo = event.borrowLoanEvent;
    return {
      type: 'borrow', direction: 'out', chainId: chainId,
      txHash: bo.txHash || event.txHash, timestamp: Number(bo.timestamp || event.timestamp),
      account: bo.beneficiary || bo.from || event.from, from: bo.from || event.from,
      baseAmount: formatActivityAmount(bo.borrowAmount, acct.symbol, acct.decimals),
      tokenAmount: '', action: 'borrowed against ' + formatCompactTokenAmount(toBigInt(bo.collateral)) + ' ' + sym, memo: '',
    };
  }
  if (event.repayLoanEvent) {
    var rp = event.repayLoanEvent;
    return {
      type: 'repay', direction: 'in', chainId: chainId,
      txHash: rp.txHash || event.txHash, timestamp: Number(rp.timestamp || event.timestamp),
      account: rp.from || event.from, from: rp.from || event.from,
      baseAmount: formatActivityAmount(rp.repayBorrowAmount, acct.symbol, acct.decimals),
      tokenAmount: '', action: 'repaid loan', memo: '',
    };
  }
  if (event.liquidateLoanEvent) {
    var lq = event.liquidateLoanEvent;
    return {
      type: 'liquidate', direction: 'out', chainId: chainId,
      txHash: lq.txHash || event.txHash, timestamp: Number(lq.timestamp || event.timestamp),
      account: lq.from || event.from, from: lq.from || event.from,
      baseAmount: formatActivityAmount(lq.borrowAmount, acct.symbol, acct.decimals),
      tokenAmount: '', action: 'loan liquidated', memo: '',
    };
  }
  if (event.mintNftEvent) {
    var nft = event.mintNftEvent;
    return {
      type: 'mint_nft', direction: 'in', chainId: chainId,
      txHash: nft.txHash || event.txHash, timestamp: Number(nft.timestamp || event.timestamp),
      account: nft.beneficiary || nft.from || event.from, from: nft.from || event.from,
      baseAmount: formatActivityAmount(nft.totalAmountPaid, acct.symbol, acct.decimals),
      tokenAmount: '', action: 'minted NFT (tier ' + nft.tierId + ')', memo: '',
    };
  }
  if (event.deployErc20Event) {
    var dep = event.deployErc20Event;
    return {
      type: 'deploy_erc20', direction: '', chainId: chainId,
      txHash: dep.txHash || event.txHash, timestamp: Number(dep.timestamp || event.timestamp),
      account: dep.from || event.from, from: dep.from || event.from,
      baseAmount: '', tokenAmount: '',
      action: 'deployed token ' + (dep.symbol || ''), memo: '',
    };
  }
  if (event.projectCreateEvent) {
    var pc = event.projectCreateEvent;
    return {
      type: 'create', direction: '', chainId: chainId,
      txHash: pc.txHash || event.txHash, timestamp: Number(pc.timestamp || event.timestamp),
      account: pc.from || event.from, from: pc.from || event.from,
      baseAmount: '', tokenAmount: '', action: 'created the project', memo: '',
    };
  }
  if (event.addToBalanceEvent) {
    var atb = event.addToBalanceEvent;
    return {
      // Inbound funds with no token mint → IN tag, no token amount.
      type: 'add_to_balance', direction: 'in', chainId: chainId,
      txHash: atb.txHash || event.txHash, timestamp: Number(atb.timestamp || event.timestamp),
      account: atb.from || event.from, from: atb.from || event.from,
      baseAmount: formatActivityAmount(atb.amount, acct.symbol, acct.decimals),
      tokenAmount: '', action: 'added to balance', memo: atb.memo || '',
    };
  }
  var label = String(event.type || 'activity').replace(/_/g, ' ').toLowerCase();
  return {
    type: label,
    direction: '',
    chainId: chainId,
    txHash: event.txHash,
    timestamp: Number(event.timestamp),
    account: event.from,
    from: event.from,
    baseAmount: '',
    tokenAmount: '',
    action: label,
    memo: '',
  };
}


var WEIGHT_CUT_DEN = 1000000000; // 1e9

// Full decoded ruleset rows grouped by section. r = ruleset tuple, m = decoded metadata tuple.
function rulesetRows(r, m) {
  return [
    ['CYCLE', 'Duration', Number(r.duration) ? formatDuration(r.duration) : 'Not set'],
    ['CYCLE', 'Start time', formatStartTime(r.start)],
    ['CYCLE', 'Rule change deadline', (r.approvalHook && r.approvalHook !== ZERO_ADDRESS) ? truncAddr(r.approvalHook) : 'No deadline'],
    ['TOKEN', 'Total issuance rate', (Number(r.weight) === 0 ? '0' : formatAmount(r.weight, 18)) + ' / ' + (Number(m.baseCurrency) === 2 ? 'USD' : 'ETH')],
    ['TOKEN', 'Reserved rate', percentFromRuleset(m.reservedPercent)],
    ['TOKEN', 'Issuance cut percent', (Number(r.weightCutPercent) / 1e7).toFixed(2) + '%'],
    ['TOKEN', 'Cash out tax rate', percentFromRuleset(m.cashOutTaxRate)],
    ['TOKEN', 'Cash outs use total surplus', m.useTotalSurplusForCashOuts ? 'Enabled' : 'Disabled'],
    ['TOKEN', 'Base currency', Number(m.baseCurrency) === 2 ? 'USD' : 'ETH'],
    ['TOKEN', 'Owner token minting', m.allowOwnerMinting ? 'Enabled' : 'Disabled'],
    ['TOKEN', 'Token transfers', m.pauseCreditTransfers ? 'Disabled' : 'Enabled'],
    ['OTHER RULES', 'Payments to this project', m.pausePay ? 'Disabled' : 'Enabled'],
    ['OTHER RULES', 'Hold fees', m.holdFees ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Owner must send payouts', m.ownerMustSendPayouts ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Set payment terminals', m.allowSetTerminals ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Set controller', m.allowSetController ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Migrate payment terminal', m.allowTerminalMigration ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Set custom token', m.allowSetCustomToken ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Add accounting context', m.allowAddAccountingContext ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Add price feed', m.allowAddPriceFeed ? 'Enabled' : 'Disabled'],
    ['EXTENSION', 'Data hook', (m.dataHook && m.dataHook !== ZERO_ADDRESS) ? truncAddr(m.dataHook) : 'None'],
    ['EXTENSION', 'Use for payments', m.useDataHookForPay ? 'Enabled' : 'Disabled'],
    ['EXTENSION', 'Use for cash outs', m.useDataHookForCashOut ? 'Enabled' : 'Disabled'],
  ];
}

function formatDateTime(sec) {
  try { return new Date(Number(sec) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch (e) { return '—'; }
}

// Coarse single-unit relative time, word form: "2 days" / "3 hours" / "1 minute".
function relativeFromNow(secs) {
  var s = Math.max(0, Number(secs));
  if (s >= 86400) { var d = Math.round(s / 86400); return d + (d === 1 ? ' day' : ' days'); }
  if (s >= 3600) { var h = Math.round(s / 3600); return h + (h === 1 ? ' hour' : ' hours'); }
  var m = Math.max(1, Math.round(s / 60)); return m + (m === 1 ? ' minute' : ' minutes');
}

// Start time: a future start (upcoming / projected cycles) leads with "In <relative>", with the absolute
// date alongside; a past/current start shows the absolute date only.
function formatStartTime(sec) {
  var s = Number(sec); var now = Math.floor(Date.now() / 1000);
  return s > now ? ('In ' + relativeFromNow(s - now) + ' (' + formatDateTime(s) + ')') : formatDateTime(s);
}

// Date only (no time) — e.g. "Feb 20, 2025" — for compact table cells.
function formatDateShort(sec) {
  try { return new Date(Number(sec) * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' }); }
  catch (e) { return '—'; }
}

// Project a ruleset to a cycle offset by decaying/un-decaying weight per cycle (rules unchanged).
function cycleRuleset(r, offset) {
  var cut = Number(r.weightCutPercent);
  var dur = Number(r.duration);
  var factor = Math.pow((WEIGHT_CUT_DEN - cut) / WEIGHT_CUT_DEN, offset);
  var w = BigInt(Math.round(Number(r.weight) * factor));
  return {
    cycleNumber: Math.max(1, Number(r.cycleNumber) + offset),
    id: r.id, basedOnId: r.basedOnId,
    start: BigInt(Number(r.start) + offset * dur),
    duration: r.duration, weight: w, weightCutPercent: r.weightCutPercent,
    approvalHook: r.approvalHook, metadata: r.metadata,
  };
}

// "Rulesets & Funds" tab for owned (non-revnet) projects.
function renderRulesetsFundsSection(project) {
  var section = el('div', 'detail-section');
  if (!project.ruleset || !project.metadata) {
    section.appendChild(emptyCard('Rulesets', 'No active ruleset found onchain.'));
    return section;
  }
  var cur = { r: project.ruleset, m: project.metadata };
  var upcoming = null; // {r, m} once fetched
  var curRows = rulesetRows(cur.r, cur.m);

  // Per-cycle funds-access limits (payout limit + surplus allowance), keyed by ruleset id and cached
  // so stepping back and forth doesn't re-read. Config is per-ruleset, so it tracks the displayed cycle.
  var faPid = BigInt(project.id);
  var faTerminal = getAddress('JBMultiTerminal', project.chainId);
  var faLimits = getAddress('JBFundAccessLimits', project.chainId);
  var faSplits = getAddress('JBSplits', project.chainId);
  var faKindsP = acctKindsForFunds(project); // funds access + payout splits are per accounting context
  var faHome = project.chainId;
  var faCache = {};
  // Reserved-token splits are token-agnostic (group 1) — one set per ruleset.
  function loadReservedSplits(rid) {
    var key = 'res:' + rid;
    if (faCache[key]) return faCache[key];
    faCache[key] = faSplits ? read(faHome, 'JBSplits', splitsOfAbi, 'splitsOf', [faPid, BigInt(rid), RESERVED_TOKEN_SPLIT_GROUP]).catch(function () { return []; }) : Promise.resolve([]);
    return faCache[key];
  }
  // Per-accounting-context funds access (payout limit + surplus allowance) + that token's payout splits.
  function loadFundsAccessForKind(rid, kind) {
    var tok = kind.addrForChain(faHome);
    var key = rid + ':' + kind.key;
    if (faCache[key]) return faCache[key];
    if (!(faLimits && faTerminal) || !tok) { faCache[key] = Promise.resolve(null); return faCache[key]; }
    var payoutGroup = BigInt(tok); // payout split group = uint256(uint160(token))
    var fmt = function (v) { return formatBalance(v, kind.decimals, kind.symbol); };
    faCache[key] = Promise.all([
      read(faHome, 'JBFundAccessLimits', payoutLimitsAbi, 'payoutLimitsOf', [faPid, BigInt(rid), faTerminal, tok]).catch(function () { return []; }),
      read(faHome, 'JBFundAccessLimits', surplusAllowancesAbi, 'surplusAllowancesOf', [faPid, BigInt(rid), faTerminal, tok]).catch(function () { return []; }),
      faSplits ? read(faHome, 'JBSplits', splitsOfAbi, 'splitsOf', [faPid, BigInt(rid), payoutGroup]).catch(function () { return []; }) : Promise.resolve([]),
    ]).then(function (r) {
      var BIG = 2n ** 200n, pc = 0n, ac = 0n;
      (r[0] || []).forEach(function (l) { if (kind.matchCur(l.currency, faHome)) pc += l.amount; });
      (r[1] || []).forEach(function (l) { if (kind.matchCur(l.currency, faHome)) ac += l.amount; });
      return {
        payout: pc >= BIG ? 'Unlimited' : (pc === 0n ? 'None' : fmt(pc)),
        allowance: ac >= BIG ? 'Unlimited' : (ac === 0n ? 'None' : fmt(ac)),
        payoutSplits: r[2] || [],
        payoutGroupId: payoutGroup,
      };
    });
    return faCache[key];
  }

  // ---- Rulesets viewer ----
  var rulesCard = el('div', 'detail-card');
  var headRow = el('div', 'rf-head');
  var headLeft = el('div', 'rf-headleft');
  var hTitle = el('div', 'detail-card-title'); hTitle.textContent = 'Rulesets'; hTitle.style.borderBottom = 'none'; hTitle.style.margin = '0';
  headLeft.appendChild(hTitle);
  var chainCtl = el('span', 'rf-chainctl'); headLeft.appendChild(chainCtl);
  headRow.appendChild(headLeft);
  // Queue a new ruleset (owner/operator-gated inside the modal).
  var queueBtn = el('button', 'detail-check-btn rf-queue-btn'); queueBtn.textContent = 'Queue ruleset';
  queueBtn.addEventListener('click', function () { openQueueRulesetModal(project); });
  headRow.appendChild(queueBtn);
  // The carousel arrows live inside the title (below) — the title itself is the cycle stepper.
  var prevBtn = document.createElement('button'); prevBtn.className = 'rf-arrow'; prevBtn.textContent = '←'; prevBtn.title = 'Earlier cycle';
  var nextBtn = document.createElement('button'); nextBtn.className = 'rf-arrow'; nextBtn.textContent = '→'; nextBtn.title = 'Later cycle';
  rulesCard.appendChild(headRow);

  var tiles = el('div', 'rf-titlebar'); rulesCard.appendChild(tiles);
  var rulesBox = el('div', 'rf-rulesbox'); rulesCard.appendChild(rulesBox);
  section.appendChild(rulesCard);

  var offset = 0; // 0 = current; 1 = upcoming; ± = projected cycles

  function viewAt(off) {
    if (off <= 0) {
      var base = cur;
      return { r: off === 0 ? base.r : cycleRuleset(base.r, off), m: base.m, projected: off !== 0 };
    }
    // off >= 1: base on the upcoming ruleset when available, else project the current one.
    if (upcoming) {
      return { r: off === 1 ? upcoming.r : cycleRuleset(upcoming.r, off - 1), m: upcoming.m, projected: off > 1 };
    }
    return { r: cycleRuleset(cur.r, off), m: cur.m, projected: true };
  }

  function render() {
    var v = viewAt(offset);
    var now = Math.floor(Date.now() / 1000);
    var cycleCtx = offset === 0 ? 'Current' : (offset === 1 ? 'Upcoming' : (offset > 0 ? 'Projected (+' + offset + ')' : 'Projected (' + offset + ')'));
    var remaining = '—';
    if (offset === 0 && Number(v.r.duration) > 0) {
      var end = Number(v.r.start) + Number(v.r.duration);
      remaining = end > now ? formatCountdown(end - now) : 'Ended';
    } else if (Number(v.r.duration) > 0) {
      remaining = formatDuration(v.r.duration);
    }
    // Title-like header that doubles as the cycle carousel: "← Cycle #1 Current →".
    var statusTxt = (v.r.approvalHook && v.r.approvalHook !== ZERO_ADDRESS) ? 'Approval hook' : 'Unlocked';
    var remLabel = offset === 0 ? 'Remaining' : 'Duration';
    tiles.innerHTML = '';
    // 2-col grid: ← arrow in col 1 (centered against the title line); the cycle line + meta in col 2,
    // so the meta aligns under "Cycle #N" (not under the arrow) while both arrows center on the title.
    var tmain = el('div', 'rf-title-main');
    tmain.appendChild(prevBtn);
    var tline = el('div', 'rf-title-line');
    var big = el('span', 'rf-title-cycle'); big.textContent = 'Cycle #' + String(v.r.cycleNumber); tline.appendChild(big);
    var ctxEl = el('span', 'rf-title-ctx'); ctxEl.textContent = cycleCtx; tline.appendChild(ctxEl);
    tline.appendChild(nextBtn);
    tmain.appendChild(tline);
    var meta = el('div', 'rf-title-meta');
    var st = el('span'); st.textContent = statusTxt; meta.appendChild(st);
    meta.appendChild(boSep());
    var rm = el('span'); rm.textContent = remLabel + ': ' + remaining; meta.appendChild(rm);
    // Ruleset ID — the on-chain id (queue timestamp). Only real for an actual ruleset (projected cycles have id 0).
    if (Number(v.r.id) > 0) { meta.appendChild(boSep()); var idEl = el('span'); idEl.textContent = 'ID: ' + String(v.r.id); meta.appendChild(idEl); }
    tmain.appendChild(meta);
    tiles.appendChild(tmain);

    // Can't project earlier than the first cycle — disable the back arrow at cycle #1.
    prevBtn.disabled = Number(v.r.cycleNumber) <= 1;
    // No real next cycle when this ruleset doesn't auto-cycle (duration 0) AND no distinct upcoming is
    // queued — don't let the user step into a phantom "Cycle #N". (`upcoming` null = not yet fetched.)
    var autoCycles = Number(v.r.duration) > 0;
    var hasQueuedUpcoming = upcoming && upcoming.r && Number(upcoming.r.id) !== 0;
    nextBtn.disabled = offset >= 0 && !autoCycles && upcoming !== null && !(offset === 0 && hasQueuedUpcoming);

    // Rules detail (with diff vs current when not the current cycle).
    rulesBox.innerHTML = '';
    var rows = rulesetRows(v.r, v.m);
    // Group rows by section. Sections are placed into two columns by NAME (not round-robin) so the
    // split sub-sections sit with their parents: RESERVED TOKEN SPLITS under TOKEN, PAYOUT SPLITS under
    // FUNDS ACCESS. A single full-width list would strand each value ~1500px from its label.
    var groups = [], gIdx = {};
    rows.forEach(function (row, i) {
      var g = gIdx[row[0]];
      if (g === undefined) { g = gIdx[row[0]] = groups.length; groups.push({ name: row[0], items: [] }); }
      groups[g].items.push({ row: row, i: i });
    });
    var byName = {}; groups.forEach(function (g) { byName[g.name] = g; });
    var grid = el('div', 'rf-grid'); rulesBox.appendChild(grid);
    var leftCol = el('div', 'rf-col'); grid.appendChild(leftCol);
    var rightCol = el('div', 'rf-col'); grid.appendChild(rightCol);
    var placed = {};
    function renderGroup(col, name) {
      var g = byName[name]; if (!g) return; placed[name] = true;
      var sh = el('div', 'rf-section'); sh.textContent = g.name; col.appendChild(sh);
      g.items.forEach(function (it) {
        // Start time always differs cycle-to-cycle (it's the cycle's own start), so the red before-value is
        // just noise — show ONLY the green new value (highlighted) for a non-current cycle, plain otherwise.
        if (it.row[1] === 'Start time') {
          col.appendChild(offset !== 0 ? rfNewRow(it.row[1], it.row[2]) : kvRow(it.row[1], it.row[2]));
        } else {
          var changed = offset !== 0 && curRows[it.i] && curRows[it.i][2] !== it.row[2];
          col.appendChild(changed ? rfDiffRow(it.row[1], curRows[it.i][2], it.row[2]) : kvRow(it.row[1], it.row[2]));
        }
      });
    }

    // Split sub-section header + recipient box (filled async by loadFundsAccess).
    function splitsSection(col, title) {
      var sh = el('div', 'rf-section'); sh.textContent = title; col.appendChild(sh);
      var box = el('div'); box.appendChild(kvRow('Recipients', '…')); col.appendChild(box);
      return { sh: sh, box: box };
    }
    // Subtle "Edit" CTA under a splits section (operator-gated inside the modal).
    function splitEditLink(col, onClick) {
      var foot = el('div', 'detail-about-foot'); foot.style.marginTop = '6px';
      var a = el('a', 'operator-cta'); a.href = '#'; a.textContent = 'Edit';
      a.addEventListener('click', function (e) { e.preventDefault(); onClick(); });
      foot.appendChild(a); col.appendChild(foot);
      return foot;
    }

    // LEFT: CYCLE | OTHER RULES | FUNDS ACCESS (+ payout splits beneath it).
    renderGroup(leftCol, 'CYCLE');
    renderGroup(leftCol, 'OTHER RULES');
    // LEFT FUNDS ACCESS — one "<TOKEN> FUNDS ACCESS" section per accounting context (USDC, ETH, …):
    // payout limit + surplus allowance + that token's payout splits. Filled async once kinds resolve.
    var faContainer = el('div', 'rf-fa'); faContainer.appendChild(kvRow('Payout limit per cycle', '…')); leftCol.appendChild(faContainer);

    // RIGHT: TOKEN (+ reserved token splits beneath it) | EXTENSION.
    renderGroup(rightCol, 'TOKEN');
    var rs = splitsSection(rightCol, 'RESERVED TOKEN SPLITS'); var rsBox = rs.box;
    var rsReserved = null;
    splitEditLink(rightCol, function () {
      openEditSplitsModal(project, { groupId: RESERVED_TOKEN_SPLIT_GROUP, title: 'Edit reserved recipients', prefill: rsReserved || undefined, gateText: 'to edit reserved recipients.', note: 'Editing reserved token recipients for this ruleset cycle.' });
    });
    renderGroup(rightCol, 'EXTENSION');
    // Any section rulesetRows adds in future that we didn't place explicitly → left column.
    groups.forEach(function (g) { if (!placed[g.name]) renderGroup(leftCol, g.name); });

    function fillSplits(box, splits) {
      box.innerHTML = '';
      var sum = 0;
      (splits || []).forEach(function (sp) {
        var pct = Number(sp.percent) / 1e9 * 100; sum += pct;
        box.appendChild(splitConfigRow(splitAccountNode(sp, project, project.chainId), pct));
      });
      var leftover = 100 - sum;
      if (!splits || !splits.length || leftover > 0.0001) {
        var oNode = el('span'); oNode.textContent = 'Project’s owner';
        if (project.owner) { oNode.innerHTML = ''; oNode.appendChild(addressNode(project.owner, project.chainId)); }
        box.appendChild(splitConfigRow(oNode, (splits && splits.length) ? leftover : 100));
      }
    }

    // Reserved-token splits (single, token-agnostic).
    loadReservedSplits(v.r.id).then(function (splits) { rsReserved = splits; fillSplits(rsBox, splits); }).catch(function () { rsBox.innerHTML = ''; });

    // Per-accounting-context funds access + payout splits.
    faKindsP.then(function (kinds) {
      faContainer.innerHTML = '';
      if (!kinds.length) { faContainer.remove(); return; }
      kinds.forEach(function (kind) {
        var secHead = el('div', 'rf-section'); secHead.textContent = kind.symbol + ' FUNDS ACCESS'; faContainer.appendChild(secHead);
        var faPayout = kvRow('Payout limit per cycle', '…'); faContainer.appendChild(faPayout);
        var faAllow = kvRow('Surplus allowance', '…'); faContainer.appendChild(faAllow);
        var psSh = el('div', 'rf-section'); psSh.textContent = kind.symbol + ' PAYOUT SPLITS'; faContainer.appendChild(psSh);
        var psBox = el('div'); psBox.appendChild(kvRow('Recipients', '…')); faContainer.appendChild(psBox);
        var foot = el('div', 'detail-about-foot'); foot.style.marginTop = '6px';
        var editA = el('a', 'operator-cta'); editA.href = '#'; editA.textContent = 'Edit'; foot.appendChild(editA); faContainer.appendChild(foot);
        loadFundsAccessForKind(v.r.id, kind).then(function (fa) {
          if (!fa) { secHead.remove(); faPayout.remove(); faAllow.remove(); psSh.remove(); psBox.remove(); foot.remove(); return; }
          faPayout.querySelector('.detail-ruleset-val').textContent = fa.payout;
          faAllow.querySelector('.detail-ruleset-val').textContent = fa.allowance;
          fillSplits(psBox, fa.payoutSplits);
          editA.addEventListener('click', function (e) { e.preventDefault(); openEditSplitsModal(project, { groupId: fa.payoutGroupId, title: 'Edit ' + kind.symbol + ' payout splits', prefill: fa.payoutSplits, gateText: 'to edit payout splits.', note: 'Editing ' + kind.symbol + ' payout recipients for this ruleset cycle.' }); });
        }).catch(function () { secHead.remove(); faPayout.remove(); faAllow.remove(); psSh.remove(); psBox.remove(); foot.remove(); });
      });
    }).catch(function () { faContainer.remove(); });
  }

  prevBtn.addEventListener('click', function () { if (prevBtn.disabled) return; offset -= 1; render(); });
  nextBtn.addEventListener('click', function () { if (nextBtn.disabled) return; offset += 1; ensureUpcoming(render); });

  function ensureUpcoming(cb) {
    if (upcoming !== null) { cb(); return; }
    read(project.chainId, 'JBController', upcomingRulesetAbi, 'upcomingRulesetOf', [BigInt(project.id)])
      .then(function (res) {
        // res = [ruleset, metadata]; treat a zero-id as "no distinct upcoming".
        if (res && res[0] && Number(res[0].id) !== 0) upcoming = { r: res[0], m: res[1] };
        else upcoming = false;
        cb();
      }).catch(function () { upcoming = false; cb(); });
  }

  render();
  // Resolve the upcoming ruleset up front so the next-arrow's disabled state (no real next cycle) is
  // accurate without a click — re-renders once known.
  ensureUpcoming(render);

  // Per-chain comparison: a chain dropdown if the ruleset's characteristics differ across chains,
  // else "Synced across all chains". Compares config (rules/flags), ignoring timing (start/cycle/weight).
  var pchains = project.chains || [];
  if (pchains.length > 1) {
    chainCtl.textContent = '…';
    var chainRs = {};
    chainRs[project.chainId] = cur;
    Promise.all(pchains.map(function (c) {
      if (chainRs[c.id]) return Promise.resolve();
      return read(c.id, 'JBController', currentRulesetAbi, 'currentRulesetOf', [BigInt(project.id)])
        .then(function (res) { if (res && res[0]) chainRs[c.id] = { r: res[0], m: res[1] }; }).catch(function () {});
    })).then(function () {
      var sigs = pchains.map(function (c) { return chainRs[c.id] ? rulesetSignature(chainRs[c.id].r, chainRs[c.id].m) : null; }).filter(Boolean);
      chainCtl.innerHTML = '';
      if (sigs.length > 1 && sigs.every(function (s) { return s === sigs[0]; })) {
        var syn = el('span', 'rf-synced'); syn.textContent = 'Synced across all chains'; chainCtl.appendChild(syn);
      } else {
        var sel = el('select', 'rf-chainselect');
        pchains.forEach(function (c) {
          if (!chainRs[c.id]) return;
          var o = document.createElement('option'); o.value = String(c.id); o.textContent = c.name;
          if (c.id === project.chainId) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener('change', function () {
          var cid = Number(sel.value);
          if (chainRs[cid]) { cur = chainRs[cid]; curRows = rulesetRows(cur.r, cur.m); offset = 0; upcoming = null; render(); }
        });
        chainCtl.appendChild(sel);
      }
    });
  }

  return section;
}

// Funds as its own tab (the funds card wrapped in a section).
function renderFundsSection(project) {
  var section = el('div', 'detail-section');
  section.appendChild(renderFundsCard(project));
  return section;
}

// Label a queued Safe tx by its calldata selector (the owner-only JB calls the site can propose).
var SAFE_QUEUE_LABELS = {
  '0x58178191': 'Deploy ERC-20 token',
  '0xfac3a6a2': 'Rename token',
  '0xcfaf5839': 'Send payouts',
  '0x090db2f1': 'Distribute reserved tokens',
};
// Friendly names for the JB functions we queue, keyed by decoded function name.
var SAFE_FN_LABELS = {
  deployERC20For: 'Deploy ERC-20 token', setTokenMetadataOf: 'Rename token',
  sendPayoutsOf: 'Send payouts', sendReservedTokensToSplitsOf: 'Distribute reserved tokens',
};
function labelForQueuedTx(tx) {
  // Decode via the target contract's ABI (same as the confirm modal) → real function name.
  var d = decodeCallForDisplay({ address: tx.to, calldata: tx.data });
  if (d && d.fn) return SAFE_FN_LABELS[d.fn] || d.fn;
  var sel = (tx.data || '').slice(0, 10).toLowerCase();
  return SAFE_QUEUE_LABELS[sel] || ('Contract call' + (sel ? ' ' + sel : ''));
}
// Show the FULL decoded call before a co-signer approves OR executes a queued Safe tx — the one-line label
// hides the recipient/amount/target a malicious co-signer could slip in. Folds the DELEGATECALL / ETH-value /
// unrecognized-target warnings into the same review. Returns the user's confirm/cancel as a promise.
function reviewQueuedSafeTx(cid, chainName, tx, actionLabel) {
  var nm = resolveContractName(tx.to, cid);
  var warns = [];
  if (Number(tx.operation) === 1) warns.push('⚠ DELEGATECALL — runs arbitrary code in the Safe’s own context (it can move any of the Safe’s assets).');
  var ethVal; try { ethVal = BigInt(tx.value || 0); } catch (_) { ethVal = 0n; }
  if (ethVal > 0n) warns.push('Sends ' + formatBalance(ethVal, 18, 'ETH') + ' from the Safe.');
  if (!nm) warns.push('⚠ Targets an UNRECOGNIZED contract (' + tx.to + ') — not a known Juicebox/Revnet contract. Review the raw data below before approving.');
  return confirmTransactionModal(
    { chain: chainName, contract: nm || tx.to, address: tx.to, calldata: tx.data, value: tx.value },
    { title: (actionLabel || 'Review') + ' Safe transaction #' + tx.nonce, confirmText: actionLabel || 'Confirm', description: warns.join(' ') || null }
  );
}

// Back office: a Safe-owned project's per-chain multisig queue. Signers confirm queued owner-only txs
// here (or open them in the Safe app); proposing happens from the action modals (Deploy token, etc.).
// The styled "|" separator used in the Owner tab rows.
function boSep() { var s = el('span', 'bo-sep'); s.textContent = '|'; return s; }

// Classify an owner address on a chain: Safe (read its policy/signers), EOA (no code), Known contract
// (has code + in our registry), or Unknown contract. Returns { type, safe }.
function classifyOwner(chainId, addr) {
  return fetchSafeInfo(addr, chainId).then(function (safe) {
    if (safe) return { type: 'Safe Multisig', safe: safe };
    var client = clientFor(chainId);
    if (!client) return { type: 'Unknown', safe: null };
    return client.getCode({ address: addr }).then(function (code) {
      if (!code || code === '0x') return { type: 'EOA', safe: null };
      var name = resolveContractName(addr, chainId);
      return { type: name ? ('Known contract (' + name + ')') : 'Unknown contract', safe: null };
    }).catch(function () { return { type: 'Contract', safe: null }; });
  }).catch(function () { return { type: 'Unknown', safe: null }; });
}

// A key/value row with a bold value (string or node).
function ownerKv(label, value) {
  var row = el('div', 'account-kvrow');
  var k = el('span', 'account-k'); k.textContent = label + ': '; row.appendChild(k);
  var v = el('strong', 'account-v');
  if (typeof value === 'string') v.textContent = value; else v.appendChild(value);
  row.appendChild(v);
  return row;
}

// "Account" card: the project's owner address on each chain + its type; Safe details (policy + signers) inline.
function renderAccountCard(project) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Account'; card.appendChild(title);
  var body = el('div'); body.appendChild(skel('100%', '60px')); card.appendChild(body);
  var pid = BigInt(project.id);
  var ids = orderedProjectChainIds(project);
  var chains = ids.length ? ids.map(function (id) { return { id: id, name: chainNameOf(id) }; }) : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  // For a revnet, the JBProjects owner is the REVDeployer — the controlling account is the OPERATOR; show
  // that instead. For custom projects, the owner IS the controlling account (read per chain via ownerOf).
  var isRev = project.isRevnet;
  var addrLabel = isRev ? 'Operator' : 'Owner';
  Promise.all(chains.map(function (c) {
    var ownerP = isRev ? Promise.resolve(projectAuthorityAddress(project)) : read(c.id, 'JBProjects', ownerOfAbi, 'ownerOf', [pid]).catch(function () { return null; });
    return Promise.resolve(ownerP).then(function (owner) {
      if (!owner) return { c: c, owner: null, type: '—', safe: null };
      return classifyOwner(c.id, owner).then(function (info) { return { c: c, owner: owner, type: info.type, safe: info.safe }; });
    });
  })).then(function (rows) {
    body.innerHTML = '';
    // Collapse chains that share the same owner/type/policy/signers into one entry (logos listed together).
    var groups = [], byKey = {};
    rows.forEach(function (r) {
      var key = (r.owner || '∅').toLowerCase() + '|' + r.type + '|' + (r.safe ? (r.safe.threshold + '/' + r.safe.owners.map(function (o) { return o.toLowerCase(); }).sort().join(',')) : '');
      var g = byKey[key];
      if (!g) { g = byKey[key] = { rep: r, chains: [] }; groups.push(g); }
      g.chains.push(r.c);
    });
    groups.forEach(function (g) {
      var r = g.rep;
      var block = el('div', 'account-chain');
      var head = el('div', 'account-head');
      g.chains.forEach(function (c) { head.appendChild(chainLogo(c.id, c.name)); });
      var nm = el('span', 'account-chainname'); nm.textContent = ' ' + g.chains.map(function (c) { return c.name; }).join(', '); head.appendChild(nm);
      block.appendChild(head);
      var kv = el('div', 'account-kv');
      // Truncated (click-to-copy, hover-full) so it sits inline with the label instead of wrapping to a new
      // row — the full address is one click/hover away, and Type/Safe details already identify the account.
      kv.appendChild(ownerKv(addrLabel, r.owner ? addressNode(r.owner) : document.createTextNode('—')));
      kv.appendChild(ownerKv('Type', r.type));
      if (r.safe) {
        kv.appendChild(ownerKv('Policy', 'Requires ' + r.safe.threshold + ' of ' + r.safe.owners.length + ' signatures'));
        var sv = el('span', 'account-signers');
        r.safe.owners.forEach(function (o, i) { if (i) sv.appendChild(document.createTextNode(', ')); sv.appendChild(addressNode(o, r.c.id)); });
        kv.appendChild(ownerKv('Signers', sv));
      }
      block.appendChild(kv);
      body.appendChild(block);
    });
  }).catch(function () { body.innerHTML = ''; body.textContent = 'Could not read ownership.'; });
  // Transfer the controlling account, multichain (Safe → queued; EOA → relayr).
  var foot = el('div', 'detail-about-foot');
  var xfer = el('a', 'operator-cta'); xfer.href = '#'; xfer.textContent = isRev ? 'Transfer operator' : 'Transfer ownership';
  xfer.title = isRev ? 'Hand over the operator role on every chain' : 'Transfer project ownership on every chain';
  xfer.addEventListener('click', function (e) { e.preventDefault(); openTransferAuthorityModal(project); });
  foot.appendChild(xfer); card.appendChild(foot);
  return card;
}

function renderBackOfficeSection(project) {
  var section = el('div', 'detail-section');
  var safe = projectAuthorityAddress(project);
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  // Account card: who owns the project on each chain + what kind of account it is.
  section.appendChild(renderAccountCard(project));
  section.appendChild(renderPendingSafeTxsCard(safe, chains, project.chainId, project.isRevnet ? 'Operator' : 'Owner'));

  // Powers / Permissions. Revnet: the controlling account is an OPERATOR with a fixed granted permission set
  // (not the ruleset-flag owner powers, which it doesn't hold) — show those actual powers, read-only. Custom:
  // the owner exercises the ruleset-gated owner powers (Powers card) AND can manage operators (Permissions card).
  if (project.isRevnet) {
    section.appendChild(renderPermissionsCard(project));
  } else {
    section.appendChild(renderPowersCard(project));
    section.appendChild(renderPermissionsCard(project));
  }
  return section;
}

// Reusable "Pending Multisig Transactions" card: lists each chain's Safe queue for `safe`, lets signers Sign /
// Execute per tx and Execute-all ready txs in one Relayr payment. Used by the project Owner/Operator tab and the
// protocol Admin tab. `homeChainId` is the chain used to read the Safe's signers/threshold; `contextLabel` =
// 'Owner' | 'Operator' | 'Admin' for the intro copy. Assumes the same Safe address across `chains` (the norm).
function renderPendingSafeTxsCard(safe, chains, homeChainId, contextLabel) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Pending Multisig Transactions'; card.appendChild(title);
  var intro = el('div', 'detail-card-body backoffice-intro'); card.appendChild(intro);
  var body = el('div'); body.appendChild(skel('100%', '60px')); card.appendChild(body);

  function loadQueues(info) {
    body.innerHTML = '';
    var acc = getAccount && getAccount();
    var isSigner = acc && info.owners.some(function (o) { return o.toLowerCase() === acc.toLowerCase(); });
    var batchBar = el('div', 'backoffice-batch'); body.appendChild(batchBar);
    var ready = []; // { cid, chain, tx } across all chains
    var chainLoads = chains.map(function (c) {
      var block = el('div', 'backoffice-chain');
      var h = el('div', 'backoffice-chain-head'); h.appendChild(chainLogo(c.id, c.name)); var t = el('span'); t.textContent = ' ' + c.name; h.appendChild(t);
      var ql = safeQueueLink(c.id, safe);
      if (ql) { var qa = document.createElement('a'); qa.className = 'backoffice-chain-link'; qa.href = ql; qa.target = '_blank'; qa.rel = 'noopener'; qa.textContent = '↗'; qa.title = 'Open this chain’s Safe queue'; h.appendChild(qa); }
      block.appendChild(h);
      var list = el('div', 'backoffice-list'); list.appendChild(skel('100%', '20px')); block.appendChild(list);
      body.appendChild(block);
      return listPendingSafeTxs(c.id, safe).then(function (txs) {
        list.innerHTML = '';
        if (!txs.length) {
          var none = el('div', 'backoffice-none'); none.textContent = 'No pending transactions.';
          list.appendChild(none); return;
        }
        txs.forEach(function (tx) {
          var nconf = (tx.confirmations || []).length, need = tx.confirmationsRequired || info.threshold;
          var row = el('div', 'backoffice-row');
          var main = el('div', 'backoffice-main');
          var lab = el('div', 'backoffice-label');
          var nspan = el('span'); nspan.textContent = '#' + tx.nonce; lab.appendChild(nspan);
          lab.appendChild(boSep()); var fnspan = el('span'); fnspan.textContent = labelForQueuedTx(tx); lab.appendChild(fnspan);
          main.appendChild(lab);
          var sub = el('div', 'backoffice-sub');
          sub.appendChild(document.createTextNode(nconf + '/' + need + ' signatures'));
          if (nconf >= need) { sub.appendChild(boSep()); sub.appendChild(document.createTextNode('ready to execute')); }
          // Surface the two things a label-only view hides: a DELEGATECALL (runs arbitrary code in the Safe's
          // context) and any ETH the tx sends. Both are WYSIWYS-critical before a signer approves.
          var isDelegate = Number(tx.operation) === 1;
          var ethVal = (function () { try { return BigInt(tx.value || 0); } catch (_) { return 0n; } })();
          if (isDelegate) { sub.appendChild(boSep()); var dc = el('span', 'backoffice-warn'); dc.textContent = '⚠ DELEGATECALL'; sub.appendChild(dc); }
          if (ethVal > 0n) { sub.appendChild(boSep()); sub.appendChild(document.createTextNode('sends ' + formatBalance(ethVal, 18, 'ETH'))); }
          main.appendChild(sub);
          // The full decoded review (incl. these DELEGATECALL/ETH warnings) is shown by reviewQueuedSafeTx
          // before Sign/Execute — see below.
          row.appendChild(main);
          var actions = el('div', 'backoffice-actions');
          var signed = (tx.confirmations || []).some(function (cf) { return acc && cf.owner && cf.owner.toLowerCase() === acc.toLowerCase(); });
          if (isSigner && !signed && nconf < need) {
            var signBtn = el('button', 'detail-check-btn'); signBtn.textContent = 'Sign';
            signBtn.addEventListener('click', function () {
              reviewQueuedSafeTx(c.id, c.name, tx, 'Sign').then(function (ok) {
                if (!ok) return;
                signBtn.disabled = true; signBtn.textContent = 'Signing…';
                confirmSafeTx(c.id, safe, tx, acc).then(function () { signBtn.textContent = 'Signed'; setTimeout(function () { loadQueues(info); }, 1200); })
                  .catch(function (e) { signBtn.disabled = false; signBtn.textContent = 'Sign'; alert((e && e.message) || e); });
              });
            });
            actions.appendChild(signBtn);
          } else if (signed) {
            var done = el('span', 'backoffice-signed'); done.textContent = 'You signed'; actions.appendChild(done);
          }
          // Enough signatures → execute straight from here (connected wallet sends it + pays gas).
          if (nconf >= need) {
            ready.push({ cid: c.id, chain: c.name, tx: tx });
            var execBtn = el('button', 'detail-check-btn'); execBtn.textContent = 'Execute';
            execBtn.addEventListener('click', function () {
              if (!(getAccount && getAccount())) { connect(); return; }
              reviewQueuedSafeTx(c.id, c.name, tx, 'Execute').then(function (ok) {
                if (!ok) return;
                execBtn.disabled = true; execBtn.textContent = 'Executing…';
                executeSafeTx(c.id, safe, tx).then(function () { execBtn.textContent = 'Sent'; setTimeout(function () { loadQueues(info); document.dispatchEvent(new CustomEvent('jb:bridge-updated')); }, 2000); })
                  .catch(function (e) { execBtn.disabled = false; execBtn.textContent = 'Execute'; alert((e && (e.shortMessage || e.message)) || e); });
              });
            });
            actions.appendChild(execBtn);
          }
          row.appendChild(actions);
          list.appendChild(row);
        });
      }).catch(function () {
        list.innerHTML = '';
        var er = el('div', 'backoffice-none'); er.textContent = 'Could not load the Safe queue.';
        list.appendChild(er);
      });
    });

    // Once every chain's queue has loaded, offer to execute all ready txs in ONE Relayr payment.
    Promise.all(chainLoads).then(function () {
      batchBar.innerHTML = '';
      if (ready.length < 2) return; // a single ready tx → just use its own Execute button
      var note = el('span', 'backoffice-batch-note'); note.textContent = ready.length + ' transactions ready across ' + (chains.length) + ' chains. '; batchBar.appendChild(note);
      var allBtn = el('button', 'detail-check-btn'); allBtn.textContent = 'Execute all';
      allBtn.addEventListener('click', function () {
        if (!(getAccount && getAccount())) { connect(); return; }
        var entries = ready.map(function (r) { return safeExecRelayrTx(r.cid, safe, r.tx); });
        var preview = ready.map(function (r) { return { cid: r.cid, chain: r.chain, label: labelForQueuedTx(r.tx) + ' → ' + (resolveContractName(r.tx.to, r.cid) || r.tx.to) + ' (#' + r.tx.nonce + ')' }; });
        runRelayrBundle(entries, { title: 'Execute on ' + ready.length + ' chains', preview: preview }).then(function (res) {
          if (res && res.done) loadQueues(info);
        });
      });
      batchBar.appendChild(allBtn);
    }).catch(function () {});
  }

  fetchSafeInfo(safe, homeChainId).then(function (info) {
    if (!info) { intro.textContent = 'This account isn’t a Safe — there’s no multisig queue.'; body.innerHTML = ''; return; }
    intro.textContent = contextLabel + '-only actions are proposed here per chain; signers confirm + execute.';
    loadQueues(info);
  }).catch(function () { intro.textContent = 'Could not read the Safe.'; body.innerHTML = ''; });

  // Refresh when an action queues a new tx from a modal.
  document.addEventListener('jb:safe-queued', function () {
    if (!card.isConnected) return;
    fetchSafeInfo(safe, homeChainId).then(function (info) { if (info) loadQueues(info); }).catch(function () {});
  });
  return card;
}

// ── Protocol Admin tab ──────────────────────────────────────────────────────
// The protocol admin = the account handed every Ownable infra singleton at deploy (deploy-all-v6
// `_finalizeCriticalOwnership` → `_CRITICAL_INFRA_OWNER`). Read live from JBDirectory.owner() per chain.
var ADMIN_OWNER_ABI = [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
// onlyOwner ABIs for the infra contracts the admin controls (used by the Admin tab's actionable powers).
var jbSetCreationFeeAbi = [{ type: 'function', name: 'setCreationFee', stateMutability: 'nonpayable', inputs: [{ name: 'fee', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [] }];
var jbSetTokenUriResolverAbi = [{ type: 'function', name: 'setTokenUriResolver', stateMutability: 'nonpayable', inputs: [{ name: 'resolver', type: 'address' }], outputs: [] }];
var jbSetFirstControllerAllowedAbi = [{ type: 'function', name: 'setIsAllowedToSetFirstController', stateMutability: 'nonpayable', inputs: [{ name: 'addr', type: 'address' }, { name: 'flag', type: 'bool' }], outputs: [] }];
var jbSetFeelessAddressAbi = [{ type: 'function', name: 'setFeelessAddress', stateMutability: 'nonpayable', inputs: [{ name: 'addr', type: 'address' }, { name: 'flag', type: 'bool' }], outputs: [] }];
var jbSetFeelessAddressForAbi = [{ type: 'function', name: 'setFeelessAddressFor', stateMutability: 'nonpayable', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'addr', type: 'address' }, { name: 'flag', type: 'bool' }], outputs: [] }];
var jbSetFeelessHookAbi = [{ type: 'function', name: 'setFeelessHook', stateMutability: 'nonpayable', inputs: [{ name: 'hook', type: 'address' }], outputs: [] }];
var jbAllowHookAbi = [{ type: 'function', name: 'allowHook', stateMutability: 'nonpayable', inputs: [{ name: 'hook', type: 'address' }], outputs: [] }];
var jbDisallowHookAbi = [{ type: 'function', name: 'disallowHook', stateMutability: 'nonpayable', inputs: [{ name: 'hook', type: 'address' }], outputs: [] }];
var jbSetDefaultHookAbi = [{ type: 'function', name: 'setDefaultHook', stateMutability: 'nonpayable', inputs: [{ name: 'hook', type: 'address' }], outputs: [] }];
var jbAllowTerminalAbi = [{ type: 'function', name: 'allowTerminal', stateMutability: 'nonpayable', inputs: [{ name: 'terminal', type: 'address' }], outputs: [] }];
var jbDisallowTerminalAbi = [{ type: 'function', name: 'disallowTerminal', stateMutability: 'nonpayable', inputs: [{ name: 'terminal', type: 'address' }], outputs: [] }];
var jbSetDefaultTerminalAbi = [{ type: 'function', name: 'setDefaultTerminal', stateMutability: 'nonpayable', inputs: [{ name: 'terminal', type: 'address' }], outputs: [] }];
var jbAllowSuckerDeployerAbi = [{ type: 'function', name: 'allowSuckerDeployer', stateMutability: 'nonpayable', inputs: [{ name: 'deployer', type: 'address' }], outputs: [] }];
var jbRemoveSuckerDeployerAbi = [{ type: 'function', name: 'removeSuckerDeployer', stateMutability: 'nonpayable', inputs: [{ name: 'deployer', type: 'address' }], outputs: [] }];
var jbSetToRemoteFeeAbi = [{ type: 'function', name: 'setToRemoteFee', stateMutability: 'nonpayable', inputs: [{ name: 'fee', type: 'uint256' }], outputs: [] }];
var jbAllowTokenMappingAbi = [{ type: 'function', name: 'allowTokenMapping', stateMutability: 'nonpayable', inputs: [{ name: 'localToken', type: 'address' }, { name: 'remoteChainId', type: 'uint256' }, { name: 'remoteToken', type: 'bytes32' }], outputs: [] }];
var jbRemoveTokenMappingAbi = [{ type: 'function', name: 'removeTokenMapping', stateMutability: 'nonpayable', inputs: [{ name: 'localToken', type: 'address' }, { name: 'remoteChainId', type: 'uint256' }, { name: 'remoteToken', type: 'bytes32' }], outputs: [] }];

// The Ownable infra contracts the admin owns: description `powers` bullets + actionable onlyOwner `actions`
// (proposed to the admin Safe per chain). `buildArgs(v)` → fn args; these functions take NO projectId — they
// are protocol-global (or, for JBPrices, use the DEFAULT project id 0). Field `kind`: address|uint|bool|bytes32.
var ADMIN_OWNED = [
  { label: 'Project registry (JBProjects)', contract: 'JBProjects', powers: ['Set the project-creation fee and the address that receives it.', 'Set the metadata resolver for project-ownership NFTs.'], actions: [
    { title: 'Set creation fee', actionVerb: 'Set', abi: jbSetCreationFeeAbi, fn: 'setCreationFee', gas: 120000n, danger: 'Changes the protocol-wide fee to create a project on every selected chain.', fields: [{ name: 'fee', label: 'Creation fee (wei)', kind: 'uint', placeholder: '0' }, { name: 'receiver', label: 'Fee receiver', kind: 'address', placeholder: '0x…' }], buildArgs: function (v) { return [v.fee, v.receiver]; } },
    { title: 'Set project-NFT resolver', actionVerb: 'Set', abi: jbSetTokenUriResolverAbi, fn: 'setTokenUriResolver', gas: 100000n, danger: 'Changes how project-ownership NFTs render protocol-wide.', fields: [{ name: 'resolver', label: 'Resolver', kind: 'address', placeholder: '0x… (0x0 to clear)' }], buildArgs: function (v) { return [v.resolver]; } },
  ] },
  { label: 'Directory (JBDirectory)', contract: 'JBDirectory', powers: ['Control which contracts may set a project’s first controller — i.e. which deployers the protocol trusts.'], actions: [
    { title: 'Set first-controller allowance', actionVerb: 'Set', abi: jbSetFirstControllerAllowedAbi, fn: 'setIsAllowedToSetFirstController', gas: 100000n, danger: 'Allows or revokes an address’s ability to set a NEW project’s first controller. Existing projects are unaffected.', fields: [{ name: 'addr', label: 'Address (deployer/controller)', kind: 'address', placeholder: '0x…' }, { name: 'flag', label: 'Allowed', kind: 'bool' }], buildArgs: function (v) { return [v.addr, v.flag]; } },
  ] },
  { label: 'Prices (JBPrices)', contract: 'JBPrices', powers: ['Add the protocol-default price feeds every project falls back to when converting between currencies.'], actions: [
    { title: 'Add default price feed', actionVerb: 'Added', abi: addPriceFeedAbi, fn: 'addPriceFeedFor', gas: 150000n, danger: 'Adds a DEFAULT (project 0) price feed used by every project lacking its own. A wrong feed misprices conversions, and feeds cannot be removed.', fields: [{ name: 'pricingCurrency', label: 'Pricing currency (id)', kind: 'uint', placeholder: 'e.g. 2 (USD)' }, { name: 'unitCurrency', label: 'Unit currency (id)', kind: 'uint', placeholder: 'e.g. 1 (ETH)' }, { name: 'feed', label: 'Feed', kind: 'address', placeholder: '0x… price feed' }], buildArgs: function (v) { return [0n, v.pricingCurrency, v.unitCurrency, v.feed]; } },
  ] },
  { label: 'Feeless addresses (JBFeelessAddresses)', contract: 'JBFeelessAddresses', powers: ['Mark addresses and hooks fee-exempt, protocol-wide or per project, and set the feeless hook.'], actions: [
    { title: 'Set feeless address', actionVerb: 'Set', abi: jbSetFeelessAddressAbi, fn: 'setFeelessAddress', gas: 90000n, danger: 'Waives the protocol fee for this address protocol-wide.', fields: [{ name: 'addr', label: 'Address', kind: 'address', placeholder: '0x…' }, { name: 'flag', label: 'Feeless', kind: 'bool' }], buildArgs: function (v) { return [v.addr, v.flag]; } },
    { title: 'Set feeless address for project', actionVerb: 'Set', abi: jbSetFeelessAddressForAbi, fn: 'setFeelessAddressFor', gas: 90000n, danger: 'Waives the protocol fee for this address on a specific project.', fields: [{ name: 'projectId', label: 'Project ID', kind: 'uint', placeholder: 'e.g. 1' }, { name: 'addr', label: 'Address', kind: 'address', placeholder: '0x…' }, { name: 'flag', label: 'Feeless', kind: 'bool' }], buildArgs: function (v) { return [v.projectId, v.addr, v.flag]; } },
    { title: 'Set feeless hook', actionVerb: 'Set', abi: jbSetFeelessHookAbi, fn: 'setFeelessHook', gas: 90000n, danger: 'Sets the hook consulted for feeless decisions protocol-wide.', fields: [{ name: 'hook', label: 'Hook', kind: 'address', placeholder: '0x… (0x0 to clear)' }], buildArgs: function (v) { return [v.hook]; } },
  ] },
  { label: 'Buyback hook registry (JBBuybackHookRegistry)', contract: 'JBBuybackHookRegistry', powers: ['Curate which buyback hooks are allowed and set the default hook.'], actions: [
    { title: 'Allow buyback hook', actionVerb: 'Allowed', abi: jbAllowHookAbi, fn: 'allowHook', gas: 90000n, danger: 'Adds a buyback hook to the protocol allowlist.', fields: [{ name: 'hook', label: 'Hook', kind: 'address', placeholder: '0x… hook' }], buildArgs: function (v) { return [v.hook]; } },
    { title: 'Disallow buyback hook', actionVerb: 'Disallowed', abi: jbDisallowHookAbi, fn: 'disallowHook', gas: 90000n, danger: 'Removes a buyback hook from the allowlist.', fields: [{ name: 'hook', label: 'Hook', kind: 'address', placeholder: '0x… hook' }], buildArgs: function (v) { return [v.hook]; } },
    { title: 'Set default buyback hook', actionVerb: 'Set', abi: jbSetDefaultHookAbi, fn: 'setDefaultHook', gas: 90000n, danger: 'Sets the default buyback hook.', fields: [{ name: 'hook', label: 'Hook', kind: 'address', placeholder: '0x… (0x0 to clear)' }], buildArgs: function (v) { return [v.hook]; } },
  ] },
  { label: 'Router terminal registry (JBRouterTerminalRegistry)', contract: 'JBRouterTerminalRegistry', powers: ['Curate which router terminals are allowed and set the default terminal.'], actions: [
    { title: 'Allow terminal', actionVerb: 'Allowed', abi: jbAllowTerminalAbi, fn: 'allowTerminal', gas: 90000n, danger: 'Adds a router terminal to the allowlist.', fields: [{ name: 'terminal', label: 'Terminal', kind: 'address', placeholder: '0x… terminal' }], buildArgs: function (v) { return [v.terminal]; } },
    { title: 'Disallow terminal', actionVerb: 'Disallowed', abi: jbDisallowTerminalAbi, fn: 'disallowTerminal', gas: 90000n, danger: 'Removes a router terminal from the allowlist.', fields: [{ name: 'terminal', label: 'Terminal', kind: 'address', placeholder: '0x… terminal' }], buildArgs: function (v) { return [v.terminal]; } },
    { title: 'Set default terminal', actionVerb: 'Set', abi: jbSetDefaultTerminalAbi, fn: 'setDefaultTerminal', gas: 90000n, danger: 'Sets the default router terminal.', fields: [{ name: 'terminal', label: 'Terminal', kind: 'address', placeholder: '0x… terminal' }], buildArgs: function (v) { return [v.terminal]; } },
  ] },
  { label: 'Sucker registry (JBSuckerRegistry)', contract: 'JBSuckerRegistry', powers: ['Curate which cross-chain sucker deployers are allowed.', 'Curate the allowed local↔remote token mappings projects may bridge (allow / remove token mappings).', 'Set the bridge (to-remote) fee.'], actions: [
    { title: 'Allow sucker deployer', actionVerb: 'Allowed', abi: jbAllowSuckerDeployerAbi, fn: 'allowSuckerDeployer', gas: 90000n, danger: 'Adds a cross-chain sucker deployer to the allowlist.', fields: [{ name: 'deployer', label: 'Deployer', kind: 'address', placeholder: '0x… deployer' }], buildArgs: function (v) { return [v.deployer]; } },
    { title: 'Remove sucker deployer', actionVerb: 'Removed', abi: jbRemoveSuckerDeployerAbi, fn: 'removeSuckerDeployer', gas: 90000n, danger: 'Removes a sucker deployer from the allowlist.', fields: [{ name: 'deployer', label: 'Deployer', kind: 'address', placeholder: '0x… deployer' }], buildArgs: function (v) { return [v.deployer]; } },
    { title: 'Set bridge fee', actionVerb: 'Set', abi: jbSetToRemoteFeeAbi, fn: 'setToRemoteFee', gas: 90000n, danger: 'Sets the shared to-remote (bridge) fee, capped by the contract.', fields: [{ name: 'fee', label: 'To-remote fee (wei)', kind: 'uint', placeholder: '0' }], buildArgs: function (v) { return [v.fee]; } },
    { title: 'Allow token mapping', actionVerb: 'Allowed', abi: jbAllowTokenMappingAbi, fn: 'allowTokenMapping', gas: 110000n, danger: 'Approves a specific local↔remote token route for bridging.', fields: [{ name: 'localToken', label: 'Local token', kind: 'address', placeholder: '0x… local token' }, { name: 'remoteChainId', label: 'Remote chain ID', kind: 'uint', placeholder: 'e.g. 8453' }, { name: 'remoteToken', label: 'Remote token (bytes32)', kind: 'bytes32', placeholder: '0x…(32 bytes)' }], buildArgs: function (v) { return [v.localToken, v.remoteChainId, v.remoteToken]; } },
    { title: 'Remove token mapping', actionVerb: 'Removed', abi: jbRemoveTokenMappingAbi, fn: 'removeTokenMapping', gas: 110000n, danger: 'Removes an approved local↔remote token route. Risky after bridge activity exists for that route.', fields: [{ name: 'localToken', label: 'Local token', kind: 'address', placeholder: '0x… local token' }, { name: 'remoteChainId', label: 'Remote chain ID', kind: 'uint', placeholder: 'e.g. 8453' }, { name: 'remoteToken', label: 'Remote token (bytes32)', kind: 'bytes32', placeholder: '0x…(32 bytes)' }], buildArgs: function (v) { return [v.localToken, v.remoteChainId, v.remoteToken]; } },
  ] },
  { label: 'Revnet loans (REVLoans)', contract: 'REVLoans', powers: ['Set the metadata resolver for loan NFTs.'], actions: [
    { title: 'Set loan-NFT resolver', actionVerb: 'Set', abi: jbSetTokenUriResolverAbi, fn: 'setTokenUriResolver', gas: 100000n, danger: 'Changes how loan NFTs render.', fields: [{ name: 'resolver', label: 'Resolver', kind: 'address', placeholder: '0x… (0x0 to clear)' }], buildArgs: function (v) { return [v.resolver]; } },
  ] },
];

// A copyable prompt for users to independently audit (with an AI or by hand) that the admin's powers are
// scoped and cannot drain or freeze any project's funds. Lists the owned contracts + the claims to verify.
function adminAuditPrompt() {
  return [
    'Audit the Juicebox V6 protocol admin (infrastructure owner) and verify its powers are SCOPED — that it cannot rug, drain, mint/burn, or freeze any individual project’s funds.',
    '',
    'The admin is the account handed every Ownable infrastructure singleton at deploy (deploy-all-v6 Deploy.s.sol `_finalizeCriticalOwnership` → `_CRITICAL_INFRA_OWNER`). Read it live as `JBDirectory.owner()`.',
    '',
    'Contracts the admin owns + the onlyOwner functions to review:',
    '- JBProjects: setCreationFee, setTokenUriResolver',
    '- JBDirectory: setIsAllowedToSetFirstController',
    '- JBPrices: addPriceFeedFor for the DEFAULT project id (0)',
    '- JBFeelessAddresses: setFeelessAddress, setFeelessAddressFor, setFeelessHook',
    '- JBBuybackHookRegistry: allowHook, disallowHook, setDefaultHook',
    '- JBRouterTerminalRegistry: allowTerminal, disallowTerminal, setDefaultTerminal',
    '- JBSuckerRegistry: allowSuckerDeployer(s), removeSuckerDeployer, setToRemoteFee, allowTokenMapping(s), removeTokenMapping(s)',
    '- REVLoans: setTokenUriResolver',
    'Also: the admin is the OPERATOR (not owner) of the protocol fee revnet (project #1, NANA).',
    '',
    'Verify each claim, citing the exact contract + function:',
    '1. None of these functions can move, mint, burn, or freeze an arbitrary project’s tokens or funds.',
    '2. A project’s controller, terminals, rulesets, payouts, surplus allowance, and token are governed by that project’s OWN owner/permissions — e.g. JBDirectory.setControllerOf / setTerminalsOf are project-permissioned (_requirePermission), NOT onlyOwner.',
    '3. setIsAllowedToSetFirstController only gates who may set a project’s FIRST controller (affects new projects); it cannot change an existing project’s controller.',
    '4. Identify the strongest INDIRECT levers (e.g. a wrong default price feed affecting projects relying on the default; removing an allowed sucker deployer or token mapping affecting future bridging) and assess blast radius — these are availability/mispricing risks, not direct fund theft.',
    '5. Confirm the admin is a multisig (Safe); report its threshold and signers per chain.',
    '',
    'Source: github.com/Bananapus — nana-core-v6, nana-suckers-v6, nana-buyback-hook-v6, nana-router-terminal-v6, revnet-core-v6, and deploy-all-v6. Each repo’s ADMINISTRATION.md documents its authority model.',
  ].join('\n');
}

export function renderAdminTab() {
  var c = document.getElementById('tab-admin'); if (!c) return;
  c.innerHTML = '';
  var chains = DISCOVER_CHAINS.slice();
  var wrap = el('div', 'detail-section admin-tab');
  var head = el('div', 'admin-head');
  var blurb = el('div', 'admin-blurb');
  blurb.textContent = 'The account that controls Juicebox protocol infrastructure — the Ownable singletons (project registry, directory, prices, feeless config, the buyback / router / sucker registries, revnet loans) and the protocol fee project. It governs shared infrastructure, not individual projects.';
  head.appendChild(blurb);
  var scope = el('div', 'admin-blurb');
  scope.textContent = 'These powers are scoped. The admin cannot queue rulesets, mint or burn a project’s tokens, send its payouts, spend its surplus, change its controller or terminals, or otherwise move any project’s funds — those stay under each project’s own owner and rules. The admin curates shared infrastructure and allowlists; it cannot rug a project.';
  head.appendChild(scope);
  var audit = el('a', 'admin-audit-link'); audit.href = '#'; audit.textContent = '[copy audit admin powers prompt]';
  audit.addEventListener('click', function (e) {
    e.preventDefault();
    copyText(adminAuditPrompt()).then(function () { audit.textContent = '[copied to clipboard]'; setTimeout(function () { audit.textContent = '[copy audit admin powers prompt]'; }, 2000); }).catch(function () {});
  });
  head.appendChild(audit);
  wrap.appendChild(head);

  wrap.appendChild(renderAdminAccountCard(chains));
  // The queue + powers load once we resolve the admin Safe address from the home chain's JBDirectory.owner().
  var lazy = el('div', 'admin-lazy'); wrap.appendChild(lazy);
  c.appendChild(wrap);

  var home = chains[0];
  read(home.id, 'JBDirectory', ADMIN_OWNER_ABI, 'owner', []).then(function (admin) {
    if (admin) lazy.appendChild(renderPendingSafeTxsCard(admin, chains, home.id, 'Admin'));
    lazy.appendChild(renderAdminPowersCard(admin || null, chains, home.id));
  }).catch(function () { lazy.appendChild(renderAdminPowersCard(null, chains, chains[0].id)); });
}

// Admin account per chain (address + Safe signers/policy). Reads JBDirectory.owner() — the live infra owner.
function renderAdminAccountCard(chains) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Admin account'; card.appendChild(title);
  var body = el('div'); body.appendChild(skel('100%', '60px')); card.appendChild(body);
  Promise.all(chains.map(function (c) {
    return read(c.id, 'JBDirectory', ADMIN_OWNER_ABI, 'owner', []).then(function (owner) {
      if (!owner) return { c: c, owner: null, type: '—', safe: null };
      return classifyOwner(c.id, owner).then(function (info) { return { c: c, owner: owner, type: info.type, safe: info.safe }; });
    }).catch(function () { return { c: c, owner: null, type: '—', safe: null }; });
  })).then(function (rows) {
    body.innerHTML = '';
    var groups = [], byKey = {};
    rows.forEach(function (r) {
      var key = (r.owner || '∅').toLowerCase() + '|' + r.type + '|' + (r.safe ? (r.safe.threshold + '/' + r.safe.owners.map(function (o) { return o.toLowerCase(); }).sort().join(',')) : '');
      var g = byKey[key]; if (!g) { g = byKey[key] = { rep: r, chains: [] }; groups.push(g); } g.chains.push(r.c);
    });
    groups.forEach(function (g) {
      var r = g.rep; var block = el('div', 'account-chain');
      var hd = el('div', 'account-head'); g.chains.forEach(function (cc) { hd.appendChild(chainLogo(cc.id, cc.name)); });
      var nm = el('span', 'account-chainname'); nm.textContent = ' ' + g.chains.map(function (cc) { return cc.name; }).join(', '); hd.appendChild(nm); block.appendChild(hd);
      var kv = el('div', 'account-kv');
      kv.appendChild(ownerKv('Admin', r.owner ? addressNode(r.owner, r.c.id) : document.createTextNode('—')));
      kv.appendChild(ownerKv('Type', r.type));
      if (r.safe) {
        kv.appendChild(ownerKv('Policy', 'Requires ' + r.safe.threshold + ' of ' + r.safe.owners.length + ' signatures'));
        var sv = el('span', 'account-signers');
        r.safe.owners.forEach(function (o, i) { if (i) sv.appendChild(document.createTextNode(', ')); sv.appendChild(addressNode(o, r.c.id)); });
        kv.appendChild(ownerKv('Signers', sv));
      }
      block.appendChild(kv); body.appendChild(block);
    });
  }).catch(function () { body.innerHTML = ''; body.textContent = 'Could not read the admin account.'; });
  return card;
}

function renderAdminPowersCard(adminAddr, chains, homeChainId) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Powers'; card.appendChild(title);
  var intro = el('div', 'detail-card-body backoffice-intro');
  intro.textContent = adminAddr
    ? 'What the admin can do across the protocol. Each row is an Ownable infrastructure contract the admin owns; actions are proposed to the admin Safe (or sent by the admin EOA) per chain.'
    : 'What the admin can do across the protocol. Each row is an Ownable infrastructure contract the admin owns, and what controlling it allows.';
  card.appendChild(intro);
  ADMIN_OWNED.forEach(function (o) {
    var row = el('div', 'powers-row');
    var hd = el('div', 'powers-head'); var lab = el('span', 'powers-label'); lab.textContent = o.label; hd.appendChild(lab); row.appendChild(hd);
    var list = el('div', 'perm-list');
    o.powers.forEach(function (p) { var it = el('div', 'perm-list-item'); var ds = el('span', 'perm-list-desc'); ds.textContent = p; it.appendChild(ds); list.appendChild(it); });
    row.appendChild(list);
    if (adminAddr && o.actions && o.actions.length) {
      var acts = el('div', 'admin-actions');
      o.actions.forEach(function (a) {
        var btn = el('a', 'operator-cta admin-act'); btn.href = '#'; btn.textContent = a.title;
        btn.addEventListener('click', function (e) { e.preventDefault(); openAdminPowerModal(adminAddr, chains, homeChainId, o.contract, a); });
        acts.appendChild(btn);
      });
      row.appendChild(acts);
    }
    card.appendChild(row);
  });
  // The protocol fee project (NANA, #1) is a revnet — the admin Safe is its OPERATOR (via REVOwner), not owner.
  // Operate it from that project's own Operator tab, so this row is read-only here.
  var feeRow = el('div', 'powers-row');
  var fh = el('div', 'powers-head'); var fl = el('span', 'powers-label'); fl.textContent = 'Protocol fee project'; fh.appendChild(fl); feeRow.appendChild(fh);
  var fd = el('div', 'powers-desc'); fd.textContent = 'The admin is the operator of the protocol’s fee-collecting revnet (project #1, NANA), where protocol fees accrue — holding that revnet’s operator powers. Operate it from that project’s Operator tab.'; feeRow.appendChild(fd);
  card.appendChild(feeRow);
  return card;
}

// Propose an admin (infra-owner) onlyOwner tx to the admin Safe per chain (EOA admin → one Relayr payment).
// Mirrors openPowerModal but the authority is the infra owner and the functions take no projectId.
function openAdminPowerModal(adminAddr, chains, homeChainId, contract, action) {
  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode('admin', adminAddr, 'to ' + action.title.toLowerCase() + '.', homeChainId));

  var inputs = {};
  action.fields.forEach(function (f) {
    var lab = el('div', 'operator-edit-label'); lab.style.marginTop = '12px'; lab.textContent = f.label; content.appendChild(lab);
    if (f.kind === 'bool') {
      var t = toggleRow(f.label, f.help || '', false, function () {}); content.appendChild(t);
      var cb = t.querySelector('input'); lab.remove();
      inputs[f.name] = { get: function () { return cb.checked; } };
      return;
    }
    var inp = el('input', 'operator-edit-jwt'); inp.type = 'text'; inp.placeholder = f.placeholder || ''; content.appendChild(inp);
    inputs[f.name] = { get: function () {
      var raw = (inp.value || '').trim();
      if (f.kind === 'address') { if (!isAddr(raw)) throw new Error('Enter a valid address for ' + f.label); return raw; }
      if (f.kind === 'bytes32') { if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('Enter a 32-byte hex value (0x + 64 hex) for ' + f.label); return raw; }
      if (f.kind === 'uint') { if (!/^\d+$/.test(raw)) throw new Error('Enter a whole number for ' + f.label); return BigInt(raw); }
      return raw;
    } };
  });

  var chlbl = el('div', 'operator-edit-label'); chlbl.style.marginTop = '14px'; chlbl.textContent = 'Set on'; content.appendChild(chlbl);
  var chainSelected = {}; chains.forEach(function (c) { chainSelected[c.id] = true; });
  var chainBox = el('div', 'splits-edit-chains');
  chains.forEach(function (c) {
    var r2 = el('label', 'splits-edit-chain'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
    cb.addEventListener('change', function () { chainSelected[c.id] = cb.checked; });
    r2.appendChild(cb); r2.appendChild(chainLogo(c.id, c.name)); var nm = el('span'); nm.textContent = c.name || ('Chain ' + c.id); r2.appendChild(nm);
    chainBox.appendChild(r2);
  });
  content.appendChild(chainBox);

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = action.title; actions.appendChild(submit);
  var gate = action.danger ? appendDangerGate(content, action.danger, submit, 'I’ve verified the values above and want to propose this admin action.') : null;
  content.appendChild(actions);
  var modal = openModal(action.title, content);
  function setStatus(m, k) { status.className = 'operator-edit-status' + (k ? ' ' + k : ''); status.textContent = m; }

  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault(); if (busy) return;
    if (gate && !gate.ok()) { setStatus('Tick the confirmation box to proceed.', 'error'); return; }
    busy = true;
    (async function () {
      var selected = chains.filter(function (c) { return chainSelected[c.id] !== false; });
      if (!selected.length) { setStatus('Select at least one chain', 'error'); busy = false; return; }
      var values;
      try { values = {}; action.fields.forEach(function (f) { values[f.name] = inputs[f.name].get(); }); }
      catch (err) { setStatus(err.message || String(err), 'error'); busy = false; return; }
      var buildCall = function (cid) {
        var to = getAddress(contract, cid);
        if (!to) throw new Error('No ' + contract + ' on ' + chainNameOf(cid));
        return { to: to, data: encodeFunctionData({ abi: action.abi, functionName: action.fn, args: action.buildArgs(values, cid) }) };
      };
      var shim = { owner: adminAddr, chains: selected, chainId: homeChainId, isRevnet: false };
      var res = await runAuthorityActionAcrossChains(shim, selected, adminAddr, buildCall, { label: action.title, title: action.title, gas: action.gas }, setStatus)
        .catch(function (err) { setStatus(errMessage(err, 'Failed'), 'error'); return null; });
      busy = false;
      if (!res) return;
      if (res.cancelled) { setStatus('Cancelled', ''); return; }
      if (res.relayr) { setStatus((action.actionVerb || 'Done') + ' on ' + selected.length + ' chain' + (selected.length > 1 ? 's' : '') + '.', 'success'); setTimeout(function () { modal.close(); }, 1600); return; }
      setStatus('Queued on ' + res.queued + ' chain' + (res.queued === 1 ? '' : 's') + ' — confirm + execute in the queue above.', 'success');
      setTimeout(function () { modal.close(); }, 2600);
    })();
  });
}

// Each owner power = a ruleset flag + (when enabled) a concrete tx. `open(project)` launches the action;
// `actionLabel` is the row's CTA. Disabled powers render description-only.
// `danger` = a short irreversibility/risk note shown in the card and as the modal's danger banner.
var OWNER_POWERS = [
  { key: 'allowAddAccountingContext', label: 'Add accounting tokens', desc: 'Register new tokens the project’s terminal accepts directly (e.g. an ERC-20 or USDC), with their decimals and currency.', actionLabel: 'Add accounting token', danger: 'Irreversible: once added, the terminal accepts this token forever — accounting tokens cannot be removed. Verify the token, decimals, and chains carefully.', open: function (p) { openAddAccountingContextModal(p); } },
  { key: 'allowAddPriceFeed', label: 'Add price feeds', desc: 'Add a price feed the project uses to convert between currencies (e.g. ETH↔USD).', actionLabel: 'Add price feed', danger: 'Irreversible: a price feed cannot be removed once added, and a wrong feed misprices the whole project.', open: function (p) { openPowerModal(p, POWER_ADD_PRICE_FEED); } },
  { key: 'allowOwnerMinting', label: 'Mint tokens freely', desc: 'Mint project tokens to any address without a payment.', actionLabel: 'Mint tokens', danger: 'Irreversible: minting dilutes every existing token holder and cannot be undone.', open: function (p) { openPowerModal(p, POWER_MINT); } },
  { key: 'allowSetTerminals', label: 'Set payment terminals', desc: 'Add or replace the project’s payment terminals (where funds are paid in).', actionLabel: 'Set terminals', danger: 'Dangerous: this reroutes where funds are paid in. A wrong terminal can misdirect or strand funds.', open: function (p) { openPowerModal(p, POWER_SET_TERMINALS); } },
  { key: 'allowSetController', label: 'Set controller', desc: 'Swap the controller contract that manages the project’s rulesets and tokens.', actionLabel: 'Set controller', danger: 'Dangerous: this hands control of the project’s rules and tokens to a new contract. A wrong address can permanently brick or compromise the project.', open: function (p) { openPowerModal(p, POWER_SET_CONTROLLER); } },
  { key: 'allowTerminalMigration', label: 'Migrate terminal', desc: 'Move the project’s funds to a new terminal version.', actionLabel: 'Migrate balance', danger: 'Dangerous: this moves the project’s funds to another terminal. A wrong destination can lose the funds.', open: function (p) { openPowerModal(p, POWER_MIGRATE); } },
  { key: 'allowSetCustomToken', label: 'Set custom token', desc: 'Replace the project token with a custom ERC-20.', actionLabel: 'Set token', danger: 'Irreversible: replacing the project token is permanent and affects every holder.', open: function (p) { openPowerModal(p, POWER_SET_TOKEN); } },
];

function renderPowersCard(project) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Powers'; card.appendChild(title);
  var intro = el('div', 'detail-card-body backoffice-intro');
  intro.textContent = 'What the current ruleset lets the owner do. Enabled powers can be used here; disabled ones need a ruleset change to turn on.';
  card.appendChild(intro);
  var m = project.metadata || {};
  OWNER_POWERS.forEach(function (p) {
    var on = !!m[p.key];
    var row = el('div', 'powers-row');
    var head = el('div', 'powers-head');
    var lab = el('span', 'powers-label'); lab.textContent = p.label; head.appendChild(lab);
    var st = el('span', 'powers-state ' + (on ? 'on' : 'off')); st.textContent = on ? 'Enabled' : 'Disabled'; head.appendChild(st);
    row.appendChild(head);
    var desc = el('div', 'powers-desc'); desc.textContent = p.desc; row.appendChild(desc);
    if (on && p.danger) { var w = el('div', 'powers-warn'); w.textContent = p.danger; row.appendChild(w); }
    if (on && p.open) {
      var act = el('a', 'operator-cta powers-act'); act.href = '#'; act.textContent = p.actionLabel;
      act.addEventListener('click', function (e) { e.preventDefault(); p.open(project); });
      row.appendChild(act);
    }
    card.appendChild(row);
  });
  return card;
}

// Every operator the project has authorized, deduped across chains. Source is bendystraw (no on-chain way to
// ENUMERATE operators — only to check a known one). Stale empty grants (permissions cleared but row kept) are
// dropped. Returns [{ operator, account, isRevnetOperator, chains:[id], permsUnion:[ids] }].
async function fetchPermissionOperators(project) {
  var chainIds = projectBendystrawChainIds(project);
  if (!chainIds.length) return [];
  var data = await bendystrawQuery(BENDYSTRAW_PERMISSION_HOLDERS_QUERY, {
    projectId: Number(project.id), version: BENDYSTRAW_VERSION, chainIds: chainIds,
  }).catch(function () { return null; });
  var items = (data && data.permissionHolders && data.permissionHolders.items) || [];
  var byOp = {}, order = [];
  items.forEach(function (it) {
    var perms = (it.permissions || []).map(Number).filter(function (n) { return n > 0; });
    if (!perms.length) return; // stale/cleared grant — the operator holds nothing
    var key = (it.operator || '').toLowerCase(); if (!key) return;
    var g = byOp[key];
    if (!g) { g = byOp[key] = { operator: it.operator, account: it.account, isRevnetOperator: false, chains: [], union: {} }; order.push(g); }
    g.isRevnetOperator = g.isRevnetOperator || !!it.isRevnetOperator;
    if (g.chains.indexOf(Number(it.chainId)) === -1) g.chains.push(Number(it.chainId));
    perms.forEach(function (n) { g.union[n] = true; });
  });
  return order.map(function (g) {
    g.permsUnion = Object.keys(g.union).map(Number).sort(function (a, b) { return a - b; });
    g.chains.sort(function (a, b) { return chainOrderIndex(a) - chainOrderIndex(b); });
    return g;
  });
}

// Permissions card (Owner/Operator tab, bottom). Revnet → read-only list of the operator's actual granted
// powers (the default revnet set + any 721 powers granted at deploy) — the operator role is set on the revnet
// itself, not via setPermissionsFor here. Custom → the owner can add operators and add/revoke their permissions.
function renderPermissionsCard(project) {
  var isRev = project.isRevnet;
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Permissions'; card.appendChild(title);
  var intro = el('div', 'detail-card-body backoffice-intro');
  intro.textContent = isRev
    ? 'What this revnet’s operator is allowed to do. These powers come with the operator role (the default revnet powers plus any NFT powers granted when the revnet was deployed).'
    : 'Operators the owner has authorized to act on the project’s behalf, and what each one can do. The owner can grant or revoke permissions at any time.';
  card.appendChild(intro);
  var body = el('div'); body.appendChild(skel('100%', '40px')); card.appendChild(body);

  fetchPermissionOperators(project).then(function (ops) {
    body.innerHTML = '';
    if (!ops.length) {
      var empty = el('div', 'powers-desc'); empty.textContent = isRev ? 'No operator permissions found.' : 'No operators authorized yet.';
      body.appendChild(empty);
    } else {
      ops.forEach(function (g) {
        var row = el('div', 'powers-row');
        var head = el('div', 'powers-head');
        var lab = el('span', 'powers-label'); lab.appendChild(addressNode(g.operator, project.chainId)); head.appendChild(lab);
        if (g.isRevnetOperator) { var b = el('span', 'powers-state on'); b.textContent = 'Operator'; head.appendChild(b); }
        row.appendChild(head);
        var list = el('div', 'perm-list');
        g.permsUnion.forEach(function (id) {
          var it = el('div', 'perm-list-item');
          var nm = el('span', 'perm-list-name'); nm.textContent = permissionLabel(id); it.appendChild(nm);
          var ds = el('span', 'perm-list-desc'); ds.textContent = permissionDesc(id); it.appendChild(ds);
          list.appendChild(it);
        });
        row.appendChild(list);
        if (!isRev) {
          var act = el('a', 'operator-cta powers-act'); act.href = '#'; act.textContent = 'Edit permissions';
          act.addEventListener('click', function (e) { e.preventDefault(); openSetPermissionsModal(project, g.operator, g.permsUnion); });
          row.appendChild(act);
        }
        body.appendChild(row);
      });
    }
    if (!isRev) {
      var add = el('a', 'operator-cta powers-act'); add.href = '#'; add.textContent = '+ Add operator'; add.style.display = 'inline-block'; add.style.marginTop = '12px';
      add.addEventListener('click', function (e) { e.preventDefault(); openSetPermissionsModal(project, null, []); });
      body.appendChild(add);
    }
  }).catch(function () { body.innerHTML = ''; body.textContent = 'Could not read permissions.'; });
  return card;
}

// Grant/revoke an operator's permissions via JBPermissions.setPermissionsFor. setPermissionsFor REPLACES the
// operator's full set on each chain (unchecking revokes; clearing all removes the operator). Routed by owner
// type — Safe → proposed per chain; EOA → one relayr payment — via runAuthorityActionAcrossChains.
function openSetPermissionsModal(project, existingOperator, existingPermIds) {
  var authorityLabel = (projectAuthorityLabel(project) || 'Owner').toLowerCase();
  var account = projectAuthorityAddress(project); // the grantor — for a custom project this is the owner
  var allChains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  var pid = BigInt(project.id);
  var editing = !!existingOperator;

  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode(authorityLabel, account, editing ? 'to change this operator’s permissions.' : 'to authorize a new operator.', project.chainId));
  var note = el('div', 'operator-edit-across');
  note.textContent = 'Grants the checked permissions to the operator for this project. Setting permissions REPLACES the operator’s current set on each selected chain — unchecking a box revokes that power, and clearing every box removes the operator.';
  content.appendChild(note);

  var olbl = el('div', 'operator-edit-label'); olbl.style.marginTop = '12px'; olbl.textContent = 'Operator'; content.appendChild(olbl);
  var opInput = el('input', 'operator-edit-jwt'); opInput.type = 'text'; opInput.placeholder = '0x… operator address';
  if (editing) { opInput.value = existingOperator; opInput.disabled = true; }
  content.appendChild(opInput);

  var plbl = el('div', 'operator-edit-label'); plbl.style.marginTop = '14px'; plbl.textContent = 'Permissions'; content.appendChild(plbl);
  var have = {}; (existingPermIds || []).forEach(function (id) { have[id] = true; });
  var checks = {};
  var listBox = el('div', 'perm-checklist');
  for (var id = 1; id <= JB_PERMISSION_MAX_ID; id++) {
    (function (id) {
      var r = el('label', 'perm-check'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!have[id];
      checks[id] = cb; r.appendChild(cb);
      var txt = el('span', 'perm-check-text');
      var nm = el('span', 'perm-check-name'); nm.textContent = permissionLabel(id) + ' #' + id; txt.appendChild(nm);
      var ds = el('span', 'perm-check-desc'); ds.textContent = permissionDesc(id); txt.appendChild(ds);
      r.appendChild(txt); listBox.appendChild(r);
    })(id);
  }
  content.appendChild(listBox);

  var chlbl = el('div', 'operator-edit-label'); chlbl.style.marginTop = '14px'; chlbl.textContent = 'Set on'; content.appendChild(chlbl);
  var chainSelected = {}; allChains.forEach(function (c) { chainSelected[c.id] = true; });
  var chainBox = el('div', 'splits-edit-chains');
  allChains.forEach(function (c) {
    var r2 = el('label', 'splits-edit-chain'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
    cb.addEventListener('change', function () { chainSelected[c.id] = cb.checked; });
    r2.appendChild(cb); r2.appendChild(chainLogo(c.id, c.name)); var nm = el('span'); nm.textContent = c.name || ('Chain ' + c.id); r2.appendChild(nm);
    chainBox.appendChild(r2);
  });
  content.appendChild(chainBox);

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = editing ? 'Update permissions' : 'Add operator'; actions.appendChild(submit);
  var gate = appendDangerGate(content, 'Granting permissions lets the operator act on the project’s behalf for the checked powers. Verify the address — a wrong or malicious operator can use these powers against the project. You can change or revoke them here at any time.', submit, 'I’ve verified the operator address and the permissions I’m granting.');
  content.appendChild(actions);
  var modal = openModal(editing ? 'Edit permissions' : 'Add operator', content);
  function setStatus(m, k) { status.className = 'operator-edit-status' + (k ? ' ' + k : ''); status.textContent = m; }

  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault(); if (busy) return;
    if (gate && !gate.ok()) { setStatus('Tick the confirmation box to proceed.', 'error'); return; }
    var operator = editing ? existingOperator : (opInput.value || '').trim();
    if (!isAddr(operator)) { setStatus('Enter a valid operator address', 'error'); return; }
    var ids = []; for (var i = 1; i <= JB_PERMISSION_MAX_ID; i++) if (checks[i].checked) ids.push(i);
    busy = true;
    (async function () {
      var selected = allChains.filter(function (c) { return chainSelected[c.id] !== false; });
      if (!selected.length) { setStatus('Select at least one chain', 'error'); busy = false; return; }
      var buildCall = function (cid) {
        var to = getAddress('JBPermissions', cid);
        if (!to) throw new Error('No JBPermissions on ' + chainNameOf(cid));
        return { to: to, data: encodeFunctionData({ abi: jbSetPermissionsAbi, functionName: 'setPermissionsFor', args: [account, { operator: operator, projectId: pid, permissionIds: ids }] }) };
      };
      var shim = Object.assign({}, project, { chains: selected });
      var res = await runAuthorityActionAcrossChains(shim, selected, account, buildCall, { label: 'Set permissions', title: editing ? 'Edit permissions' : 'Add operator', gas: 200000n }, setStatus)
        .catch(function (err) { setStatus(errMessage(err, 'Failed'), 'error'); return null; });
      busy = false;
      if (!res) return;
      if (res.cancelled) { setStatus('Cancelled', ''); return; }
      if (res.relayr) { setStatus('Permissions set on ' + selected.length + ' chain' + (selected.length > 1 ? 's' : '') + '.', 'success'); setTimeout(function () { modal.close(); }, 1600); return; }
      setStatus('Queued on ' + res.queued + ' chain' + (res.queued === 1 ? '' : 's') + ' — confirm + execute in the ' + (project.isRevnet ? 'Operator' : 'Owner') + ' tab.', 'success');
      setTimeout(function () { modal.close(); }, 2600);
    })();
  });
}

// ── Generic owner-power action descriptors ──────────────────────────────────
// kind: address | amount(18-dec→wei) | uint | bool | text. `infra` blank-default = that chain's contract.
// buildArgs(v, cid, pid) → the function args. chainsDefault: 'all' (JB infra, same address everywhere) or
// 'primary' (per-chain values like feeds/mints — only the current chain checked by default).
var POWER_MINT = {
  title: 'Mint tokens', actionVerb: 'Minted', contract: 'JBController', abi: mintTokensAbi, fn: 'mintTokensOf', gas: 300000n, chainsDefault: 'primary',
  note: 'Mints new project tokens to an address without a payment.',
  danger: 'Irreversible: minting dilutes every existing token holder and cannot be undone.',
  fields: [
    { name: 'tokenCount', label: 'Amount (tokens)', kind: 'amount', placeholder: '0.0' },
    { name: 'beneficiary', label: 'Recipient', kind: 'address', placeholder: '0x… recipient', defaultAccount: true },
    { name: 'useReservedPercent', label: 'Also send the reserved share', kind: 'bool', help: 'On: split this mint with the reserved recipients too. Off: the recipient gets the full amount.' },
  ],
  buildArgs: function (v, cid, pid) { return [pid, v.tokenCount, v.beneficiary, '', !!v.useReservedPercent]; },
};
var POWER_SET_CONTROLLER = {
  title: 'Set controller', actionVerb: 'Set', contract: 'JBDirectory', abi: setControllerAbi, fn: 'setControllerOf', gas: 200000n, chainsDefault: 'all',
  note: 'Points the project at a new controller contract. Defaults to the current JBController on each chain.',
  danger: 'Dangerous: this hands control of the project’s rules and tokens to a new contract. A wrong address can permanently brick or compromise the project.',
  fields: [{ name: 'controller', label: 'Controller', kind: 'address', placeholder: '0x… controller', infra: 'JBController' }],
  buildArgs: function (v, cid, pid) { return [pid, v.controller || getAddress('JBController', cid)]; },
};
var POWER_SET_TERMINALS = {
  title: 'Set payment terminals', actionVerb: 'Set', contract: 'JBDirectory', abi: setTerminalsAbi, fn: 'setTerminalsOf', gas: 250000n, chainsDefault: 'all',
  note: 'Sets the project’s payment terminals (comma-separated). Defaults to the current JBMultiTerminal on each chain.',
  danger: 'Dangerous: this reroutes where funds are paid in. A wrong terminal can misdirect or strand funds.',
  fields: [{ name: 'terminals', label: 'Terminals', kind: 'addressList', placeholder: '0x…, 0x…', infra: 'JBMultiTerminal' }],
  buildArgs: function (v, cid, pid) { var list = (v.terminals && v.terminals.length) ? v.terminals : [getAddress('JBMultiTerminal', cid)]; return [pid, list]; },
};
var POWER_MIGRATE = {
  title: 'Migrate terminal balance', actionVerb: 'Migrated', contract: 'JBMultiTerminal', abi: migrateBalanceAbi, fn: 'migrateBalanceOf', gas: 400000n, chainsDefault: 'primary',
  note: 'Moves the project’s balance for a token from the current terminal to another terminal.',
  danger: 'Dangerous: this moves the project’s funds to another terminal. A wrong destination can lose the funds.',
  fields: [
    { name: 'token', label: 'Token', kind: 'address', placeholder: '0x… (or ' + NATIVE_TOKEN.slice(0, 10) + '… for ETH)', defaultNative: true },
    { name: 'to', label: 'New terminal', kind: 'address', placeholder: '0x… destination terminal' },
  ],
  buildArgs: function (v, cid, pid) { return [pid, v.token, v.to]; },
};
var POWER_ADD_PRICE_FEED = {
  title: 'Add price feed', actionVerb: 'Added', contract: 'JBController', abi: addPriceFeedAbi, fn: 'addPriceFeedFor', gas: 200000n, chainsDefault: 'primary',
  note: 'Registers a price feed converting one currency to another. Currencies are JB currency ids (1 = ETH, 2 = USD, or uint32(uint160(token)) for a token).',
  danger: 'Irreversible: a price feed cannot be removed once added, and a wrong feed misprices the project.',
  fields: [
    { name: 'pricingCurrency', label: 'Pricing currency (id)', kind: 'uint', placeholder: 'e.g. 2 (USD)' },
    { name: 'unitCurrency', label: 'Unit currency (id)', kind: 'uint', placeholder: 'e.g. 1 (ETH)' },
    { name: 'feed', label: 'Feed', kind: 'address', placeholder: '0x… price feed' },
  ],
  buildArgs: function (v, cid, pid) { return [pid, v.pricingCurrency, v.unitCurrency, v.feed]; },
};
var POWER_SET_TOKEN = {
  title: 'Set custom token', actionVerb: 'Set', contract: 'JBController', abi: setTokenAbi, fn: 'setTokenFor', gas: 250000n, chainsDefault: 'all',
  note: 'Replaces the project’s token with a custom ERC-20 (it must conform to IJBToken). Same address is set on every selected chain.',
  danger: 'Irreversible: replacing the project token is permanent and affects every holder.',
  fields: [{ name: 'token', label: 'Token', kind: 'address', placeholder: '0x… ERC-20 (IJBToken)' }],
  buildArgs: function (v, cid, pid) { return [pid, v.token]; },
};

// A deliberate-confirmation gate for irreversible/dangerous owner actions: a danger banner + a checkbox
// that must be ticked for the submit to proceed (the submit greys out until then).
function appendDangerGate(content, text, submitBtn, confirmLabel) {
  var banner = el('div', 'create-banner'); banner.style.marginTop = '10px'; banner.textContent = text; content.appendChild(banner);
  var row = el('label', 'danger-confirm');
  var cb = document.createElement('input'); cb.type = 'checkbox';
  var sp = el('span'); sp.textContent = confirmLabel || 'I understand this is permanent and have verified every detail above.';
  row.appendChild(cb); row.appendChild(sp); content.appendChild(row);
  function sync() { submitBtn.classList.toggle('cta-disabled', !cb.checked); }
  cb.addEventListener('change', sync); sync();
  return { ok: function () { return cb.checked; } };
}

// Generic owner-power action modal. Renders the action's fields + chain picker, then routes the tx by
// authority type (Safe → proposed per chain; EOA → one relayr payment) via runAuthorityActionAcrossChains.
function openPowerModal(project, action) {
  var authorityLabel = (projectAuthorityLabel(project) || 'Owner').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var allChains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  var pid = BigInt(project.id);

  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode(authorityLabel, operatorAddr, 'to ' + action.title.toLowerCase() + '.', project.chainId));
  if (action.note) { var note = el('div', 'operator-edit-across'); note.textContent = action.note; content.appendChild(note); }

  var inputs = {}; // name → { get(): value-or-throw }
  action.fields.forEach(function (f) {
    var lab = el('div', 'operator-edit-label'); lab.style.marginTop = '12px'; lab.textContent = f.label; content.appendChild(lab);
    if (f.kind === 'bool') {
      var t = toggleRow(f.label, f.help || '', false, function () {}); content.appendChild(t);
      var cb = t.querySelector('input');
      lab.remove(); // toggleRow already shows the label
      inputs[f.name] = { get: function () { return cb.checked; } };
      return;
    }
    var inp = el('input', 'operator-edit-jwt'); inp.type = (f.kind === 'uint' || f.kind === 'amount') ? 'text' : 'text'; inp.placeholder = f.placeholder || '';
    if (f.defaultAccount) { var a = getAccount && getAccount(); if (a) inp.value = a; }
    if (f.defaultNative) inp.value = NATIVE_TOKEN;
    content.appendChild(inp);
    if (f.help) { var h = el('div', 'operator-edit-cur'); h.textContent = f.help; content.appendChild(h); }
    inputs[f.name] = { get: function () {
      var raw = (inp.value || '').trim();
      if (f.kind === 'address') {
        if (!raw && f.infra) return ''; // blank → buildArgs resolves the per-chain infra default
        if (!isAddr(raw)) throw new Error('Enter a valid address for ' + f.label);
        return raw;
      }
      if (f.kind === 'addressList') {
        if (!raw && f.infra) return [];
        var list = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        list.forEach(function (a2) { if (!isAddr(a2)) throw new Error('Invalid address in ' + f.label + ': ' + a2); });
        return list;
      }
      if (f.kind === 'amount') { if (!raw) throw new Error('Enter ' + f.label); return parseAmount(raw, 18).toString(); }
      if (f.kind === 'uint') { if (!/^\d+$/.test(raw)) throw new Error('Enter a whole number for ' + f.label); return BigInt(raw).toString(); }
      return raw;
    } };
  });

  var chlbl = el('div', 'operator-edit-label'); chlbl.style.marginTop = '14px'; chlbl.textContent = 'Run on'; content.appendChild(chlbl);
  var chainSelected = {}; allChains.forEach(function (c, i) { chainSelected[c.id] = action.chainsDefault === 'all' ? true : (c.id === project.chainId); });
  var chainBox = el('div', 'splits-edit-chains');
  allChains.forEach(function (c) {
    var r2 = el('label', 'splits-edit-chain'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = chainSelected[c.id] !== false;
    cb.addEventListener('change', function () { chainSelected[c.id] = cb.checked; });
    r2.appendChild(cb); r2.appendChild(chainLogo(c.id, c.name)); var nm = el('span'); nm.textContent = c.name || ('Chain ' + c.id); r2.appendChild(nm);
    chainBox.appendChild(r2);
  });
  content.appendChild(chainBox);

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = action.title; actions.appendChild(submit);
  // Irreversible/dangerous action → require an explicit confirmation before the submit will fire.
  var gate = action.danger ? appendDangerGate(content, action.danger, submit) : null;
  content.appendChild(actions);
  var modal = openModal(action.title, content);
  function setStatus(m2, k) { status.className = 'operator-edit-status' + (k ? ' ' + k : ''); status.textContent = m2; }

  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault(); if (busy) return;
    if (gate && !gate.ok()) { setStatus('Tick the confirmation box to proceed — this can’t be undone.', 'error'); return; }
    busy = true;
    (async function () {
      var selected = allChains.filter(function (c) { return chainSelected[c.id] !== false; });
      if (!selected.length) { setStatus('Select at least one chain', 'error'); busy = false; return; }
      var values;
      try { values = {}; action.fields.forEach(function (f) { values[f.name] = inputs[f.name].get(); }); }
      catch (err) { setStatus(err.message || String(err), 'error'); busy = false; return; }
      var buildCall = function (cid) {
        var to = getAddress(action.contract, cid);
        if (!to) throw new Error('No ' + action.contract + ' on ' + chainNameOf(cid));
        return { to: to, data: encodeFunctionData({ abi: action.abi, functionName: action.fn, args: action.buildArgs(values, cid, pid) }) };
      };
      var shim = Object.assign({}, project, { chains: selected });
      var res = await runAuthorityActionAcrossChains(shim, selected, operatorAddr, buildCall, { label: action.title, title: action.title, gas: action.gas }, setStatus)
        .catch(function (err) { setStatus(errMessage(err, 'Failed'), 'error'); return null; });
      busy = false;
      if (!res) return;
      if (res.cancelled) { setStatus('Cancelled', ''); return; }
      if (res.relayr) { setStatus((action.actionVerb || 'Done') + ' on ' + selected.length + ' chain' + (selected.length > 1 ? 's' : '') + '.', 'success'); document.dispatchEvent(new CustomEvent('jb:bridge-updated')); setTimeout(function () { modal.close(); }, 1600); return; }
      setStatus('Queued on ' + res.queued + ' chain' + (res.queued === 1 ? '' : 's') + (res.skipped && res.skipped.length ? ' (skipped ' + res.skipped.join(', ') + ')' : '') + ' — confirm + execute in the ' + (project.isRevnet ? 'Operator' : 'Owner') + ' tab.', 'success');
      setTimeout(function () { modal.close(); }, 2600);
    })();
  });
}

// Owner action (gated by allowAddAccountingContext): register a token the project's terminal accepts.
// Routed by authority type — Safe → proposed per chain; EOA → one relayr payment.
function openAddAccountingContextModal(project) {
  var authorityLabel = (projectAuthorityLabel(project) || 'Owner').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var allChains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  var pid = BigInt(project.id);

  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode(authorityLabel, operatorAddr, 'to add an accounting token.', project.chainId));
  var note = el('div', 'operator-edit-across');
  note.textContent = 'Registers a token the project’s terminal accepts directly. Native ETH and USDC have different addresses per chain — the presets fill the right one for each chain. The currency is derived from the token address.';
  content.appendChild(note);

  // Show what's already accepted on the primary chain (read-only reference).
  var cur = el('div', 'operator-edit-cur'); cur.textContent = 'Reading current accounting tokens…'; content.appendChild(cur);
  read(project.chainId, 'JBMultiTerminal', TERMINAL_CONTEXTS_ABI, 'accountingContextsOf', [pid]).then(function (ctxs) {
    if (!cur.isConnected) return;
    var names = (ctxs || []).map(function (c) { return acctTokenLabel(c.token); });
    cur.textContent = names.length ? ('Currently accepted: ' + names.join(', ')) : 'No accounting tokens set yet.';
  }).catch(function () { cur.textContent = ''; });

  var mode = { kind: 'custom' }; // 'custom' | 'native' | 'usdc'
  var chainSelected = {}; allChains.forEach(function (c) { chainSelected[c.id] = true; });

  var tlbl = el('div', 'operator-edit-label'); tlbl.style.marginTop = '12px'; tlbl.textContent = 'Token'; content.appendChild(tlbl);
  var tokenInput = el('input', 'operator-edit-jwt'); tokenInput.type = 'text'; tokenInput.placeholder = '0x… ERC-20 address'; content.appendChild(tokenInput);
  // Presets — fill the correct per-chain address at submit (Native ETH = same address on every chain; USDC differs).
  var chipRow = el('div', 'create-split-chiprow'); chipRow.style.marginTop = '6px';
  var nativeChip = el('button', 'create-split-chip'); nativeChip.type = 'button'; nativeChip.textContent = 'Native (ETH)';
  var usdcChip = el('button', 'create-split-chip'); usdcChip.type = 'button'; usdcChip.textContent = 'USDC';
  chipRow.appendChild(nativeChip); chipRow.appendChild(usdcChip); content.appendChild(chipRow);
  // Per-chain address breakdown shown while a preset is active.
  var presetList = el('div', 'operator-edit-cur'); presetList.style.display = 'none'; content.appendChild(presetList);

  var dlbl = el('div', 'operator-edit-label'); dlbl.style.marginTop = '12px'; dlbl.textContent = 'Decimals'; content.appendChild(dlbl);
  var decInput = el('input', 'operator-edit-jwt'); decInput.type = 'number'; decInput.min = '0'; decInput.max = '36'; decInput.value = '18'; content.appendChild(decInput);

  function tokenForChain(cid) {
    if (mode.kind === 'native') return NATIVE_TOKEN;
    if (mode.kind === 'usdc') return USDC_BY_CHAIN[cid] || null;
    return (tokenInput.value || '').trim();
  }
  function decimalsForMode() {
    if (mode.kind === 'native') return 18;
    if (mode.kind === 'usdc') return 6;
    return Math.max(0, Math.min(36, parseInt(decInput.value, 10) || 0));
  }
  function selectedChains() { return allChains.filter(function (c) { return chainSelected[c.id] !== false; }); }
  function updatePresetList() {
    presetList.innerHTML = '';
    if (mode.kind === 'custom') { presetList.style.display = 'none'; return; }
    presetList.style.display = '';
    var head = el('div'); head.style.fontWeight = 'bold'; head.textContent = (mode.kind === 'usdc' ? 'USDC' : 'Native ETH') + ' address per selected chain:'; presetList.appendChild(head);
    selectedChains().forEach(function (c) {
      var t = tokenForChain(c.id);
      var line = el('div'); line.textContent = (c.name || ('Chain ' + c.id)) + ': ' + (t ? t : 'no USDC — will be skipped'); presetList.appendChild(line);
    });
  }
  function setMode(kind) {
    mode.kind = (mode.kind === kind) ? 'custom' : kind; // re-tap a preset to clear it
    nativeChip.classList.toggle('active', mode.kind === 'native');
    usdcChip.classList.toggle('active', mode.kind === 'usdc');
    var isPreset = mode.kind !== 'custom';
    tlbl.style.display = isPreset ? 'none' : '';
    tokenInput.style.display = isPreset ? 'none' : '';
    decInput.disabled = isPreset;
    if (mode.kind === 'native') decInput.value = '18';
    else if (mode.kind === 'usdc') decInput.value = '6';
    if (mode.kind === 'custom') tokenInput.value = '';
    updatePresetList();
  }
  nativeChip.addEventListener('click', function () { setMode('native'); });
  usdcChip.addEventListener('click', function () { setMode('usdc'); });
  // Auto-read decimals for a pasted ERC-20 (best-effort, custom mode only).
  tokenInput.addEventListener('change', function () {
    var t = (tokenInput.value || '').trim();
    if (mode.kind !== 'custom' || !isAddr(t)) return;
    if (t.toLowerCase() === NATIVE_TOKEN.toLowerCase()) { decInput.value = '18'; return; }
    clientFor(project.chainId).readContract({ address: t, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', args: [] }).then(function (d) { if (d != null) decInput.value = String(Number(d)); }).catch(function () {});
  });

  var chlbl = el('div', 'operator-edit-label'); chlbl.style.marginTop = '14px'; chlbl.textContent = 'Add on'; content.appendChild(chlbl);
  var chainBox = el('div', 'splits-edit-chains');
  allChains.forEach(function (c) {
    var r2 = el('label', 'splits-edit-chain'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
    cb.addEventListener('change', function () { chainSelected[c.id] = cb.checked; updatePresetList(); });
    r2.appendChild(cb); r2.appendChild(chainLogo(c.id, c.name)); var nm = el('span'); nm.textContent = c.name || ('Chain ' + c.id); r2.appendChild(nm);
    chainBox.appendChild(r2);
  });
  content.appendChild(chainBox);

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = 'Add accounting token'; actions.appendChild(submit);
  var gate = appendDangerGate(content, 'Irreversible: once added, the terminal accepts this token forever — accounting tokens cannot be removed. Verify the token, decimals, and chains carefully before proceeding.', submit);
  content.appendChild(actions);
  var modal = openModal('Add accounting token', content);
  function setStatus(m2, k) { status.className = 'operator-edit-status' + (k ? ' ' + k : ''); status.textContent = m2; }

  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault(); if (busy) return;
    if (gate && !gate.ok()) { setStatus('Tick the confirmation box to proceed — this can’t be undone.', 'error'); return; }
    busy = true;
    (async function () {
      var selected = selectedChains();
      if (!selected.length) { setStatus('Select at least one chain', 'error'); busy = false; return; }
      if (mode.kind === 'custom' && !isAddr((tokenInput.value || '').trim())) { setStatus('Enter a valid token address (or pick Native / USDC)', 'error'); busy = false; return; }
      var dec = decimalsForMode();
      // Per-chain token: Native = same address everywhere; USDC = each chain's own; custom = the pasted address.
      var usable = selected.filter(function (c) { return !!tokenForChain(c.id); });
      var skippedNoUsdc = selected.filter(function (c) { return !tokenForChain(c.id); }).map(function (c) { return c.name; });
      if (!usable.length) { setStatus('USDC isn’t configured on the selected chain(s).', 'error'); busy = false; return; }
      var buildCall = function (cid) {
        var token = tokenForChain(cid);
        var currency = Number(BigInt(token) & 0xffffffffn);
        return { to: getAddress('JBMultiTerminal', cid), data: encodeFunctionData({ abi: addAccountingContextsAbi, functionName: 'addAccountingContextsFor', args: [pid, [{ token: token, decimals: dec, currency: currency }]] }) };
      };
      var shim = Object.assign({}, project, { chains: usable });
      var res = await runAuthorityActionAcrossChains(shim, usable, operatorAddr, buildCall, { label: 'Add accounting token', title: 'Add accounting token', gas: 300000n }, setStatus)
        .catch(function (err) { setStatus(errMessage(err, 'Failed'), 'error'); return null; });
      busy = false;
      if (!res) return;
      if (res.cancelled) { setStatus('Cancelled', ''); return; }
      var skipNote = skippedNoUsdc.length ? ' (skipped ' + skippedNoUsdc.join(', ') + ' — no USDC)' : '';
      if (res.relayr) { setStatus('Accounting token added on ' + usable.length + ' chain' + (usable.length > 1 ? 's' : '') + skipNote + '.', 'success'); document.dispatchEvent(new CustomEvent('jb:bridge-updated')); setTimeout(function () { modal.close(); }, 1600); return; }
      setStatus('Queued on ' + res.queued + ' chain' + (res.queued === 1 ? '' : 's') + (res.skipped && res.skipped.length ? ' (skipped ' + res.skipped.join(', ') + ')' : '') + skipNote + ' — confirm + execute in the ' + (project.isRevnet ? 'Operator' : 'Owner') + ' tab.', 'success');
      setTimeout(function () { modal.close(); }, 2600);
    })();
  });
}

// Short label for an accounting-context token: ETH / USDC / truncated address.
function acctTokenLabel(token) {
  if (!token) return '';
  var lc = String(token).toLowerCase();
  if (lc === NATIVE_TOKEN.toLowerCase()) return 'ETH';
  for (var k in USDC_BY_CHAIN) { if (USDC_BY_CHAIN[k] && USDC_BY_CHAIN[k].toLowerCase() === lc) return 'USDC'; }
  return truncAddr(token);
}

// Signature of a ruleset's CONFIGURED characteristics (ignores timing: start/cycle/live weight).
function rulesetSignature(r, m) {
  return [
    r.duration, r.weightCutPercent,
    m.reservedPercent, m.cashOutTaxRate, m.baseCurrency,
    m.pausePay, m.pauseCreditTransfers, m.allowOwnerMinting, m.allowSetTerminals, m.allowSetController,
    m.allowTerminalMigration, m.holdFees, m.useDataHookForPay, m.useDataHookForCashOut, m.dataHook,
  ].map(String).join('|');
}


function rfDiffRow(label, oldVal, newVal) {
  var row = el('div', 'detail-ruleset-row');
  var k = el('span', 'detail-ruleset-key'); k.textContent = label; row.appendChild(k);
  var v = el('span', 'detail-ruleset-val rf-diff');
  var oldS = el('span', 'rf-diff-old'); oldS.textContent = '− ' + oldVal; v.appendChild(oldS);
  var newS = el('span', 'rf-diff-new'); newS.textContent = '+ ' + newVal; v.appendChild(newS);
  row.appendChild(v);
  return row;
}

// New value only, green-highlighted (no red before-value) — for rows where the before/after isn't meaningful.
function rfNewRow(label, newVal) {
  var row = el('div', 'detail-ruleset-row');
  var k = el('span', 'detail-ruleset-key'); k.textContent = label; row.appendChild(k);
  var v = el('span', 'detail-ruleset-val rf-diff');
  var newS = el('span', 'rf-diff-new'); newS.textContent = newVal; v.appendChild(newS);
  row.appendChild(v);
  return row;
}

// Unit + decimals for a JB currency id (1=ETH, 2=USD as 18-dec; token-keyed → the accounting token).
function currencyMeta(cur, acct) {
  cur = Number(cur);
  if (cur === 1) return { decimals: 18, symbol: 'ETH', tokenKeyed: false };
  if (cur === 2) return { decimals: 18, symbol: 'USD', tokenKeyed: false };
  return { decimals: acct.decimals, symbol: acct.symbol, tokenKeyed: true };
}

// Distribute payouts: send the project's funds to its recipients (splits, then owner) on one chain.
// Permissionless — anyone can trigger it. Amount is in the payout limit's currency (usually the accounting token).
function buildPayoutsModal(project, acctKind) {
  var wrap = el('div', 'modal-body');
  var pid = BigInt(project.id);
  var state = { chainId: (project.chains && project.chains[0] && project.chains[0].id) || project.chainId, acct: null, balance: null, currency: null, meta: null };
  // When a funds block opened this for a specific accounting context, resolve that token per chain;
  // otherwise fall back to the project's primary accounting token.
  function resolveAcct(cid) {
    if (acctKind) { var a = acctKind.addrForChain(cid); return Promise.resolve(a ? { address: a, decimals: acctKind.decimals, symbol: acctKind.symbol } : null); }
    return resolveAcctToken(cid, pid);
  }

  var lbl1 = el('div', 'modal-label'); lbl1.textContent = 'Distribute payouts'; wrap.appendChild(lbl1);
  var desc = el('div', 'modal-balance'); desc.textContent = 'Sends the project’s funds to its payout recipients (any splits, then the owner). Anyone can trigger this; a 2.5% protocol fee may apply.'; wrap.appendChild(desc);
  var bal = el('div', 'modal-balance'); wrap.appendChild(bal);

  var chainRow = el('div', 'ops-chainrow');
  var chainSel = opsChainSelect(project, function (cid) { state.chainId = cid; onChainChange(); });
  chainRow.appendChild(chainSel); wrap.appendChild(chainRow);

  var inRow = el('div', 'ops-inrow');
  var field = el('div', 'ops-field');
  var amt = el('input', 'ops-amount'); amt.type = 'number'; amt.placeholder = '0.00'; field.appendChild(amt);
  var maxBtn = el('button', 'lp-max'); maxBtn.textContent = 'Max'; field.appendChild(maxBtn);
  var unit = el('span', 'ops-unit'); unit.textContent = '…'; field.appendChild(unit);
  inRow.appendChild(field); wrap.appendChild(inRow);

  var status = el('div', 'modal-status'); wrap.appendChild(status);
  var foot = el('div', 'modal-foot');
  var btn = document.createElement('button'); btn.className = 'modal-submit'; btn.textContent = 'Distribute'; foot.appendChild(btn); wrap.appendChild(foot);

  maxBtn.addEventListener('click', function () {
    if (state.balance == null || !state.meta || !state.meta.tokenKeyed) return; // balance is token units — only a valid max in the token's own currency
    amt.value = formatAmount(state.balance, state.acct.decimals);
  });

  function onChainChange() {
    bal.textContent = 'Available: …'; unit.textContent = '…';
    resolveAcct(state.chainId).then(function (acct) {
      if (!acct) { state.acct = null; bal.textContent = (acctKind ? acctKind.symbol : 'This token') + ' isn’t accepted on ' + chainNameOf(state.chainId) + '.'; return; }
      state.acct = acct;
      var term = getAddress('JBMultiTerminal', state.chainId);
      return Promise.all([
        term ? read(state.chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [term, pid, acct.address]).catch(function () { return null; }) : Promise.resolve(null),
        (getAddress('JBFundAccessLimits', state.chainId) && term && project.ruleset) ? read(state.chainId, 'JBFundAccessLimits', payoutLimitsAbi, 'payoutLimitsOf', [pid, BigInt(project.ruleset.id), term, acct.address]).catch(function () { return []; }) : Promise.resolve([]),
      ]).then(function (r) {
        state.balance = r[0] != null ? BigInt(r[0]) : 0n;
        var isNative = acct.address.toLowerCase() === NATIVE_TOKEN.toLowerCase();
        var acctCur = isNative ? 1 : Number(BigInt(acct.address) & 0xffffffffn);
        var lims = r[1] || [];
        state.currency = lims.length ? Number(lims[0].currency) : acctCur;
        state.meta = currencyMeta(state.currency, acct);
        unit.textContent = state.meta.symbol;
        maxBtn.style.display = state.meta.tokenKeyed ? '' : 'none';
        bal.textContent = state.balance > 0n
          ? ('Available on ' + chainNameOf(state.chainId) + ': ' + formatBalance(state.balance, acct.decimals, acct.symbol))
          : ('Nothing to pay out on ' + chainNameOf(state.chainId) + ' yet.');
      });
    }).catch(function () { bal.textContent = 'Could not read the terminal.'; });
  }
  onChainChange();

  btn.addEventListener('click', function () {
    if (!(getAccount && getAccount())) { connect(); return; }
    if (!state.acct || !state.meta) { status.textContent = 'Loading…'; return; }
    var amount; try { amount = parseAmount(amt.value, state.meta.decimals); } catch (_) { status.textContent = 'Invalid amount'; return; }
    if (amount === 0n) { status.textContent = 'Enter an amount'; return; }
    if (state.meta.tokenKeyed && state.balance != null && amount > state.balance) { status.textContent = 'Amount exceeds available'; return; }
    var term = getAddress('JBMultiTerminal', state.chainId);
    if (!term) { status.textContent = 'No terminal on this chain'; return; }
    btn.disabled = true;
    executeTransaction({
      chainId: state.chainId, address: term, abi: sendPayoutsAbi, functionName: 'sendPayoutsOf', contractName: 'JBMultiTerminal',
      args: [pid, state.acct.address, amount, BigInt(state.currency), 0n], label: 'Distribute payouts',
      onStatus: function (m, k) { status.classList.toggle('pending', k === 'pending'); status.textContent = m; },
      onError: function (m) { status.classList.remove('pending'); status.textContent = m; btn.disabled = false; },
      onSuccess: function () { status.classList.remove('pending'); status.textContent = 'Payouts distributed on ' + chainNameOf(state.chainId) + '.'; btn.disabled = false; document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
    });
  });
  return wrap;
}

// Use surplus allowance: the owner/operator withdraws surplus (balance beyond the payout limit), up to
// the ruleset's surplus allowance, on one chain. Owner-gated (needs USE_ALLOWANCE permission).
function buildUseAllowanceModal(project, acctKind) {
  var wrap = el('div', 'modal-body');
  var pid = BigInt(project.id);
  var authorityLabel = (projectAuthorityLabel(project) || 'Operator').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var state = { chainId: (project.chains && project.chains[0] && project.chains[0].id) || project.chainId, acct: null, usable: null, currency: null, meta: null };
  function resolveAcct(cid) {
    if (acctKind) { var a = acctKind.addrForChain(cid); return Promise.resolve(a ? { address: a, decimals: acctKind.decimals, symbol: acctKind.symbol } : null); }
    return resolveAcctToken(cid, pid);
  }

  wrap.appendChild(operatorGateNode(authorityLabel, operatorAddr, 'to use the surplus allowance.'));
  var desc = el('div', 'modal-balance'); desc.textContent = 'Withdraws surplus (funds beyond the payout limit) to a beneficiary, up to this ruleset’s surplus allowance. A 2.5% protocol fee may apply.'; wrap.appendChild(desc);
  var bal = el('div', 'modal-balance'); wrap.appendChild(bal);

  var chainRow = el('div', 'ops-chainrow');
  var chainSel = opsChainSelect(project, function (cid) { state.chainId = cid; onChainChange(); });
  chainRow.appendChild(chainSel); wrap.appendChild(chainRow);

  var inRow = el('div', 'ops-inrow');
  var field = el('div', 'ops-field');
  var amt = el('input', 'ops-amount'); amt.type = 'number'; amt.placeholder = '0.00'; field.appendChild(amt);
  var maxBtn = el('button', 'lp-max'); maxBtn.textContent = 'Max'; field.appendChild(maxBtn);
  var unit = el('span', 'ops-unit'); unit.textContent = '…'; field.appendChild(unit);
  inRow.appendChild(field); wrap.appendChild(inRow);

  var status = el('div', 'modal-status'); wrap.appendChild(status);
  var foot = el('div', 'modal-foot');
  var btn = document.createElement('button'); btn.className = 'modal-submit'; btn.textContent = 'Use allowance'; foot.appendChild(btn); wrap.appendChild(foot);

  maxBtn.addEventListener('click', function () {
    if (state.usable == null || !state.meta || !state.meta.tokenKeyed) return;
    amt.value = formatAmount(state.usable, state.acct.decimals);
  });

  function onChainChange() {
    bal.textContent = 'Usable: …'; unit.textContent = '…';
    resolveAcct(state.chainId).then(function (acct) {
      if (!acct) { state.acct = null; bal.textContent = (acctKind ? acctKind.symbol : 'This token') + ' isn’t accepted on ' + chainNameOf(state.chainId) + '.'; return; }
      state.acct = acct;
      var term = getAddress('JBMultiTerminal', state.chainId);
      var fal = getAddress('JBFundAccessLimits', state.chainId);
      var isNative = acct.address.toLowerCase() === NATIVE_TOKEN.toLowerCase();
      var acctCur = isNative ? 1 : Number(BigInt(acct.address) & 0xffffffffn);
      var matchCur = function (c) { c = Number(c); return isNative ? (c === 1 || c === 61166) : c === acctCur; };
      return Promise.all([
        term ? read(state.chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [term, pid, acct.address]).catch(function () { return null; }) : Promise.resolve(null),
        (fal && term && project.ruleset) ? read(state.chainId, 'JBFundAccessLimits', payoutLimitsAbi, 'payoutLimitsOf', [pid, BigInt(project.ruleset.id), term, acct.address]).catch(function () { return []; }) : Promise.resolve([]),
        (fal && term && project.ruleset) ? read(state.chainId, 'JBFundAccessLimits', surplusAllowancesAbi, 'surplusAllowancesOf', [pid, BigInt(project.ruleset.id), term, acct.address]).catch(function () { return []; }) : Promise.resolve([]),
      ]).then(function (r) {
        var balance = r[0] != null ? BigInt(r[0]) : 0n;
        var payoutCap = 0n; (r[1] || []).forEach(function (l) { if (matchCur(l.currency)) payoutCap += l.amount; });
        var allowCap = 0n; (r[2] || []).forEach(function (l) { if (matchCur(l.currency)) allowCap += l.amount; });
        var unlimitedPayout = payoutCap >= (2n ** 200n);
        var surplus = unlimitedPayout ? 0n : (balance > payoutCap ? balance - payoutCap : 0n);
        var allowUnlimited = allowCap >= (2n ** 200n);
        // Usable = surplus capped by the allowance (the terminal enforces both).
        state.usable = allowUnlimited ? surplus : (surplus < allowCap ? surplus : allowCap);
        state.currency = (r[1] && r[1].length) ? Number(r[1][0].currency) : acctCur;
        state.meta = currencyMeta(state.currency, acct);
        unit.textContent = state.meta.symbol;
        maxBtn.style.display = state.meta.tokenKeyed ? '' : 'none';
        bal.textContent = state.usable > 0n
          ? ('Usable on ' + chainNameOf(state.chainId) + ': ' + formatBalance(state.usable, acct.decimals, acct.symbol))
          : ('No usable surplus allowance on ' + chainNameOf(state.chainId) + ' right now.');
      });
    }).catch(function () { bal.textContent = 'Could not read the terminal.'; });
  }
  onChainChange();

  btn.addEventListener('click', function () {
    var acc = getAccount && getAccount();
    if (!acc) { connect(); return; }
    if (!state.acct || !state.meta) { status.textContent = 'Loading…'; return; }
    var amount; try { amount = parseAmount(amt.value, state.meta.decimals); } catch (_) { status.textContent = 'Invalid amount'; return; }
    if (amount === 0n) { status.textContent = 'Enter an amount'; return; }
    if (state.meta.tokenKeyed && state.usable != null && amount > state.usable) { status.textContent = 'Amount exceeds usable allowance'; return; }
    var term = getAddress('JBMultiTerminal', state.chainId);
    if (!term) { status.textContent = 'No terminal on this chain'; return; }
    btn.disabled = true;
    executeTransaction({
      chainId: state.chainId, address: term, abi: useAllowanceAbi, functionName: 'useAllowanceOf', contractName: 'JBMultiTerminal',
      args: [pid, state.acct.address, amount, BigInt(state.currency), 0n, acc, acc, ''], label: 'Use surplus allowance',
      onStatus: function (m, k) { status.classList.toggle('pending', k === 'pending'); status.textContent = m; },
      onError: function (m) { status.classList.remove('pending'); status.textContent = m; btn.disabled = false; },
      onSuccess: function () { status.classList.remove('pending'); status.textContent = 'Surplus used on ' + chainNameOf(state.chainId) + '.'; btn.disabled = false; document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
    });
  });
  return wrap;
}

// A funds "kind" descriptor — one per accounting context the project's terminal accepts. Resolves the
// right token ADDRESS per chain (native = same everywhere; USDC differs per chain; custom = fixed).
function nativeFundsKind(dec) { return { key: 'native', symbol: 'ETH', decimals: dec || 18, addrForChain: function () { return NATIVE_TOKEN; }, matchCur: function (c) { c = Number(c); return c === 1 || c === 61166; } }; }
function usdcFundsKind(dec) { return { key: 'usdc', symbol: 'USDC', decimals: dec || 6, addrForChain: function (cid) { return USDC_BY_CHAIN[cid] || null; }, matchCur: function (c, cid) { var u = USDC_BY_CHAIN[cid]; return !!u && Number(c) === Number(BigInt(u) & 0xffffffffn); } }; }
function customFundsKind(addr, dec) { var curr = Number(BigInt(addr) & 0xffffffffn); return { key: addr.toLowerCase(), symbol: acctTokenLabel(addr), decimals: dec || 18, addrForChain: function () { return addr; }, matchCur: function (c) { return Number(c) === curr; } }; }

// All accounting contexts a project accepts (read from the home chain), classified into funds kinds.
function acctKindsForFunds(project) {
  var pid = BigInt(project.id);
  var home = project.chainId;
  if (!getAddress('JBMultiTerminal', home)) return Promise.resolve([nativeFundsKind(18)]);
  return read(home, 'JBMultiTerminal', TERMINAL_CONTEXTS_ABI, 'accountingContextsOf', [pid]).then(function (ctxs) {
    if (!ctxs || !ctxs.length) return [nativeFundsKind(18)];
    var usdcHome = (USDC_BY_CHAIN[home] || '').toLowerCase();
    return ctxs.map(function (c) {
      var lc = c.token.toLowerCase(); var dec = Number(c.decimals);
      if (lc === NATIVE_TOKEN.toLowerCase()) return nativeFundsKind(dec);
      if (usdcHome && lc === usdcHome) return usdcFundsKind(dec);
      return customFundsKind(c.token, dec);
    });
  }).catch(function () { return [nativeFundsKind(18)]; });
}

// Total balance for an accounting kind across all the project's chains (for the at-a-glance tab label).
function totalBalanceForKind(project, kind) {
  var pid = BigInt(project.id);
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId }];
  return Promise.all(chains.map(function (c) {
    var term = getAddress('JBMultiTerminal', c.id); var tok = kind.addrForChain(c.id);
    if (!term || !tok) return Promise.resolve(0n);
    return read(c.id, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [term, pid, tok]).then(function (b) { return b != null ? BigInt(b) : 0n; }).catch(function () { return 0n; });
  })).then(function (bs) { return bs.reduce(function (s, v) { return s + v; }, 0n); });
}

// Funds card: one block per accounting context (balance per chain, payouts available, surplus, payouts +
// Distribute / Use). A project with both ETH and USDC contexts shows both blocks.
function renderFundsCard(project) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Funds'; card.appendChild(title);
  var holder = el('div'); holder.appendChild(skel('100%', '120px')); card.appendChild(holder);

  acctKindsForFunds(project).then(function (kinds) {
    holder.innerHTML = '';
    if (!kinds.length) kinds = [nativeFundsKind(18)];
    if (kinds.length === 1) { holder.appendChild(buildFundsTokenBlock(project, kinds[0], false)); return; }
    // Total balance — the same USD total shown on the project's header card (all tokens, all chains).
    var totLbl = el('div', 'rf-funds-label'); totLbl.textContent = 'Total balance'; holder.appendChild(totLbl);
    var totBig = el('div', 'rf-funds-big'); totBig.style.marginBottom = '14px'; totBig.appendChild(mountUsdBalance(project)); holder.appendChild(totBig);
    // Multiple accounting contexts → one tab per token; blocks built lazily + cached. Inactive tabs show the
    // balance at a glance (e.g. "0 ETH"); the SELECTED tab shows just the token (its balance is right below).
    var subRow = el('div', 'owners-subtabs'); subRow.style.marginBottom = '18px';
    var pane = el('div'); var built = {}; var btns = []; var bals = []; var activeIdx = 0;
    function labelFor(i) {
      if (i === activeIdx) return kinds[i].symbol;
      return bals[i] != null ? formatBalance(bals[i], kinds[i].decimals, kinds[i].symbol) : kinds[i].symbol;
    }
    function show(i) {
      activeIdx = i;
      btns.forEach(function (b, bi) { b.classList.toggle('active', bi === i); b.textContent = labelFor(bi); });
      pane.innerHTML = '';
      if (!built[i]) built[i] = buildFundsTokenBlock(project, kinds[i], false);
      pane.appendChild(built[i]);
    }
    kinds.forEach(function (kind, i) {
      var btn = el('button', 'owners-subtab'); btn.textContent = kind.symbol; btns.push(btn);
      btn.addEventListener('click', function () { show(i); });
      subRow.appendChild(btn);
      totalBalanceForKind(project, kind).then(function (t) { bals[i] = t; btns[i].textContent = labelFor(i); }).catch(function () {});
    });
    holder.appendChild(subRow); holder.appendChild(pane);
    show(0);
  }).catch(function () { holder.innerHTML = ''; holder.textContent = 'Could not read the project’s funds.'; });

  return card;
}

// One accounting-context block. `showHead` adds a token-symbol heading (when the project has >1 context).
function buildFundsTokenBlock(project, kind, showHead) {
  var pid = BigInt(project.id);
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: 'This chain' }];
  var home = project.chainId;
  var terminal = getAddress('JBMultiTerminal', home);
  var limits = getAddress('JBFundAccessLimits', home);
  var splitsAddr = getAddress('JBSplits', home);
  var homeToken = kind.addrForChain(home);
  var fmt = function (v) { return v == null ? '—' : formatBalance(v, kind.decimals, kind.symbol); };

  function rulesetLink(text) {
    var a = el('a', 'rf-ruleset-link'); a.href = '#'; a.textContent = text;
    a.addEventListener('click', function (e) { e.preventDefault(); if (_activeDetail && _activeDetail.showTab) { _activeDetail.showTab('Rulesets'); routerSetHash(projectHash(project, 'Rulesets')); } });
    return a;
  }

  var wrap = el('div', 'rf-funds-token');
  if (showHead) { var th = el('div', 'rf-funds-token-head'); th.textContent = kind.symbol; wrap.appendChild(th); }

  var balHead = el('div', 'rf-funds-label'); balHead.textContent = 'Balance'; wrap.appendChild(balHead);
  var balTotal = el('div', 'rf-funds-big'); balTotal.textContent = '…'; wrap.appendChild(balTotal);
  var chainTable = el('div', 'funds-chain-table'); wrap.appendChild(chainTable);
  var cHead = el('div', 'funds-chain-row funds-chain-head');
  ['Chain', 'Balance', 'Payouts available', 'Surplus'].forEach(function (h) { var s = el('span'); s.textContent = h; cHead.appendChild(s); });
  chainTable.appendChild(cHead);

  var bottomGrid = el('div', 'funds-bottom-grid'); bottomGrid.style.marginTop = '14px'; wrap.appendChild(bottomGrid);
  var payCol = el('div', 'rf-funds-col'); bottomGrid.appendChild(payCol);
  var surCol = el('div', 'rf-funds-col'); bottomGrid.appendChild(surCol);

  var limitLbl = el('div', 'rf-funds-label');
  limitLbl.appendChild(rulesetLink('Current')); limitLbl.appendChild(document.createTextNode(' payout limit:'));
  payCol.appendChild(limitLbl);
  var limitVal = el('div', 'rf-funds-mid'); limitVal.textContent = '…'; payCol.appendChild(limitVal);
  var payHead = el('div', 'rf-funds-label'); payHead.style.marginTop = '18px'; payHead.textContent = 'Payouts'; payCol.appendChild(payHead);
  var payBox = el('div'); payBox.textContent = 'Reading…'; payCol.appendChild(payBox);
  var distBtn = el('button', 'detail-check-btn'); distBtn.style.marginTop = '12px'; distBtn.textContent = 'Distribute payouts';
  distBtn.addEventListener('click', function () { openModal('Distribute payouts', buildPayoutsModal(project, kind)); });
  payCol.appendChild(distBtn);

  var saHead = el('div', 'rf-funds-label');
  saHead.appendChild(rulesetLink('Current')); saHead.appendChild(document.createTextNode(' surplus allowance:'));
  surCol.appendChild(saHead);
  var saV = el('div', 'rf-funds-mid'); saV.textContent = '…'; surCol.appendChild(saV);
  var useBtn = el('button', 'detail-check-btn'); useBtn.style.marginTop = '12px'; useBtn.textContent = 'Use surplus allowance';
  useBtn.addEventListener('click', function () { openModal('Use surplus allowance', buildUseAllowanceModal(project, kind)); });
  surCol.appendChild(useBtn);

  // Per-chain balances + the home-chain payout limit / surplus allowance (config is synced across chains).
  Promise.all([
    Promise.all(chains.map(function (c) {
      var term = getAddress('JBMultiTerminal', c.id); var tok = kind.addrForChain(c.id);
      if (!term || !tok) return Promise.resolve({ c: c, bal: null });
      return read(c.id, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [term, pid, tok]).then(function (b) { return { c: c, bal: b }; }).catch(function () { return { c: c, bal: null }; });
    })),
    (limits && terminal && homeToken && project.ruleset) ? read(home, 'JBFundAccessLimits', payoutLimitsAbi, 'payoutLimitsOf', [pid, BigInt(project.ruleset.id), terminal, homeToken]).catch(function () { return []; }) : Promise.resolve([]),
    (limits && terminal && homeToken && project.ruleset) ? read(home, 'JBFundAccessLimits', surplusAllowancesAbi, 'surplusAllowancesOf', [pid, BigInt(project.ruleset.id), terminal, homeToken]).catch(function () { return []; }) : Promise.resolve([]),
  ]).then(function (R) {
    var rows = R[0];
    var payoutCap = 0n; (R[1] || []).forEach(function (l) { if (kind.matchCur(l.currency, home)) payoutCap += l.amount; });
    var allowCap = 0n; (R[2] || []).forEach(function (l) { if (kind.matchCur(l.currency, home)) allowCap += l.amount; });
    var unlimited = payoutCap >= (2n ** 200n);
    var total = 0n;
    rows.forEach(function (x) {
      var bal = x.bal != null ? BigInt(x.bal) : 0n;
      if (x.bal != null) total += bal;
      var avail = unlimited ? bal : (bal > payoutCap ? payoutCap : bal);
      var surplus = unlimited ? 0n : (bal > payoutCap ? bal - payoutCap : 0n);
      var row = el('div', 'funds-chain-row');
      var nm = el('span', 'funds-chain-name'); nm.appendChild(chainLogo(x.c.id, x.c.name));
      var t = el('span'); t.textContent = ' ' + x.c.name; nm.appendChild(t); row.appendChild(nm);
      var b = el('span'); b.textContent = fmt(x.bal); row.appendChild(b);
      var a = el('span'); a.textContent = x.bal == null ? '—' : fmt(avail); row.appendChild(a);
      var s = el('span'); s.textContent = x.bal == null ? '—' : fmt(surplus); row.appendChild(s);
      chainTable.appendChild(row);
    });
    balTotal.textContent = fmt(total);
    limitVal.textContent = unlimited ? 'Unlimited' : fmt(payoutCap);
    saV.textContent = allowCap >= (2n ** 200n) ? 'Unlimited' : fmt(allowCap);
  });

  // Payouts table (home chain): percent | recipient | amount distributable now. Splits keyed by the home
  // accounting token; leftover → owner.
  Promise.all([
    (terminal && homeToken) ? read(home, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, pid, homeToken]).catch(function () { return null; }) : Promise.resolve(null),
    (limits && terminal && homeToken && project.ruleset) ? read(home, 'JBFundAccessLimits', payoutLimitsAbi, 'payoutLimitsOf', [pid, BigInt(project.ruleset.id), terminal, homeToken]).catch(function () { return []; }) : Promise.resolve([]),
    (splitsAddr && homeToken && project.ruleset) ? read(home, 'JBSplits', splitsOfAbi, 'splitsOf', [pid, BigInt(project.ruleset.id), BigInt(homeToken)]).catch(function () { return []; }) : Promise.resolve([]),
  ]).then(function (res) {
    var homeBal = res[0] != null ? BigInt(res[0]) : 0n;
    var cap = 0n; (res[1] || []).forEach(function (l) { if (kind.matchCur(l.currency, home)) cap += l.amount; });
    var unlimited = cap >= (2n ** 200n);
    var distributable = unlimited ? homeBal : (homeBal > cap ? cap : homeBal);
    var splits = res[2] || [];

    payBox.innerHTML = '';
    var table = el('div', 'payouts-table');
    var head = el('div', 'payouts-row payouts-head');
    ['Percent', 'Recipient', 'Available'].forEach(function (h) { var c = el('span'); c.textContent = h; head.appendChild(c); });
    table.appendChild(head);
    function addRow(pct, recipientNode, amt) {
      var row = el('div', 'payouts-row');
      var p = el('span', 'payouts-pct'); p.textContent = pct.toFixed(pct % 1 === 0 ? 0 : 2) + '%'; row.appendChild(p);
      var r = el('span', 'payouts-recipient'); r.appendChild(recipientNode); row.appendChild(r);
      var a = el('span', 'payouts-amt'); a.textContent = fmt(amt); row.appendChild(a);
      table.appendChild(row);
    }
    var sumPct = 0, sumAmt = 0n;
    splits.forEach(function (sp) {
      var pct = Number(sp.percent) / 1e9 * 100; sumPct += pct;
      var amt = distributable * BigInt(sp.percent) / 1000000000n; sumAmt += amt;
      addRow(pct, splitAccountNode(sp, project, home), amt);
    });
    var leftoverPct = 100 - sumPct;
    if (splits.length === 0 || leftoverPct > 0.0001) {
      var ownerPct = splits.length === 0 ? 100 : leftoverPct;
      var ownerName = el('span'); ownerName.textContent = 'Project’s owner';
      var setOwner = function (a) { if (a) { ownerName.innerHTML = ''; ownerName.appendChild(addressNode(a, home)); } };
      if (project.owner) setOwner(project.owner);
      else read(home, 'JBProjects', ownerOfAbi, 'ownerOf', [pid]).then(function (o) { project.owner = o; setOwner(o); }).catch(function () {});
      addRow(ownerPct, ownerName, distributable - sumAmt);
    }
    payBox.appendChild(table);
  }).catch(function () { payBox.textContent = 'Could not read payouts.'; });

  return wrap;
}


// Revnet stages = the queued rulesets, oldest→newest. Each stage's issuance (weight),
// issuance cut, and duration are read straight off the ruleset; the current stage is marked.
function renderStagesSection(project) {
  var section = el('div', 'detail-section');
  var stages = (project.stages || []).slice().sort(function (a, b) { return Number(a.start) - Number(b.start); });
  if (!stages.length) {
    var card = el('div', 'detail-card');
    var title = el('div', 'detail-card-title'); title.textContent = 'Terms'; card.appendChild(title);
    var body = el('div', 'detail-card-body');
    body.textContent = project.stages ? 'No stages found onchain.' : 'Could not read stages.';
    card.appendChild(body);
    section.appendChild(card);
    return section;
  }
  section.appendChild(renderIssuance(project, stages)); // projected issuance ladder (into the future)
  section.appendChild(renderTermsTable(project, stages));
  return section;
}

// Horizontal per-stage terms table (revnet.app-style): one row per stage.
function renderTermsTable(project, stages) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Terms'; card.appendChild(title);

  var sym = project.tokenSymbol || 'tokens';
  var currentId = project.ruleset ? String(project.ruleset.id) : null;

  var wrap = el('div', 'terms-table-wrap');
  var table = document.createElement('table');
  table.className = 'terms-table';

  var thead = document.createElement('thead');
  var hr = document.createElement('tr');
  ['Stage', 'Period', 'Issuance (' + sym + '/' + baseUnitLabel(project) + ')', 'Split limit', 'Auto issuance (' + sym + ')', 'Cash out tax'].forEach(function (h) {
    var th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
  });
  thead.appendChild(hr); table.appendChild(thead);

  var autoCells = []; // per-stage "Auto issuance" cells, filled in once indexed totals load
  var tbody = document.createElement('tbody');
  for (var i = 0; i < stages.length; i++) {
    var s = stages[i];
    var isCurrent = currentId && String(s.id) === currentId;
    var nextStart = (i + 1 < stages.length) ? Number(stages[i + 1].start) : null;
    var md = decodeStageMetadata(s.metadata);
    var tr = document.createElement('tr');
    if (isCurrent) tr.className = 'terms-current';

    // Stage number (+ current dot) — header already labels the column "Stage".
    var c1 = document.createElement('td'); c1.className = 'terms-stagecell';
    var stg = el('span', 'terms-stage'); stg.textContent = String(i + 1); c1.appendChild(stg);
    if (isCurrent) { var dot = el('span', 'terms-current-dot'); dot.title = 'active'; c1.appendChild(dot); var cur = el('div', 'terms-sub'); cur.textContent = 'active'; c1.appendChild(cur); }
    tr.appendChild(c1);

    // Period (start – end) + span subtext
    var c2 = document.createElement('td');
    var per = el('div', 'terms-period');
    per.textContent = formatDate(s.start) + ' – ' + (nextStart ? formatDate(nextStart) : 'forever');
    c2.appendChild(per);
    if (nextStart) {
      var sub = el('div', 'terms-sub'); sub.textContent = Math.round((nextStart - Number(s.start)) / 86400) + ' days'; c2.appendChild(sub);
    }
    tr.appendChild(c2);

    // Issuance = "<rate> cut <pct>%" with "<sym> / ETH" and "every N days" as subtexts under each part.
    var c3 = document.createElement('td');
    var iss = el('div', 'terms-issuance');
    var amtTop = el('div'); amtTop.textContent = (Number(s.weight) === 0 ? '0' : formatRate(Number(s.weight) / 1e18)); iss.appendChild(amtTop);
    // Cut + cadence as a single subtext under the number (omitted entirely when there's no cut).
    if (Number(s.weightCutPercent) > 0) {
      var cutSub = el('div', 'terms-sub');
      cutSub.textContent = 'cut ' + formatCutPercent(s.weightCutPercent) + ' every ' + Math.round(Number(s.duration) / 86400) + ' days';
      iss.appendChild(cutSub);
    }
    c3.appendChild(iss);
    tr.appendChild(c3);

    // Split limit (reserved %)
    var c5 = document.createElement('td'); c5.textContent = percentFromRuleset(md.reservedPercent); tr.appendChild(c5);

    // Auto issuance — total across chains/beneficiaries for this stage (filled in async below).
    var c6 = document.createElement('td'); c6.className = 'terms-muted'; c6.textContent = '…';
    autoCells[i] = c6; tr.appendChild(c6);

    // Cash out tax
    var c7 = document.createElement('td'); c7.textContent = percentFromRuleset(md.cashOutTaxRate); tr.appendChild(c7);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);

  // Sum indexed auto-issuance per stage (across chains + beneficiaries) and fill the cells.
  loadStageAutoIssuanceTotals(project, stages).then(function (totals) {
    for (var j = 0; j < autoCells.length; j++) {
      var sum = totals[j];
      if (sum && sum > 0n) { autoCells[j].textContent = formatTokenCount(sum); autoCells[j].classList.remove('terms-muted'); }
      else { autoCells[j].textContent = '—'; }
    }
  }).catch(function () {
    for (var k = 0; k < autoCells.length; k++) autoCells[k].textContent = '—';
  });

  return card;
}

// Cut percent formatted compactly (no trailing zeros): 38.00 → "38%", 7.5 → "7.5%".
function formatCutPercent(weightCutPercent) {
  var v = Number(weightCutPercent) / WEIGHT_CUT_SCALE;
  return v.toFixed(2).replace(/\.?0+$/, '') + '%';
}

// Total auto-issuance per stage (index-aligned to `stages`), summed across chains + beneficiaries.
async function loadStageAutoIssuanceTotals(project, stages) {
  var pid = BigInt(project.id);
  var chains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('Chain ' + project.chainId) }];
  var stageCache = {};
  function stagesForChain(chainId) {
    if (stageCache[chainId]) return stageCache[chainId];
    if (chainId === project.chainId && stages && stages.length) {
      stageCache[chainId] = Promise.resolve(stages);
      return stageCache[chainId];
    }
    stageCache[chainId] = read(chainId, 'JBRulesets', allOfAbi, 'allOf', [pid, 0n, 8n])
      .then(function (rs) { return (rs || []).slice().sort(function (a, b) { return Number(a.start) - Number(b.start); }); })
      .catch(function () { return []; });
    return stageCache[chainId];
  }
  var rows = await loadAutoIssuanceRows(project, chains, stagesForChain);
  var totals = {};
  rows.forEach(function (r) {
    totals[r.stageIndex] = (totals[r.stageIndex] || 0n) + toBigInt(r.count);
  });
  return totals;
}

var YEAR = 365 * 86400;

// Issuance (tokens per base unit) at time t: find the active stage, then decay its weight by
// weightCutPercent once per elapsed cycle. duration 0 = perpetual (no cycling).
function issuanceAtTime(sortedStages, t) {
  var active = sortedStages[0];
  for (var i = 0; i < sortedStages.length; i++) {
    if (Number(sortedStages[i].start) <= t) active = sortedStages[i];
  }
  var W0 = Number(active.weight), C = Number(active.weightCutPercent), D = Number(active.duration), S = Number(active.start);
  if (D === 0) return W0 / 1e18;
  var k = Math.max(0, Math.floor((t - S) / D));
  return (W0 / 1e18) * Math.pow((1e9 - C) / 1e9, k);
}

function formatRate(n) {
  if (!isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n >= 1000) return Math.round(n).toLocaleString();
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

// Price (ETH per token) for the y-axis: small numbers, trimmed trailing zeros.
function formatPrice(n) {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.001) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return n.toPrecision(2);
}

// "Token issuance" card: current rate, next scheduled cut + countdown, % to splits, and an SVG
// schedule chart (stepped per cycle) with stage dividers and a "now" marker. All from ruleset data.
// Hero price chart shown above the tabs for revnets: the Issuance Price ladder (the ceiling). AMM
// price (pool slot0, once it has liquidity) and Cash out price (the floor, once Bendystraw indexes V6)
// are surfaced in the legend and join later — issuance and cash out bound the AMM price.
function renderPriceChart(project, stages) {
  var sym = project.tokenSymbol || 'tokens';
  var sorted = stages.slice().sort(function (a, b) { return Number(a.start) - Number(b.start); });
  var now = Math.floor(Date.now() / 1000);

  var card = el('div', 'detail-card price-hero');
  var top = el('div', 'price-top');

  var legend = el('div', 'price-legend');
  // Each chip stacks its label over a live value subtext (no separate values row). _liq is an optional
  // second subtext line (used by the AMM chip for pooled liquidity).
  function chip(label, kind, active, note) {
    var c = el('span', 'price-chip ' + kind + (active ? ' active' : ' muted'));
    var dot = el('span', 'price-dot'); c.appendChild(dot);
    var col = el('span', 'price-chip-col');
    var t = el('span', 'price-chip-label'); t.textContent = label; col.appendChild(t);
    var v = el('span', 'price-chip-val');
    // Ghost the value while it loads so the chip reserves its width and the range row below doesn't jump.
    var g = el('span', 'skel price-chip-skel'); g.style.width = (kind === 'pc-amm' ? 200 : 78) + 'px';
    v.appendChild(g);
    col.appendChild(v);
    var liq = el('span', 'price-chip-val price-chip-liq'); liq.style.display = 'none'; col.appendChild(liq);
    c.appendChild(col); c._val = v; c._liq = liq;
    if (note) c.title = note;
    return c;
  }
  // Pair denominator follows baseCurrency: token/ETH normally, token/USD for USD-based rulesets (e.g. ART).
  var baseLabel = (project.metadata && Number(project.metadata.baseCurrency) === 2) ? 'USD' : 'ETH';
  var pairUnit = sym + '/' + baseLabel;
  function setChipVal(c, numStr, tail) {
    c._val.textContent = '';
    c._val.appendChild(document.createTextNode(numStr + ' '));
    var u = el('span', 'price-chip-unit'); u.textContent = pairUnit; c._val.appendChild(u);
    if (tail) c._val.appendChild(document.createTextNode(' ' + tail));
  }
  var amm = null;        // current AMM price (ETH/token), filled in lazily
  var cashout = null;    // current cash-out floor (ETH/token), filled in lazily
  var cashoutHistory = [];
  var ammHistory = [];   // realized AMM trade prices from Bendystraw swapEvents
  var curYears = 1;
  // Order: Issuance, Cash out, then AMM price.
  var issChip = chip('Issuance price', 'pc-issuance', true);
  legend.appendChild(issChip);
  var cashChip = chip('Cash out price', 'pc-cashout', true, 'Loading historical floor…');
  legend.appendChild(cashChip);
  var ammChip = chip('AMM price', 'pc-amm', true, 'Reading the buyback pool…');
  legend.appendChild(ammChip);
  top.appendChild(legend);

  var issNow = issuanceAtTime(sorted, now); var issPrice = issNow > 0 ? 1 / issNow : null;
  if (issPrice) setChipVal(issChip, formatPrice(issPrice)); else issChip._val.textContent = '—';

  var ranges = [['1D', 1 / 365], ['7D', 7 / 365], ['30D', 30 / 365], ['3M', 0.25], ['1Y', 1], ['All', 0]];
  var rangeRow = el('div', 'issuance-ranges price-ranges');
  var chartWrap = el('div', 'issuance-chart price-chart');
  function draw() { mountChart(chartWrap, sorted, now, curYears, sym, amm, cashout, true, cashoutHistory, ammHistory); }
  function selectRange(years, btn) {
    var btns = rangeRow.querySelectorAll('.issuance-range-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
    if (btn) btn.classList.add('active');
    curYears = years; draw();
  }
  ranges.forEach(function (rg) {
    var b = document.createElement('button');
    b.className = 'issuance-range-btn' + (rg[0] === '1Y' ? ' active' : '');
    b.textContent = rg[0];
    b.addEventListener('click', function () { selectRange(rg[1], b); });
    rangeRow.appendChild(b);
  });
  top.appendChild(rangeRow);
  card.appendChild(top);
  card.appendChild(chartWrap);
  draw();

  // Live AMM price (pool slot0, works even with zero liquidity), current cash-out floor, and
  // indexed floor history from Bendystraw's sucker group moments.
  Promise.all([
    readAmmPrice(project, project.chainId),
    readCashoutPrice(project, project.chainId),
    fetchPriceFloorHistory(project, sorted),
    fetchSwapHistory(project).catch(function () { return null; }),
    readLpPositions(project, project.chainId).catch(function () { return null; }),
  ]).then(function (res) {
    var p = res[0], f = res[1], history = res[2] || [];
    var swaps = res[3] || { series: [], buyVolume: 0, sellVolume: 0, count: 0 };
    var lp = res[4];
    // The pool's pair (terminal) token — ETH or USDC — labels every pool/liquidity/volume value below.
    var pairSym = (lp && lp.pair && lp.pair.symbol) || 'ETH';
    var pairScale = Math.pow(10, (lp && lp.pair && lp.pair.decimals) || 18);
    // Plot realized AMM trade prices as a time series; extend it to the live pool price.
    if (swaps.series && swaps.series.length) {
      ammHistory = swaps.series.slice();
    }
    if (p && p > 0) {
      amm = p;
      ammHistory.push({ timestamp: now, value: p });
      ammChip.classList.remove('muted'); ammChip.classList.add('active');
      var volNote = swaps.count
        ? swaps.count + ' trade' + (swaps.count === 1 ? '' : 's') + ' | '
          + formatPrice(swaps.buyVolume + swaps.sellVolume) + ' ' + pairSym + ' volume | '
        : '';
      ammChip.title = volNote + '~' + formatPrice(p) + ' ' + pairSym + ' / ' + sym + ' (current pool price)';
    } else if (swaps.count) {
      ammChip.classList.remove('muted'); ammChip.classList.add('active');
      ammChip.title = swaps.count + ' trade' + (swaps.count === 1 ? '' : 's') + ' | '
        + formatPrice(swaps.buyVolume + swaps.sellVolume) + ' ' + pairSym + ' volume';
    } else { ammChip.title = 'No liquidity in the pool yet'; }
    if (history.length) {
      cashoutHistory = history;
      var last = history[history.length - 1];
      cashout = last && last.value > 0 ? last.value : f;
      cashChip.classList.remove('muted'); cashChip.classList.add('active');
      cashChip.title = 'Historical cash-out floor from Bendystraw';
    }
    if (f && f > 0) {
      cashout = cashout || f;
      cashChip.classList.remove('muted'); cashChip.classList.add('active');
      if (!history.length) cashChip.title = '~' + formatPrice(f) + ' ' + pairSym + ' / ' + sym + ' (current cash-out floor)';
    } else if (!history.length) {
      cashChip.title = 'No cash-out floor indexed yet';
    }
    if (amm || cashout || cashoutHistory.length || ammHistory.length) draw();

    // Fill the chip value subtexts (no ETH/REV unit — the chart axis carries it). AMM is one line:
    // "<price> on <x REV> + <y ETH> liq".
    var liq = (lp && (lp.totalRev > 0n || lp.totalEth > 0n))
      ? formatCompactTokenAmount(lp.totalRev) + ' ' + sym + ' + ' + formatPrice(Number(lp.totalEth) / pairScale) + ' ' + pairSym
      : '';
    if (amm) setChipVal(ammChip, formatPrice(amm), liq ? 'on ' + liq + ' liq' : '');
    else ammChip._val.textContent = swaps.count ? '—' : 'No liquidity yet';
    if (cashout) setChipVal(cashChip, formatPrice(cashout)); else cashChip._val.textContent = '—';
    // (The liquidity-by-price depth chart lives in the Owners → AMM section, not here.)
  });
  return card;
}

function renderIssuance(project, stages) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title');
  title.textContent = 'Token issuance';
  card.appendChild(title);

  var sym = project.tokenSymbol ? project.tokenSymbol : 'tokens';
  var r = project.ruleset;
  var cur = r ? Number(r.weight) / 1e18 : 0;

  var big = el('div', 'issuance-rate');
  big.textContent = cur > 0 ? (formatRate(cur) + ' ' + sym + ' / ' + baseUnitLabel(project)) : 'No issuance';
  card.appendChild(big);

  var now = Math.floor(Date.now() / 1000);
  if (r && cur > 0 && Number(r.weightCutPercent) > 0 && Number(r.duration) > 0) {
    var next = cur * (1e9 - Number(r.weightCutPercent)) / 1e9;
    var when = Number(r.start) + Number(r.duration) - now;
    var sub = el('div', 'issuance-sub');
    sub.textContent = 'Cuts to ' + formatRate(next) + ' ' + sym + ' / ' + baseUnitLabel(project) + ' in ' + (when > 0 ? formatCountdown(when) : 'the next cycle');
    card.appendChild(sub);
  } else if (cur > 0) {
    var fixed = el('div', 'issuance-sub');
    fixed.textContent = 'Fixed issuance — no scheduled cut.';
    card.appendChild(fixed);
  }
  if (project.metadata) {
    var split = el('div', 'issuance-sub');
    split.textContent = percentFromRuleset(project.metadata.reservedPercent) + ' of issuance and buybacks to splits';
    card.appendChild(split);
  }

  // Range selector + chart.
  var sorted = stages.slice().sort(function (a, b) { return Number(a.start) - Number(b.start); });
  var ranges = [['1Y', 1], ['5Y', 5], ['10Y', 10], ['All', 0]];
  var rangeRow = el('div', 'issuance-ranges');
  var chartWrap = el('div', 'issuance-chart');
  function selectRange(years, btn) {
    var btns = rangeRow.querySelectorAll('.issuance-range-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
    if (btn) btn.classList.add('active');
    mountChart(chartWrap, sorted, now, years, sym);
  }
  ranges.forEach(function (rg, idx) {
    var b = document.createElement('button');
    b.className = 'issuance-range-btn' + (idx === 0 ? ' active' : '');
    b.textContent = rg[0];
    b.addEventListener('click', function () { selectRange(rg[1], b); });
    rangeRow.appendChild(b);
  });
  card.appendChild(rangeRow);
  card.appendChild(chartWrap);
  mountChart(chartWrap, sorted, now, 1, sym);

  return card;
}

// Plots PRICE (ETH per token = 1/issuance), rising as issuance is cut — matching revnet.app. The card
// header still shows issuance (tokens/ETH). Zero-issuance regions clamp to the top of the finite range.
function issuanceChartSvg(sorted, now, years, sym, ammPrice, cashoutPrice, past, cashoutHistory, ammHistory) {
  var firstStart = Number(sorted[0].start);
  var t0, t1;
  if (past) {
    // History only: AMM and cash-out prices in the future are unknowable, so end at "now".
    t1 = now;
    t0 = years > 0 ? now - years * YEAR : firstStart;
    if (t0 >= t1) t0 = t1 - YEAR;
  } else {
    t0 = Math.min(firstStart, now);
    t1 = years > 0 ? now + years * YEAR : (Number(sorted[sorted.length - 1].start) + 5 * YEAR);
    if (t1 <= t0) t1 = t0 + YEAR;
  }

  var W = 600, H = 200, padL = 8, padR = 8, padT = 10, padB = 22, N = 240;
  var pts = [];
  var maxV = 0;
  for (var i = 0; i <= N; i++) {
    var t = t0 + (t1 - t0) * i / N;
    var iss = issuanceAtTime(sorted, t);
    var v = iss > 0 ? 1 / iss : null; // price (ETH per token); null when issuance is off
    pts.push([t, v]);
    if (v !== null && v > maxV) maxV = v;
  }
  if (maxV <= 0) maxV = 1;
  if (ammPrice && ammPrice > maxV) maxV = ammPrice * 1.05; // keep the AMM line in view
  var ammSeries = visibleSeries(ammHistory || [], t0, t1);
  if (ammSeries.length) {
    for (var ap = 0; ap < ammSeries.length; ap++) if (ammSeries[ap].value > maxV) maxV = ammSeries[ap].value * 1.05;
  }
  var cashSeries = visibleSeries(cashoutHistory || [], t0, t1);
  if (cashSeries.length) {
    for (var cp = 0; cp < cashSeries.length; cp++) if (cashSeries[cp].value > maxV) maxV = cashSeries[cp].value * 1.05;
  } else if (cashoutPrice && cashoutPrice > maxV) maxV = cashoutPrice * 1.05;
  // Zero-issuance (price → ∞) clamps to the top of the finite range so the curve reads as "maxed out".
  for (var p = 0; p < pts.length; p++) if (pts[p][1] === null) pts[p][1] = maxV;
  function X(t) { return padL + (W - padL - padR) * (t - t0) / (t1 - t0); }
  function Y(v) { return padT + (H - padT - padB) * (1 - v / maxV); }

  var line = 'M' + X(pts[0][0]).toFixed(1) + ' ' + Y(pts[0][1]).toFixed(1);
  for (var j = 1; j < pts.length; j++) line += ' L' + X(pts[j][0]).toFixed(1) + ' ' + Y(pts[j][1]).toFixed(1);
  var area = line + ' L' + X(pts[pts.length - 1][0]).toFixed(1) + ' ' + Y(0).toFixed(1)
    + ' L' + X(pts[0][0]).toFixed(1) + ' ' + Y(0).toFixed(1) + ' Z';

  // Stage divider verticals (skip the first start at the very edge).
  var dividers = '';
  for (var s = 0; s < sorted.length; s++) {
    var st = Number(sorted[s].start);
    if (st > t0 && st < t1) {
      var x = X(st).toFixed(1);
      dividers += '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="rgba(0,0,0,0.25)" stroke-width="1" stroke-dasharray="3 3"/>'
        + '<text x="' + (X(st) + 4).toFixed(1) + '" y="' + (padT + 12) + '" font-size="10" fill="rgba(0,0,0,0.45)">Stage ' + (s + 1) + '</text>';
    }
  }
  // Today marker: history charts (`past`) end at "now" (right edge); projection charts place it
  // wherever `now` falls in the range. Clamp into the plot and anchor the label so it never overflows.
  var nowX = Math.max(padL, Math.min(W - padR, X(now)));
  var nowShow = past || (now > t0 && now < t1);
  var nearRight = nowX > W - padR - 40;
  // Just the marker line here; the "Today" label is an HTML overlay (mountChart) so it stays at the
  // regular font size instead of being shrunk by the chart's responsive viewBox.
  var nowLine = nowShow
    ? '<line x1="' + nowX.toFixed(1) + '" y1="' + padT + '" x2="' + nowX.toFixed(1) + '" y2="' + (H - padB) + '" stroke="#1a8a8a" stroke-width="1.5" stroke-dasharray="4 3"/>'
    : '';
  // AMM gets a Bendystraw historical trade line (swapEvents) when indexed; otherwise the
  // current pool price is a flat reference line.
  var ammLine = '';
  if (ammSeries.length) {
    ammLine = 'M' + X(ammSeries[0].timestamp).toFixed(1) + ' ' + Y(ammSeries[0].value).toFixed(1);
    for (var ai = 1; ai < ammSeries.length; ai++) {
      ammLine += ' L' + X(ammSeries[ai].timestamp).toFixed(1) + ' ' + Y(ammSeries[ai].value).toFixed(1);
    }
    ammLine = '<path d="' + ammLine + '" fill="none" stroke="#b8602e" stroke-width="1.7"/>';
    for (var ad = 0; ad < ammSeries.length; ad++) {
      ammLine += '<circle cx="' + X(ammSeries[ad].timestamp).toFixed(1) + '" cy="' + Y(ammSeries[ad].value).toFixed(1) + '" r="1.8" fill="#b8602e"/>';
    }
  } else if (ammPrice && ammPrice > 0) {
    ammLine = '<line x1="' + padL + '" y1="' + Y(ammPrice).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(ammPrice).toFixed(1) + '" stroke="#b8602e" stroke-width="1.5" stroke-dasharray="5 4"/>';
  }
  var cashLine = '';
  if (cashSeries.length) {
    cashLine = 'M' + X(cashSeries[0].timestamp).toFixed(1) + ' ' + Y(cashSeries[0].value).toFixed(1);
    for (var ci = 1; ci < cashSeries.length; ci++) {
      cashLine += ' L' + X(cashSeries[ci].timestamp).toFixed(1) + ' ' + Y(cashSeries[ci].value).toFixed(1);
    }
    cashLine = '<path d="' + cashLine + '" fill="none" stroke="#c43550" stroke-width="1.7"/>';
  } else if (cashoutPrice && cashoutPrice > 0) {
    cashLine = '<line x1="' + padL + '" y1="' + Y(cashoutPrice).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(cashoutPrice).toFixed(1) + '" stroke="#c43550" stroke-width="1.5" stroke-dasharray="2 4"/>';
  }

  var y0 = new Date(t0 * 1000).getFullYear();
  var y1 = new Date(t1 * 1000).getFullYear();

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="none" class="issuance-svg">'
    + '<path d="' + area + '" fill="rgba(110,196,196,0.18)"/>'
    + '<path d="' + line + '" fill="none" stroke="#6ec4c4" stroke-width="2"/>'
    + dividers + nowLine + ammLine + cashLine
    + '</svg>';
  // Axis years + "Today" go to mountChart as HTML overlays (regular font, not viewBox-shrunk).
  return { svg: svg, geo: { t0: t0, t1: t1, W: W, padL: padL, padR: padR, nowX: nowX, nowShow: nowShow, nearRight: nearRight, y0: y0, y1: y1 } };
}

// Render the chart into a wrap + attach a hover tooltip/guide showing each series' value at that time.
function mountChart(wrap, sorted, now, years, sym, amm, cashout, past, cashoutHistory, ammHistory) {
  var c = issuanceChartSvg(sorted, now, years, sym, amm, cashout, past, cashoutHistory, ammHistory);
  var holder = wrap.querySelector('.chart-holder');
  if (!holder) {
    wrap.classList.add('chart-wrap');
    holder = el('div', 'chart-holder'); wrap.appendChild(holder);
    var guide = el('div', 'chart-guide'); guide.style.display = 'none'; wrap.appendChild(guide);
    var tip = el('div', 'chart-tip'); tip.style.display = 'none'; wrap.appendChild(tip);
    wrap._guide = guide; wrap._tip = tip;
    wrap.addEventListener('mouseleave', function () { wrap._guide.style.display = 'none'; wrap._tip.style.display = 'none'; });
    wrap.addEventListener('mousemove', function (e) {
      var ch = wrap._chart; if (!ch) return;
      var g = ch.geo, rect = wrap.getBoundingClientRect();
      var plotL = (g.padL / g.W) * rect.width, plotR = ((g.W - g.padR) / g.W) * rect.width;
      var x = Math.max(plotL, Math.min(plotR, e.clientX - rect.left));
      var frac = (plotR > plotL) ? (x - plotL) / (plotR - plotL) : 0;
      var t = g.t0 + frac * (g.t1 - g.t0);
      var iss = issuanceAtTime(ch.sorted, t); var issP = iss > 0 ? 1 / iss : null;
      function row(label, val, color) {
        return '<div class="chart-tip-row"><span class="chart-tip-dot" style="background:' + color + '"></span>'
          + label + ' ' + (val ? formatPrice(val) : '—') + '</div>';
      }
      var html = '<div class="chart-tip-date">' + formatDate(t) + '</div>' + row('Issuance', issP, '#6ec4c4');
      var ammVal = seriesValueAt(ch.ammHistory || [], t) || ch.amm;
      if (ammVal) html += row('AMM', ammVal, '#b8602e');
      var floor = seriesValueAt(ch.cashoutHistory || [], t) || ch.cashout;
      if (floor) html += row('Cash out', floor, '#c43550');
      wrap._tip.innerHTML = html;
      wrap._guide.style.display = ''; wrap._guide.style.left = x + 'px';
      wrap._tip.style.display = '';
      wrap._tip.style.left = Math.max(4, Math.min(rect.width - 130, x + 8)) + 'px';
    });
  }
  holder.innerHTML = c.svg;
  // Axis years + "Today" as HTML overlays so they render at the regular font size (the chart SVG's
  // responsive viewBox would otherwise shrink them to ~6px on a phone).
  var g = c.geo;
  var lbl = '<span class="chart-axis chart-axis-l">' + g.y0 + '</span><span class="chart-axis chart-axis-r">' + g.y1 + '</span>';
  if (g.nowShow) {
    lbl += '<span class="chart-today' + (g.nearRight ? ' chart-today-r' : '') + '" style="left:' + (g.nowX / g.W * 100).toFixed(1) + '%">Today</span>';
  }
  holder.insertAdjacentHTML('beforeend', lbl);
  wrap._chart = { geo: c.geo, sorted: sorted, sym: sym, amm: amm, cashout: cashout, cashoutHistory: cashoutHistory || [], ammHistory: ammHistory || [] };
}

function visibleSeries(series, t0, t1) {
  if (!series || !series.length) return [];
  var out = [];
  var previous = null;
  for (var i = 0; i < series.length; i++) {
    var point = series[i];
    if (!point || point.value == null || point.value <= 0) continue;
    if (point.timestamp < t0) {
      previous = point;
      continue;
    }
    if (point.timestamp > t1) break;
    out.push(point);
  }
  if (previous) out.unshift({ timestamp: t0, value: previous.value });
  if (out.length && out[out.length - 1].timestamp < t1) {
    out.push({ timestamp: t1, value: out[out.length - 1].value });
  }
  return out;
}

function seriesValueAt(series, timestamp) {
  if (!series || !series.length) return null;
  var value = null;
  for (var i = 0; i < series.length; i++) {
    if (series[i].timestamp > timestamp) break;
    if (series[i].value > 0) value = series[i].value;
  }
  return value;
}

function formatCountdown(secs) {
  var s = Number(secs);
  if (s <= 0) return 'now';
  var d = Math.floor(s / 86400);
  if (d >= 1) { var h = Math.floor((s % 86400) / 3600); return d + 'd' + (h ? ' ' + h + 'h' : ''); }
  var hh = Math.floor(s / 3600);
  if (hh >= 1) { var m = Math.floor((s % 3600) / 60); return hh + 'h' + (m ? ' ' + m + 'm' : ''); }
  return Math.max(1, Math.floor(s / 60)) + 'm';
}

function formatDate(ts) {
  try { return new Date(Number(ts) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return '—'; }
}

function timeAgo(timestamp) {
  var seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp || 0));
  if (seconds < 60) return 'now';
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  var months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.floor(months / 12) + 'y ago';
}

// "2d 03h 14m 09s" style countdown for a future timestamp (seconds remaining).
function fmtCountdown(secs) {
  secs = Math.max(0, Math.floor(secs));
  var d = Math.floor(secs / 86400); secs -= d * 86400;
  var h = Math.floor(secs / 3600); secs -= h * 3600;
  var m = Math.floor(secs / 60); var s = secs - m * 60;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var parts = [];
  if (d) parts.push(d + 'd');
  if (d || h) parts.push(pad(h) + 'h');
  parts.push(pad(m) + 'm');
  parts.push(pad(s) + 's');
  return parts.join(' ');
}

function formatActivityAmount(raw, symbol, decimals) {
  var value = toBigInt(raw);
  if (value === 0n) return '0 ' + (symbol || 'ETH');
  // Format in the project's accounting token (decimals + symbol), not assumed 18-dp ETH.
  return formatBalance(value, (decimals == null ? 18 : decimals), symbol || 'ETH');
}

// bendystraw pay/cash-out events carry the raw `amount` (in the paid token) + its USD value, but NOT which
// token. Infer it so we can show the real token amount ("0.005 ETH" / "20 USDC"): a 6-dec stablecoin's face
// value ≈ its USD value, whereas ETH's 18-dec face value is ~1000×+ off. Falls back to the project's
// accounting token when unpriced.
function inferActivityAmount(amount, scaledUsd, acct) {
  var amt = toBigInt(amount);
  if (amt === 0n) return '0 ' + ((acct && acct.symbol) || 'ETH');
  var target = Number(usdFromScaled(scaledUsd));
  if (!(target > 0)) return formatActivityAmount(amount, acct && acct.symbol, acct && acct.decimals);
  var asStable = Number(amt) / 1e6; // value if the token were a 6-dec ~$1 stablecoin
  if (asStable >= target / 10 && asStable <= target * 10) return formatBalance(amt, 6, 'USDC');
  return formatBalance(amt, 18, 'ETH'); // 18-dec native otherwise
}

function renderExplorerTxLink(chainId, txHash, label) {
  var url = txUrl(chainId, txHash);
  if (!url) {
    var span = el('span');
    span.textContent = label || '—';
    return span;
  }
  var a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label || truncAddr(txHash);
  return a;
}

function txUrl(chainId, txHash) {
  var url = CHAINS[chainId] && CHAINS[chainId].blockExplorers
    && CHAINS[chainId].blockExplorers.default
    && CHAINS[chainId].blockExplorers.default.url;
  return url && txHash ? (url.replace(/\/$/, '') + '/tx/' + txHash) : null;
}

function identGradient(seed) {
  var str = String(seed || '');
  var hash = 0;
  for (var i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  var a = LOGO_COLORS[Math.abs(hash) % LOGO_COLORS.length];
  var b = LOGO_COLORS[Math.abs(hash >> 3) % LOGO_COLORS.length];
  return 'linear-gradient(135deg, ' + a + ', ' + b + ')';
}

// Full auto-issuance table. Beneficiary rows come solely from Bendystraw (no deploy-script fallback);
// the live remaining amount per row is read on-chain from REVOwner. If Bendystraw fails, the section
// shows an error rather than fabricated data.
function renderAutoIssuance(project, stages) {
  var card = el('div');

  var desc = el('div', 'detail-card-body');
  desc.textContent = 'Tokens auto-issued to specific accounts, unlocking per stage across every chain.';
  card.appendChild(desc);

  var pid = BigInt(project.id);
  var sym = project.tokenSymbol ? ' ' + project.tokenSymbol : '';
  var chains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('Chain ' + project.chainId) }];
  var stageCache = {};

  var body = el('div', 'autoissue-tablewrap');
  body.appendChild(skelGenericTable('autoissue-table', 'autoissue-row', 'autoissue-head',
    ['Chain', 'Stage', 'Account', 'Amount (' + (project.tokenSymbol || sym).trim() + ')', 'Unlock date', 'Distribute'],
    ['58%', '40%', '66%', '54%', '60%', '50%'], 3));
  card.appendChild(body);

  function stagesForChain(chainId) {
    if (stageCache[chainId]) return stageCache[chainId];
    if (chainId === project.chainId && stages && stages.length) {
      stageCache[chainId] = Promise.resolve(stages);
      return stageCache[chainId];
    }
    stageCache[chainId] = read(chainId, 'JBRulesets', allOfAbi, 'allOf', [pid, 0n, 8n])
      .then(function (rs) {
        return (rs || []).slice().sort(function (a, b) { return Number(a.start) - Number(b.start); });
      }).catch(function () { return []; });
    return stageCache[chainId];
  }

  loadAutoIssuanceRows(project, chains, stagesForChain).then(function (rows) {
    if (!body.isConnected) return;
    body.innerHTML = '';
    body.className = 'autoissue-tablewrap';
    if (!rows.length) {
      body.className = 'detail-card-body owners-empty';
      body.textContent = 'No auto issuance configured for this revnet.';
      return;
    }
    body.appendChild(renderAutoIssuanceTable(rows, sym, distribute));
  }).catch(function () {
    if (!body.isConnected) return;
    body.className = 'detail-card-body owners-empty';
    body.textContent = 'Could not load auto issuance.';
  });

  function distribute(row, btn) {
    var stageId = BigInt(row.stage.id);
    var args = [pid, stageId, row.beneficiary];
    var chainName = row.chain && row.chain.name ? row.chain.name : ('Chain ' + row.chain.id);
    var amount = row.remaining != null && row.remaining > 0n ? row.remaining : row.count;
    var data = encodeCalldata(autoIssueForAbi, 'autoIssueFor', args);
    var payload = {
      chain: chainName,
      chainId: row.chain.id,
      contract: 'REVOwner',
      address: row.revOwnerAddr,
      functionName: 'autoIssueFor',
      value: '0',
      data: data,
      rawArgs: args,
      args: {
        revnetId: String(project.id),
        stageId: stageId.toString(),
        beneficiary: row.beneficiary,
      },
      review: {
        stage: 'Stage ' + (row.stageIndex + 1),
        unlockDate: row.stage ? formatDateTime(row.stage.start) : null,
        configuredAmount: row.count.toString(),
        remainingAmount: row.remaining == null ? null : row.remaining.toString(),
        displayAmount: formatAmount(amount, 18) + sym,
      },
      abiFragment: autoIssueForAbi[0],
    };
    openTxConfirm(payload, function (ctx) {
      sendAutoIssue(row, btn, args, ctx);
    }, {
      title: 'Confirm auto issue',
      confirmText: 'Confirm & Distribute',
      closeOnConfirm: false,
    });
  }

  function setConfirmStatus(ctx, message, kind) {
    if (!ctx || !ctx.status) return;
    ctx.status.style.display = message ? '' : 'none';
    ctx.status.className = 'modal-status tx-confirm-status' + (kind ? (' ' + kind) : '');
    ctx.status.textContent = message || '';
  }

  function setConfirmBusy(ctx, busy) {
    if (ctx && ctx.confirm) ctx.confirm.disabled = !!busy;
    if (ctx && ctx.cancel) ctx.cancel.disabled = !!busy;
  }

  function sendAutoIssue(row, btn, args, ctx) {
    if (!(getAccount && getAccount())) {
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      setConfirmBusy(ctx, true);
      setConfirmStatus(ctx, 'Connecting wallet…');
      connect().then(function () {
        sendAutoIssue(row, btn, args, ctx);
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Distribute';
        setConfirmBusy(ctx, false);
        setConfirmStatus(ctx, errMessage(err, 'Could not connect wallet'), 'error');
      });
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Distributing…';
    setConfirmBusy(ctx, true);
    executeTransaction({
      skipConfirm: true, // already confirmed via openTxConfirm
      chainId: row.chain.id,
      address: row.revOwnerAddr,
      abi: autoIssueForAbi,
      functionName: 'autoIssueFor',
      args: args,
      onStatus: function (m, kind) { setConfirmStatus(ctx, m, kind); },
      onSuccess: function () {
        row.remaining = 0n;
        row.distributed = true;
        btn.textContent = 'Distributed';
        setConfirmStatus(ctx, 'Auto issuance distributed.', 'success');
        if (ctx && ctx.modal) ctx.modal.close();
      },
      onError: function (m) {
        btn.disabled = false;
        btn.textContent = 'Distribute';
        setConfirmBusy(ctx, false);
        setConfirmStatus(ctx, m, 'error');
      },
    });
  }

  return card;
}

// Wrap a content node in a titled detail-card (null title → the content supplies its own heading).
function ownersCard(title, node) {
  var card = el('div', 'detail-card');
  if (title) { var label = el('div', 'detail-card-title'); label.textContent = title; card.appendChild(label); }
  card.appendChild(node);
  return card;
}

// Owners tab (revnets) — split into lazy SUBTABS so each pane's reads only fire when first opened
// (the page no longer fetches every holder/settlement/splits/loan source at once on tab open).
function renderOwnersSection(project, opts) {
  opts = opts || {};
  var section = el('div', 'detail-section owners-section');
  var stages = (project.stages || []).slice().sort(function (a, b) { return Number(a.start) - Number(b.start); });

  var subBuilders = {
    'Accounts': function () {
      var w = el('div', 'owners-subgroup');
      w.appendChild(ownersCard('You', renderYouCard(project, opts)));
      w.appendChild(ownersCard('All', renderOwnersAll(project)));
      return w;
    },
    'Market': function () {
      var w = el('div', 'owners-subgroup');
      w.appendChild(ownersCard(null, renderOwnersAmm(project))); // AMM supplies its own "AMM <addr>" heading
      w.appendChild(renderSplitHookCard(project)); // populated only if the project routes a split to the LP hook
      return w;
    },
    'Settlement': function () {
      // Composition / Gossip / Bridges / Movement are each their own independent card within the tab.
      var w = el('div', 'owners-subgroup');
      w.appendChild(ownersCard('Composition', renderAcrossChainsBody(project)));
      var gossip = renderGossipSection(project);
      if (gossip) w.appendChild(gossip);
      w.appendChild(renderBridgesSubsection(project));
      w.appendChild(renderBridgeTransactions(project));
      return w;
    },
    'Splits': function () {
      var reservedDistBox = el('div', 'detail-card-body');
      appendBendystrawHistory(reservedDistBox,
        function () { return fetchProjectEventRows(BENDYSTRAW_RESERVED_DIST_QUERY, 'sendReservedTokensToSplitsEvents', project, 25); },
        function (r) {
          return historyRow(Number(r.chainId), r.txHash, Number(r.timestamp),
            formatCompactTokenAmount(toBigInt(r.tokenCount)) + ' ' + (project.tokenSymbol || 'tokens'));
        },
        'No reserved-token distributions indexed yet.');
      var w = el('div');
      w.appendChild(renderOwnersSplits(project));
      w.appendChild(detailSubSection('Latest distributions', reservedDistBox));
      return ownersCard('Splits', w);
    },
    'Reserved': function () {
      // Custom-project view of the reserved-token splits — same data as revnet "Splits", no stage framing.
      return ownersCard('Reserved', renderOwnersSplits(project, { reserved: true }));
    },
    'Auto Issuance': function () {
      return ownersCard('Auto issue', renderAutoIssuance(project, stages));
    },
    'Loans': function () {
      var loansBox = el('div', 'detail-card-body');
      loansBox.textContent = 'Loading from Bendystraw…';
      fetchProjectEventRows(BENDYSTRAW_LOANS_QUERY, 'loans', project, 50).then(function (rows) {
        loansBox.innerHTML = '';
        if (!rows.length) { loansBox.className = 'detail-card-body owners-empty'; loansBox.textContent = 'No active loans indexed.'; return; }
        loansBox.className = '';
        loansBox.appendChild(renderLoansTable(project, rows, { mine: false }));
      }).catch(function () { loansBox.innerHTML = ''; loansBox.textContent = 'Could not load loans from Bendystraw.'; });
      return ownersCard('Active loans', loansBox);
    },
  };
  var order = opts.subtabs || ['Accounts', 'Market', 'Settlement', 'Splits', 'Auto Issuance', 'Loans'];

  var subRow = el('div', 'owners-subtabs');
  var content = el('div', 'owners-subcontent');
  var built = {};
  function show(name) {
    if (!subBuilders[name]) return;
    if (!built[name]) built[name] = subBuilders[name](); // build (and fetch) only on first open
    content.innerHTML = '';
    content.appendChild(built[name]);
    var btns = subRow.querySelectorAll('.owners-subtab');
    for (var b = 0; b < btns.length; b++) btns[b].classList.toggle('active', btns[b].textContent === name);
    // Reflect the nested subtab in the URL so a refresh restores it (e.g. #…/tokens/settlement).
    if (_activeDetail && (opts.tabName ? _activeDetail.current === opts.tabName : true)) {
      _activeDetail.subtab = name;
      routerSetHash(projectHash(project, opts.tabName || _activeDetail.current, name));
    }
  }
  order.forEach(function (name) {
    var btn = document.createElement('button');
    btn.className = 'owners-subtab';
    btn.textContent = name;
    btn.addEventListener('click', function () { show(name); });
    subRow.appendChild(btn);
  });
  // Token card (name / symbol / address per chain + operator Edit) sits above the subtabs — for both
  // revnets (Owners tab) and custom projects (Tokens tab). Replaces the old in-Overview token panel.
  section.appendChild(renderTokenPanel(project));
  section.appendChild(subRow);
  section.appendChild(content);
  // Inner content (e.g. the owners table's "Market" row) can request a subtab switch via this event.
  section.addEventListener('jb:goto-subtab', function (e) { if (e.detail) show(e.detail); });
  // Expose subtab switching so a route change (#…/tab/subtab) can drive it; pick the routed subtab if given.
  if (_activeDetail) _activeDetail.showSubTab = show;
  var initial = 'Accounts';
  if (opts.initialSubTab) {
    for (var oi = 0; oi < order.length; oi++) if (tabSlug(order[oi]) === tabSlug(opts.initialSubTab)) { initial = order[oi]; break; }
  }
  show(initial);
  return section;
}

// A bottom subsection (activity-feed style) within a detail card: small uppercase heading + content.
function detailSubSection(title, contentNode) {
  var s = el('div', 'detail-subsection');
  var h = el('div', 'detail-subsection-title'); h.textContent = title; s.appendChild(h);
  s.appendChild(contentNode);
  return s;
}

var BENDYSTRAW_PROJECT_QUERY = 'query($projectId: Float!, $chainId: Float!, $version: Float!) { '
  + 'project(projectId: $projectId, chainId: $chainId, version: $version) { suckerGroupId tokenSupply volume volumeUsd paymentsCount contributorsCount } }';
// Cross-chain aggregate stats for a sucker group (the honest omnichain totals).
var BENDYSTRAW_SUCKER_GROUP_STATS_QUERY = 'query($id: String!) { '
  + 'suckerGroup(id: $id) { volume volumeUsd paymentsCount contributorsCount balance tokenSupply } }';
var BENDYSTRAW_PROJECT_OPERATOR_QUERY = 'query($chainId: Int!, $projectId: Int!, $version: Int!) { '
  + 'permissionHolders(where: { chainId: $chainId, projectId: $projectId, version: $version, isRevnetOperator: true }, limit: 10) { '
  + 'items { operator permissions } } }';
// Every operator that holds permissions on this project, across all chains (drives the Permissions card).
var BENDYSTRAW_PERMISSION_HOLDERS_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!]) { '
  + 'permissionHolders(where: { projectId: $projectId, version: $version, chainId_in: $chainIds }, limit: 100) { '
  + 'items { chainId account operator permissions isRevnetOperator } } }';
// Buyback-hook AMM trades (V6 swapEvent model). Each buy/sell is a realized
// AMM price; mints are the issuance route, not a market trade.
var BENDYSTRAW_SWAP_EVENTS_QUERY = 'query($suckerGroupId: String!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'swapEvents(where: { suckerGroupId: $suckerGroupId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "timestamp", orderDirection: "asc", limit: $limit, offset: $offset) { '
  + 'items { timestamp direction terminalTokenAmount projectTokenAmount poolId chainId txHash } totalCount } }';
var BENDYSTRAW_PARTICIPANTS_BY_GROUP_QUERY = 'query($suckerGroupId: String!, $chainIds: [Int!], $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'participants(where: { suckerGroupId: $suckerGroupId, chainId_in: $chainIds, version: $version, balance_gt: "0" }, '
  + 'orderBy: "balance", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { address balance volume volumeUsd chainId projectId version suckerGroupId } totalCount } }';
var BENDYSTRAW_PARTICIPANTS_BY_PROJECT_QUERY = 'query($projectId: Int!, $chainIds: [Int!], $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'participants(where: { projectId: $projectId, chainId_in: $chainIds, version: $version, balance_gt: "0" }, '
  + 'orderBy: "balance", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { address balance volume volumeUsd chainId projectId version suckerGroupId } totalCount } }';
var BENDYSTRAW_STORE_AUTO_ISSUANCE_QUERY = 'query($projectId: Int!, $chainId: Int!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'storeAutoIssuanceAmountEvents(where: { projectId: $projectId, chainId: $chainId, version: $version }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { timestamp txHash caller beneficiary stageId count } totalCount } }';
var BENDYSTRAW_AUTO_ISSUE_EVENTS_QUERY = 'query($projectId: Int!, $chainId: Int!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'autoIssueEvents(where: { projectId: $projectId, chainId: $chainId, version: $version }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { timestamp txHash caller beneficiary stageId count } totalCount } }';
var BENDYSTRAW_SUCKER_GROUP_MOMENTS_QUERY = 'query($suckerGroupId: String!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'suckerGroupMoments(where: { suckerGroupId: $suckerGroupId, version: $version }, '
  + 'orderBy: "timestamp", orderDirection: "asc", limit: $limit, offset: $offset) { '
  + 'items { timestamp balance tokenSupply } totalCount } }';
var BENDYSTRAW_CASH_OUT_TAX_SNAPSHOTS_QUERY = 'query($suckerGroupId: String!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'cashOutTaxSnapshots(where: { suckerGroupId: $suckerGroupId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "start", orderDirection: "asc", limit: $limit, offset: $offset) { '
  + 'items { chainId start duration rulesetId cashOutTax } totalCount } }';
// Activity feed spans every meaningful event the indexer tracks (pays, cash-outs, payouts,
// reserved-token distributions, loans, NFT mints, ERC20 deploys, project creation).
var BENDYSTRAW_ACTIVITY_OR = 'OR: [{ payEvent_not: null }, { cashOutTokensEvent_not: null }, '
  + '{ sendPayoutsEvent_not: null }, { sendReservedTokensToSplitsEvent_not: null }, '
  + '{ autoIssueEvent_not: null }, { mintTokensEvent_not: null }, '
  + '{ borrowLoanEvent_not: null }, { repayLoanEvent_not: null }, { liquidateLoanEvent_not: null }, '
  + '{ mintNftEvent_not: null }, { deployErc20Event_not: null }, { projectCreateEvent_not: null }, '
  + '{ addToBalanceEvent_not: null }]';
var BENDYSTRAW_ACTIVITY_ITEM_FIELDS = 'items { id chainId timestamp txHash from type '
  + 'payEvent { amount amountUsd beneficiary memo newlyIssuedTokenCount from txHash timestamp } '
  + 'cashOutTokensEvent { cashOutCount reclaimAmount reclaimAmountUsd holder beneficiary from txHash timestamp } '
  + 'mintTokensEvent { beneficiary beneficiaryTokenCount caller from txHash timestamp } '
  + 'sendPayoutsEvent { amount amountPaidOut fee caller from txHash timestamp } '
  + 'sendReservedTokensToSplitsEvent { tokenCount from txHash timestamp } '
  + 'autoIssueEvent { beneficiary count stageId from txHash timestamp } '
  + 'borrowLoanEvent { borrowAmount collateral beneficiary from txHash timestamp } '
  + 'repayLoanEvent { repayBorrowAmount collateralCountToReturn from txHash timestamp } '
  + 'liquidateLoanEvent { borrowAmount collateral from txHash timestamp } '
  + 'mintNftEvent { tierId tokenId beneficiary totalAmountPaid from txHash timestamp } '
  + 'deployErc20Event { symbol name token from txHash timestamp } '
  + 'projectCreateEvent { from txHash timestamp } '
  + 'addToBalanceEvent { amount memo from txHash timestamp } } totalCount';
var BENDYSTRAW_ACTIVITY_EVENTS_QUERY = 'query($suckerGroupId: String!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'activityEvents(where: { suckerGroupId: $suckerGroupId, version: $version, chainId_in: $chainIds, ' + BENDYSTRAW_ACTIVITY_OR + ' }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + BENDYSTRAW_ACTIVITY_ITEM_FIELDS + ' } }';
var BENDYSTRAW_ACTIVITY_EVENTS_BY_PROJECT_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'activityEvents(where: { projectId: $projectId, version: $version, chainId_in: $chainIds, ' + BENDYSTRAW_ACTIVITY_OR + ' }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + BENDYSTRAW_ACTIVITY_ITEM_FIELDS + ' } }';
// History lists (Bendystraw): payout distributions, reserved-token distributions, and loans.
var BENDYSTRAW_RESERVED_DIST_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'sendReservedTokensToSplitsEvents(where: { projectId: $projectId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { tokenCount timestamp txHash chainId } totalCount } }';
var BENDYSTRAW_LOANS_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'loans(where: { projectId: $projectId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "createdAt", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { id borrowAmount collateral beneficiary owner createdAt chainId prepaidFeePercent prepaidDuration sourceFeeAmount } totalCount } }';

// REVLoans liquidation horizon (LOAN_LIQUIDATION_DURATION = 3650 days). After this the collateral is lost.
var LOAN_LIQUIDATION_SECONDS = 3650 * 86400;
// The source fee still owed on full repayment NOW, beyond what was prepaid at open — mirrors
// REVLoansSourceFees.sourceFeeAmountFrom: 0 inside the prepaid window, then a linear ramp of the
// un-prepaid remainder from 0 (window end) to 100% (liquidation). All BigInt, MAX_FEE = 1000.
function loanOutstandingFee(loan, nowSec) {
  var amount = toBigInt(loan.borrowAmount);
  var prepaidPct = BigInt(Number(loan.prepaidFeePercent || 0));
  var prepaidDur = Number(loan.prepaidDuration || 0);
  var elapsed = nowSec - Number(loan.createdAt || 0);
  if (elapsed <= prepaidDur) return 0n;
  if (elapsed > LOAN_LIQUIDATION_SECONDS) return null; // expired — no longer repayable
  var prepaid = amount * prepaidPct / BigInt(LOAN_MAX_FEE);
  var rampPct = BigInt(elapsed - prepaidDur) * BigInt(LOAN_MAX_FEE) / BigInt(LOAN_LIQUIDATION_SECONDS - prepaidDur);
  return (amount - prepaid) * rampPct / BigInt(LOAN_MAX_FEE);
}

function autoIssueEventKey(row) {
  return [
    Number(row.chainId),
    String(row.stageId || ''),
    String(row.beneficiary || '').toLowerCase(),
    String(row.count || '0'),
  ].join(':');
}

function autoIssueAllocationKey(row) {
  return [
    Number(row.chainId),
    String(row.stageId || ('stage:' + row.stageIndex)),
    String(row.beneficiary || '').toLowerCase(),
    String(row.count || '0'),
  ].join(':');
}

async function fetchBendystrawAutoIssuePages(query, path, projectId, chainId) {
  var items = [];
  var totalCount = 0;
  var offset = 0;
  while (offset < AUTO_ISSUE_MAX_EVENTS) {
    var data = await bendystrawQuery(query, {
      projectId: Number(projectId),
      chainId: Number(chainId),
      version: BENDYSTRAW_VERSION,
      limit: AUTO_ISSUE_PAGE_SIZE,
      offset: offset,
    });
    var result = data && data[path];
    var page = (result && result.items) || [];
    if (result && result.totalCount != null) totalCount = Number(result.totalCount) || 0;
    items = items.concat(page.map(function (item) {
      return Object.assign({ chainId: Number(chainId) }, item);
    }));
    if (!page.length || items.length >= totalCount || items.length >= AUTO_ISSUE_MAX_EVENTS) break;
    offset += page.length;
  }
  return items;
}

async function fetchBendystrawCollectionPages(query, path, variables, pageSize, maxItems) {
  var items = [];
  var totalCount = 0;
  var offset = 0;
  while (offset < maxItems) {
    var data = await bendystrawQuery(query, Object.assign({}, variables, {
      limit: pageSize,
      offset: offset,
    }));
    var result = data && data[path];
    var page = (result && result.items) || [];
    if (result && result.totalCount != null) totalCount = Number(result.totalCount) || 0;
    items = items.concat(page);
    if (!page.length || items.length >= totalCount || items.length >= maxItems) break;
    offset += page.length;
  }
  return { items: items, totalCount: totalCount || items.length };
}

async function fetchIndexedAutoIssuanceRows(project, chainIds) {
  var pages = await Promise.all(chainIds.map(async function (chainId) {
    // Main allocations query is strict — if Bendystraw fails, let it throw so the section hides rather
    // than showing fabricated data. The distributed-status lookup stays tolerant (best-effort enrichment).
    var stored = await fetchBendystrawAutoIssuePages(
      BENDYSTRAW_STORE_AUTO_ISSUANCE_QUERY,
      'storeAutoIssuanceAmountEvents',
      project.id,
      chainId
    );
    var issued = await fetchBendystrawAutoIssuePages(
      BENDYSTRAW_AUTO_ISSUE_EVENTS_QUERY,
      'autoIssueEvents',
      project.id,
      chainId
    ).catch(function () { return []; });
    return { stored: stored, issued: issued };
  }));

  var issuedByKey = {};
  pages.forEach(function (page) {
    page.issued.forEach(function (event) {
      issuedByKey[autoIssueEventKey(event)] = event;
    });
  });

  var byKey = {};
  pages.forEach(function (page) {
    page.stored.forEach(function (event) {
      if (!event || !event.beneficiary || toBigInt(event.count) === 0n) return;
      var row = {
        source: 'bendystraw',
        chainId: Number(event.chainId),
        stageId: String(event.stageId),
        stageIndex: null,
        beneficiary: event.beneficiary,
        count: toBigInt(event.count),
        storedTxHash: event.txHash || null,
        storedTimestamp: event.timestamp || null,
        distributedEvent: issuedByKey[autoIssueEventKey(event)] || null,
      };
      var key = autoIssueAllocationKey(row);
      var previous = byKey[key];
      if (!previous || Number(row.storedTimestamp || 0) > Number(previous.storedTimestamp || 0)) byKey[key] = row;
    });
  });

  return Object.keys(byKey).map(function (key) { return byKey[key]; });
}

function stageMatchForAutoIssue(row, stages) {
  if (!stages || !stages.length) return { stage: null, stageIndex: row.stageIndex == null ? -1 : row.stageIndex };
  if (row.stageId != null) {
    for (var i = 0; i < stages.length; i++) {
      if (String(stages[i].id) === String(row.stageId)) return { stage: stages[i], stageIndex: i };
    }
    // stageId from a superseded ruleset (project re-queued) matches no current stage → drop the row.
    // Falling back to stages[0] here is what dumped stale allocations under Stage 1 with the current
    // stage's remaining stapled on.
    return { stage: null, stageIndex: -1 };
  }
  var idx = row.stageIndex == null ? 0 : Number(row.stageIndex);
  return { stage: stages[idx] || null, stageIndex: idx };
}

async function enrichAutoIssuanceRow(project, row, stagesForChain) {
  var chain = chainById(row.chainId);
  var revOwnerAddr = getAddress('REVOwner', chain.id);
  if (!revOwnerAddr) return null;
  var chainStages = await stagesForChain(chain.id);
  var match = stageMatchForAutoIssue(row, chainStages);
  if (!match.stage) return null;
  var remaining = await clientFor(chain.id).readContract({
    address: revOwnerAddr,
    abi: amountToAutoIssueAbi,
    functionName: 'amountToAutoIssue',
    args: [BigInt(project.id), BigInt(match.stage.id), row.beneficiary],
  }).catch(function () { return null; });

  return Object.assign({}, row, {
    chain: chain,
    revOwnerAddr: revOwnerAddr,
    stage: match.stage,
    stageId: String(match.stage.id),
    stageIndex: match.stageIndex,
    remaining: remaining,
    distributed: !!row.distributedEvent || remaining === 0n,
  });
}

async function loadAutoIssuanceRows(project, chains, stagesForChain) {
  var chainIds = chains.map(function (chain) { return Number(chain.id); }).filter(function (chainId, idx, arr) {
    return CHAINS[chainId] && arr.indexOf(chainId) === idx;
  });
  if (!chainIds.length) return [];

  // Bendystraw only — no deploy-script fallback. A failure here propagates so the section shows an
  // error/empty instead of fabricated rows.
  var rows = await fetchIndexedAutoIssuanceRows(project, chainIds);
  rows = await Promise.all(rows.map(function (row) {
    return enrichAutoIssuanceRow(project, row, stagesForChain);
  }));
  rows = rows.filter(Boolean);
  var byKey = {};
  rows.forEach(function (row) {
    var key = autoIssueAllocationKey(row);
    var previous = byKey[key];
    if (!previous) {
      byKey[key] = row;
      return;
    }
    byKey[key] = Object.assign({}, previous, row.source === 'bendystraw' ? row : previous, {
      distributed: previous.distributed || row.distributed,
      distributedEvent: previous.distributedEvent || row.distributedEvent,
      remaining: row.remaining != null ? row.remaining : previous.remaining,
    });
  });
  rows = Object.keys(byKey).map(function (key) { return byKey[key]; });
  rows.sort(function (a, b) {
    var as = a.stage ? Number(a.stage.start) : 0;
    var bs = b.stage ? Number(b.stage.start) : 0;
    if (as !== bs) return as - bs;
    if (a.stageIndex !== b.stageIndex) return a.stageIndex - b.stageIndex;
    var ac = chainSortIndex(a.chain.id);
    var bc = chainSortIndex(b.chain.id);
    if (ac !== bc) return ac - bc;
    return String(a.beneficiary).localeCompare(String(b.beneficiary));
  });
  return rows;
}


function renderAutoIssuanceTable(rows, sym, distribute) {
  var table = el('div', 'autoissue-table');
  var head = el('div', 'autoissue-row autoissue-head');
  var symClean = (sym || '').trim();
  var labels = ['Chain', 'Stage', 'Account', symClean ? ('Amount (' + symClean + ')') : 'Amount', 'Unlock date', 'Distribute'];
  labels.forEach(function (h) {
    var cell = el('span');
    cell.textContent = h;
    head.appendChild(cell);
  });
  table.appendChild(head);

  rows.forEach(function (row) {
    var tr = el('div', 'autoissue-row');

    var chainCell = el('span', 'autoissue-chain');
    chainCell.setAttribute('data-label', labels[0]);
    chainCell.appendChild(chainLogo(row.chain.id, row.chain.name));
    // Show the real chain name (incl. "… Sepolia" on testnet) — stripping it made L2 testnets look like mainnet.
    chainCell.appendChild(document.createTextNode(row.chain.name));
    tr.appendChild(chainCell);

    var stageCell = el('span');
    stageCell.setAttribute('data-label', labels[1]);
    stageCell.textContent = String(row.stageIndex + 1);
    tr.appendChild(stageCell);

    var acct = el('span', 'autoissue-account');
    acct.setAttribute('data-label', labels[2]);
    acct.appendChild(addressNode(row.beneficiary));
    tr.appendChild(acct);

    var amount = el('span', 'autoissue-amount');
    amount.setAttribute('data-label', labels[3]);
    var main = el('span');
    main.textContent = formatTokenCount(row.count);
    amount.appendChild(main);
    if (row.remaining != null && row.remaining !== row.count && row.remaining > 0n) {
      var remaining = el('span', 'autoissue-muted');
      remaining.textContent = formatTokenCount(row.remaining) + ' remaining';
      amount.appendChild(remaining);
    }
    tr.appendChild(amount);

    var unlock = el('span');
    unlock.setAttribute('data-label', labels[4]);
    unlock.textContent = row.stage ? formatDateShort(row.stage.start) : '—';
    tr.appendChild(unlock);

    var action = el('span', 'autoissue-action');
    action.setAttribute('data-label', labels[5]);
    renderAutoIssueAction(action, row, distribute);
    tr.appendChild(action);

    table.appendChild(tr);
  });

  return table;
}

function renderAutoIssueAction(cell, row, distribute) {
  var now = Math.floor(Date.now() / 1000);
  if (row.distributedEvent) {
    // Idle "Distributed" text, linked to the tx (no checkmark).
    cell.classList.add('autoissue-distributed');
    cell.appendChild(renderExplorerTxLink(row.chain.id, row.distributedEvent.txHash, 'Distributed'));
    return;
  }
  if (row.remaining === 0n || row.distributed) {
    cell.classList.add('autoissue-distributed');
    cell.textContent = 'Distributed';
    return;
  }

  var btn = document.createElement('button');
  btn.className = 'ops-action-btn autoissue-btn';
  if (row.remaining == null) {
    btn.textContent = 'Unavailable';
    btn.disabled = true;
  } else if (row.stage && Number(row.stage.start) > now) {
    btn.textContent = 'Locked';
    btn.disabled = true;
    btn.title = 'Unlocks ' + formatDateTime(row.stage.start);
  } else {
    btn.textContent = 'Distribute';
    btn.addEventListener('click', function () { distribute(row, btn); });
  }
  cell.appendChild(btn);
}

function projectChainIds(project) {
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId }];
  var seen = {};
  return chains.map(function (c) { return Number(c.id); }).filter(function (cid) {
    if (!CHAINS[cid] || seen[cid]) return false;
    seen[cid] = true;
    return true;
  });
}

function projectBendystrawChainIds(project) {
  var source = projectChainIds(project);
  if (!source.length && project.chainId) source = [Number(project.chainId)];
  var seen = {};
  var out = [];
  function add(chainId) {
    var cid = Number(chainId);
    if (!cid || seen[cid]) return;
    seen[cid] = true;
    out.push(cid);
  }
  source.forEach(function (chainId) {
    add(chainId);
    if (BENDYSTRAW_PARENT_CHAIN_ID[chainId]) add(BENDYSTRAW_PARENT_CHAIN_ID[chainId]);
  });
  return out;
}

function chainSortIndex(chainId) {
  for (var i = 0; i < DISCOVER_CHAINS.length; i++) if (DISCOVER_CHAINS[i].id === Number(chainId)) return i;
  return 999;
}

function toBigInt(value) {
  if (value === null || value === undefined || value === '') return 0n;
  try { return BigInt(value); } catch (e) { return 0n; }
}

async function resolveBendystrawSuckerGroupId(project, chainIds) {
  var seen = {};
  var queryChainIds = [];
  function addChain(chainId) {
    var cid = Number(chainId);
    if (!cid || seen[cid]) return;
    seen[cid] = true;
    queryChainIds.push(cid);
    if (BENDYSTRAW_PARENT_CHAIN_ID[cid] && !seen[BENDYSTRAW_PARENT_CHAIN_ID[cid]]) {
      seen[BENDYSTRAW_PARENT_CHAIN_ID[cid]] = true;
      queryChainIds.push(BENDYSTRAW_PARENT_CHAIN_ID[cid]);
    }
  }
  chainIds.forEach(addChain);
  var rows = await Promise.all(queryChainIds.map(function (chainId) {
    return bendystrawQuery(BENDYSTRAW_PROJECT_QUERY, {
      projectId: Number(project.id),
      chainId: Number(chainId),
      version: BENDYSTRAW_VERSION,
    }).then(function (data) { return data && data.project; }).catch(function () { return null; });
  }));
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].suckerGroupId) return rows[i].suckerGroupId;
  }
  return null;
}

async function fetchPriceFloorHistory(project, stages) {
  var chainIds = projectBendystrawChainIds(project);
  if (!chainIds.length) return [];
  var groupId = await resolveBendystrawSuckerGroupId(project, chainIds);
  if (!groupId) return [];

  var currentTax = project.metadata && project.metadata.cashOutTaxRate != null
    ? Number(project.metadata.cashOutTaxRate)
    : 0;
  var projectStart = stages && stages.length ? Number(stages[0].start) : 0;

  var res = await Promise.all([
    fetchBendystrawCollectionPages(BENDYSTRAW_SUCKER_GROUP_MOMENTS_QUERY, 'suckerGroupMoments', {
      suckerGroupId: groupId,
      version: BENDYSTRAW_VERSION,
    }, PRICE_HISTORY_PAGE_SIZE, PRICE_HISTORY_MAX_POINTS),
    fetchBendystrawCollectionPages(BENDYSTRAW_CASH_OUT_TAX_SNAPSHOTS_QUERY, 'cashOutTaxSnapshots', {
      suckerGroupId: groupId,
      version: BENDYSTRAW_VERSION,
      chainIds: chainIds,
    }, PRICE_HISTORY_PAGE_SIZE, PRICE_HISTORY_MAX_POINTS),
  ]);
  var moments = res[0].items || [];
  var taxes = (res[1].items || []).sort(function (a, b) { return Number(a.start) - Number(b.start); });
  if (!moments.length) return [];

  var out = [];
  var firstMoment = Number(moments[0].timestamp);
  if (projectStart && firstMoment > projectStart) out.push({ timestamp: projectStart, value: 0 });
  moments.forEach(function (moment) {
    var timestamp = Number(moment.timestamp);
    var tax = cashOutTaxAt(timestamp, taxes, currentTax);
    var value = calculateFloorPrice(toBigInt(moment.balance), toBigInt(moment.tokenSupply), tax);
    out.push({ timestamp: timestamp, value: value });
  });
  return out.sort(function (a, b) { return a.timestamp - b.timestamp; });
}

// Historical AMM trade prices + buy/sell volume from the buyback hook's swapEvents.
// Realized price = terminal tokens / project tokens (both 18-decimal → ETH per token).
// Returns the empty shape if the model isn't indexed yet — never fabricates.
async function fetchSwapHistory(project) {
  var empty = { series: [], buyVolume: 0, sellVolume: 0, count: 0 };
  var chainIds = projectBendystrawChainIds(project);
  if (!chainIds.length) return empty;
  var groupId = await resolveBendystrawSuckerGroupId(project, chainIds);
  if (!groupId) return empty;

  var res = await fetchBendystrawCollectionPages(BENDYSTRAW_SWAP_EVENTS_QUERY, 'swapEvents', {
    suckerGroupId: groupId,
    version: BENDYSTRAW_VERSION,
    chainIds: chainIds,
  }, PRICE_HISTORY_PAGE_SIZE, PRICE_HISTORY_MAX_POINTS);

  var items = res.items || [];
  var series = [];
  var buyVolume = 0, sellVolume = 0, count = 0;
  items.forEach(function (sw) {
    if (sw.direction === 'mint') return; // mint is the issuance route, not a market trade
    var terminalEth = Number(toBigInt(sw.terminalTokenAmount)) / 1e18;
    if (sw.direction === 'buy') buyVolume += terminalEth;
    else if (sw.direction === 'sell') sellVolume += terminalEth;
    count++;
    var tokens = Number(toBigInt(sw.projectTokenAmount));
    if (tokens > 0) {
      var price = Number(toBigInt(sw.terminalTokenAmount)) / tokens; // ETH per token (both 18-dec)
      if (price > 0) series.push({ timestamp: Number(sw.timestamp), value: price });
    }
  });
  series.sort(function (a, b) { return a.timestamp - b.timestamp; });
  return { series: series, buyVolume: buyVolume, sellVolume: sellVolume, count: count };
}

// Indexed project stats (volume / payments / contributors) from Bendystraw. Prefers the
// cross-chain sucker-group aggregate (the honest omnichain total) over the single-chain
// project row. Returns null on any failure — never fabricates.
async function fetchProjectIndexedStats(id, chainId) {
  try {
    var data = await bendystrawQuery(BENDYSTRAW_PROJECT_QUERY, {
      projectId: Number(id),
      chainId: Number(chainId),
      version: BENDYSTRAW_VERSION,
    });
    var p = data && data.project;
    if (!p) return null;
    var stats = {
      volume: p.volume,
      volumeUsd: p.volumeUsd,
      paymentsCount: Number(p.paymentsCount) || 0,
      contributorsCount: Number(p.contributorsCount) || 0,
    };
    if (p.suckerGroupId) {
      var agg = await bendystrawQuery(BENDYSTRAW_SUCKER_GROUP_STATS_QUERY, { id: p.suckerGroupId })
        .then(function (d) { return d && d.suckerGroup; })
        .catch(function () { return null; });
      if (agg) {
        stats.volume = agg.volume;
        stats.volumeUsd = agg.volumeUsd;
        stats.paymentsCount = Number(agg.paymentsCount) || 0;
        stats.contributorsCount = Number(agg.contributorsCount) || 0;
      }
    }
    return stats;
  } catch (e) {
    return null;
  }
}

// Fetch a recent slice of a per-project Bendystraw event collection (across the project's chains).
// Returns [] on any failure — never throws.
async function fetchProjectEventRows(query, path, project, maxItems) {
  var chainIds = projectBendystrawChainIds(project);
  if (!chainIds.length) return [];
  try {
    var res = await fetchBendystrawCollectionPages(query, path, {
      projectId: Number(project.id),
      version: BENDYSTRAW_VERSION,
      chainIds: chainIds,
    }, maxItems, maxItems);
    return res.items || [];
  } catch (e) {
    return [];
  }
}

// Fill a box with a lazily-loaded history list. rowFn(row) -> DOM node. Handles loading/empty/error.
function appendBendystrawHistory(box, fetchFn, rowFn, emptyText) {
  box.textContent = 'Loading from Bendystraw…';
  fetchFn().then(function (rows) {
    box.innerHTML = '';
    if (!rows.length) { box.textContent = emptyText || 'None yet.'; return; }
    rows.forEach(function (r) { box.appendChild(rowFn(r)); });
  }).catch(function () { box.innerHTML = ''; box.textContent = 'Could not load from Bendystraw.'; });
}

// A label-left (tx link + time) / value-right history row.
function historyRow(chainId, txHash, timestamp, valueText) {
  var row = el('div', 'rf-perchain-row');
  var left = el('span', 'rf-perchain-name');
  left.appendChild(renderExplorerTxLink(chainId, txHash, timeAgo(timestamp)));
  row.appendChild(left);
  var val = el('span', 'rf-perchain-val'); val.textContent = valueText;
  row.appendChild(val);
  return row;
}

function cashOutTaxAt(timestamp, snapshots, fallback) {
  var tax = fallback == null ? 0 : Number(fallback);
  for (var i = 0; i < snapshots.length; i++) {
    if (Number(snapshots[i].start) > timestamp) break;
    if (snapshots[i].cashOutTax != null) tax = Number(snapshots[i].cashOutTax);
  }
  return tax;
}

function calculateFloorPrice(balance, tokenSupply, cashOutTax) {
  if (!balance || !tokenSupply || balance === 0n || tokenSupply === 0n) return 0;
  var r = Number(cashOutTax || 0) / 10000;
  var o = Number(balance);
  var s = Number(tokenSupply);
  var x = Number(ONE_TOKEN);
  var y = ((o * x) / s) * (1 - r + (r * x) / s);
  var value = y / 1e18;
  return isFinite(value) && value > 0 ? value : 0;
}

async function fetchProjectActivity(project) {
  var chainIds = projectBendystrawChainIds(project);
  if (!chainIds.length) return [];
  var groupId = await resolveBendystrawSuckerGroupId(project, chainIds);

  // Query by BOTH the current sucker group AND the (omnichain-consistent) projectId, then merge.
  // Why both: an activityEvent's `suckerGroupId` is the group AS OF that event. Sucker groups merge
  // over time as chains link up, so the earliest events (project creation, ERC20 deploy) on each chain
  // carry a stale per-chain group id and the by-group query misses them — they only show on the one
  // chain whose early event happens to match the current group. The by-projectId query recovers the
  // rest (projectId is deterministic and identical across an omnichain deploy). Dedup by event id.
  var queries = [];
  if (groupId) {
    queries.push(fetchBendystrawCollectionPages(BENDYSTRAW_ACTIVITY_EVENTS_QUERY, 'activityEvents', {
      suckerGroupId: groupId, version: BENDYSTRAW_VERSION, chainIds: chainIds,
    }, ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE).catch(function () { return { items: [] }; }));
  }
  queries.push(fetchBendystrawCollectionPages(BENDYSTRAW_ACTIVITY_EVENTS_BY_PROJECT_QUERY, 'activityEvents', {
    projectId: Number(project.id), version: BENDYSTRAW_VERSION, chainIds: chainIds,
  }, ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE).catch(function () { return { items: [] }; }));

  var results = await Promise.all(queries);
  var seen = {}, merged = [];
  results.forEach(function (res) {
    (res.items || []).forEach(function (ev) {
      var key = ev.id || ((ev.txHash || '') + ':' + (ev.type || '') + ':' + ev.chainId);
      if (seen[key]) return;
      seen[key] = true;
      merged.push(ev);
    });
  });
  merged.sort(function (a, b) { return Number(b.timestamp || 0) - Number(a.timestamp || 0); });
  var bendyRows = merged.map(function (event) {
    return activityRowFromEvent(event, project);
  }).filter(Boolean);

  // Ruleset queueing isn't indexed by bendystraw (no queueRulesets ActivityEvent type), so synthesize it
  // from chain state: JBRulesets.allOf returns each configured ruleset, whose `id` IS the queue timestamp.
  var rsRows = await fetchRulesetQueueRows(project).catch(function () { return []; });
  return bendyRows.concat(rsRows);
}

var RULESET_QUEUED_EVENT = { type: 'event', name: 'RulesetQueued', inputs: [
  { name: 'rulesetId', type: 'uint256', indexed: true },
  { name: 'projectId', type: 'uint256', indexed: true },
  { name: 'duration', type: 'uint256', indexed: false },
  { name: 'weight', type: 'uint256', indexed: false },
  { name: 'weightCutPercent', type: 'uint256', indexed: false },
  { name: 'approvalHook', type: 'address', indexed: false },
  { name: 'metadata', type: 'uint256', indexed: false },
  { name: 'mustStartAtOrAfter', type: 'uint256', indexed: false },
  { name: 'caller', type: 'address', indexed: false },
] };

// Synthesize "queued Ruleset with ID N" activity rows from chain state (bendystraw doesn't index ruleset
// queueing — there is no RulesetQueued ActivityEvent type). JBRulesets.allOf(pid, 0, 8) gives the configured
// rulesets, whose `id` == the queue timestamp. The genesis ruleset (`basedOnId == 0`) is queued in the same tx
// as the project's creation, so it's dropped here — it already shows as "created the project". For each
// remaining ruleset we recover the queuer (`caller`) and tx from the RulesetQueued event: RPCs cap eth_getLogs
// at 50k blocks, so we estimate the ruleset's block from its timestamp (rulesetId == queue timestamp) using the
// chain's recent block rate, then scan a ±25k window filtered by the indexed rulesetId. Found → attributed row
// (actor + tx link); not found (very old, outside the window) → a `system` fallback row (no actor/tx).
async function fetchRulesetQueueRows(project) {
  var pid = BigInt(project.id);
  var chainIds = projectBendystrawChainIds(project);
  if (!chainIds.length) return [];
  var rows = [];
  await Promise.all(chainIds.map(async function (cid) {
    var rs = await read(cid, 'JBRulesets', allOfAbi, 'allOf', [pid, 0n, 8n]).catch(function () { return null; });
    if (!rs || !rs.length) return;
    var queued = rs.filter(function (r) { return Number(r.basedOnId) !== 0 && Number(r.id) > 0; });
    if (!queued.length) return;

    var callerById = {};
    try {
      var lc = lpLogsClient(cid) || clientFor(cid);
      var rsAddr = getAddress('JBRulesets', cid);
      var latestNum = await lc.getBlockNumber();
      var latestBlk = await lc.getBlock({ blockNumber: latestNum });
      var refNum = latestNum > 20000n ? latestNum - 20000n : 0n;
      var refBlk = await lc.getBlock({ blockNumber: refNum });
      var spanBlocks = Number(latestNum - refNum) || 1;
      var secPerBlock = (Number(latestBlk.timestamp) - Number(refBlk.timestamp)) / spanBlocks;
      if (!(secPerBlock > 0)) secPerBlock = 12;
      await Promise.all(queued.map(async function (r) {
        var est = Number(latestNum) - Math.floor((Number(latestBlk.timestamp) - Number(r.id)) / secPerBlock);
        var hi = Math.min(Number(latestNum), est + 25000);
        var lo = Math.max(0, est - 25000);
        if (hi < 0) return;
        var logs = await lc.getLogs({
          address: rsAddr, event: RULESET_QUEUED_EVENT, args: { rulesetId: BigInt(r.id) },
          fromBlock: BigInt(lo), toBlock: BigInt(hi),
        }).catch(function () { return []; });
        if (logs && logs[0]) callerById[String(r.id)] = { caller: logs[0].args.caller, txHash: logs[0].transactionHash };
      }));
    } catch (_) {}

    queued.forEach(function (r) {
      var info = callerById[String(r.id)];
      // Label by cycle NUMBER (stable across chains) so the same ruleset queued on every chain groups into one
      // row — the rulesetId differs per chain (it's the local queue timestamp) and would split the rows apart.
      if (info && info.caller) {
        rows.push({
          type: 'queue_ruleset', direction: '', chainId: cid,
          txHash: info.txHash || '', timestamp: Number(r.id), account: info.caller, from: info.caller,
          baseAmount: '', tokenAmount: '',
          action: 'queued Ruleset #' + Number(r.cycleNumber), memo: '',
        });
      } else {
        rows.push({
          type: 'queue_ruleset', system: true, direction: '', chainId: cid,
          txHash: '', timestamp: Number(r.id), account: '', from: '',
          baseAmount: '', tokenAmount: '',
          action: 'Ruleset #' + Number(r.cycleNumber) + ' queued', memo: '',
        });
      }
    });
  }));
  return rows;
}

// Reconstruct bridge transactions from chain state. (Bendystraw now indexes V6, but the action-critical
// data isn't there: the merkle PROOF needed to claim isn't indexed — revnet-app fetches it from a separate
// juicerkle service — and claimable/claimed status must be read live from the destination sucker's inbox
// root + executed bitmap. So we read it all from chain in one consistent pass.) Per sucker: enumerate the
// outbound InsertToOutboxTree leaves, then derive per-leaf status from the source outbox (sent?) and the
// destination inbox (delivered? claimed?). Claimable rows carry a locally-verified merkle proof.
async function fetchBridgeTransactions(project) {
  var pid = project.id;
  var chains = (project.chains || []).map(function (c) { return c.id; });
  var rows = [];
  await Promise.all(chains.map(async function (C) {
    var pairs = await readSuckerPairsOf(pid, C);
    // The terminal (backing) token the suckers bridge for this project — USDC for a USDC project, native
    // ETH for an ETH project. The outbox/inbox trees are keyed per token, so the whole scan must use it.
    var acct = await resolveAcctToken(C, pid);
    var TOKEN = acct.address;
    await Promise.all(pairs.map(async function (p) {
      var srcSucker = p.local, R = p.remoteChainId, peerSucker = p.remote;
      var infra = await classifySuckerInfra(C, srcSucker).catch(function () { return 'native'; }); // CCIP vs native bridge → which tracker to link
      // The DESTINATION inbox/claim is keyed by the destination chain's LOCAL token (e.g. Base USDC), which
      // differs from the source token (Ethereum USDC). Resolve it for the inbox/executed/claim reads on R.
      var remoteAcct = await resolveAcctToken(R, pid).catch(function () { return { address: TOKEN }; });
      var RTOKEN = remoteAcct.address;
      var logClient = lpLogsClient(C) || clientFor(C);
      var latest; try { latest = await logClient.getBlockNumber(); } catch (_) { return; }
      var W = 45000n, windows = [];
      // 5 windows (~225k blocks) covers recent movements on every chain without the slowest tail — the table
      // is "Recent movement", and pending/claimable leaves are recent. Fewer getLogs = faster first paint.
      for (var n = 0; n < 5 && latest - BigInt(n) * W > 0n; n++) { var hi = latest - BigInt(n) * W, lo = hi > W ? hi - W + 1n : 0n; windows.push({ lo: lo, hi: hi }); if (lo === 0n) break; }
      var batches = await Promise.all(windows.map(function (w) {
        return logClient.getLogs({ address: srcSucker, event: INSERT_TO_OUTBOX_EVENT, args: { token: TOKEN }, fromBlock: w.lo, toBlock: w.hi }).catch(function () { return []; });
      }));
      var byIndex = {}, blockOf = {};
      batches.forEach(function (b) { b.forEach(function (l) { var i = Number(l.args.index); if (byIndex[i] === undefined) { byIndex[i] = l.args; blockOf[i] = l.blockNumber; } }); });
      var idxs = Object.keys(byIndex).map(Number);
      if (!idxs.length) return;
      var count = Math.max.apply(null, idxs) + 1;
      var leafHashes = [], complete = true;
      for (var i = 0; i < count; i++) { if (!byIndex[i]) { complete = false; break; } leafHashes.push(byIndex[i].hashed); }

      // sent-so-far on the source, delivered root on the destination
      var sentCount = 0;
      try { var ob = await clientFor(C).readContract({ address: srcSucker, abi: suckerClaimAbi, functionName: 'outboxOf', args: [TOKEN] }); sentCount = Number(ob.numberOfClaimsSent); } catch (_) {}
      var inboxRoot = SUCKER_BYTES32_ZERO;
      try { var ib = await clientFor(R).readContract({ address: peerSucker, abi: suckerClaimAbi, functionName: 'inboxOf', args: [RTOKEN] }); inboxRoot = (ib && ib.root) || SUCKER_BYTES32_ZERO; } catch (_) {}
      var deliveredCount = 0;
      if (!/^0x0+$/.test(inboxRoot)) Object.keys(byIndex).forEach(function (k) { if ((byIndex[k].root || '').toLowerCase() === inboxRoot.toLowerCase()) deliveredCount = Number(k) + 1; });

      // block timestamps for "Initiated"
      var ts = {};
      await Promise.all(Object.keys(blockOf).map(async function (k) { try { var blk = await logClient.getBlock({ blockNumber: blockOf[k] }); ts[k] = Number(blk.timestamp); } catch (_) { ts[k] = 0; } }));

      for (var k = 0; k < count; k++) {
        var a = byIndex[k]; if (!a) continue;
        var executed = false;
        try { var ex = await clientFor(R).readContract({ address: peerSucker, abi: suckerClaimAbi, functionName: 'executedLeafHashOf', args: [RTOKEN, BigInt(k)] }); executed = ex && !/^0x0+$/.test(ex); } catch (_) {}
        var status, proof = null, canExecute = false;
        if (executed) status = 'claimed';
        else if (complete && k < deliveredCount && suckerBranchRoot(a.hashed, (proof = suckerLeafProof(leafHashes.slice(0, deliveredCount), k)), k).toLowerCase() === inboxRoot.toLowerCase()) status = 'claimable';
        else { status = 'pending'; proof = null; canExecute = (k >= sentCount); }
        rows.push({
          createdAt: ts[k] || 0, chainId: C, peerChainId: R, beneficiary: '0x' + String(a.beneficiary).slice(-40),
          projectTokenCount: a.projectTokenCount, terminalTokenAmount: a.terminalTokenAmount, status: status,
          index: k, sourceSucker: srcSucker, peerSucker: peerSucker, metadata: a.metadata, beneficiary32: a.beneficiary,
          proof: proof, canExecute: canExecute,
          token: TOKEN, remoteToken: RTOKEN, tokenDecimals: acct.decimals, tokenSymbol: acct.symbol, infra: infra,
        });
      }
    }));
  }));
  rows.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  return rows;
}

async function fetchBendystrawParticipantPages(query, variables) {
  var items = [];
  var totalCount = 0;
  var offset = 0;
  while (offset < OWNERS_MAX_PARTICIPANTS) {
    var data = await bendystrawQuery(query, Object.assign({}, variables, {
      limit: OWNERS_PAGE_SIZE,
      offset: offset,
    }));
    var result = data && data.participants;
    var page = (result && result.items) || [];
    if (result && result.totalCount != null) totalCount = Number(result.totalCount) || 0;
    items = items.concat(page);
    if (!page.length || items.length >= totalCount || items.length >= OWNERS_MAX_PARTICIPANTS) break;
    offset += page.length;
  }
  return { items: items, totalCount: totalCount || items.length };
}

function aggregateParticipants(items) {
  var byAddress = {};
  items.forEach(function (p) {
    if (!p || !p.address) return;
    var key = String(p.address).toLowerCase();
    if (!byAddress[key]) {
      byAddress[key] = {
        address: p.address,
        balance: 0n,
        volume: 0n,
        volumeUsd: 0n,
        chains: {},
      };
    }
    byAddress[key].balance += toBigInt(p.balance);
    byAddress[key].volume += toBigInt(p.volume);
    byAddress[key].volumeUsd += toBigInt(p.volumeUsd);
    if (p.chainId != null) byAddress[key].chains[Number(p.chainId)] = true;
  });
  return Object.keys(byAddress).map(function (key) {
    var row = byAddress[key];
    row.chains = Object.keys(row.chains).map(Number).sort(function (a, b) { return chainSortIndex(a) - chainSortIndex(b); });
    return row;
  }).filter(function (row) {
    return row.balance > 0n;
  }).sort(function (a, b) {
    return a.balance > b.balance ? -1 : (a.balance < b.balance ? 1 : 0);
  });
}

async function readTotalSupplyAcrossChains(project, chainIds) {
  var pid = BigInt(project.id);
  var supplies = await Promise.all(chainIds.map(function (chainId) {
    return read(chainId, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return 0n; });
  }));
  return supplies.reduce(function (sum, value) { return sum + (value || 0n); }, 0n);
}

// Pay events carry amount + amountUsd but not the token, so we infer the paid token (USDC 6-dec vs ETH
// 18-dec) and sum per beneficiary → literal per-token "Paid" totals (e.g. "20 USDC, 0.01 ETH").
var BENDYSTRAW_PAY_BY_GROUP_QUERY = 'query($suckerGroupId: String!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { payEvents(where: { suckerGroupId: $suckerGroupId, version: $version, chainId_in: $chainIds }, orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { items { beneficiary amount amountUsd } totalCount } }';
var BENDYSTRAW_PAY_BY_PROJECT_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { payEvents(where: { projectId: $projectId, version: $version, chainId_in: $chainIds }, orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { items { beneficiary amount amountUsd } totalCount } }';
async function fetchPaidByToken(project) {
  var chainIds = projectChainIds(project);
  if (!chainIds.length) return {};
  var groupId = await resolveBendystrawSuckerGroupId(project, chainIds).catch(function () { return null; });
  var res = null;
  if (groupId) res = await fetchBendystrawCollectionPages(BENDYSTRAW_PAY_BY_GROUP_QUERY, 'payEvents', { suckerGroupId: groupId, chainIds: chainIds, version: BENDYSTRAW_VERSION }, 100, 1000).catch(function () { return null; });
  if (!res || !res.items.length) res = await fetchBendystrawCollectionPages(BENDYSTRAW_PAY_BY_PROJECT_QUERY, 'payEvents', { projectId: Number(project.id), chainIds: chainIds, version: BENDYSTRAW_VERSION }, 100, 1000).catch(function () { return { items: [] }; });
  var byAddr = {};
  (res.items || []).forEach(function (p) {
    var addr = (p.beneficiary || '').toLowerCase(); if (!addr) return;
    var amt = toBigInt(p.amount); if (amt === 0n) return;
    var usd = Number(usdFromScaled(p.amountUsd));
    // 6-dec stablecoin if its face value is within ~10× of the USD value; else 18-dec native (ETH).
    var asStable = Number(amt) / 1e6;
    var bucket = (usd > 0) ? ((asStable >= usd / 10 && asStable <= usd * 10) ? { dec: 6, sym: 'USDC' } : { dec: 18, sym: 'ETH' })
      : (Number(amt) >= 1e12 ? { dec: 18, sym: 'ETH' } : { dec: 6, sym: 'USDC' });
    var key = bucket.sym + '@' + bucket.dec;
    if (!byAddr[addr]) byAddr[addr] = {};
    if (!byAddr[addr][key]) byAddr[addr][key] = { sum: 0n, dec: bucket.dec, sym: bucket.sym };
    byAddr[addr][key].sum += amt;
  });
  var out = {};
  Object.keys(byAddr).forEach(function (addr) {
    out[addr] = Object.keys(byAddr[addr]).map(function (k) { var b = byAddr[addr][k]; return formatBalance(b.sum, b.dec, b.sym); }).join(', ');
  });
  return out;
}

// Count of unique owners (holders, deduped across chains) — matches the Owners tab. Null on failure.
async function fetchOwnersCount(project) {
  try {
    var chainIds = projectChainIds(project);
    if (!chainIds.length) return null;
    var groupId = await resolveBendystrawSuckerGroupId(project, chainIds);
    var result = null;
    if (groupId) {
      result = await fetchBendystrawParticipantPages(BENDYSTRAW_PARTICIPANTS_BY_GROUP_QUERY, {
        suckerGroupId: groupId, chainIds: chainIds, version: BENDYSTRAW_VERSION,
      });
    }
    if (!result || !result.items.length) {
      result = await fetchBendystrawParticipantPages(BENDYSTRAW_PARTICIPANTS_BY_PROJECT_QUERY, {
        projectId: Number(project.id), chainIds: chainIds, version: BENDYSTRAW_VERSION,
      });
    }
    return aggregateParticipants(result.items).length;
  } catch (e) {
    return null;
  }
}

async function fetchOwnersDistribution(project) {
  var chainIds = projectChainIds(project);
  if (!chainIds.length) return { participants: [], totalCount: 0, totalSupply: 0n, totalBalance: 0n, truncated: false };

  // The by-group query is an optimization; if it errors (or the group can't be resolved) fall through to
  // the by-project query rather than failing the whole panel.
  var groupId = await resolveBendystrawSuckerGroupId(project, chainIds).catch(function () { return null; });
  var result = null;
  if (groupId) {
    result = await fetchBendystrawParticipantPages(BENDYSTRAW_PARTICIPANTS_BY_GROUP_QUERY, {
      suckerGroupId: groupId,
      chainIds: chainIds,
      version: BENDYSTRAW_VERSION,
    }).catch(function () { return null; });
  }
  if (!result || !result.items.length) {
    result = await fetchBendystrawParticipantPages(BENDYSTRAW_PARTICIPANTS_BY_PROJECT_QUERY, {
      projectId: Number(project.id),
      chainIds: chainIds,
      version: BENDYSTRAW_VERSION,
    });
  }

  var participants = aggregateParticipants(result.items);
  var totalBalance = participants.reduce(function (sum, row) { return sum + row.balance; }, 0n);
  var totalSupply = await readTotalSupplyAcrossChains(project, chainIds);
  if (!totalSupply && project.totalSupply != null) totalSupply = project.totalSupply;
  return {
    participants: participants,
    totalCount: result.totalCount,
    totalSupply: totalSupply || totalBalance,
    totalBalance: totalBalance,
    truncated: result.totalCount > result.items.length,
  };
}

function renderOwnersAll(project) {
  var wrap = el('div');
  var sym = project.tokenSymbol || 'token';
  var desc = el('div', 'detail-card-body owners-intro');
  desc.textContent = sym + ' owners paid in, received splits, received auto-issuance, or got them second-hand.';
  wrap.appendChild(desc);
  var body = el('div', 'owners-load');
  body.appendChild(skelOwnersDistribution());
  wrap.appendChild(body);
  Promise.all([fetchOwnersDistribution(project), fetchPaidByToken(project).catch(function () { return {}; })]).then(function (r) {
    var data = r[0], paidByToken = r[1] || {};
    if (!body.isConnected) return;
    body.innerHTML = '';
    if (!data.participants.length || data.totalBalance === 0n) {
      body.className = 'detail-card-body owners-empty';
      // This list is indexer-backed (bendystraw) and trails the chain — a brand-new holder (e.g. you,
      // shown live in the You card above) appears here only once the indexer catches up.
      body.textContent = 'No owners indexed yet — this list comes from the indexer, which trails the chain by a bit. Your own balance shows live under You above; new holders appear here once indexed.';
      return;
    }
    body.className = 'owners-distribution';
    body.appendChild(renderOwnersPieChart(data.participants, data.totalBalance, data.totalSupply, sym));
    body.appendChild(renderOwnersTable(data.participants, data.totalSupply || data.totalBalance, sym, project, paidByToken));
    if (data.truncated) {
      var note = el('div', 'owners-footnote');
      note.textContent = 'Showing the first ' + data.participants.length + ' indexed owners by balance.';
      body.appendChild(note);
    }
  }).catch(function () {
    if (!body.isConnected) return;
    body.className = 'detail-card-body owners-empty';
    body.textContent = 'Could not load owner distribution from Bendystraw.';
  });
  return wrap;
}

// The AMM (buyback pool) section — its own distinct section. LP ownership donut + ETH/token composition
// bar + per-LP table + liquidity-by-price depth chart. Self-contained: reads the pool directly.
function renderOwnersAmm(project) {
  var sym = project.tokenSymbol || 'token';
  var wrap = el('div');
  var lpTitle = el('div', 'lp-amm-title');
  var lpTitlePrefix = el('span'); lpTitlePrefix.textContent = 'Market';
  lpTitle.appendChild(lpTitlePrefix);
  var lpTitleText = el('span', 'owners-amm-tag'); lpTitleText.textContent = 'AMM';
  lpTitleText.title = 'Uniswap V4 pool holding pooled LP liquidity';
  lpTitle.appendChild(lpTitleText);
  var ammAddr = POOL_MANAGER_BY_CHAIN[project.chainId];
  if (ammAddr) { var a = addressNode(ammAddr); a.classList.add('lp-amm-title-addr'); lpTitle.appendChild(a); }
  wrap.appendChild(lpTitle);
  var lpHead = el('div', 'detail-card-body owners-intro');
  lpHead.textContent = 'The market is used to fill orders that give payers more REV than issuance would.';
  wrap.appendChild(lpHead);
  var loading = el('div', 'owners-load'); loading.appendChild(skelOwnersDistribution()); wrap.appendChild(loading);
  readLpPositions(project, project.chainId).then(function (lp) {
    if (!wrap.isConnected) return;
    loading.remove();
    if (!lp) { lpHead.textContent = 'No liquidity added yet.'; return; }
    if (!lp.owners.length) { lpHead.textContent = 'Liquidity in the buyback pool — no LP positions yet (the pool is seeded but not yet traded).'; return; }
    var rowEl = el('div', 'lp-amm-row');
    // Left column: pie, then the composition bar stacked directly on top of the liquidity-by-price chart.
    var leftCol = el('div', 'lp-amm-leftcol');
    var pie = renderLpOwnersPie(lp); if (pie) leftCol.appendChild(pie);
    var bt = el('div', 'detail-card-title lp-amm-bartitle'); bt.textContent = 'Composition'; leftCol.appendChild(bt);
    var bar = renderLpCompositionBar(lp, sym); if (bar) leftCol.appendChild(bar);
    rowEl.appendChild(leftCol);
    // Right column: LP table.
    var rightCol = el('div', 'lp-amm-rightcol');
    var tbl = renderLpTable(lp, sym, project.chainId); if (tbl) rightCol.appendChild(tbl);
    rowEl.appendChild(rightCol);
    wrap.appendChild(rowEl);
    var issuancePrice = (project.ruleset && project.ruleset.weight) ? 1 / (Number(project.ruleset.weight) / 1e18) : null;
    readCashoutPrice(project, project.chainId).catch(function () { return null; }).then(function (cashout) {
      if (!wrap.isConnected) return;
      var depth = renderLpDepthChart(lp, lp.poolPrice, issuancePrice, cashout, sym);
      if (depth && !leftCol.querySelector('.lp-depth')) leftCol.appendChild(depth);
    });
  }).catch(function () { loading.remove(); lpHead.textContent = 'Could not read the buyback pool.'; });
  return wrap;
}

// Split-hook card (Market subtab). Shown only when the project routes a reserved split to the
// BannyLPSplitHook (JBUniswapV4LPSplitHook). Surfaces, per chain: the hook's accumulated project
// tokens (its "position" before pooling), whether the LP pool is deployed + its active tick range,
// claimable LP fees, and the permissionless keeper actions anyone can call.
function renderSplitHookCard(project) {
  var host = el('div');
  var hookAddr = getAddress('BannyLPSplitHook', project.chainId);
  if (!hookAddr) return host;
  var uses = (project.reservedSplits || []).some(function (s) { return s.hook && s.hook.toLowerCase() === hookAddr.toLowerCase(); });
  if (!uses) return host;

  var sym = project.tokenSymbol || 'tokens';
  var pid = BigInt(project.id);
  var card = el('div', 'detail-card'); host.appendChild(card);
  var title = el('div', 'lp-amm-title');
  var tp = el('span'); tp.textContent = 'Split hook'; title.appendChild(tp);
  var tag = el('span', 'owners-amm-tag'); tag.textContent = 'LP'; tag.title = 'Uniswap V4 LP split hook — pools reserved tokens'; title.appendChild(tag);
  var a = addressNode(hookAddr, project.chainId); a.classList.add('lp-amm-title-addr'); title.appendChild(a);
  card.appendChild(title);
  var intro = el('div', 'detail-card-body owners-intro');
  intro.textContent = 'Reserved ' + sym + ' routed here accumulate until anyone seeds a Uniswap V4 LP position with them; the position’s trading fees are then routed back to the project. The actions below are permissionless.';
  card.appendChild(intro);

  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  chains.forEach(function (c) {
    if (!getAddress('BannyLPSplitHook', c.id)) return;
    var block = el('div', 'splithook-chain');
    var head = el('div', 'splithook-head'); head.appendChild(chainLogo(c.id, c.name));
    var nm = el('span'); nm.textContent = ' ' + c.name; head.appendChild(nm);
    block.appendChild(head);
    var body = el('div'); body.appendChild(skel('100%', '40px')); block.appendChild(body);
    card.appendChild(block);

    resolveAcctToken(c.id, pid).then(function (acct) {
      var tok = acct.address;
      var rd = function (fn, args) { return read(c.id, 'BannyLPSplitHook', bannyHookAbi, fn, args).catch(function () { return null; }); };
      return Promise.all([
        rd('accumulatedProjectTokens', [pid]),
        rd('hasDeployedPool', [pid]),
        rd('claimableFeeTokens', [pid]),
        rd('tokenIdOf', [pid, tok]),
        rd('activeTickLowerOf', [pid, tok]),
        rd('activeTickUpperOf', [pid, tok]),
      ]).then(function (r) {
        body.innerHTML = '';
        var accumulated = r[0] != null ? BigInt(r[0]) : 0n;
        var hasPool = !!r[1];
        var fees = r[2] != null ? BigInt(r[2]) : 0n;
        var tokenId = r[3] != null ? BigInt(r[3]) : 0n;
        var tickLo = r[4], tickHi = r[5];
        // Read-only position / balance rows.
        body.appendChild(kvRow('Pool', hasPool ? 'Deployed' : 'Not deployed yet'));
        body.appendChild(kvRow('Accumulated ' + sym, formatBalance(accumulated, 18, sym)));
        if (hasPool && tokenId > 0n) {
          body.appendChild(kvRow('LP position', '#' + tokenId.toString() + (tickLo != null && tickHi != null ? ' (ticks ' + tickLo + ' → ' + tickHi + ')' : '')));
        }
        body.appendChild(kvRow('Claimable LP fees', formatBalance(fees, acct.decimals, acct.symbol)));

        // Permissionless keeper actions.
        var foot = el('div', 'splithook-actions');
        var status = el('div', 'operator-edit-status');
        function actBtn(label, fn, args, title) {
          var b = el('button', 'detail-check-btn'); b.textContent = label; if (title) b.title = title;
          b.addEventListener('click', function () {
            b.disabled = true;
            executeTransaction({
              chainId: c.id, address: getAddress('BannyLPSplitHook', c.id), contractName: 'BannyLPSplitHook',
              abi: bannyHookAbi, functionName: fn, args: args(), label: label,
              onStatus: function (m, k) { status.classList.toggle('pending', k === 'pending'); status.textContent = m; },
              onError: function (m) { status.classList.remove('pending'); status.textContent = m; b.disabled = false; },
              onSuccess: function () { status.classList.remove('pending'); status.textContent = label + ' confirmed on ' + c.name + '.'; b.disabled = false; document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
            });
          });
          foot.appendChild(b);
        }
        if (!hasPool) {
          actBtn('Deploy pool', 'deployPool', function () { return [pid, 0n]; }, 'Seed the Uniswap V4 pool from accumulated tokens (accepts any cash-out return)');
        } else {
          if (accumulated > 0n) actBtn('Add liquidity', 'addLiquidity', function () { return [pid, tok, 0n]; }, 'Add accumulated ' + sym + ' to the LP position');
          actBtn('Collect fees', 'collectAndRouteLPFees', function () { return [pid, tok]; }, 'Collect LP trading fees and route them to the project');
        }
        if (fees > 0n) {
          actBtn('Claim fees', 'claimFeeTokensFor', function () { var acc = getAccount(); return [pid, acc || hookAddr]; }, 'Claim the routed fee tokens to your wallet');
        }
        if (foot.childNodes.length) { block.appendChild(foot); block.appendChild(status); }
      });
    }).catch(function () { body.innerHTML = ''; body.textContent = 'Could not read the split hook on ' + c.name + '.'; });
  });
  return host;
}

function renderOwnersPieChart(participants, totalBalance, totalSupply, sym) {
  var panel = el('div', 'owners-chart-panel');
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 240 214'); // crop bottom whitespace (donut ends at y≈212) → tighter to the total
  svg.setAttribute('class', 'owners-pie-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', sym + ' owner distribution');

  var cx = 120, cy = 120, outer = 92, inner = 54;
  var angle = -Math.PI / 2;
  var drawable = participants.filter(function (row) { return row.balance > 0n; });
  // Pink-light fill, borders distinguish slices (see .owners-pie-slice).
  if (drawable.length === 1) {
    // One owner → a full annulus (near-360° so the band fills but the hole stays open).
    var ring = document.createElementNS(svgNS, 'path');
    ring.setAttribute('d', donutSlicePath(cx, cy, outer, inner, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 - 0.001));
    ring.setAttribute('class', 'owners-pie-slice');
    tagPieSlice(ring, drawable[0].address, isAmmAddress(drawable[0].address), pieSuffixOwners(drawable[0], totalSupply, sym));
    svg.appendChild(ring);
  } else {
    drawable.forEach(function (row) {
      var slice = Number(row.balance) / Number(totalBalance);
      if (!isFinite(slice) || slice <= 0) return;
      var next = angle + slice * Math.PI * 2;
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', donutSlicePath(cx, cy, outer, inner, angle, next));
      path.setAttribute('class', 'owners-pie-slice');
      tagPieSlice(path, row.address, isAmmAddress(row.address), pieSuffixOwners(row, totalSupply, sym));
      svg.appendChild(path);
      angle = next;
    });
  }

  var centerA = document.createElementNS(svgNS, 'text');
  centerA.setAttribute('x', String(cx));
  centerA.setAttribute('y', '113');
  centerA.setAttribute('class', 'owners-pie-center owners-pie-center-main');
  centerA.textContent = String(participants.length);
  svg.appendChild(centerA);
  var centerB = document.createElementNS(svgNS, 'text');
  centerB.setAttribute('x', String(cx));
  centerB.setAttribute('y', '132');
  centerB.setAttribute('class', 'owners-pie-center owners-pie-center-sub');
  centerB.textContent = participants.length === 1 ? 'owner' : 'owners';
  svg.appendChild(centerB);

  panel.appendChild(svg);
  attachPieHover(panel, svg);
  var total = el('div', 'owners-chart-total');
  total.textContent = formatCompactTokenAmount(totalBalance) + ' ' + sym;
  panel.appendChild(total);
  return panel;
}

// The tooltip suffix (after the address/ENS name) for an owners-distribution slice.
function pieSuffixOwners(row, totalSupply, sym) {
  return ' ' + formatCompactTokenAmount(row.balance) + ' ' + sym + ' (' + formatOwnerPortion(row.balance, totalSupply) + ')';
}

function donutSlicePath(cx, cy, outer, inner, start, end) {
  var large = end - start > Math.PI ? 1 : 0;
  var p1 = polar(cx, cy, outer, start);
  var p2 = polar(cx, cy, outer, end);
  var p3 = polar(cx, cy, inner, end);
  var p4 = polar(cx, cy, inner, start);
  return 'M ' + p1.x + ' ' + p1.y
    + ' A ' + outer + ' ' + outer + ' 0 ' + large + ' 1 ' + p2.x + ' ' + p2.y
    + ' L ' + p3.x + ' ' + p3.y
    + ' A ' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + p4.x + ' ' + p4.y
    + ' Z';
}

function polar(cx, cy, r, a) {
  return {
    x: (cx + Math.cos(a) * r).toFixed(3),
    y: (cy + Math.sin(a) * r).toFixed(3),
  };
}

function renderOwnersTable(participants, totalSupply, sym, project, paidByToken) {
  var wrap = el('div', 'owners-table-wrap');
  var table = el('div', 'owners-table');
  var head = el('div', 'owners-row owners-head');
  ['Account', 'Share', 'Chains', 'Paid'].forEach(function (h) {
    var cell = el('span');
    cell.textContent = h;
    head.appendChild(cell);
  });
  table.appendChild(head);

  participants.forEach(function (row, idx) {
    var tr = el('div', 'owners-row');
    var acct = el('span', 'owners-account');
    if (isAmmAddress(row.address)) {
      // The AMM row reads "Market [AMM]" (matching the Market section); the address lives on hover.
      // Clicking it jumps to the Market subtab (caught by renderOwnersSection).
      acct.appendChild(document.createTextNode('Market '));
      var ammTag = el('span', 'owners-amm-tag'); ammTag.textContent = 'AMM';
      ammTag.title = row.address + ' — Uniswap V4 pool holding pooled LP liquidity';
      acct.appendChild(ammTag);
      tr.classList.add('owners-row-link');
      tr.title = 'Open the Market';
      tr.addEventListener('click', function () {
        tr.dispatchEvent(new CustomEvent('jb:goto-subtab', { bubbles: true, detail: 'Market' }));
      });
    } else {
      acct.appendChild(addressNode(row.address));
    }
    tr.appendChild(acct);

    // Share: just the %, with the token balance on hover.
    var bal = el('span', 'owners-balance');
    bal.title = formatCompactTokenAmount(row.balance) + ' ' + sym;
    var pct = el('strong');
    pct.textContent = formatOwnerPortion(row.balance, totalSupply);
    bal.appendChild(pct);
    tr.appendChild(bal);

    var chains = el('span', 'owners-chains');
    row.chains.forEach(function (chainId) {
      var chain = CHAINS[chainId];
      chains.appendChild(chainLogo(chainId, chain ? chain.name : String(chainId)));
    });
    tr.appendChild(chains);

    var paid = el('span', 'owners-paid');
    // Prefer the literal per-token amounts paid (e.g. "20 USDC, 0.01 ETH"), derived from this account's pay
    // events; fall back to the USD total (volumeUsd), then the raw token.
    var lit = paidByToken && paidByToken[(row.address || '').toLowerCase()];
    var paidUsd = Number(usdFromScaled(row.volumeUsd));
    if (lit) paid.textContent = lit;
    else if (paidUsd > 0) paid.textContent = formatUsd(paidUsd);
    else { var acct = project.acctToken || { decimals: 18, symbol: 'ETH' }; paid.textContent = formatBalance(row.volume, acct.decimals, acct.symbol); }
    tr.appendChild(paid);
    table.appendChild(tr);
  });

  wrap.appendChild(table);
  return wrap;
}

// Loans table (Owners-style). Columns: Address, Collateral, Borrowed, Opened, Prepaid, Prepaid until,
// Outstanding fee (source fee accruing past the prepaid window), Expires. When opts.mine, an extra Repay
// column with a button per loan (opts.onRepay(loan)).
function renderLoansTable(project, loans, opts) {
  opts = opts || {};
  var sym = project.tokenSymbol || 'tokens';
  var baseLbl = baseUnitLabel(project);
  var now = Math.floor(Date.now() / 1000);
  var cols = ['Address', 'Collateral', 'Borrowed', 'Opened', 'Prepaid', 'Prepaid until', 'Outstanding fee', 'Due by'];
  if (opts.mine) cols.push('');
  var wrap = el('div', 'owners-table-wrap loans-table-wrap' + (opts.mine ? ' loans-table-mine' : ''));
  var table = el('div', 'owners-table loans-table');
  var head = el('div', 'owners-row loans-row owners-head');
  cols.forEach(function (h) { var c = el('span'); c.textContent = h; head.appendChild(c); });
  table.appendChild(head);

  loans.forEach(function (loan) {
    var tr = el('div', 'owners-row loans-row');
    var addr = el('span', 'owners-account'); addr.appendChild(addressNode(loan.owner || loan.beneficiary)); tr.appendChild(addr);

    var coll = el('span'); coll.textContent = formatCompactTokenAmount(toBigInt(loan.collateral)) + ' ' + sym; tr.appendChild(coll);
    var bor = el('span'); bor.textContent = formatBalance(toBigInt(loan.borrowAmount), 18, baseLbl); tr.appendChild(bor);
    var opened = el('span', 'loans-muted'); opened.textContent = timeAgo(Number(loan.createdAt)); tr.appendChild(opened);

    var prepaidPct = Number(loan.prepaidFeePercent || 0) / 10;
    var pp = el('span'); pp.textContent = prepaidPct + '%'; tr.appendChild(pp);
    var until = Number(loan.createdAt || 0) + Number(loan.prepaidDuration || 0);
    var puCell = el('span', 'loans-muted'); puCell.textContent = until > now ? formatDateShort(until) : 'passed'; tr.appendChild(puCell);

    var outFee = loanOutstandingFee(loan, now);
    var of = el('span'); of.textContent = outFee == null ? 'expired' : (outFee === 0n ? '—' : '+ ' + formatBalance(outFee, 18, baseLbl)); if (outFee && outFee > 0n) of.className = 'loans-fee'; tr.appendChild(of);

    var exp = Number(loan.createdAt || 0) + LOAN_LIQUIDATION_SECONDS;
    var expCell = el('span', 'loans-muted'); expCell.textContent = formatDateShort(exp); tr.appendChild(expCell);

    if (opts.mine) {
      var act = el('span', 'loans-act');
      var rb = el('button', 'loans-repay-btn'); rb.textContent = 'Repay';
      rb.addEventListener('click', function () { if (opts.onRepay) opts.onRepay(loan); });
      act.appendChild(rb); tr.appendChild(act);
    }
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

// Pending reserved tokens accrue per chain (each chain mints its own issuance). Read the pending balance
// on every chain the project lives on, so the splits table can show the per-chain spread.
function fetchPendingReservedPerChain(project) {
  var pid = BigInt(project.id);
  var chains = (project.chains && project.chains.length) ? project.chains : DISCOVER_CHAINS;
  return Promise.all(chains.map(function (chain) {
    return read(chain.id, 'JBController', pendingReservedAbi, 'pendingReservedTokenBalanceOf', [pid])
      .then(function (v) { return { id: chain.id, name: chain.name, pending: v }; })
      .catch(function () { return { id: chain.id, name: chain.name, pending: null }; });
  }));
}

function renderOwnersSplits(project, opts) {
  var reserved = !!(opts && opts.reserved); // custom-project "Reserved" view — no revnet stage framing
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'splits-wrap');

  var intro = el('div', 'splits-intro');
  intro.textContent = reserved
    ? 'A reserved percentage of newly issued ' + sym + ' is split between these accounts. The owner can adjust the recipients at any time, up to the reserved rate set by the ruleset.'
    : 'Newly issued and bought back ' + sym + ' are split between these accounts. The operator can adjust the splits at any time within each stage’s permanent split limit.';
  wrap.appendChild(intro);

  var stages = (project.stages || []).slice().sort(function (a, b) { return Number(a.start) - Number(b.start); });
  if (!stages.length) {
    var none = el('div', 'detail-card-body'); none.textContent = 'No stages found onchain.'; wrap.appendChild(none); return wrap;
  }
  var currentId = project.ruleset ? String(project.ruleset.id) : null;

  // Per-stage selector.
  var stageRow = el('div', 'splits-stagerow');
  wrap.appendChild(stageRow);
  var limitLine = el('div', 'splits-limit'); wrap.appendChild(limitLine);
  var tableWrap = el('div', 'splits-tablewrap'); wrap.appendChild(tableWrap);

  var splitsCache = {};
  var activeIdx = 0;
  var perChainPending = null;
  function showStage(idx) {
    activeIdx = idx;
    var s = stages[idx];
    var isCurrent = currentId && String(s.id) === currentId;
    var btns = stageRow.querySelectorAll('.splits-stage-btn');
    for (var b = 0; b < btns.length; b++) btns[b].classList.toggle('active', b === idx);
    var md = decodeStageMetadata(s.metadata);
    limitLine.textContent = reserved
      ? 'Reserved rate: ' + percentFromRuleset(md.reservedPercent) + ' of issuance.'
      : 'The split limit for this stage is ' + percentFromRuleset(md.reservedPercent) + ' of issuance.';
    tableWrap.innerHTML = '';
    var skWrap = el('div', 'splits-tablewrap');
    skWrap.appendChild(skelGenericTable('splits-table', 'splits-row', 'splits-head', ['Account', 'Percentage', 'Pending splits'], ['46%', '40%', '42%'], 0));
    for (var sci = 0; sci < 2; sci++) {
      var blk = el('div', 'splits-chain-block');
      var cr = el('div', 'splits-chainrow'); cr.appendChild(skel('110px', '12px')); cr.appendChild(skel('72px', '24px')); blk.appendChild(cr);
      var t = el('div', 'splits-table'); var r = el('div', 'splits-row');
      ['46%', '40%', '42%'].forEach(function (w) { var c = el('span'); c.appendChild(skel(w, '11px')); r.appendChild(c); });
      t.appendChild(r); blk.appendChild(t); skWrap.appendChild(blk);
    }
    tableWrap.appendChild(skWrap);
    var key = String(s.id);
    var p = splitsCache[key] !== undefined ? Promise.resolve(splitsCache[key])
      : read(project.chainId, 'JBSplits', splitsOfAbi, 'splitsOf', [BigInt(project.id), BigInt(s.id), RESERVED_TOKEN_SPLIT_GROUP])
        .then(function (x) { splitsCache[key] = x || []; return splitsCache[key]; })
        .catch(function () { splitsCache[key] = null; return null; });
    p.then(function (splits) {
      tableWrap.innerHTML = '';
      if (!splits || !splits.length) {
        var body = el('div', 'detail-card-body');
        body.textContent = splits
          ? (reserved
            ? 'No reserved recipients set — reserved ' + sym + ' goes to the project owner.'
            : (project.isRevnet
              ? 'No splits configured for this stage — reserved tokens go to REVOwner.'
              : 'No splits configured for this stage — reserved tokens go to the project owner.'))
          : 'Could not read splits.';
        tableWrap.appendChild(body);
        return;
      }
      // A standalone column header on top, then each chain as its own small table (tight gap between).
      var chains = (perChainPending && perChainPending.length)
        ? perChainPending
        : [{ id: project.chainId, name: chainById(project.chainId).name, pending: project.pendingReserved }];
      var headTable = el('div', 'splits-table splits-headtable');
      var headRow = el('div', 'splits-row splits-head');
      ['Account', 'Percentage', 'Pending splits'].forEach(function (h) { var c = el('span'); c.textContent = h; headRow.appendChild(c); });
      headTable.appendChild(headRow);
      tableWrap.appendChild(headTable);
      chains.forEach(function (pc) { appendChainSplitBlock(tableWrap, splits, md, project, sym, isCurrent, pc); });
    });
  }
  // Per-chain pending reserved (async) — re-render the open stage once it lands so the spread shows.
  fetchPendingReservedPerChain(project).then(function (rows) {
    if (!wrap.isConnected) return;
    perChainPending = rows.filter(function (r) { return r.pending != null; });
    showStage(activeIdx);
  });

  // The "Reserved" view (custom projects) shows only the current ruleset's recipients — no stage stepper.
  if (!reserved) stages.forEach(function (s, idx) {
    var isCurrent = currentId && String(s.id) === currentId;
    var btn = document.createElement('button');
    btn.className = 'splits-stage-btn';
    btn.textContent = 'Stage ' + (idx + 1);
    if (isCurrent) { var dot = el('span', 'splits-current-dot'); dot.title = 'current'; btn.appendChild(dot); }
    btn.addEventListener('click', function () { showStage(idx); });
    stageRow.appendChild(btn);
  });

  var curIdx = 0;
  for (var i = 0; i < stages.length; i++) if (String(stages[i].id) === currentId) { curIdx = i; break; }
  showStage(curIdx);

  // Operator CTA — edit the current stage's split recipients (subtle underlined, bottom of the section,
  // above "Latest distributions" which the caller appends after this wrap).
  // Custom-project "Reserved" view edits reserved recipients from the Rulesets card instead, so no CTA here.
  if (!reserved) {
    var foot = el('div', 'detail-about-foot'); foot.style.marginTop = '20px';
    var edit = el('a', 'operator-cta'); edit.textContent = 'Edit splits'; edit.href = '#';
    edit.title = 'Edit the current stage’s split recipients (operator only)';
    edit.addEventListener('click', function (e) { e.preventDefault(); openEditSplitsModal(project); });
    foot.appendChild(edit);
    wrap.appendChild(foot);
  }
  return wrap;
}

// One split-recipient row. The recipient is either a 0x address OR a project ID — when it's a project,
// a second "token beneficiary" input appears (who receives that project's minted tokens). Pushes a record
// into `rows`; record.parse() -> { projectId: bigint, beneficiary: address } (throws on bad input).
function addSplitRecipientRow(rowsBox, rows, opts) {
  opts = opts || {};
  // Row reads like the create flow: "Split [%] to [recipient]" (the lead is "Split"/"… and", set by
  // the caller's updateLeads). The recipient sits in a column box so its ENS hint + chip align under it.
  var row = el('div', 'splits-edit-row');
  var lead = el('span', 'splits-edit-lead');
  var pct = el('input', 'splits-edit-pct'); pct.type = 'number'; pct.placeholder = '10'; pct.step = 'any'; pct.min = '0';
  var sign = el('span', 'splits-edit-pctsign'); sign.textContent = '%';
  var toEl = el('span', 'splits-edit-to'); toEl.textContent = 'to';
  var recip = el('input', 'splits-edit-addr'); recip.type = 'text'; recip.placeholder = '0x…, name.eth, or project ID';
  var ensHint = el('div', 'splits-edit-hint'); ensHint.style.display = 'none';
  var recipBox = el('div', 'splits-edit-recipbox'); recipBox.appendChild(recip); recipBox.appendChild(ensHint);
  var rm = el('a', 'splits-edit-rm'); rm.href = '#'; rm.textContent = '✕'; rm.title = 'Remove';
  row.appendChild(lead); row.appendChild(pct); row.appendChild(sign); row.appendChild(toEl); row.appendChild(recipBox); row.appendChild(rm);
  var wrap = el('div', 'splits-edit-item'); wrap.appendChild(row);
  var benefRow = el('div', 'splits-edit-benef'); benefRow.style.display = 'none';
  var benef = el('input', 'splits-edit-addr'); benef.type = 'text'; benef.placeholder = '0x… token beneficiary for that project';
  benefRow.appendChild(benef); recipBox.appendChild(benefRow); // under the recipient field, in its column
  var ensAddr = null; // resolved address for the current ENS input
  function isEnsName(v) { return v.indexOf('.') !== -1 && !isAddr(v) && !/^[0-9]+$/.test(v); }
  function refresh() {
    var v = (recip.value || '').trim();
    benefRow.style.display = /^[0-9]+$/.test(v) ? '' : 'none';
    if (isEnsName(v)) {
      ensHint.style.display = ''; ensHint.className = 'splits-edit-hint'; ensHint.textContent = 'Resolving ' + v + '…'; ensAddr = null;
      ensAddressOf(v).then(function (addr) {
        if ((recip.value || '').trim() !== v) return;
        if (addr) { ensAddr = addr; ensHint.className = 'splits-edit-hint'; ensHint.textContent = addr; }
        else { ensAddr = null; ensHint.className = 'splits-edit-hint warn'; ensHint.textContent = 'No address set for ' + v; }
      });
    } else if (isAddr(v)) {
      ensAddr = null; ensHint.style.display = ''; ensHint.className = 'splits-edit-hint'; ensHint.textContent = 'Looking up ENS…';
      ensNameOf(v).then(function (name) {
        if ((recip.value || '').trim() !== v) return;
        if (name) { ensHint.style.display = ''; ensHint.className = 'splits-edit-hint'; ensHint.textContent = name; }
        else ensHint.style.display = 'none';
      });
    } else { ensHint.style.display = 'none'; ensAddr = null; }
    // The "fund market" chip only belongs on an empty row — once a real recipient is entered, hide it.
    if (lpChip && !rec.lpHook) { var has = !!(recip.value || '').trim(); lpChip.style.display = has ? 'none' : ''; if (has && lpHint) lpHint.style.display = 'none'; }
  }
  // "fund market" chip — reserved-token splits only. Routes this split to the shared zero-fee
  // BannyLPSplitHook, which pools the reserved tokens into a Uniswap V4 position for the project's token.
  var lpChip = null, lpHint = null;
  if (opts.allowLpHook && opts.lpHookAddr) {
    lpChip = el('button', 'splits-edit-chip'); lpChip.type = 'button'; lpChip.textContent = 'fund market';
    lpChip.title = 'Pool reserved tokens into a Uniswap V4 buyback position for your token';
    lpHint = el('div', 'splits-edit-hint'); lpHint.style.display = 'none';
    lpHint.textContent = 'Pools splits tokens into a Uniswap V4 position. Trading fees route back to your project.';
    recipBox.appendChild(lpChip); wrap.appendChild(lpHint);
  }
  var rec = {
    pct: pct, leadEl: lead, orig: (opts.prefill && opts.prefill.orig) || null, lpHook: false,
    isEmpty: function () { return !rec.lpHook && !(recip.value || '').trim() && !(pct.value || '').trim(); },
    hookAddr: function () { return rec.lpHook ? opts.lpHookAddr : ((rec.orig && rec.orig.hook && rec.orig.hook !== ZERO_ADDRESS) ? rec.orig.hook : ZERO_ADDRESS); },
    parse: function () {
      // Hook split: the hook keys off the distributing project; projectId/beneficiary are pass-through.
      if (rec.lpHook) return { projectId: 0n, beneficiary: opts.ownerAddr || getAccount() || ZERO_ADDRESS };
      var v = (recip.value || '').trim();
      if (isAddr(v)) return { projectId: 0n, beneficiary: v };
      if (isEnsName(v)) {
        if (!ensAddr) throw new Error(v + ' hasn’t resolved to an address yet');
        return { projectId: 0n, beneficiary: ensAddr };
      }
      if (/^[0-9]+$/.test(v) && Number(v) > 0) {
        var b = (benef.value || '').trim();
        if (!isAddr(b)) throw new Error('Project #' + v + ' recipient needs a token beneficiary address');
        return { projectId: BigInt(v), beneficiary: b };
      }
      throw new Error('Enter a 0x address, ENS name, or a project ID');
    },
  };
  function setLp(on) {
    rec.lpHook = on;
    // When funding the market, the recipient IS the shared LP hook — show it (read-only).
    if (on) { recip.value = opts.lpHookAddr; recip.readOnly = true; ensHint.style.display = 'none'; benefRow.style.display = 'none'; }
    else { recip.value = ''; recip.readOnly = false; refresh(); }
    if (lpChip) lpChip.classList.toggle('active', on);
    if (lpHint) lpHint.style.display = on ? '' : 'none';
    if (opts.onChange) opts.onChange();
  }
  recip.addEventListener('input', refresh);
  if (lpChip) lpChip.addEventListener('click', function () { setLp(!rec.lpHook); });
  if (opts.onChange) pct.addEventListener('input', opts.onChange);
  rm.addEventListener('click', function (e) { e.preventDefault(); var i = rows.indexOf(rec); if (i >= 0) rows.splice(i, 1); wrap.remove(); if (opts.onChange) opts.onChange(); });
  rowsBox.appendChild(wrap);
  rows.push(rec);
  if (opts.prefill) {
    var pf = opts.prefill;
    var isLp = lpChip && pf.orig && pf.orig.hook && opts.lpHookAddr && pf.orig.hook.toLowerCase() === opts.lpHookAddr.toLowerCase();
    if (isLp) { setLp(true); }
    else if (Number(pf.projectId) > 0) { recip.value = String(pf.projectId); benef.value = pf.beneficiary || ''; }
    else if (pf.beneficiary && pf.beneficiary !== ZERO_ADDRESS) recip.value = pf.beneficiary;
    if (pf.pct != null) pct.value = pf.pct;
    if (!isLp) refresh();
  }
  return rec;
}

// Queue a new ruleset (full editor, prefilled from the current ruleset). Single-chain projects queue via
// JBController.queueRulesetsOf; omnichain projects queue the same config on every chain via the
// JBOmnichainDeployer + relayr. Owner/operator-gated (QUEUE_RULESETS). Splits & fund-access are carried
// forward from the current ruleset (edit recipients via the dedicated Payouts/Reserved editors); the
// ruleset parameters here are fully editable.
// Initialize the create-flow shop fields the "new shop" path needs (renderNfts + build721Config read these).
function ensureNewShopState(state, allChains) {
  state.shopEnabled = true;
  if (!state.collection) state.collection = { useForRedemptions: false };
  if (!state.nfts) state.nfts = [];
  if (!state.chainIds || !state.chainIds.length) state.chainIds = allChains.map(function (c) { return c.id; });
}

function openQueueRulesetModal(project) {
  var pid = BigInt(project.id);
  var authorityLabel = (projectAuthorityLabel(project) || 'Operator').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var allChains = (project.chains && project.chains.length) ? project.chains
    : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  var omnichain = allChains.length > 1;
  var SPLITS_TOTAL = 1000000000; // 1e9 — JBSplits group total

  var content = el('div', 'modal-body operator-edit queue-ruleset');
  content.appendChild(operatorGateNode(authorityLabel, operatorAddr, 'to queue a ruleset.', project.chainId));

  // Approval-hook context: what governs WHEN this queued ruleset can take effect. (The "Edit deadline"
  // control inside the form below governs FUTURE changes.)
  var curHookLabel = deadlineLabelOf(project.ruleset && project.ruleset.approvalHook, project.chainId);
  var hasDeadline = curHookLabel !== 'No deadline';
  var hookNote = el('div', 'operator-edit-across'); hookNote.style.marginBottom = '18px';
  hookNote.innerHTML = '<strong>Current rule-change deadline: ' + curHookLabel + '.</strong> ' + (hasDeadline
    ? ('A queued ruleset only takes effect at the next cycle boundary if it’s queued at least ' + curHookLabel
      + ' beforehand; otherwise it waits one more cycle. ')
    : ('With no deadline, a queued ruleset takes effect at the start of the next cycle' + (Number(project.ruleset && project.ruleset.duration) > 0 ? '' : ' — and since this ruleset has no fixed duration, as soon as it’s queued') + '. '))
    + 'The “Edit deadline” you set below governs <em>future</em> changes.';
  content.appendChild(hookNote);

  var body = el('div'); body.appendChild(skel('100%', '120px')); content.appendChild(body);
  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = 'Queue ruleset'; actions.appendChild(submit);
  content.appendChild(actions);
  var modal = openModal('Queue ruleset', content);
  var setStatus = makeStatusSetter(status, 'operator-edit-status');

  // The queue form IS the create flow's Rulesets tab. We drive it with the same create-flow `state` shape
  // (stages + afterMode), prefill stage 1 from the project's current ruleset, render via `renderStages`,
  // and encode via `buildQueueRulesetConfigs` — so the two forms are the same code.
  var state = {
    projectType: 'custom',          // custom-flow rendering (not the revnet stage editor)
    accepts: ['eth'],               // set from the accounting token below (eth | usdc)
    swapRouter: false,
    perChain: {},                   // no per-chain overrides — assembler falls back to stage defaults
    details: { name: project.name || '', ticker: project.tokenSymbol || '' },
    stages: [],
    afterMode: 'cycle',
    shopChoice: null,                    // queue-time 721-shop choice: 'continue' | 'remove' (set once a shop is found)
    currentDataHook: '',                 // the project's current 721 hook (= single-chain metadata.dataHook)
    currentUseDataHookForCashOut: false, // preserve item-redemption on "continue"
    isOmnichain: omnichain,              // omnichain queues carry the shop forward automatically (no metadata.dataHook)
  };
  var chainSelected = {}; allChains.forEach(function (c) { chainSelected[c.id] = true; });

  // Read the current ruleset's data hook (the 721 shop; on single-chain it IS metadata.dataHook). Default the
  // choice to "continue" so queueing re-passes the hook — the encoder's default would silently DETACH the shop.
  read(project.chainId, 'JBController', currentRulesetAbi, 'currentRulesetOf', [pid]).then(function (r) {
    var m = r ? (r[1] || r.metadata) : null;
    state.shopChecked = true; // the shop control renders once we know whether a shop exists
    if (m && m.dataHook && !/^0x0+$/.test(m.dataHook)) {
      state.currentDataHook = m.dataHook;
      state.currentUseDataHookForCashOut = !!m.useDataHookForCashOut;
      state.shopChoice = 'continue';
    }
    renderEditor();
  }).catch(function () { state.shopChecked = true; renderEditor(); });

  function renderEditor() {
    body.innerHTML = '';
    body.appendChild(renderStages(state, renderEditor, { noHead: true }));

    // 721 shop choice. Shows once the current-hook read resolves. With a live shop: keep (single-chain
    // re-passes the hook so it isn't dropped) / remove (single-chain only — no omnichain detach path) / new.
    // With NO shop: a checkbox to add one. "new"/add deploys a fresh collection via the one-call deployer.
    if (state.shopChecked) {
      var shopH = el('div', 'operator-edit-label'); shopH.style.marginTop = '18px'; shopH.textContent = 'Shop (NFT items)'; body.appendChild(shopH);
      if (state.currentDataHook) {
        var shopBox = el('div', 'queue-shop-choice');
        var shopOpts = [['continue', 'Keep the current shop', 'Same items for purchase remain during the new rulesets.']];
        if (!state.isOmnichain) shopOpts.push(['remove', 'Remove the shop', 'Stops NFT minting; payments mint project tokens at the ruleset weight instead.']);
        shopOpts.push(['new', 'Start a new shop', 'Make a new shop with the new rulesets, replacing the current one entirely.']);
        shopOpts.forEach(function (o) {
          var row = el('label', 'queue-shop-opt');
          var rb = document.createElement('input'); rb.type = 'radio'; rb.name = 'queue-shop'; rb.checked = state.shopChoice === o[0];
          rb.addEventListener('change', function () { if (rb.checked) { state.shopChoice = o[0]; if (o[0] === 'new') ensureNewShopState(state, allChains); renderEditor(); } });
          var txt = el('div', 'queue-shop-opt-txt');
          var nm = el('div', 'queue-shop-opt-name'); nm.textContent = o[1]; txt.appendChild(nm);
          var sub = el('div', 'queue-shop-opt-sub'); sub.textContent = o[2]; txt.appendChild(sub);
          row.appendChild(rb); row.appendChild(txt); shopBox.appendChild(row);
        });
        body.appendChild(shopBox);
      } else {
        // No current shop — let the operator add one with this ruleset (deploys a fresh 721 collection).
        var addRow = el('label', 'queue-shop-opt');
        var addCb = document.createElement('input'); addCb.type = 'checkbox'; addCb.checked = state.shopChoice === 'new';
        addCb.addEventListener('change', function () { state.shopChoice = addCb.checked ? 'new' : null; if (addCb.checked) ensureNewShopState(state, allChains); renderEditor(); });
        var addTxt = el('div', 'queue-shop-opt-txt');
        var addNm = el('div', 'queue-shop-opt-name'); addNm.textContent = 'Sell NFT items'; addTxt.appendChild(addNm);
        var addSub = el('div', 'queue-shop-opt-sub'); addSub.textContent = 'This project has no shop yet — add one and start selling NFT items with this ruleset.'; addTxt.appendChild(addSub);
        addRow.appendChild(addCb); addRow.appendChild(addTxt); body.appendChild(addRow);
      }
      // Starting/adding a shop → the full collection + items form (reused verbatim from the create flow).
      if (state.shopChoice === 'new') {
        ensureNewShopState(state, allChains);
        var nftWrap = el('div', 'queue-new-shop-form'); nftWrap.style.marginTop = '12px';
        nftWrap.appendChild(renderNfts(state, renderEditor)); body.appendChild(nftWrap);
      }
    }
    if (omnichain) {
      var ch = el('div', 'operator-edit-label'); ch.style.marginTop = '18px'; ch.textContent = 'Queue on'; body.appendChild(ch);
      var chainBox = el('div', 'splits-edit-chains');
      allChains.forEach(function (c) {
        var r2 = el('label', 'splits-edit-chain'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = chainSelected[c.id] !== false; cb.value = String(c.id);
        cb.addEventListener('change', function () { chainSelected[c.id] = cb.checked; });
        r2.appendChild(cb); r2.appendChild(chainLogo(c.id, c.name)); var nm = el('span'); nm.textContent = c.name || ('Chain ' + c.id); r2.appendChild(nm);
        chainBox.appendChild(r2);
      });
      body.appendChild(chainBox);
      var memoNote = el('div', 'rf-funds-sub'); memoNote.style.marginTop = '8px'; memoNote.textContent = 'Queues the same ruleset(s) on each selected chain via the omnichain deployer (one prepaid relayr payment).'; body.appendChild(memoNote);
    }
  }

  // Prefill stage 1 from the BASE ruleset — the one the queued ruleset will be based on. That's the latest
  // queued ruleset if a distinct one is already queued (upcoming), otherwise the current ruleset. All values
  // (params + reserved/payout splits + fund access) default to that base, keyed on its id.
  resolveAcctToken(project.chainId, pid).then(function (acct) {
    var isNative = acct.address.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    var usdc = USDC_BY_CHAIN[project.chainId];
    state.accepts = [(!isNative && usdc && acct.address.toLowerCase() === usdc.toLowerCase()) ? 'usdc' : 'eth'];

    return read(project.chainId, 'JBController', upcomingRulesetAbi, 'upcomingRulesetOf', [pid]).catch(function () { return null; }).then(function (up) {
      // A genuinely-queued upcoming ruleset has an id distinct from the current one (an auto-cycle reuses the
      // same config id). When present, it's the base; otherwise base on the current ruleset.
      var baseR = project.ruleset, baseM = project.metadata;
      if (up && up[0] && Number(up[0].id) > 0 && (!project.ruleset || String(up[0].id) !== String(project.ruleset.id))) { baseR = up[0]; baseM = up[1]; }

      var terminal = getAddress('JBMultiTerminal', project.chainId);
      var fal = getAddress('JBFundAccessLimits', project.chainId);
      var splitsAddr = getAddress('JBSplits', project.chainId);
      var rid = baseR ? BigInt(baseR.id) : 0n;
      return Promise.all([
        (fal && terminal && rid) ? read(project.chainId, 'JBFundAccessLimits', payoutLimitsAbi, 'payoutLimitsOf', [pid, rid, terminal, acct.address]).catch(function () { return []; }) : Promise.resolve([]),
        (fal && terminal && rid) ? read(project.chainId, 'JBFundAccessLimits', surplusAllowancesAbi, 'surplusAllowancesOf', [pid, rid, terminal, acct.address]).catch(function () { return []; }) : Promise.resolve([]),
        (splitsAddr && rid) ? read(project.chainId, 'JBSplits', splitsOfAbi, 'splitsOf', [pid, rid, BigInt(acct.address)]).catch(function () { return []; }) : Promise.resolve([]),
        (splitsAddr && rid) ? read(project.chainId, 'JBSplits', splitsOfAbi, 'splitsOf', [pid, rid, RESERVED_TOKEN_SPLIT_GROUP]).catch(function () { return []; }) : Promise.resolve([]),
      ]).then(function (R) {
        var stage = stageFromBaseRuleset(baseR, baseM, R[0], R[1], R[2], R[3]);
        state.stages = [stage];
        renderEditor();
        // If the project accepts more than one token, switch payouts to per-token blocks ("Payout USDC
        // funds" / "Payout ETH funds"), prefilling each token's payout limit + splits from the base ruleset.
        acctKindsForFunds(project).then(function (kinds) {
          if (!kinds || kinds.length <= 1) return;
          var lpHook = (getAddress('BannyLPSplitHook', project.chainId) || '').toLowerCase();
          var tokCurOf = function (t) { return Number(BigInt(t) & 0xffffffffn); };
          return Promise.all(kinds.map(function (kind) {
            var tok = kind.addrForChain(project.chainId);
            if (!(splitsAddr && fal && terminal && rid && tok)) { stage.payoutByKind[kind.key] = { mode: 'none', recipients: [] }; return Promise.resolve(); }
            return Promise.all([
              read(project.chainId, 'JBFundAccessLimits', payoutLimitsAbi, 'payoutLimitsOf', [pid, rid, terminal, tok]).catch(function () { return []; }),
              read(project.chainId, 'JBSplits', splitsOfAbi, 'splitsOf', [pid, rid, BigInt(tok)]).catch(function () { return []; }),
            ]).then(function (rr) {
              var lim = (rr[0] || [])[0], splits = rr[1] || [], pk;
              if (!lim || BigInt(lim.amount) === 0n) pk = { mode: 'none', recipients: [] };
              else if (BigInt(lim.amount) >= (2n ** 200n)) pk = { mode: 'unlimited', recipients: splits.map(function (sp) { return recFromSplit(sp, lpHook, (Number(sp.percent) / SPLITS_TOTAL) * 100, ''); }) };
              else {
                var total = BigInt(lim.amount);
                var dec = (Number(lim.currency) === tokCurOf(tok)) ? kind.decimals : 18; // limit may be token-denominated or ETH/USD (18)
                var recs = splits.map(function (sp) { return recFromSplit(sp, lpHook, 0, formatAmount(total * BigInt(sp.percent) / BigInt(SPLITS_TOTAL), dec)); });
                if (!recs.length) recs = [{ type: 'wallet', address: '', projectId: 0, percent: 0, amountEth: '' }];
                pk = { mode: 'limited', recipients: recs };
              }
              stage.payoutByKind[kind.key] = pk;
            });
          })).then(function () { state.payoutKinds = kinds; renderEditor(); });
        }).catch(function () {});
      });
    });
  }).catch(function () { body.innerHTML = ''; body.textContent = 'Could not read the current ruleset.'; });

  // Build one create-flow `stage` from the base ruleset (ruleset struct `r` + decoded metadata `m`).
  function stageFromBaseRuleset(r, m, payoutLims, surplusAllows, payoutSplits, reservedSplits) {
    var s = createStage();
    s.expanded = true;
    if (r) {
      s.durationSeconds = Number(r.duration) || 0;
      s.durationCustom = false;
      var w = BigInt(r.weight || 0);
      if (w > 0n) { s.tokenMode = 'custom'; s.weight = formatEther(w); }
      else { s.tokenMode = 'none'; s.weight = '0'; }
      s.weightCutPercent = Number(r.weightCutPercent) / 1e7;
      s.issuanceCutOn = s.weightCutPercent > 0;
      var dlKey = 'none';
      DEADLINE_OPTIONS.forEach(function (d) { if (d.contract && (getAddress(d.contract, project.chainId) || '').toLowerCase() === (r.approvalHook || '').toLowerCase()) dlKey = d.key; });
      s.deadline = dlKey;
    }
    if (m) {
      s.baseCurrency = Number(m.baseCurrency) || 1;
      s.cashOutEnabled = Number(m.cashOutTaxRate) < 10000;
      s.cashOutTaxRate = Number(m.cashOutTaxRate) / 100;
      s.allowOwnerMinting = !!m.allowOwnerMinting;
      s.pauseTransfers = !!m.pauseCreditTransfers;
      s.pausePay = !!m.pausePay;
      s.holdFees = !!m.holdFees;
      s.allowSetTerminals = !!m.allowSetTerminals;
      s.allowSetController = !!m.allowSetController;
      s.allowTerminalMigration = !!m.allowTerminalMigration;
      s.allowSetCustomToken = !!m.allowSetCustomToken;
      s.allowAddAccountingContext = !!m.allowAddAccountingContext;
      s.allowAddPriceFeed = !!m.allowAddPriceFeed;
    }
    // Reserved recipients — each row's percent is its share of ISSUANCE = (split share ÷ 1e9) × reserved rate.
    var reservedRate = m ? Number(m.reservedPercent) / 100 : 0; // 0..100
    var lpHook = (getAddress('BannyLPSplitHook', project.chainId) || '').toLowerCase();
    s.reservedRecipients = (reservedSplits || []).map(function (sp) {
      return recFromSplit(sp, lpHook, reservedRate > 0 ? (Number(sp.percent) / SPLITS_TOTAL) * reservedRate : 0, '');
    });
    // Payouts — none / unlimited / limited, reconstructed from the limit + splits.
    var lim = (payoutLims || [])[0];
    if (!lim || BigInt(lim.amount) === 0n) {
      s.payoutMode = 'none'; s.payoutRecipients = [];
    } else if (BigInt(lim.amount) >= (2n ** 200n)) {
      s.payoutMode = 'unlimited';
      s.payoutRecipients = (payoutSplits || []).map(function (sp) { return recFromSplit(sp, lpHook, (Number(sp.percent) / SPLITS_TOTAL) * 100, ''); });
    } else {
      s.payoutMode = 'limited';
      s.payoutCurrency = Number(lim.currency) || 1;
      var total = BigInt(lim.amount); // 18-decimal (parseEther on encode)
      s.payoutRecipients = (payoutSplits || []).map(function (sp) {
        return recFromSplit(sp, lpHook, 0, formatEther(total * BigInt(sp.percent) / BigInt(SPLITS_TOTAL)));
      });
      if (!s.payoutRecipients.length) s.payoutRecipients = [{ type: 'wallet', address: '', projectId: 0, percent: 0, amountEth: '' }];
    }
    // Surplus allowance — owner withdrawal cap (18-decimal, like the create flow).
    var sa = (surplusAllows || [])[0];
    if (sa && BigInt(sa.amount) > 0n) {
      s.surplusAllowanceOn = true;
      if (BigInt(sa.amount) >= (2n ** 200n)) { s.surplusAllowanceUnlimited = true; }
      else { s.surplusAllowanceUnlimited = false; s.surplusAllowanceAmount = formatEther(BigInt(sa.amount)); s.surplusAllowanceCurrency = Number(sa.currency) || 1; }
    }
    return s;
  }

  // One on-chain split → a create-flow recipient (wallet / project / market-funding LP hook).
  function recFromSplit(sp, lpHook, pct, amountEth) {
    var base = { percent: pct || 0, amountEth: amountEth || '', lockedUntil: Number(sp.lockedUntil) || 0 };
    if (sp.hook && lpHook && String(sp.hook).toLowerCase() === lpHook) { base.type = 'lphook'; base.address = ''; base.projectId = 0; return base; }
    if (Number(sp.projectId) > 0) { base.type = 'project'; base.projectId = Number(sp.projectId); base.address = sp.beneficiary || ''; return base; }
    base.type = 'wallet'; base.address = sp.beneficiary || ''; base.projectId = 0; return base;
  }

  var busy = false, queuedToSafe = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault();
    // After a successful Safe propose the button becomes "Go to Safe execution" → jump to the Back office tab.
    if (queuedToSafe) { modal.close(); location.hash = projectHash(project, project.isRevnet ? 'Operator' : 'Owner'); return; }
    if (busy) return;
    // Removing a live shop is destructive — confirm explicitly (the silent-drop this whole feature prevents).
    if (state.shopChoice === 'remove' && state.currentDataHook && !window.confirm('Remove the shop? From the next ruleset onward your project stops minting NFTs on payment — payments mint project tokens at the ruleset weight instead. Continue?')) return;
    busy = true;
    var selected = allChains.filter(function (c) { return chainSelected[c.id] !== false; });
    submitQueueRuleset(project, state, selected, operatorAddr, setStatus).then(function (res) {
      busy = false;
      if (res && res.safe && res.queued > 0) { queuedToSafe = true; submit.textContent = 'Go to Safe execution'; }
    }).catch(function (err) {
      busy = false; setStatus(errMessage(err, 'Queue failed'), 'error');
    });
  });
}

async function submitQueueRuleset(project, state, selected, operatorAddr, setStatus) {
  var pid = BigInt(project.id);
  var memo = '';
  if (!selected.length) { setStatus('Select at least one chain', 'error'); return; }
  var multi = selected.length > 1;
  // Share one first-ruleset start across chains (now + 20 min) so cycles align; single chain starts at 0
  // (next cycle / per the approval hook). Configs are built PER CHAIN — the accounting/fund-access token
  // (USDC) and approval-hook addresses differ per chain.
  var immediateStart = multi ? (Math.floor(Date.now() / 1000) + 1200) : 0;

  // "Start a new shop" deploys a fresh 721 collection + wires it, via the one-call deployer (ownership → the
  // project). Pin the new items' metadata once up front (images are already pinned on upload).
  var newShop = state.shopChoice === 'new';
  var newShopSalt = newShop ? deploySalt(state, operatorAddr) : ('0x' + '0'.repeat(64));
  var projUri = project.metadataUri || project.uri || '';
  if (newShop) { setStatus('Pinning new shop items…', 'pending'); await pinShopItemsMetadata(state); }

  // One per-chain call, routed identically for EOA and Safe. continue/remove: omnichain → JBOmnichainDeployer,
  // single → JBController. NEW: omnichain → JBOmnichainDeployer (explicit deploy721 overload), single →
  // JB721TiersHookProjectDeployer. buildNewShopQueueCall picks the deployer + arg-order (unit-tested).
  var buildCall = function (cid) {
    var cfgs = buildQueueRulesetConfigs(state, cid, immediateStart);
    if (newShop) {
      var nc = buildNewShopQueueCall({ projectId: project.id, deployConfig: build721Config(state, projUri, cid), cfgs: cfgs,
        useDataHookForCashOut: !!(state.collection && state.collection.useForRedemptions),
        controller: getAddress('JBController', cid), projectDeployer: getAddress('JB721TiersHookProjectDeployer', cid),
        omnichainDeployer: getAddress('JBOmnichainDeployer', cid), salt: newShopSalt, isOmnichain: multi, memo: memo });
      return { to: nc.to, data: encodeFunctionData({ abi: nc.abi, functionName: nc.functionName, args: nc.args }) };
    }
    return multi
      ? { to: getAddress('JBOmnichainDeployer', cid), data: encodeFunctionData({ abi: omnichainQueueAbi, functionName: 'queueRulesetsOf', args: [pid, cfgs, memo] }) }
      : { to: getAddress('JBController', cid), data: encodeFunctionData({ abi: queueRulesetsAbi, functionName: 'queueRulesetsOf', args: [pid, cfgs, memo] }) };
  };

  // Safe-owned project → Relayr can't sign for the Safe; propose the call to each selected chain's Safe queue.
  // The Safe is the owner (msg.sender), so the same target/calldata as the EOA path works — no forwarder needed.
  var safeInfo = await fetchSafeInfo(operatorAddr, project.chainId).catch(function () { return null; });
  if (safeInfo) {
    var signer = getAccount();
    if (!signer) { setStatus('Connecting wallet…', 'pending'); signer = await connect().then(getAccount).catch(function () { return null; }); }
    if (!signer) { setStatus('Connect a wallet to continue', 'error'); return; }
    if (!safeInfo.owners.some(function (o) { return o.toLowerCase() === signer.toLowerCase(); })) {
      setStatus('Connected wallet isn’t a signer of the owner Safe (' + truncAddr(operatorAddr) + ').', 'error'); return;
    }
    try { buildCall(selected[0].id); } catch (e) { setStatus('Invalid ruleset: ' + (e.message || e), 'error'); return; }
    var shim = Object.assign({}, project, { chains: selected });
    var res = await proposeSafeAcrossChains(shim, operatorAddr, signer, buildCall, { title: 'Queue ruleset on Safe' });
    if (!res || res.cancelled) { setStatus('Cancelled', ''); return; }
    document.dispatchEvent(new CustomEvent('jb:safe-queued'));
    setStatus('Queued on ' + res.queued + ' chain' + (res.queued === 1 ? '' : 's') + (res.skipped.length ? ' (skipped ' + res.skipped.join(', ') + ' — add the Safe there first)' : '') + ' — confirm + execute in Back office or the Safe app.', 'success');
    return { safe: true, queued: res.queued };
  }

  // EOA owner — the connected wallet must be the owner.
  var account = await ensureOperatorAccount(project, operatorAddr, setStatus);
  if (!account) return;

  if (!multi) {
    // Single chain → JBController.queueRulesetsOf directly, or JB721TiersHookProjectDeployer for a new shop.
    var cid0 = selected[0].id;
    var configs;
    try { configs = buildQueueRulesetConfigs(state, cid0, 0); } catch (e) { setStatus('Invalid ruleset: ' + (e.message || e), 'error'); return; }
    var exec;
    if (newShop) {
      var dep = getAddress('JB721TiersHookProjectDeployer', cid0);
      if (!dep) { setStatus('No 721 deployer on this chain', 'error'); return; }
      var nc1 = buildNewShopQueueCall({ projectId: project.id, deployConfig: build721Config(state, projUri, cid0), cfgs: configs, controller: getAddress('JBController', cid0), projectDeployer: dep, salt: newShopSalt, isOmnichain: false });
      exec = { address: nc1.to, abi: nc1.abi, functionName: nc1.functionName, args: nc1.args, contractName: 'JB721TiersHookProjectDeployer', label: 'Start a new shop' };
    } else {
      var ctrl = getAddress('JBController', cid0);
      if (!ctrl) { setStatus('No controller on this chain', 'error'); return; }
      exec = { address: ctrl, abi: queueRulesetsAbi, functionName: 'queueRulesetsOf', args: [pid, configs, memo], contractName: 'JBController', label: 'Queue ruleset' };
    }
    await new Promise(function (resolve, reject) {
      executeTransaction({
        chainId: cid0, address: exec.address, abi: exec.abi, functionName: exec.functionName, contractName: exec.contractName,
        args: exec.args, label: exec.label,
        onStatus: function (m, k) { setStatus(m, k); }, onError: function (m) { reject(new Error(m)); },
        onSuccess: function () { setStatus((newShop ? 'New shop deployed + ruleset queued on ' : 'Ruleset queued on ') + chainNameOf(cid0) + '.', 'success'); document.dispatchEvent(new CustomEvent('jb:bridge-updated')); resolve(); },
      });
    });
    return;
  }

  // EOA omnichain → JBOmnichainDeployer.queueRulesetsOf on every selected chain, one relayr payment.
  await runRelayrAcrossChains(selected, account, buildCall, 1500000n, setStatus, { label: 'Queue ruleset', title: 'Confirm queue ruleset' });
  setStatus('Ruleset queued on ' + selected.length + ' chain' + (selected.length > 1 ? 's' : '') + '.', 'success');
  document.dispatchEvent(new CustomEvent('jb:bridge-updated'));
}

// Operator-only: edit the current ruleset's reserved-token split recipients on the chains the operator
// picks, via relayr. Each selected chain's CURRENT ruleset id is read fresh (it can differ per chain).
function openEditSplitsModal(project, opts) {
  opts = opts || {};
  var groupId = opts.groupId != null ? opts.groupId : RESERVED_TOKEN_SPLIT_GROUP;
  var modalTitle = opts.title || 'Edit splits';
  var prefill = opts.prefill || project.reservedSplits || [];
  var authorityLabel = (projectAuthorityLabel(project) || 'Operator').toLowerCase();
  var operatorAddr = projectAuthorityAddress(project);
  var allChains = (project.chains && project.chains.length)
    ? project.chains
    : [{ id: project.chainId, name: (CHAINS[project.chainId] && CHAINS[project.chainId].name) || ('Chain ' + project.chainId) }];

  var content = el('div', 'modal-body operator-edit');
  content.appendChild(operatorGateNode(authorityLabel, operatorAddr, opts.gateText || 'to edit splits.'));

  var note = el('div', 'operator-edit-across');
  if (opts.note) {
    note.textContent = opts.note;
  } else {
    // "Editing splits for Stage X's Y% split limit." — X = current stage number, Y = reserved percent.
    var splitStages = (project.stages || []).slice().sort(function (a, b) { return Number(a.start) - Number(b.start); });
    var curStageId = project.ruleset ? String(project.ruleset.id) : null;
    var stageNum = 1;
    for (var si = 0; si < splitStages.length; si++) if (String(splitStages[si].id) === curStageId) { stageNum = si + 1; break; }
    var reservedPct = project.metadata && project.metadata.reservedPercent != null ? percentFromRuleset(project.metadata.reservedPercent) : null;
    note.textContent = 'Editing splits for Stage ' + stageNum + (reservedPct ? '’s ' + reservedPct + ' split limit.' : '.');
  }
  content.appendChild(note);

  // Recipients editor — prefilled from the current splits for this group.
  var rlbl = el('div', 'operator-edit-label'); rlbl.style.marginTop = '12px'; rlbl.textContent = 'Recipients'; content.appendChild(rlbl);
  var rowsBox = el('div', 'splits-edit-rows'); content.appendChild(rowsBox);
  var totalLine = el('div', 'splits-edit-total'); content.appendChild(totalLine);

  // The shared LP split hook only applies to reserved-token splits (it pools project tokens).
  var lpHookAddr = (groupId === RESERVED_TOKEN_SPLIT_GROUP) ? getAddress('BannyLPSplitHook', project.chainId) : null;
  // Like the create flow, percentages are entered as % OF ISSUANCE and must sum to the split limit:
  //  - reserved group → the ruleset's reserved rate (reservedPercent, basis points /100 = % of issuance);
  //  - any other group (payouts) → 100% (the full distributable amount).
  // Each split's stored group share = its issuance% ÷ limit (so issuance% = groupShare × limit). See submit.
  var limitPct = splitLimitPctFor(project, groupId);
  var rowOpts = { allowLpHook: !!lpHookAddr, lpHookAddr: lpHookAddr, ownerAddr: project.owner, sym: project.tokenSymbol || 'tokens' };
  function mkRowOpts(extra) { var o = {}; for (var k in rowOpts) o[k] = rowOpts[k]; o.onChange = onRowChange; if (extra) for (var k2 in extra) o[k2] = extra[k2]; return o; }
  var rows = [];
  function updateLeads() { for (var i = 0; i < rows.length; i++) if (rows[i].leadEl) rows[i].leadEl.textContent = i === 0 ? 'Split' : '… and'; }
  function onRowChange() { recalcTotal(); updateLeads(); }
  function recalcTotal() {
    var sum = rows.reduce(function (a, r) { return a + (parseFloat(r.pct.value) || 0); }, 0);
    var rounded = Math.round(sum * 100) / 100;
    var over = sum > limitPct + 0.005;
    var remainder = Math.round((limitPct - sum) * 100) / 100;
    var limLabel = limitPct >= 100 ? '100%' : (Math.round(limitPct * 100) / 100) + '% limit';
    totalLine.textContent = over
      ? 'Total: ' + rounded + '% — can’t exceed the ' + (Math.round(limitPct * 100) / 100) + '% split limit'
      : 'Total: ' + rounded + '% of ' + limLabel + (remainder > 0.005 ? ', remaining ' + remainder + '% goes to the project owner' : '');
    totalLine.className = 'splits-edit-total' + (over ? ' error' : '');
  }
  prefill.forEach(function (sp) {
    // Stored group share (sp.percent / 1e9) → displayed as % of issuance = share × limit.
    var issPct = Math.round((Number(sp.percent) / 1e9) * limitPct * 100) / 100;
    addSplitRecipientRow(rowsBox, rows, mkRowOpts({ prefill: { projectId: sp.projectId, beneficiary: sp.beneficiary, pct: issPct, orig: sp } }));
  });
  if (!rows.length) addSplitRecipientRow(rowsBox, rows, mkRowOpts());
  onRowChange();

  var addLink = el('a', 'operator-cta splits-edit-add'); addLink.href = '#'; addLink.textContent = '+ Add recipient';
  addLink.addEventListener('click', function (e) { e.preventDefault(); addSplitRecipientRow(rowsBox, rows, mkRowOpts()); onRowChange(); });
  content.insertBefore(addLink, totalLine); // "+ Add recipient" sits above the total

  // Chain checkboxes — which chains to apply the change on. Kept at the bottom, just above Save.
  var clbl = el('div', 'operator-edit-label'); clbl.style.marginTop = '18px'; clbl.textContent = 'Apply on'; content.appendChild(clbl);
  var chainBox = el('div', 'splits-edit-chains');
  var chainChecks = allChains.map(function (c) {
    var row = el('label', 'splits-edit-chain');
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.value = String(c.id);
    row.appendChild(cb);
    row.appendChild(chainLogo(c.id, c.name));
    var nm = el('span'); nm.textContent = c.name || ('Chain ' + c.id); row.appendChild(nm);
    chainBox.appendChild(row);
    return { chain: c, cb: cb };
  });
  content.appendChild(chainBox);

  var status = el('div', 'operator-edit-status'); content.appendChild(status);
  var actions = el('div', 'operator-edit-actions');
  var submit = el('a', 'operator-cta operator-edit-submit'); submit.href = '#'; submit.textContent = 'Save splits';
  actions.appendChild(submit);
  content.appendChild(actions);

  var modal = openModal(modalTitle, content);
  var setStatus = makeStatusSetter(status, 'operator-edit-status');
  var busy = false;
  submit.addEventListener('click', function (e) {
    e.preventDefault();
    if (busy) return;
    var selected = chainChecks.filter(function (c) { return c.cb.checked; }).map(function (c) { return c.chain; });
    submitSplitsEdit(project, selected, operatorAddr, rows, setStatus, modal, groupId).catch(function (err) {
      busy = false; setStatus(errMessage(err, 'Edit failed'), 'error');
    });
    busy = true;
  });
}

async function submitSplitsEdit(project, selectedChains, operatorAddr, rows, setStatus, modal, groupId) {
  var splitGroupId = groupId != null ? groupId : RESERVED_TOKEN_SPLIT_GROUP;
  if (!selectedChains.length) { setStatus('Select at least one chain', 'error'); return; }
  // Percentages are entered as % OF ISSUANCE and must sum to the split limit (reserved rate for the
  // reserved group, else 100%). The on-chain JBSplit.percent is a share of SPLITS_TOTAL (1e9) of the
  // group total, so groupShare = issuance% ÷ limit. Clamp the running total so rounding can't exceed 1e9.
  var limitPct = splitLimitPctFor(project, splitGroupId);
  var splits = [];
  var sumPct = 0;
  var accShare = 0; // accumulated group share (out of 1e9)
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].isEmpty()) continue;
    var pct = parseFloat(rows[i].pct.value);
    if (!(pct > 0)) { setStatus('Row ' + (i + 1) + ': enter a percentage above 0', 'error'); return; }
    var parsed;
    try { parsed = rows[i].parse(); } catch (e) { setStatus('Row ' + (i + 1) + ': ' + e.message, 'error'); return; }
    sumPct += pct;
    var share = Math.round(pct / limitPct * 1e9);
    if (accShare + share > 1e9) share = 1e9 - accShare;
    if (share < 0) share = 0;
    accShare += share;
    var orig = rows[i].orig;
    splits.push({
      percent: share,
      projectId: parsed.projectId,
      beneficiary: parsed.beneficiary,
      preferAddToBalance: orig ? !!orig.preferAddToBalance : false,
      lockedUntil: orig && orig.lockedUntil ? Number(orig.lockedUntil) : 0,
      // hookAddr() returns the LP split hook when the row's "fund market" chip is on, else preserves any
      // existing hook. Same singleton address on every chain.
      hook: (rows[i].hookAddr ? rows[i].hookAddr() : ((orig && orig.hook && orig.hook !== ZERO_ADDRESS) ? orig.hook : ZERO_ADDRESS)),
    });
  }
  if (!splits.length) { setStatus('Add at least one recipient', 'error'); return; }
  if (sumPct > limitPct + 0.0001) { setStatus('Splits add up to ' + (Math.round(sumPct * 100) / 100) + '% — can’t exceed the ' + (Math.round(limitPct * 100) / 100) + '% split limit', 'error'); return; }

  var account = await ensureOperatorAccount(project, operatorAddr, setStatus);
  if (!account) return;

  // Each chain can have a different current ruleset id — read them up front.
  setStatus('Reading current rulesets…', 'pending');
  var ridMap = {};
  for (var j = 0; j < selectedChains.length; j++) {
    var cid = selectedChains[j].id;
    var rs = await read(cid, 'JBController', currentRulesetAbi, 'currentRulesetOf', [BigInt(project.id)]).catch(function () { return null; });
    if (!rs || !rs[0] || !rs[0].id) throw new Error('No current ruleset on ' + (selectedChains[j].name || cid));
    ridMap[cid] = rs[0].id;
  }
  var groups = [{ groupId: splitGroupId, splits: splits }];

  await runRelayrAcrossChains(selectedChains, account, function (cid) {
    return { to: getAddress('JBController', cid), data: encodeFunctionData({ abi: setSplitGroupsAbi, functionName: 'setSplitGroupsOf', args: [BigInt(project.id), BigInt(ridMap[cid]), groups] }) };
  }, 600000n, setStatus, { label: 'Edit splits', title: 'Confirm edit splits' });

  setStatus('Splits updated on ' + selectedChains.length + ' chain' + (selectedChains.length > 1 ? 's' : '') + '', 'success');
  setTimeout(function () { modal.close(); }, 1400);
}

// Append one chain block: an unboxed [chain name … Distribute] row sitting atop a bordered table of
// that chain's split rows. pc = { id, name, pending }. Distribute is active only when this chain has
// pending reserved to send.
function appendChainSplitBlock(container, splits, md, project, sym, isCurrent, pc) {
  var limitPct = Number(md.reservedPercent) / 100; // reservedPercent out of 10,000 → percent of issuance
  var hasPending = isCurrent && pc.pending != null && pc.pending > 0n;

  var block = el('div', 'splits-chain-block');
  var chainrow = el('div', 'splits-chainrow');
  var name = el('span', 'splits-chain-head');
  name.appendChild(chainLogo(pc.id, pc.name));
  name.appendChild(document.createTextNode(pc.name));
  chainrow.appendChild(name);
  block.appendChild(chainrow);

  var table = el('div', 'splits-table');
  splits.forEach(function (sp) {
    var frac = Number(sp.percent) / 1e9;          // share of the reserved group (0..1)
    var effective = limitPct * frac;              // share of total issuance
    var ofLimit = frac * 100;                     // share of the limit
    var row = el('div', 'splits-row');
    var acct = el('span', 'splits-acct');
    acct.appendChild(splitAccountNode(sp, project, pc.id));
    row.appendChild(acct);
    var pct = el('span', 'splits-pct');
    var strong = el('strong'); strong.textContent = effective.toFixed(effective % 1 === 0 ? 0 : 2) + '%'; pct.appendChild(strong);
    var ofl = el('span', 'splits-muted'); ofl.textContent = ' (' + Math.round(ofLimit) + '% of limit)'; pct.appendChild(ofl);
    row.appendChild(pct);
    var pend = el('span', 'splits-pend');
    pend.textContent = hasPending ? (formatAmount(pc.pending * BigInt(sp.percent) / 1000000000n, 18) + ' ' + sym) : '—';
    row.appendChild(pend);
    table.appendChild(row);
  });
  block.appendChild(table);
  // Distribute button below the table, right-aligned.
  var distFoot = el('div', 'splits-chain-foot');
  distFoot.appendChild(makeChainDistribute(project, pc, hasPending, isCurrent));
  block.appendChild(distFoot);
  container.appendChild(block);
}

// Per-chain Distribute button — calls sendReservedTokensToSplitsOf on that chain. Disabled (idle) unless
// this chain has pending reserved available to send.
function makeChainDistribute(project, pc, hasPending, isCurrent) {
  var foot = el('div', 'splits-chain-foot');
  var status = el('div', 'modal-status splits-status');
  var btn = document.createElement('button');
  btn.className = 'ops-action-btn splits-cta';
  btn.textContent = 'Distribute';
  if (!hasPending) {
    btn.disabled = true;
    btn.title = isCurrent ? ('Nothing pending to distribute on ' + pc.name) : 'Only the current stage has pending splits';
  }
  btn.addEventListener('click', function () {
    status.className = 'modal-status splits-status'; status.textContent = '';
    if (!(getAccount && getAccount())) {
      btn.disabled = true; btn.textContent = 'Connecting…'; status.textContent = 'Connecting wallet…';
      connect().then(function () { btn.disabled = false; btn.textContent = 'Distribute'; btn.click(); })
        .catch(function (err) { btn.disabled = false; btn.textContent = 'Distribute'; status.className = 'modal-status splits-status error'; status.textContent = errMessage(err, 'Could not connect wallet'); });
      return;
    }
    var ctrl = getAddress('JBController', pc.id);
    if (!ctrl) { status.className = 'modal-status splits-status error'; status.textContent = 'No controller on ' + pc.name + '.'; return; }
    btn.disabled = true; btn.textContent = 'Distributing…';
    executeTransaction({
      chainId: pc.id, address: ctrl, abi: sendReservedAbi, functionName: 'sendReservedTokensToSplitsOf', args: [BigInt(project.id)],
      onStatus: function (m, kind) { status.className = 'modal-status splits-status' + (kind === 'pending' ? ' pending' : ''); status.textContent = m || ''; },
      onSuccess: function () { btn.textContent = 'Distributed'; status.className = 'modal-status splits-status success'; status.textContent = 'Pending splits distributed on ' + pc.name + '.'; document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
      onError: function (m) { btn.disabled = false; btn.textContent = 'Distribute'; status.className = 'modal-status splits-status error'; status.textContent = m; },
    });
  });
  foot.appendChild(status); foot.appendChild(btn); // status left of button → button stays flush-right
  return foot;
}

// The token summary card (ERC-20 status, supply, reserved). Reused standalone and inside the "All" subtab.
// Ops: the same project across every chain. Reads per-chain supply / native balance / unit cash-out
// value directly from each chain (one Multicall3 batch per chain), then totals supply + balance.
// The per-chain supply / native balance / unit cash-out value table (omnichain). Returns a body node
// (desc + async table) — the caller wraps it in a titled card. Shown in Owners (revnets) or Ops (others).
function renderAcrossChainsBody(project) {
  var body = el('div');
  var supplyHdr = 'Supply (' + (project.tokenSymbol || 'tokens') + ')';
  var desc = el('div', 'detail-card-body');
  desc.textContent = 'A project can settle funds on many chains, and holders can move funds between them.';
  body.appendChild(desc);
  var status = skelOpsTable(['Chain', supplyHdr, 'Balance', 'Unit value'], 4);
  body.appendChild(status);
  fetchOps(project).then(function (rows) {
    status.remove();
    var totSupply = 0n;
    rows.forEach(function (r) { if (r.supply != null) totSupply += r.supply; });
    // Per-token totals across chains — drive each chain's "% of that token's total" and the Total row.
    var totByTok = {};
    rows.forEach(function (r) { (r.tokens || []).forEach(function (t) { if (t.balance != null && BigInt(t.balance) > 0n) { var k = t.symbol + '@' + t.decimals; if (!totByTok[k]) totByTok[k] = { sum: 0n, decimals: t.decimals, symbol: t.symbol }; totByTok[k].sum += BigInt(t.balance); } }); });
    var table = el('div', 'detail-ops-table');
    table.appendChild(opsRow('Chain', supplyHdr, 'Balance', 'Unit value', true, false));
    // Balance shows every accounting token the chain holds with its share of that token's cross-chain total
    // ("20 USDC (100%)" then "0.005 ETH (50%)").
    var balCell = function (tokens, acct) {
      var nz = (tokens || []).filter(function (t) { return t.balance != null && BigInt(t.balance) > 0n; });
      if (!nz.length) return '0 ' + ((acct && acct.symbol) || 'ETH');
      // Single token: value with the share-% as a muted sub-line — matches the Supply column's {main, sub}.
      if (nz.length === 1) {
        var t = nz[0]; var k = t.symbol + '@' + t.decimals; var tot = totByTok[k] ? totByTok[k].sum : 0n; var pct = pctOf(BigInt(t.balance), tot);
        var val = formatBalance(t.balance, t.decimals, t.symbol);
        return pct ? { main: val, sub: pct } : val;
      }
      // % as a muted sub-line under each token's value — same style + position as the Supply column.
      var lineFor = function (t) { var k = t.symbol + '@' + t.decimals; var tot = totByTok[k] ? totByTok[k].sum : 0n; var pct = pctOf(BigInt(t.balance), tot); var val = formatBalance(t.balance, t.decimals, t.symbol); return pct ? { main: val, sub: pct } : val; };
      return { lines: nz.map(lineFor) };
    };
    rows.forEach(function (r) {
      var acct = r.acct || { decimals: 18, symbol: 'ETH' };
      table.appendChild(opsRow(
        r.name,
        r.supply == null ? '—' : { main: formatTokens(r.supply), sub: pctOf(r.supply, totSupply) },
        (r.tokens && r.tokens.length) ? balCell(r.tokens, acct) : (r.balance == null ? '—' : formatBalance(r.balance, acct.decimals, acct.symbol)),
        r.unitValue == null ? '—' : formatBalance(r.unitValue, acct.decimals, acct.symbol),
        false, false, r.id));
    });
    var totAcct = project.acctToken || { decimals: 18, symbol: 'ETH' };
    var totKeys = Object.keys(totByTok);
    // No chain holds a positive balance (new / drained / fully-paid-out project) → show a real zero, not a
    // reference to an undeclared var (which threw ReferenceError and blanked the whole table via the catch).
    var totBalCell = !totKeys.length ? formatBalance(0n, totAcct.decimals, totAcct.symbol)
      : (totKeys.length === 1 ? formatBalance(totByTok[totKeys[0]].sum, totByTok[totKeys[0]].decimals, totByTok[totKeys[0]].symbol)
        : { lines: totKeys.map(function (k) { return formatBalance(totByTok[k].sum, totByTok[k].decimals, totByTok[k].symbol); }) });
    table.appendChild(opsRow('Total', formatTokens(totSupply), totBalCell, '', false, true));
    body.appendChild(table);
  }).catch(function () {
    status.textContent = 'Could not read cross-chain state.';
  });
  return body;
}

// Which bridge infra each sucker route uses (native rollup bridge vs Chainlink CCIP), read from the
// suckers. Its own subsection, sits above Movement. Removes itself if the project has no suckers.
function renderBridgesSubsection(project) {
  var table = el('div', 'detail-ops-table bridges-table');
  var head = el('div', 'detail-ops-row detail-ops-head');
  ['Chains', 'Types'].forEach(function (label) { var c = el('span', 'detail-ops-cell'); c.textContent = label; head.appendChild(c); });
  table.appendChild(head);
  var wrap = el('div');
  var desc = el('div', 'detail-card-body');
  desc.textContent = (project.tokenSymbol || 'Tokens') + ', funds, and information can move through available bridges.';
  wrap.appendChild(desc); wrap.appendChild(table);
  var section = ownersCard('Bridges', wrap);
  fetchProjectSuckerInfra(project).then(function (routes) {
    if (!section.isConnected) return;
    if (!routes.length) { section.remove(); return; }
    // One row per chain-pair; a pair that carries both a native and a CCIP sucker shows both type tags.
    var groups = [], byKey = {};
    routes.forEach(function (r) {
      var k = r._lo + '-' + r._hi;
      if (!byKey[k]) { byKey[k] = { a: r.a, b: r.b, infras: [] }; groups.push(byKey[k]); }
      if (byKey[k].infras.indexOf(r.infra) < 0) byKey[k].infras.push(r.infra);
    });
    var infraOrder = { native: 0, CCIP: 1 };
    groups.forEach(function (g) {
      var row = el('div', 'detail-ops-row');
      // A sucker bridges both ways — show the pair joined by a bidirectional arrow, not a From→To direction.
      var chains = el('span', 'detail-ops-cell bridge-pair');
      chains.appendChild(chainLogo(g.a, moveChainName(g.a)));
      chains.appendChild(document.createTextNode(moveChainName(g.a)));
      var arrow = el('span', 'bridge-pair-arrow');
      arrow.innerHTML = '<svg viewBox="0 0 30 12" width="30" height="12" aria-hidden="true">'
        + '<line x1="5" y1="6" x2="25" y2="6" stroke="currentColor" stroke-width="1.4"/>'
        + '<path d="M9 2.5 L4.5 6 L9 9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M21 2.5 L25.5 6 L21 9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg>';
      chains.appendChild(arrow);
      chains.appendChild(chainLogo(g.b, moveChainName(g.b)));
      chains.appendChild(document.createTextNode(moveChainName(g.b)));
      row.appendChild(chains);
      var type = el('span', 'detail-ops-cell bridge-types');
      g.infras.sort(function (a, b) { return (infraOrder[a] || 0) - (infraOrder[b] || 0); });
      g.infras.forEach(function (inf) {
        var tag = el('span', 'settlement-infra-tag settlement-infra-tag--' + inf.toLowerCase());
        tag.textContent = inf;
        type.appendChild(tag);
      });
      row.appendChild(type);
      table.appendChild(row);
    });
  });
  return section;
}

function renderOpsSection(project) {
  var section = el('div', 'detail-section');
  // Revnets show "Settlement" in the Owners tab; here it's only for non-revnets (which have no Owners tab).
  if (!project.isRevnet) {
    section.appendChild(ownersCard('Composition', renderAcrossChainsBody(project)));
    var gossip = renderGossipSection(project);
    if (gossip) section.appendChild(gossip);
    section.appendChild(renderBridgesSubsection(project));
  } else {
    // Revnet bridge-transactions live under Owners → Settlement; Ops keeps just the action buttons.
    section.appendChild(renderOpsActions(project));
  }
  return section;
}

// The row of wallet actions (cash out, borrow, move, add liquidity), each opening a modal.
function opsActionsRow(project, opts) {
  opts = opts || {};
  var row = el('div', 'ops-actions');
  var multiChain = (project.chains || []).length > 1;
  [
    ['Cash out', function () { var h = {}; var content = buildCashOutModal(project, function () { if (h.close) h.close(); }); h.close = openModal('Cash out', content).close; }],
    // Loans run through REVLoans — a revnet feature; omit for custom projects.
    opts.noLoans ? null : ['Get a loan', function () { var h = {}; var content = buildLoanModal(project, function () { if (h.close) h.close(); }); h.close = openModal('Get a loan', content).close; }],
    // Moving funds only makes sense when the project lives on more than one chain.
    multiChain ? ['Move between chains', function () { openModal('Move between chains', buildMoveModal(project)); }] : null,
    ['Add market liquidity', function () { openModal('Add market liquidity', buildAddLiquidityModal(project)); }],
  ].filter(Boolean).forEach(function (a) {
    var b = document.createElement('button');
    b.className = 'ops-action-btn';
    b.textContent = a[0];
    b.addEventListener('click', a[1]);
    row.appendChild(b);
  });
  return row;
}

// "Use your <SYM>" — cash out, borrow, or move tokens across chains, each in a modal.
function renderOpsActions(project) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title');
  title.textContent = 'Use your ' + (project.tokenSymbol || 'tokens');
  card.appendChild(title);
  card.appendChild(opsActionsRow(project));
  return card;
}

// Per chain: the connected wallet's token balance, its cash-out value (reclaimable ETH), and its max
// loan (borrowable ETH against that balance via REVLoans). Null fields where unavailable on a chain.
function fetchYouPosition(project) {
  var pid = BigInt(project.id);
  var acct = getAccount && getAccount();
  var chains = (project.chains && project.chains.length) ? project.chains : DISCOVER_CHAINS;
  return Promise.all(chains.map(function (chain) {
    var cid = chain.id;
    if (!acct) return Promise.resolve({ id: cid, name: chain.name, balance: null, cashout: null, maxLoan: null });
    var terminal = getAddress('JBMultiTerminal', cid);
    var revLoans = getAddress('REVLoans', cid);
    var baseCur = BigInt((project.metadata && project.metadata.baseCurrency) || 1);
    return Promise.all([
      readUserBalance(project, cid),
      read(cid, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return null; }),
      // The terminal's surplus is held in its accounting token (USDC/ETH), not necessarily native ETH.
      terminal ? resolveAcctToken(cid, pid) : Promise.resolve({ address: NATIVE_TOKEN, decimals: 18, symbol: 'ETH' }),
      // Unclaimed credits — the rest of the balance is claimed ERC-20. Drives the "Credits"/"ERC-20s" subtext.
      read(cid, 'JBTokens', creditBalanceOfAbi, 'creditBalanceOf', [acct, pid]).then(toBigInt).catch(function () { return null; }),
    ]).then(function (res) {
      var bal = res[0], supply = res[1], acct = res[2], credit = res[3];
      var hasBal = bal != null && bal > 0n;
      var surplusJob = terminal
        // Actual reclaimable surplus (balance − remaining payout limit), in the accounting token's units — not
        // raw balanceOf, which overstated the cash-out value when a payout limit exists.
        ? read(cid, 'JBTerminalStore', currentSurplusOfAbi, 'currentSurplusOf', [pid, [], [acct.address], BigInt(acct.decimals || 18), BigInt(Number(BigInt(acct.address) & 0xffffffffn))]).catch(function () { return null; })
        : Promise.resolve(null);
      return surplusJob.then(function (surplus) {
        // Cash-out value: what `bal` tokens reclaim now, in the accounting token.
        var cashJob = (hasBal && supply && supply >= bal && surplus != null)
          ? read(cid, 'JBTerminalStore', reclaimableAbi, 'currentReclaimableSurplusOf', [pid, bal, supply, surplus]).catch(function () { return null; })
          : Promise.resolve(hasBal ? null : 0n);
        // Max loan: borrowable against `bal` collateral, denominated in the base currency. Returns 0 while
        // the cash-out delay is active.
        var loanJob = (hasBal && revLoans)
          ? read(cid, 'REVLoans', borrowableAbi, 'borrowableAmountFrom', [pid, bal, 18n, baseCur]).then(function (r) { return toBigInt(Array.isArray(r) ? r[0] : r); }).catch(function () { return null; })
          : Promise.resolve(revLoans ? (hasBal ? null : 0n) : null);
        return Promise.all([cashJob, loanJob]).then(function (out) {
          return { id: cid, name: chain.name, balance: bal, credit: credit, cashout: out[0], maxLoan: out[1], acct: acct };
        });
      });
    });
  }));
}

// Claim credits → ERC-20: mint the holder's unclaimed credits as transferable tokens. One Claim per
// chain that has credits (each is a JBController.claimTokensFor tx on that chain). `creditRows` is the
// held rows carrying a positive `credit`.
function buildClaimModal(project, creditRows) {
  var pid = BigInt(project.id);
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'modal-body');
  var intro = el('div', 'detail-card-body');
  intro.textContent = 'Claim your credits into transferable ' + sym + ' ERC-20 tokens. Credits and ERC-20s '
    + 'have the same value; claiming just makes them transferable. Done per chain.';
  wrap.appendChild(intro);

  var table = el('div', 'claim-rows');
  creditRows.forEach(function (r) {
    var acct = getAccount && getAccount();
    var rowEl = el('div', 'claim-row');
    var chainCell = el('span', 'claim-row-chain');
    chainCell.appendChild(chainLogo(r.id, r.name));
    var nm = el('span', 'claim-row-chainname'); nm.textContent = r.name; chainCell.appendChild(nm);
    rowEl.appendChild(chainCell);
    var amt = el('span', 'claim-row-amt'); amt.textContent = formatTokenCount(r.credit) + ' credits'; rowEl.appendChild(amt);
    var btn = document.createElement('button'); btn.className = 'ops-action-btn claim-row-btn'; btn.textContent = 'Claim';
    var status = el('span', 'claim-row-status');
    btn.addEventListener('click', function () {
      var holder = getAccount && getAccount();
      if (!holder) { connect(); return; }
      var ctrl = getAddress('JBController', r.id);
      if (!ctrl) { status.textContent = 'No controller on this chain'; return; }
      btn.disabled = true;
      executeTransaction(Object.assign(buildClaimTokensArgs({ chainId: r.id, controllerAddr: ctrl, holder: holder, projectId: pid, tokenCount: r.credit, beneficiary: holder }), {
        label: 'Claim credits',
        onStatus: function (m, k) { status.classList.toggle('pending', k === 'pending'); status.textContent = m; },
        onError: function (m) { status.classList.remove('pending'); status.textContent = m; btn.disabled = false; },
        onSuccess: function () {
          status.classList.remove('pending'); status.textContent = 'Claimed on ' + r.name + '.';
          btn.textContent = 'Claimed';
          document.dispatchEvent(new CustomEvent('jb:bridge-updated')); // reloads the You card with fresh credit/ERC-20 split
        },
      }));
    });
    rowEl.appendChild(btn);
    rowEl.appendChild(status);
    table.appendChild(rowEl);
  });
  wrap.appendChild(table);
  return wrap;
}

// When this revnet's loans/cash-outs unlock (the cash-out delay), read from its data hook (REVOwner).
// Returns a bigint unix timestamp, or null when there's no delay / no data hook.
function readCashOutDelay(project) {
  var dh = project.metadata && project.metadata.dataHook;
  if (!dh || dh === ZERO_ADDRESS) return Promise.resolve(null);
  return clientFor(project.chainId).readContract({
    address: dh, abi: cashOutDelayAbi, functionName: 'cashOutDelayOf', args: [BigInt(project.id)],
  }).then(function (d) { return toBigInt(d); }).catch(function () { return null; });
}

// "You": the connected wallet's position in this project across chains + the action buttons. Sits at the
// top of the Owners tab (replaces the standalone Ops tab for revnets).
function renderYouCard(project, opts) {
  opts = opts || {};
  var noLoans = !!opts.noLoans;
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'you-card');
  var body = el('div', 'you-body');
  var actions = opsActionsRow(project, opts); // shown only while connected
  wrap.appendChild(body);
  wrap.appendChild(actions);

  // "Claim credits" — appended to the actions row, shown only when an ERC-20 exists AND the wallet holds
  // unclaimed credits on some chain. `claimRows` is refreshed each load; the handler reads the latest.
  var claimRows = [];
  var claimBtn = document.createElement('button');
  claimBtn.className = 'ops-action-btn ops-claim-btn';
  claimBtn.textContent = 'Claim credits';
  claimBtn.style.display = 'none';
  claimBtn.addEventListener('click', function () {
    if (claimRows.length) openModal('Claim credits', buildClaimModal(project, claimRows));
  });
  actions.appendChild(claimBtn);

  var loadSeq = 0;
  function load() {
    var seq = ++loadSeq; // guard: stale in-flight loads must not append a second table (caused duplicate cards on connect)
    var acct = getAccount && getAccount();
    body.innerHTML = '';
    if (!acct) {
      // Disconnected: show ONLY the connect prompt + button (hide the action buttons).
      actions.style.display = 'none';
      var m = el('div', 'detail-card-body you-empty');
      m.textContent = 'Connect a wallet to see your ' + sym + ' across chains, its cash-out value, and your max loan.';
      var c = document.createElement('button'); c.className = 'ops-action-btn you-connect'; c.textContent = 'Connect wallet';
      c.addEventListener('click', function () { connect().then(load).catch(function () {}); });
      body.appendChild(m); body.appendChild(c);
      return;
    }
    actions.style.display = ''; // connected: reveal the action buttons
    var status = skelOpsTable(noLoans ? ['Chain', 'Balance', 'Cash out'] : ['Chain', 'Balance', 'Cash out', 'Max loan'], 2); body.appendChild(status);
    Promise.all([fetchYouPosition(project), readCashOutDelay(project)]).then(function (out) {
      if (seq !== loadSeq || !body.isConnected) return; // a newer load() superseded this one
      var rows = out[0], delay = out[1];
      // The revnet's cash-out delay gates BOTH direct cash-outs (REVOwner.beforeCashOutRecordedWith
      // reverts) AND loans (borrowableAmountFrom returns 0). The cash-out *value* still computes (pure
      // bonding-curve calc), so we show it but mark it locked; loans can't compute, so they read "Locked".
      var locked = delay != null && delay > 0n && Number(delay) > Math.floor(Date.now() / 1000);
      var baseLbl = baseUnitLabel(project);
      function fmtCash(r, v) { var a = r.acct || { decimals: 18, symbol: 'ETH' }; return formatBalance(v, a.decimals, a.symbol); }
      function fmtLoan(v) { return formatBalance(v, 18, baseLbl); } // borrowable is base-currency-denominated, 18-dec
      function cashCell(r) {
        if (r.cashout == null) return '—';
        return locked ? { main: fmtCash(r, r.cashout), sub: 'locked' } : fmtCash(r, r.cashout);
      }
      // While locked, borrowableAmountFrom returns 0, but the contract's borrowable capacity IS the
      // bonding-curve reclaim — i.e. ≈ the cash-out value. Show that as the would-be loan, marked locked.
      function loanCell(r) {
        if (r.maxLoan == null) return '—'; // no REVLoans on this chain
        if (r.maxLoan > 0n) return fmtLoan(r.maxLoan); // unlocked: the real borrowable
        if (locked && r.cashout != null && r.cashout > 0n) return { main: fmtCash(r, r.cashout), sub: 'locked' };
        return locked ? 'Locked' : fmtLoan(0n);
      }
      status.remove();
      var held = rows.filter(function (r) { return r.balance && r.balance > 0n; });
      if (!held.length) {
        claimRows = []; claimBtn.style.display = 'none';
        var none = el('div', 'detail-card-body you-empty');
        none.textContent = 'You don’t hold any ' + sym + ' yet. Pay the project to get some.';
        body.appendChild(none);
        return;
      }
      // Subtext under a balance: "Credits" (all unclaimed), "Credits & ERC-20s" (both), or none (all claimed ERC-20).
      function subFor(hasCredit, hasErc20) {
        if (hasCredit && hasErc20) return 'Credits & ERC-20s';
        if (hasCredit) return 'Credits';
        return undefined;
      }
      function balCell(r) {
        var main = formatTokenCount(r.balance) + ' ' + sym;
        if (r.credit == null) return main; // couldn't read the split — show the bare balance
        var sub = subFor(r.credit > 0n, r.balance != null && r.balance > r.credit);
        return sub ? { main: main, sub: sub } : main;
      }
      var table = el('div', 'detail-ops-table');
      table.appendChild(opsRow('Chain', 'Balance', 'Cash out', noLoans ? undefined : 'Max loan', true, false));
      var totBal = 0n, totCash = 0n, totLoan = 0n, anyLoan = false, anyCredit = false, anyErc20 = false;
      held.forEach(function (r) {
        table.appendChild(opsRow(
          r.name,
          balCell(r),
          cashCell(r),
          noLoans ? undefined : loanCell(r),
          false, false, r.id));
        totBal += r.balance;
        if (r.credit != null && r.credit > 0n) anyCredit = true;
        if (r.credit != null && r.balance != null && r.balance > r.credit) anyErc20 = true;
        if (r.cashout != null) totCash += r.cashout;
        if (r.maxLoan != null && r.maxLoan > 0n) { totLoan += r.maxLoan; anyLoan = true; }
      });
      // Reveal "Claim credits" when an ERC-20 exists and the wallet holds unclaimed credits somewhere.
      claimRows = held.filter(function (r) { return r.credit != null && r.credit > 0n; });
      claimBtn.style.display = (project.tokenAddress && claimRows.length) ? '' : 'none';
      var totBalSub = subFor(anyCredit, anyErc20);
      var totBalCell = totBalSub ? { main: formatTokenCount(totBal) + ' ' + sym, sub: totBalSub } : (formatTokenCount(totBal) + ' ' + sym);
      // Per-chain cash-out values are each in that chain's accounting token; summing across chains is only
      // meaningful when they all hold the SAME token. Mixed tokens (e.g. ETH + USDC) → no honest Total.
      var mixedAcct = held.some(function (r) { return r.acct && held[0].acct && (r.acct.symbol !== held[0].acct.symbol || r.acct.decimals !== held[0].acct.decimals); });
      var totCashCell = mixedAcct ? '—' : (locked ? { main: fmtCash(held[0], totCash), sub: 'locked' } : fmtCash(held[0], totCash));
      // Locked total loan ≈ total cash-out value (same bonding-curve reclaim, in the accounting token).
      var totLoanCell = anyLoan ? fmtLoan(totLoan) : (mixedAcct ? '—' : (locked && totCash > 0n ? { main: fmtCash(held[0], totCash), sub: 'locked' } : (locked ? 'Locked' : '—')));
      // A Total row is redundant when there's only one chain row.
      if (held.length > 1) table.appendChild(opsRow('Total', totBalCell, totCashCell, noLoans ? undefined : totLoanCell, false, true));
      body.appendChild(table);
      if (locked) {
        var note = el('div', 'you-footnote');
        note.textContent = noLoans
          ? 'Cash-outs unlock ' + formatDateShort(delay) + '. Locked values estimate what you could redeem then.'
          : 'Cash-outs and loans unlock ' + formatDateShort(delay) + '. Locked values estimate what you could redeem or borrow then.';
        body.appendChild(note);
      }
      // Your open loans (owner == connected wallet) + per-loan repay. Custom projects have no loans.
      if (!noLoans) {
        var myLoansWrap = el('div', 'you-loans');
        body.appendChild(myLoansWrap);
        fetchProjectEventRows(BENDYSTRAW_LOANS_QUERY, 'loans', project, 100).then(function (allLoans) {
          if (seq !== loadSeq || !myLoansWrap.isConnected) return;
          var mine = (allLoans || []).filter(function (l) { return String(l.owner || '').toLowerCase() === acct.toLowerCase(); });
          if (!mine.length) return;
          var title = el('div', 'you-loans-title'); title.textContent = 'Your loans'; myLoansWrap.appendChild(title);
          myLoansWrap.appendChild(renderLoansTable(project, mine, { mine: true, onRepay: function (loan) {
            var h = {}; var content = buildRepayModal(project, loan, function () { if (h.close) h.close(); });
            h.close = openModal('Repay loan #' + String(loan.id), content).close;
          } }));
        }).catch(function () {});
      }
    }).catch(function () {
      if (seq !== loadSeq || !body.isConnected) return;
      status.textContent = 'Could not read your position.';
    });
  }

  load();
  onWalletChange(function () { if (body.isConnected) load(); });
  document.addEventListener('jb:bridge-updated', function () { if (body.isConnected) load(); });
  return wrap;
}

// Movement, as a bottom subsection (activity-feed style) of "Settlement".
function renderBridgeTransactions(project) {
  var card = el('div', 'detail-subsection bridge-card');
  var head = el('div', 'bridge-card-head');
  var title = el('div', 'detail-subsection-title bridge-title');
  title.textContent = 'Queued movements';
  head.appendChild(title);

  var filter = document.createElement('select');
  filter.className = 'bridge-filter';
  // Cleared (claimed) movements drop out of this table — they live in the activity feed. So no "Claimed" filter.
  [
    ['all', 'All statuses'],
    ['pending', 'Pending'],
    ['claimable', 'Claimable'],
  ].forEach(function (opt) {
    var o = document.createElement('option');
    o.value = opt[0];
    o.textContent = opt[1];
    filter.appendChild(o);
  });
  head.appendChild(filter);
  card.appendChild(head);

  var body = el('div', 'bridge-table-wrap');
  body.appendChild(skelGenericTable('bridge-table', 'bridge-row', 'bridge-head',
    ['Initiated', 'Chains', 'Beneficiary', 'Tokens', 'Value', 'Status', 'Action'],
    ['60%', '50%', '70%', '55%', '55%', '45%', '40%'], 2));
  card.appendChild(body);

  var rows = [];
  var emptyRetries = 0;
  function rowKey(r) { return r.chainId + ':' + (r.sourceSucker || '') + ':' + r.index; }
  function draw() {
    body.innerHTML = '';
    body.className = 'bridge-table-wrap';
    var status = filter.value;
    var visible = status === 'all' ? rows : rows.filter(function (row) { return String(row.status) === status; });
    body.appendChild(renderBridgeTransactionsTable(visible, project));
  }
  // While anything is still in flight (sent but not yet delivered/claimable), re-read on-chain every 45s so
  // the row flips to "claimable" on its own once the destination inbox receives the root — no manual reload.
  var pollTimer = null;
  function schedulePoll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!body.isConnected) return;
    var inFlight = rows.some(function (r) { return r.status === 'pending'; });
    // Self-heal a transient empty scan: a flaky getLogs can return nothing even though movements exist, so
    // retry a few times quickly when the table is empty before giving up.
    var retryEmpty = rows.length === 0 && emptyRetries < 4;
    if (!inFlight && !retryEmpty) return;
    if (rows.length === 0) emptyRetries++;
    pollTimer = setTimeout(function () { if (body.isConnected) load(); }, rows.length === 0 ? 8000 : 45000);
  }
  function load() {
    fetchBridgeTransactions(project).then(function (data) {
      if (!body.isConnected) return;
      data = data || [];
      // Movements never legitimately disappear (a delivered/claimed leaf persists). A transient RPC/getLogs
      // failure returns fewer rows — merge by key (fresh status wins) so the view is monotonic and never
      // blanks out mid-flight; statuses still refresh as polls succeed.
      var byKey = {};
      rows.forEach(function (r) { byKey[rowKey(r)] = r; });
      data.forEach(function (r) { byKey[rowKey(r)] = r; });
      rows = Object.keys(byKey).map(function (k) { return byKey[k]; })
        // Cleared movements drop out — once claimed, the move is done and lives in the activity feed.
        .filter(function (r) { return r.status !== 'claimed'; })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      if (rows.length) emptyRetries = 0;
      draw();
      schedulePoll();
    }).catch(function () {
      if (!body.isConnected) return;
      // Don't wipe a populated table on a failed re-read — only show the error when we have nothing.
      if (!rows.length) { body.className = 'detail-card-body bridge-empty'; body.textContent = 'Could not load bridge transactions.'; }
      schedulePoll();
    });
  }

  filter.addEventListener('change', draw);
  // A move/claim/execute elsewhere dispatches this; re-read chain state so statuses stay fresh.
  document.addEventListener('jb:bridge-updated', load);
  load();

  return card;
}

// Rough delivery estimate (from when the message is SENT) by route — CCIP needs source finality + relay;
// native L2→L1 withdrawals wait out the challenge period; native L1→L2 deposits land in a few minutes.
function bridgeEtaHint(tx) {
  var L1 = { 1: 1, 11155111: 1 };
  var srcL1 = !!L1[Number(tx.chainId)], dstL1 = !!L1[Number(tx.peerChainId)];
  if (tx.infra === 'CCIP') return '20–30 min';
  if (!srcL1 && dstL1) return '7 days (challenge period)';
  return 'a few min';
}

function renderBridgeTransactionsTable(rows, project) {
  var sym = project.tokenSymbol || 'tokens';
  var table = el('div', 'bridge-table');
  var head = el('div', 'bridge-row bridge-head');
  ['Initiated', 'Chains', 'Beneficiary', 'Tokens', 'Value', 'Status', 'Action'].forEach(function (label) {
    var cell = el('span');
    cell.textContent = label;
    head.appendChild(cell);
  });
  table.appendChild(head);

  if (!rows.length) {
    var empty = el('div', 'bridge-empty-row');
    empty.textContent = 'No queued movements — anything in flight shows here until it clears.';
    table.appendChild(empty);
    return table;
  }

  // Per-row Claim — claiming is per-leaf on the destination chain.
  function attachClaim(action, tx) {
    var claimBtn = document.createElement('button'); claimBtn.className = 'ops-percent-btn'; claimBtn.textContent = 'Claim';
    var cstat = el('span', 'bridge-action-stat');
    claimBtn.addEventListener('click', function () {
      var acct = getAccount && getAccount(); if (!acct) { connect(); return; }
      var leaf = { index: BigInt(tx.index), beneficiary: tx.beneficiary32, projectTokenCount: toBigInt(tx.projectTokenCount), terminalTokenAmount: toBigInt(tx.terminalTokenAmount), metadata: tx.metadata };
      var payload = {
        action: 'Claim ' + formatCompactTokenAmount(toBigInt(tx.projectTokenCount)) + ' ' + sym + ' on ' + moveChainName(tx.peerChainId),
        chainId: tx.peerChainId, contract: tx.peerSucker, function: 'claim',
        args: { token: tx.remoteToken || tx.token, leaf: { index: tx.index, beneficiary: tx.beneficiary, projectTokenCount: leaf.projectTokenCount, terminalTokenAmount: leaf.terminalTokenAmount, metadata: tx.metadata }, proof: '[32-element merkle proof]' },
      };
      // Claiming runs on the DESTINATION chain — gas paid in that chain's native ETH. Warn early if the
      // wallet has none there (the most common reason a valid claim "doesn't work").
      cstat.classList.add('pending'); cstat.textContent = 'Checking…';
      readEthBalance(tx.peerChainId, acct).then(function (bal) {
        cstat.classList.remove('pending'); cstat.textContent = '';
        var lowGas = bal != null && bal < 200000000000000n;
        openTxConfirm(payload, function (ctx) {
          executeTransaction({
            skipConfirm: true,
            chainId: tx.peerChainId, address: tx.peerSucker, abi: suckerClaimAbi, functionName: 'claim', contractName: 'JBSucker',
            args: [{ token: tx.remoteToken || tx.token, leaf: leaf, proof: tx.proof }],
            onStatus: function (m, kind) { ctx.showStatus(m, kind); },
            onError: function (m) { ctx.showStatus(m, 'error'); },
            onSuccess: function () { ctx.showStatus('Claimed', 'success'); ctx.modal.close(); cstat.textContent = 'Claimed'; document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
          });
        }, { title: 'Confirm claim', confirmText: 'Confirm & Claim', closeOnConfirm: false,
          note: lowGas ? 'Heads up: claiming is a transaction on ' + moveChainName(tx.peerChainId) + ', and your wallet looks low on ' + moveChainName(tx.peerChainId) + ' ETH for gas. Fund it there first if the wallet can’t submit.' : undefined });
      });
    });
    action.appendChild(claimBtn); action.appendChild(cstat);
  }

  // Group by from→to pair. One toRemote ships the ENTIRE outbox for a (source sucker, token) pair, so the
  // "Execute" lives once per pair (a footer below its rows) rather than inline on every queued row.
  var groups = [], byKey = {};
  rows.forEach(function (tx) {
    var key = tx.chainId + '->' + tx.peerChainId;
    if (!byKey[key]) { byKey[key] = { from: tx.chainId, to: tx.peerChainId, sample: tx, rows: [] }; groups.push(byKey[key]); }
    byKey[key].rows.push(tx);
  });

  groups.forEach(function (g) {
    g.rows.forEach(function (tx) {
      var row = el('div', 'bridge-row');
      var when = el('span'); when.textContent = timeAgo(tx.createdAt); row.appendChild(when);

      var chains = el('span', 'bridge-chain-pair');
      chains.appendChild(chainLogo(Number(tx.chainId), chainById(tx.chainId).name));
      chains.appendChild(el('span', 'bridge-arrow')).textContent = '→';
      chains.appendChild(chainLogo(Number(tx.peerChainId), chainById(tx.peerChainId).name));
      row.appendChild(chains);

      var beneficiary = el('span', 'bridge-beneficiary'); beneficiary.appendChild(addressNode(tx.beneficiary)); row.appendChild(beneficiary);

      var tokens = el('span', 'bridge-num');
      tokens.textContent = formatCompactTokenAmount(toBigInt(tx.projectTokenCount)) + ' ' + (project.tokenSymbol || '');
      row.appendChild(tokens);

      var value = el('span', 'bridge-num');
      value.textContent = formatActivityAmount(tx.terminalTokenAmount, tx.tokenSymbol || 'ETH', tx.tokenDecimals);
      row.appendChild(value);

      var status = el('span');
      var badge = el('span', 'bridge-status bridge-status--' + String(tx.status || 'unknown').toLowerCase());
      badge.textContent = tx.status || 'unknown';
      status.appendChild(badge); row.appendChild(status);

      var action = el('span', 'bridge-action');
      if (tx.status === 'claimable') attachClaim(action, tx);
      else if (tx.status === 'pending' && tx.canExecute) { var q = el('span', 'bridge-action-stat'); q.textContent = 'Queued'; action.appendChild(q); } // sent via the group Execute below
      else if (tx.status === 'claimed') action.textContent = '—';
      else {
        // Sent over the bridge, not yet delivered to the destination inbox. The "Bridging…" text itself is
        // the live-tracker link (route-based delivery estimate alongside). CCIP messages are searchable on
        // the CCIP explorer by sender; native bridges link to the source sucker on the chain explorer.
        var eta = bridgeEtaHint(tx);
        var link = document.createElement('a'); link.className = 'bridge-action-stat bridge-track-link'; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = 'Bridging… ↗';
        link.title = tx.infra === 'CCIP' ? 'Track this message on the CCIP explorer' : 'Track on the chain explorer';
        if (tx.infra === 'CCIP') { link.href = 'https://ccip.chain.link/address/' + tx.sourceSucker; }
        else { var be = CHAINS[tx.chainId] && CHAINS[tx.chainId].blockExplorers && CHAINS[tx.chainId].blockExplorers.default; link.href = (be ? be.url.replace(/\/$/, '') : '') + '/address/' + tx.sourceSucker; }
        action.appendChild(link);
        if (eta) { var etaSpan = el('span', 'bridge-action-stat bridge-eta'); etaSpan.textContent = '~' + eta; action.appendChild(etaSpan); }
      }
      row.appendChild(action);
      table.appendChild(row);
    });

    // One Execute per pair: send every queued (not-yet-sent) move to the destination in a single toRemote.
    var sendable = g.rows.filter(function (r) { return r.status === 'pending' && r.canExecute; });
    if (!sendable.length) return;
    var s = g.sample;
    var foot = el('div', 'bridge-group-foot');
    var lbl = el('span', 'bridge-group-foot-lbl');
    lbl.textContent = sendable.length + ' queued move' + (sendable.length > 1 ? 's' : '') + ' to ' + moveChainName(g.to) + ' — send all in one bridge message:';
    foot.appendChild(lbl);
    var estat = el('span', 'bridge-action-stat');
    var execBtn = document.createElement('button'); execBtn.className = 'ops-percent-btn'; execBtn.textContent = 'Execute';
    execBtn.title = 'Ship the queued outbox to ' + moveChainName(g.to) + ' (anyone can call this)';
    execBtn.addEventListener('click', function () {
      var acct = getAccount && getAccount(); if (!acct) { connect(); return; }
      execBtn.disabled = true;
      var onS = function (m, kind) { estat.classList.toggle('pending', kind === 'pending'); estat.textContent = m; };
      onS('Reading bridge fee…', 'pending');
      findToRemoteValue(s.chainId, s.sourceSucker, s.token, acct).then(function (fee) {
        if (fee == null) { estat.classList.remove('pending'); execBtn.disabled = false; estat.textContent = 'Couldn’t determine the bridge fee — try again shortly.'; return; }
        estat.classList.remove('pending'); estat.textContent = ''; execBtn.disabled = false;
        // Same decoded confirm as the auto-pop after prepare (executeTransaction → confirmTransactionModal).
        executeTransaction({
          chainId: s.chainId, address: s.sourceSucker, abi: suckerBridgeAbi, functionName: 'toRemote', contractName: 'JBSucker',
          args: [s.token], value: fee, label: 'Transfer all queued movements',
          confirmTitle: 'Transfer all queued movements',
          confirmDescription: 'This ships the bridge’s queued outbox to ' + moveChainName(s.peerChainId) + ' — it delivers all '
            + sendable.length + ' queued move' + (sendable.length > 1 ? 's' : '') + ' to ' + moveChainName(s.peerChainId) + ' in a single bridge '
            + 'message, so anyone can trigger it. The value shown is the bridge’s messaging fee — you pay it to relay the message; it’s not the bridged tokens (those move from the project’s funds).',
          // Tx progress shows inside the confirm modal (which stays open) — keep the table row's status
          // empty so it never pushes the Execute button around. Just re-enable / refresh on terminal states.
          onStatus: function () {},
          onError: function () { execBtn.disabled = false; },
          onSuccess: function () { execBtn.disabled = false; document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
        });
      });
    });
    foot.appendChild(execBtn); foot.appendChild(estat);
    table.appendChild(foot);
  });

  return table;
}

// -- Modal primitive --
// Map a modal/card title to a known component concept, so the prompt carries that concept's contract + the
// gotchas that make it correct and safe (defined once in COMPONENT_SPECS).
var TITLE_CONCEPT = {
  'cash out': 'cashout', 'get a loan': 'loan', 'repay loan': 'loan', 'move between chains': 'move',
  'distribute payouts': 'payouts', 'use surplus allowance': 'payouts', 'queue ruleset': 'queue-ruleset',
  'add operator': 'permissions', 'edit permissions': 'permissions',
  'set token name & symbol': 'deploy-erc20',     // this branch genuinely deploys the ERC-20
  'edit token name & symbol': 'token-metadata',  // deployed branch is setTokenMetadataOf, NOT deployERC20For
  'add items for sale': 'items-for-sale', 'confirm add items': 'items-for-sale',
  'transfer ownership': 'transfer-ownership', 'transfer operator': 'transfer-operator',
  'edit project': 'edit-project', 'add accounting token': 'accounting-token',
  'edit splits': 'split-groups', 'edit reserved recipients': 'split-groups',
  'add market liquidity': 'add-liquidity', 'add liquidity': 'add-liquidity',
};
function conceptForTitle(title) {
  var k = (title || '').trim().toLowerCase();
  if (TITLE_CONCEPT[k]) return TITLE_CONCEPT[k];
  if (k.indexOf('payout splits') >= 0) return 'split-groups'; // dynamic "Edit <SYM> payout splits" title
  for (var pre in TITLE_CONCEPT) if (k.indexOf(pre) === 0) return TITLE_CONCEPT[pre];
  return null;
}

// The "copy LLM prompt" link for a project-explorer card/modal/form. A known concept reuses its rich spec
// (contract + gotchas); anything else falls back to a generic prompt pointing at src/discover.js.
function discoverPromptFoot(title) {
  var foot = el('div', 'comp-prompt-foot');
  var concept = conceptForTitle(title);
  foot.appendChild(promptLinkButton(function () {
    return concept ? componentReproPrompt(title, concept) : componentReproPrompt(title, null, 'discover.js');
  }));
  return foot;
}

// Add a "copy LLM prompt" link to EVERY card on EVERY project tab. Switching tabs swaps the content area's
// children, so a MutationObserver keeps coverage without editing all ~20 card sites. Idempotent; skips the
// pay card (it already carries its component-specific link).
function attachCardPromptLinks(contentArea) {
  if (!contentArea || typeof MutationObserver === 'undefined') return;
  var tag = function (card) {
    if (!card.classList || card.classList.contains('paybox')) return;
    if (card.querySelector('.detail-card, .you-card')) return; // container card — only tag the leaf inside it
    if (card.dataset.promptLinked) return; // idempotent: never add a second link to the same card
    card.dataset.promptLinked = '1';
    var t = card.querySelector('.detail-card-title');
    var title = t ? (t.textContent || '').trim().split('\n')[0]
      : (card.classList.contains('you-card') ? 'Your holdings & actions' : 'this section');
    card.appendChild(discoverPromptFoot(title));
  };
  var scan = function (root) {
    if (!root.querySelectorAll) return;
    if (root.classList && (root.classList.contains('detail-card') || root.classList.contains('you-card'))) tag(root);
    root.querySelectorAll('.detail-card, .you-card').forEach(tag);
  };
  scan(contentArea);
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) scan(added[j]);
    }
  }).observe(contentArea, { childList: true, subtree: true });
}

function openModal(titleText, contentNode, opts) {
  opts = opts || {};
  var overlay = el('div', 'modal-overlay');
  var dialog = el('div', 'modal-dialog');
  var head = el('div', 'modal-head');
  var h = el('div', 'modal-title'); h.textContent = titleText; head.appendChild(h);
  var x = document.createElement('button'); x.className = 'modal-close'; x.textContent = '✕';
  x.addEventListener('click', close); head.appendChild(x);
  dialog.appendChild(head);
  dialog.appendChild(contentNode);
  // Every action modal/form is a recreatable component — give it an LLM prompt link. Skip transient
  // pre-sign confirmations (opts.noPrompt), which aren't features to rebuild.
  if (!opts.noPrompt) dialog.appendChild(discoverPromptFoot(titleText));
  overlay.appendChild(dialog);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return { close: close };
}

// Pre-sign confirmation: shows the exact transaction payload as JSON and only sends on explicit confirm.
function openTxConfirm(payload, onConfirm, opts) {
  opts = opts || {};
  var content = el('div', 'pay-confirm');
  renderConfirmBody(content, payload, opts); // shared body: decoded summary + raw-in-details + audit link
  var status = el('div', 'modal-status tx-confirm-status');
  status.style.display = 'none';
  content.appendChild(status);
  var foot = el('div', 'create-modal-foot');
  var cancel = el('button', 'create-btn ghost'); cancel.textContent = 'Cancel';
  var confirm = el('button', 'create-btn primary'); confirm.textContent = opts.confirmText || 'Confirm';
  foot.appendChild(cancel); foot.appendChild(confirm);
  content.appendChild(foot);
  var modal = openModal(opts.title || 'Confirm transaction', content, { noPrompt: true });
  cancel.addEventListener('click', modal.close);
  function showStatus(message, kind) {
    status.style.display = message ? '' : 'none';
    status.className = 'modal-status tx-confirm-status' + (kind ? (' ' + kind) : '');
    status.textContent = message || '';
  }
  confirm.addEventListener('click', function () {
    if (opts.closeOnConfirm !== false) modal.close();
    onConfirm({
      modal: modal,
      status: status,
      showStatus: showStatus,
      confirm: confirm,
      cancel: cancel,
    });
  });
}

function openPayConfirm(payload, onConfirm) {
  openTxConfirm(payload, onConfirm, {
    title: 'Confirm payment',
    confirmText: 'Confirm & Pay',
  });
}

// Shared: a chain <select> from the project's chains.
function opsChainSelect(project, onChange, opts) {
  opts = opts || {};
  // Compact dropdown styling (matches the cash-out selectors), not the heavy full-width bordered control.
  var sel = el('select', 'field create-input'); sel.style.width = 'auto'; sel.style.minWidth = '0';
  var sym = project.tokenSymbol || 'tokens';
  (project.chains || []).forEach(function (c) {
    var o = document.createElement('option'); o.value = String(c.id); o.textContent = c.name; sel.appendChild(o);
    // Show the connected wallet's balance on each chain right in the option, so the user can pick the
    // chain with funds without switching first.
    if (opts.withBalance) {
      readUserBalance(project, c.id).then(function (b) {
        if (b == null) return;
        o.textContent = c.name + ' | ' + formatTokens(b) + ' ' + sym;
      });
    }
  });
  if (onChange) sel.addEventListener('change', function () { onChange(Number(sel.value)); });
  return sel;
}

// Shared: 10/25/50/Max buttons that fill an input from a max-bigint getter (18 decimals).
function opsPercentButtons(input, getMax) {
  var row = el('div', 'ops-percent');
  [['10%', 10], ['25%', 25], ['50%', 50], ['Max', 100]].forEach(function (p) {
    var b = document.createElement('button'); b.className = 'ops-percent-btn'; b.textContent = p[0];
    b.addEventListener('click', function () {
      var max = getMax();
      if (max == null) return;
      var v = max * BigInt(p[1]) / 100n;
      input.value = formatAmount(v, 18);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    row.appendChild(b);
  });
  return row;
}

// Read the connected wallet's token balance for the project on a chain (credits + ERC-20).
function readUserBalance(project, chainId) {
  var acct = getAccount && getAccount();
  if (!acct) return Promise.resolve(null);
  var tokens = getAddress('JBTokens', chainId);
  if (!tokens) return Promise.resolve(null);
  return clientFor(chainId).readContract({
    address: tokens, abi: totalBalanceOfAbi, functionName: 'totalBalanceOf', args: [acct, BigInt(project.id)],
  }).catch(function () { return null; });
}

// Renders, into `balTable`, two per-chain sections: the connected wallet's project-token balance, and the
// project's (accounting-token) balances. Shared by the Cash out + Move modals.
function renderBalanceTables(balTable, project, sym) {
  balTable.innerHTML = '';
  var chs = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: chainNameOf(project.chainId) }];
  function chainCell(cid, name) { var c = el('span', 'cashout-tbl-chain'); c.appendChild(chainLogo(cid, name)); var t = el('span'); t.textContent = ' ' + (name || ('Chain ' + cid)); c.appendChild(t); return c; }
  function th(text, num) { var s = el('span', 'cashout-tbl-th' + (num ? ' num' : '')); s.textContent = text; return s; }
  function numCell(text) { var s = el('span', 'cashout-tbl-num'); s.textContent = text == null ? '…' : text; return s; }
  // Each table is a stack of row-grids (like the owners table) so rows can carry separators.
  function makeTable(cols) { var t = el('div', 'cashout-tbl'); t._cols = cols; return t; }
  function addRow(tbl, cells, isHead) { var r = el('div', 'cashout-tbl-row' + (isHead ? ' cashout-tbl-headrow' : '')); r.style.gridTemplateColumns = tbl._cols; cells.forEach(function (c) { r.appendChild(c); }); tbl.appendChild(r); }
  function title(text) { var h = el('div', 'cashout-bal-title'); h.textContent = text; return h; }

  // YOUR BALANCE — Chain | <project token>.
  balTable.appendChild(title('Your balance'));
  if (!(getAccount && getAccount())) { var cc = el('div', 'modal-balance'); cc.textContent = 'Connect a wallet to see your balance.'; balTable.appendChild(cc); }
  else {
    var yt = makeTable('1.4fr auto');
    addRow(yt, [th('Chain'), th(sym, true)], true);
    chs.forEach(function (c) { var v = numCell(null); addRow(yt, [chainCell(c.id, c.name), v]); readUserBalance(project, c.id).then(function (b) { v.textContent = (b == null ? '—' : formatTokens(b)); }).catch(function () { v.textContent = '—'; }); });
    balTable.appendChild(yt);
  }

  // PROJECT BALANCES — Chain | <one column per accounting token (USDC, ETH, …)>.
  var ph = title('Project balances'); ph.style.marginTop = '14px'; balTable.appendChild(ph);
  var tt = makeTable('1.4fr auto'); balTable.appendChild(tt);
  acctKindsForFunds(project).then(function (kinds) {
    if (!kinds || !kinds.length) kinds = [{ symbol: sym, decimals: 18 }];
    tt._cols = '1.4fr ' + kinds.map(function () { return '1fr'; }).join(' ');
    addRow(tt, [th('Chain')].concat(kinds.map(function (k) { return th(k.symbol, true); })), true);
    var cells = {}; // chainId → [cell per kind]
    chs.forEach(function (c) { var cs = kinds.map(function () { return numCell(null); }); cells[c.id] = cs; addRow(tt, [chainCell(c.id, c.name)].concat(cs)); });
    return fetchBalanceBreakdown(project).then(function (bd) {
      var byChainSym = {}; (bd.rows || []).forEach(function (r) { byChainSym[r.chainId + '|' + r.symbol] = formatAmount(r.balance, r.decimals); });
      chs.forEach(function (c) { kinds.forEach(function (k, i) { var v = cells[c.id][i]; if (v) { var key = c.id + '|' + k.symbol; v.textContent = byChainSym[key] != null ? byChainSym[key] : '0'; } }); });
    });
  }).catch(function () { tt.textContent = 'Could not read balances.'; });
}

// The protocol fee on payouts/cash-outs is paid into this project (JBConstants.FEE_BENEFICIARY_PROJECT_ID).
var FEE_BENEFICIARY_PROJECT_ID = 1n;

// REVOwner.FEE_REVNET_ID — the revnet that receives a revnet's 2.5%-of-tokens cash-out fee.
var feeRevnetIdAbi = [{ type: 'function', name: 'FEE_REVNET_ID', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];

// Cached ERC-20 symbol of a project's token, per (chain, projectId) — labels the tokens a casher-out
// receives in return for a fee paid into that project (JB #1 protocol fee, or the fee revnet).
var _projTokenSymCache = {};
function projectTokenSymbol(chainId, projectId) {
  var key = chainId + ':' + String(projectId);
  if (_projTokenSymCache[key] !== undefined) return Promise.resolve(_projTokenSymCache[key]);
  return read(chainId, 'JBTokens', tokenOfAbi, 'tokenOf', [BigInt(projectId)]).then(function (tokenAddr) {
    if (!tokenAddr || /^0x0+$/.test(tokenAddr)) { _projTokenSymCache[key] = null; return null; }
    return clientFor(chainId).readContract({ address: tokenAddr, abi: erc20SymbolAbi, functionName: 'symbol', args: [] })
      .then(function (s) { _projTokenSymCache[key] = s || null; return _projTokenSymCache[key]; });
  }).catch(function () { _projTokenSymCache[key] = null; return null; });
}

// The fee revnet id for a revnet, read from its data hook (REVOwner). Cached per (chain, dataHook).
var _feeRevnetIdCache = {};
function feeRevnetIdOf(chainId, dataHook) {
  if (!dataHook || dataHook === ZERO_ADDRESS) return Promise.resolve(null);
  var key = chainId + ':' + dataHook.toLowerCase();
  if (_feeRevnetIdCache[key] !== undefined) return Promise.resolve(_feeRevnetIdCache[key]);
  return clientFor(chainId).readContract({ address: dataHook, abi: feeRevnetIdAbi, functionName: 'FEE_REVNET_ID', args: [] })
    .then(function (id) { _feeRevnetIdCache[key] = toBigInt(id); return _feeRevnetIdCache[key]; })
    .catch(function () { _feeRevnetIdCache[key] = null; return null; });
}

function buildCashOutModal(project, requestClose) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'modal-body');
  var pid = BigInt(project.id);
  var state = { chainId: (project.chains && project.chains[0] && project.chains[0].id) || project.chainId, balance: null, supply: null, surplus: null, reclaim: null, net: null, cashOutTaxRate: null, locked: false, exact: true, kinds: null, reclaimKey: null };

  // Your BREADFRUIT balance on each chain (so you can see where you can cash out from).
  var balTable = el('div', 'cashout-bal-table'); wrap.appendChild(balTable);
  function loadBalanceTable() { renderBalanceTables(balTable, project, sym); }

  // One line: "Cash out on [chain], reclaim in [token]". The reclaim picker shows only for multi-token
  // projects (cash-out reclaim is per token — each is bounded by THAT token's surplus, so to cash out ETH
  // surplus you reclaim in ETH; USDC may have unlimited payouts → 0 surplus). Populated once kinds resolve.
  var selRow = el('div', 'cashout-selrow');
  selRow.appendChild(document.createTextNode('Cash out on'));
  // Plain compact select (same style as the reclaim-token dropdown) — the styled opsChainSelect overflowed.
  var coChains = (project.chains && project.chains.length) ? project.chains : [{ id: state.chainId, name: chainNameOf(state.chainId) }];
  var chainSel = el('select', 'field create-input'); chainSel.style.width = 'auto'; chainSel.style.minWidth = '0';
  coChains.forEach(function (c) { var o = document.createElement('option'); o.value = String(c.id); o.textContent = c.name || ('Chain ' + c.id); if (c.id === state.chainId) o.selected = true; chainSel.appendChild(o); });
  chainSel.addEventListener('change', function () { state.chainId = Number(chainSel.value); onChainChange(); });
  selRow.appendChild(chainSel);
  var reclaimWrap = el('span', 'cashout-reclaim'); reclaimWrap.style.display = 'none';
  reclaimWrap.appendChild(document.createTextNode(', reclaim in'));
  var reclaimSel = el('select', 'field create-input'); reclaimSel.style.width = 'auto'; reclaimSel.style.minWidth = '0';
  reclaimSel.addEventListener('change', function () { state.reclaimKey = reclaimSel.value; onChainChange(); });
  reclaimWrap.appendChild(reclaimSel); selRow.appendChild(reclaimWrap);
  wrap.appendChild(selRow);

  // Amount field (titled + the selected chain's available balance, like the Move form).
  var amtLbl = el('div', 'modal-label move-label'); amtLbl.textContent = 'Amount'; amtLbl.style.marginTop = '12px'; wrap.appendChild(amtLbl);
  var availLine = el('div', 'modal-balance'); wrap.appendChild(availLine);
  var inRow = el('div', 'ops-inrow');
  var field = el('div', 'ops-field');
  var amt = el('input', 'ops-amount'); amt.type = 'number'; amt.placeholder = '0.00'; field.appendChild(amt);
  var unit = el('span', 'ops-unit'); unit.textContent = sym; field.appendChild(unit);
  inRow.appendChild(field);
  wrap.appendChild(inRow);
  wrap.appendChild(opsPercentButtons(amt, function () { return state.balance; }));

  var preview = el('div', 'ops-preview'); wrap.appendChild(preview);
  var status = el('div', 'modal-status'); wrap.appendChild(status);
  var foot = el('div', 'modal-foot');
  var btn = document.createElement('button'); btn.className = 'modal-submit'; btn.textContent = 'Cash out';
  foot.appendChild(btn); wrap.appendChild(foot);

  function refreshBalance() {
    // The selected chain's balance backs the percent/Max buttons + the "available" line; the per-chain
    // table renders separately.
    availLine.textContent = '';
    readUserBalance(project, state.chainId).then(function (b) {
      state.balance = b;
      if (!(getAccount && getAccount())) { availLine.textContent = 'Connect a wallet to cash out.'; return; }
      availLine.textContent = 'Your ' + sym + ' available on ' + chainNameOf(state.chainId) + ': ' + (b == null ? '—' : (formatTokens(b) + ' ' + sym));
    });
  }
  // The reclaim token for the current chain — the picked accounting kind if any, else the primary token.
  function acctForChain(chainId) {
    if (state.kinds && state.reclaimKey) {
      var k = state.kinds.filter(function (x) { return x.key === state.reclaimKey; })[0];
      var a = k && k.addrForChain(chainId);
      if (a) return Promise.resolve({ address: a, decimals: k.decimals, symbol: k.symbol });
    }
    return getAddress('JBMultiTerminal', chainId) ? resolveAcctToken(chainId, pid) : Promise.resolve({ address: NATIVE_TOKEN, decimals: 18, symbol: 'ETH' });
  }
  function onChainChange() {
    refreshBalance();
    state.supply = null; state.surplus = null; state.acct = null; state.cashOutTaxRate = null; updatePreview();
    var terminal = getAddress('JBMultiTerminal', state.chainId);
    var acctP = acctForChain(state.chainId);
    acctP.then(function (acct) {
      state.acct = acct;
      return Promise.all([
        read(state.chainId, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return null; }),
        // Actual reclaimable SURPLUS (= terminal balance − remaining payout limit), in the accounting token's
        // own decimals/currency. Reading raw `balanceOf` here overstated it when a payout limit exists and could
        // push the fallback min-reclaimed floor above the real reclaim → cashOutTokensOf revert.
        terminal ? read(state.chainId, 'JBTerminalStore', currentSurplusOfAbi, 'currentSurplusOf', [pid, [], [acct.address], BigInt(acct.decimals), BigInt(Number(BigInt(acct.address) & 0xffffffffn))]).catch(function () { return null; }) : Promise.resolve(null),
        // The 2.5% protocol fee on cash-out only applies when the ruleset's cash-out tax rate is non-zero.
        read(state.chainId, 'JBController', currentRulesetAbi, 'currentRulesetOf', [pid]).catch(function () { return null; }),
      ]);
    }).then(function (r) {
      state.supply = r[0]; state.surplus = r[1];
      state.cashOutTaxRate = r[2] && r[2][1] ? Number(r[2][1].cashOutTaxRate || 0) : 0;
      updatePreview();
      loadCashAggregates(state.acct);
    });
  }
  // Aggregate the bonding-curve inputs across every chain (omnichain gossip): total supply (with reserved)
  // = the curve's denominator, and total surplus (all tokens, valued in the reclaim token's currency) = the
  // numerator. Summing per-chain mirrors how the sucker data hook prices an omnichain cash-out.
  function loadCashAggregates(acct) {
    state.aggSupply = null; state.aggSurplus = null;
    if (!acct) return;
    var chs = (project.chains && project.chains.length) ? project.chains : [{ id: state.chainId, name: chainNameOf(state.chainId) }];
    var cur = Number(BigInt(acct.address) & 0xffffffffn);
    Promise.all([
      Promise.all(chs.map(function (c) { return read(c.id, 'JBController', totalSupplyWithReservedAbi, 'totalTokenSupplyWithReservedTokensOf', [pid]).catch(function () { return 0n; }); })),
      // Surplus of the RECLAIM token specifically (tokens=[acct], in its own currency) — that's what you can
      // actually reclaim of this token (settlement caps at the token's local surplus), and needs no price feed.
      Promise.all(chs.map(function (c) { return getAddress('JBMultiTerminal', c.id) ? read(c.id, 'JBTerminalStore', currentSurplusOfAbi, 'currentSurplusOf', [pid, [], [acct.address], BigInt(acct.decimals), BigInt(cur)]).catch(function () { return 0n; }) : Promise.resolve(0n); })),
    ]).then(function (r) {
      state.aggSupply = (r[0] || []).reduce(function (s, v) { return s + toBigInt(v); }, 0n);
      state.aggSurplus = (r[1] || []).reduce(function (s, v) { return s + toBigInt(v); }, 0n);
      state.aggChains = chs.length;
      updatePreview();
    }).catch(function () {});
  }
  var previewSeq = 0;
  function updatePreview() {
    var count; try { count = parseAmount(amt.value, 18); } catch (_) { count = 0n; }
    if (!count || count === 0n || state.supply == null || state.surplus == null || state.surplus === 0n) { preview.innerHTML = ''; state.reclaim = null; state.net = null; return; }
    var terminal = getAddress('JBMultiTerminal', state.chainId);
    if (!terminal) { preview.innerHTML = ''; return; }
    var a = state.acct || { address: NATIVE_TOKEN, decimals: 18, symbol: 'ETH' };
    var seq = ++previewSeq;
    preview.textContent = 'Calculating…';
    // Beneficiary drives feeless + REV-fee math; use the connected wallet so the preview matches what
    // that wallet will see. A placeholder (not feeless) is fine for the disconnected preview.
    var who = (getAccount && getAccount()) || '0x0000000000000000000000000000000000000001';
    Promise.all([
      // Hook-aware reclaim: for revnets this already nets out the REVOwner 2.5%-of-tokens fee + buyback.
      clientFor(state.chainId).readContract({
        address: terminal, abi: previewCashOutAbi, functionName: 'previewCashOutFrom',
        args: [who, pid, count, a.address || NATIVE_TOKEN, who, '0x'],
      }).catch(function () { return null; }),
      // Curve reclaim on the FULL token count (no hook) — the gap vs the hook-aware reclaim is the REV fee.
      read(state.chainId, 'JBTerminalStore', reclaimableAbi, 'currentReclaimableSurplusOf', [pid, count, state.supply, state.surplus]).catch(function () { return null; }),
    ]).then(function (r) {
      if (seq !== previewSeq) return;
      var preCut = r[0];
      var fullGross = r[1] != null ? toBigInt(r[1]) : null;
      // The hook-aware preview reverts while a revnet's cash-out delay is active (and the real cash-out
      // would too). Surface that as a lock + countdown instead of a broken estimate.
      if (!preCut) {
        return readCashOutDelay(Object.assign({}, project, { chainId: state.chainId })).then(function (delay) {
          if (seq !== previewSeq) return;
          var now = Math.floor(Date.now() / 1000);
          if (delay != null && Number(delay) > now) {
            state.locked = true; state.net = null; state.reclaim = null;
            preview.innerHTML = '';
            var lock = el('div', 'ops-preview-line ops-preview-lock');
            lock.textContent = 'Cash outs unlock in ' + fmtCountdown(Number(delay) - now);
            preview.appendChild(lock);
            btn.disabled = true;
            return;
          }
          // Not delay-locked — fall back to the raw curve reclaim (no hook). Approximate the revnet fee as
          // 2.5% so the floor isn't set above the payout, and widen the slippage on submit (state.exact=false).
          state.locked = false; btn.disabled = false;
          if (fullGross == null) { preview.innerHTML = ''; state.net = null; return; }
          var approxAfterHook = project.isRevnet ? fullGross - fullGross / 40n : fullGross;
          var taxR = state.cashOutTaxRate || 0;
          var pFee = taxR ? approxAfterHook / 40n : 0n;
          state.exact = false; state.reclaim = approxAfterHook; state.net = approxAfterHook - pFee;
          renderCashPreview(seq, { net: state.net, revFee: project.isRevnet ? fullGross - approxAfterHook : 0n, protocolFee: pFee, approx: true });
        });
      }
      state.locked = false; state.exact = true; btn.disabled = false;
      // afterHook = reclaim after the data hook (REV fee + buyback) but before the terminal's protocol fee.
      var afterHook = toBigInt(preCut[1]);
      var taxRate = Number(preCut[2] || 0);
      // The exact REV fee value is the cash-out hook spec routed back to the data hook (REVOwner) — it pays
      // the fee revnet on the holder's behalf. (A separate buyback spec, if any, has a different `hook`.)
      var specs = preCut[3] || [];
      var dataHook = (project.metadata && project.metadata.dataHook || '').toLowerCase();
      var revFee = 0n;
      for (var i = 0; i < specs.length; i++) {
        if (specs[i] && !specs[i].noop && (specs[i].hook || '').toLowerCase() === dataHook) revFee += toBigInt(specs[i].amount);
      }
      if (revFee === 0n && fullGross != null && fullGross > afterHook) revFee = fullGross - afterHook; // fallback
      // The terminal then takes the 2.5% protocol fee (`amount / 40`) on the post-hook reclaim, and checks
      // minTokensReclaimed against THIS net. Mirror it exactly so the floor isn't set above the payout.
      var protocolFee = taxRate ? afterHook / 40n : 0n;
      var net = afterHook - protocolFee;
      state.reclaim = afterHook;
      state.net = net;
      renderCashPreview(seq, { net: net, revFee: revFee, protocolFee: protocolFee });
    }).catch(function () { if (seq === previewSeq) { preview.innerHTML = ''; state.reclaim = null; state.net = null; } });
  }

  // Render the post-fee payout, a line per fee (revnet fee + protocol fee), and — for the protocol fee —
  // an async preview of the fee-project tokens the beneficiary receives (the fee is paid into JB #1 on
  // their behalf, minting its token in return).
  function renderCashPreview(seq, f) {
    if (seq !== previewSeq) return;
    var a = state.acct || { decimals: 18, symbol: 'ETH' };
    // Snapshot the outcome for the success panel (fee-token amounts fill in as their previews resolve).
    state.outcome = { net: f.net, sym: a.symbol, decimals: a.decimals, revToken: null, protoToken: null };
    preview.innerHTML = '';
    var recv = el('div', 'ops-preview-line ops-preview-recv');
    recv.textContent = 'You’ll receive ~ ' + formatBalance(f.net, a.decimals, a.symbol);
    preview.appendChild(recv);
    if (f.approx) {
      var note = el('div', 'ops-preview-line ops-preview-feetok');
      note.textContent = '(estimate — exact reclaim couldn’t be previewed)';
      preview.appendChild(note);
    }
    // When the payout reads ~0, explain why (cash-outs draw only from surplus across all tokens): either
    // cash-outs are off (100% tax) or there's no surplus (payout limit covers the whole balance).
    if (f.net != null && f.net === 0n) {
      var why = '';
      if ((state.cashOutTaxRate || 0) >= 10000) why = 'Cash outs are off this ruleset (100% cash-out tax).';
      else if (state.aggSurplus != null && state.aggSurplus === 0n) why = 'No ' + a.symbol + ' surplus — its payout limit covers the whole ' + a.symbol + ' balance.' + (state.kinds && state.kinds.length > 1 ? ' Try reclaiming a different token above.' : '');
      if (why) { var wl = el('div', 'ops-preview-line ops-preview-feetok'); wl.textContent = why; preview.appendChild(wl); }
    }
    // Revnet fee (2.5% of cashed-out tokens, routed to the fee revnet). Only shown when present. The fee
    // is paid into the fee revnet on the holder's behalf, minting its token to them — preview that too.
    if (f.revFee > 0n) {
      var revLine = el('div', 'ops-preview-line ops-preview-fee');
      revLine.textContent = '2.5% revnet fee: ' + formatBalance(f.revFee, a.decimals, a.symbol);
      preview.appendChild(revLine);
      var dataHook = project.metadata && project.metadata.dataHook;
      if (!f.approx && dataHook && dataHook !== ZERO_ADDRESS) {
        var revTok = el('div', 'ops-preview-line ops-preview-feetok');
        revTok.textContent = '↳ minting the fee revnet’s token to you…';
        preview.appendChild(revTok);
        var racct = (getAccount && getAccount()) || undefined;
        feeRevnetIdOf(state.chainId, dataHook).then(function (frid) {
          if (seq !== previewSeq) return;
          if (frid == null) { if (revTok.parentNode) revTok.parentNode.removeChild(revTok); return; }
          return Promise.all([
            computePayPreview({ chainId: state.chainId, projectId: Number(frid), token: a.address || NATIVE_TOKEN, amount: f.revFee, beneficiary: racct }),
            projectTokenSymbol(state.chainId, frid),
          ]).then(function (r) {
            if (seq !== previewSeq) return;
            var p = r[0], rsym = r[1] || 'tokens';
            if (p && !p.unavailable && p.received != null && p.received > 0n) {
              revTok.textContent = '↳ get ~ ' + formatTokens(p.received) + ' ' + rsym + ' in revnet #' + String(frid) + ' for the fee';
              if (state.outcome) state.outcome.revToken = { amount: p.received, sym: rsym, id: String(frid) };
            } else {
              revTok.textContent = '↳ fee funds revnet #' + String(frid);
            }
          });
        }).catch(function () { if (seq === previewSeq && revTok.parentNode) revTok.parentNode.removeChild(revTok); });
      }
    }
    if (f.protocolFee > 0n) {
      var feeLine = el('div', 'ops-preview-line ops-preview-fee');
      feeLine.textContent = '2.5% protocol fee: ' + formatBalance(f.protocolFee, a.decimals, a.symbol);
      preview.appendChild(feeLine);
      var feeTok = el('div', 'ops-preview-line ops-preview-feetok');
      feeTok.textContent = '↳ paid into JB #' + String(FEE_BENEFICIARY_PROJECT_ID) + ', minting its token to you…';
      preview.appendChild(feeTok);
      // Preview the fee payment into project #1 to show the tokens returned (matches the on-chain pay).
      var acct = (getAccount && getAccount()) || undefined;
      Promise.all([
        computePayPreview({ chainId: state.chainId, projectId: Number(FEE_BENEFICIARY_PROJECT_ID), token: a.address || NATIVE_TOKEN, amount: f.protocolFee, beneficiary: acct }),
        projectTokenSymbol(state.chainId, FEE_BENEFICIARY_PROJECT_ID),
      ]).then(function (r) {
        if (seq !== previewSeq) return;
        var p = r[0], fsym = r[1] || 'tokens';
        if (p && !p.unavailable && p.received != null && p.received > 0n) {
          feeTok.textContent = '↳ get ~ ' + formatTokens(p.received) + ' ' + fsym + ' in JB #' + String(FEE_BENEFICIARY_PROJECT_ID) + ' for the fee';
          if (state.outcome) state.outcome.protoToken = { amount: p.received, sym: fsym };
        } else {
          feeTok.textContent = '↳ fee funds JB #' + String(FEE_BENEFICIARY_PROJECT_ID) + ' (protocol project)';
        }
      }).catch(function () {
        if (seq !== previewSeq) return;
        feeTok.textContent = '↳ fee funds JB #' + String(FEE_BENEFICIARY_PROJECT_ID) + ' (protocol project)';
      });
    }

    // Breakdown — the bonding-curve inputs the payout is derived from: total supply (the denominator,
    // aggregated across chains for omnichain projects), the project's total surplus across all tokens, and
    // the cash-out tax. reclaim = surplus × share × ((1 − tax) + tax × share), where share = count / supply.
    var count2; try { count2 = parseAmount(amt.value, 18); } catch (_) { count2 = 0n; }
    if (state.aggSupply != null && state.aggSupply > 0n && count2 > 0n) {
      var multi = (state.aggChains || 1) > 1;
      var bd = el('div', 'ops-cash-breakdown');
      var bh = el('div', 'ops-cash-bd-head'); bh.textContent = 'How this is calculated'; bd.appendChild(bh);
      function bdRow(k, val) { var r = el('div', 'ops-cash-bd-row'); var kk = el('span'); kk.textContent = k; var vv = el('span'); vv.textContent = val; r.appendChild(kk); r.appendChild(vv); bd.appendChild(r); }
      var sharePct = Number(count2) / Number(state.aggSupply) * 100;
      bdRow('Cash out tax', ((state.cashOutTaxRate || 0) / 100) + '%');
      bdRow('Total supply' + (multi ? ' (' + state.aggChains + ' chains)' : ''), formatTokens(state.aggSupply) + ' ' + sym);
      bdRow(a.symbol + ' surplus' + (multi ? ' (' + state.aggChains + ' chains)' : ''), formatBalance(state.aggSurplus || 0n, a.decimals, a.symbol));
      bdRow('You’re cashing out', formatTokens(count2) + ' ' + sym + ' (' + (Math.round(sharePct * 100) / 100) + '%)');
      var formula = el('div', 'ops-cash-bd-formula'); formula.textContent = 'reclaim = surplus × share × ((1 − tax) + tax × share)'; bd.appendChild(formula);
      preview.appendChild(bd);
    }
  }
  amt.addEventListener('input', updatePreview);
  onChainChange();
  loadBalanceTable();
  // Multi-token projects: offer a reclaim-token picker (default to the primary), then re-resolve.
  acctKindsForFunds(project).then(function (kinds) {
    state.kinds = kinds;
    if (kinds && kinds.length > 1) {
      reclaimSel.innerHTML = '';
      kinds.forEach(function (k) { var o = document.createElement('option'); o.value = k.key; o.textContent = k.symbol; reclaimSel.appendChild(o); });
      state.reclaimKey = kinds[0].key; reclaimSel.value = state.reclaimKey;
      reclaimWrap.style.display = 'inline-flex';
      onChainChange();
    }
  }).catch(function () {});

  btn.addEventListener('click', function () {
    var acct = getAccount && getAccount();
    if (!acct) { connect(); return; }
    var count; try { count = parseAmount(amt.value, 18); } catch (_) { status.textContent = 'Invalid amount'; return; }
    if (count === 0n) { status.textContent = 'Enter an amount'; return; }
    if (state.locked) { status.textContent = 'Cash outs are not unlocked yet'; return; }
    var terminal = getAddress('JBMultiTerminal', state.chainId);
    if (!terminal) { status.textContent = 'No terminal on this chain'; return; }
    // Slippage floor under the previewed NET payout. The terminal checks `minTokensReclaimed` against the
    // post-everything amount: bonding curve → REVOwner's 2.5% revnet fee (via the data hook) → the 2.5%
    // protocol fee. `state.net` mirrors all of that (from previewCashOutFrom). Using the raw curve reclaim
    // here was the bug that reverted cash-outs. 1% buffer when exact; 5% on a fallback estimate.
    var bps = state.exact === false ? 9500n : 9900n;
    var minReclaimed = state.net != null ? state.net * bps / 10000n : 0n;
    var reclaimToken = (state.acct && state.acct.address) || NATIVE_TOKEN; // cash out in the accounting token
    btn.disabled = true; status.textContent = '';
    // Snapshot what the user is cashing out + the previewed outcome, for the success panel.
    var outCount = count;
    var outcome = state.outcome ? Object.assign({}, state.outcome) : { net: state.net, sym: (state.acct && state.acct.symbol) || 'ETH', decimals: (state.acct && state.acct.decimals) || 18 };
    executeTransaction({
      chainId: state.chainId, address: terminal, abi: cashOutTokensAbi, functionName: 'cashOutTokensOf',
      args: [acct, pid, count, reclaimToken, minReclaimed, acct, '0x'],
      onStatus: function (m, kind) { status.classList.toggle('pending', kind === 'pending'); status.textContent = m; },
      onSuccess: function (m, meta) { renderCashSuccess(outCount, outcome, meta); },
      onError: function (m) { status.classList.remove('pending'); status.textContent = m; btn.disabled = false; },
    });
  });

  // Replace the form with a satisfying summary of what landed: tokens burned, value received, and the
  // fee-revnet / fee-project tokens minted in return. Closes via "Done" (or the modal's ✕).
  function renderCashSuccess(count, o, meta) {
    var done = el('div', 'cashout-success');
    var title = el('div', 'cashout-success-title');
    title.textContent = 'Cashed out';
    done.appendChild(title);

    var burned = el('div', 'cashout-success-sub');
    burned.textContent = 'You cashed out ' + formatTokens(count) + ' ' + sym + '.';
    done.appendChild(burned);

    var recvLbl = el('div', 'cashout-success-reclbl'); recvLbl.textContent = 'You received';
    done.appendChild(recvLbl);
    var recv = el('div', 'cashout-success-amount');
    recv.textContent = formatBalance(o.net, o.decimals || 18, o.sym || 'ETH');
    done.appendChild(recv);

    // Bonus tokens minted from the two fees.
    var extras = [];
    if (o.revToken) extras.push('+ ' + formatTokens(o.revToken.amount) + ' ' + o.revToken.sym + ' (revnet #' + o.revToken.id + ')');
    if (o.protoToken) extras.push('+ ' + formatTokens(o.protoToken.amount) + ' ' + o.protoToken.sym + ' (JB #' + String(FEE_BENEFICIARY_PROJECT_ID) + ')');
    extras.forEach(function (t) { var e = el('div', 'cashout-success-extra'); e.textContent = t; done.appendChild(e); });

    if (meta && meta.hash) {
      var txRow = el('div', 'cashout-success-tx');
      txRow.appendChild(renderExplorerTxLink(state.chainId, meta.hash, 'View transaction ↗'));
      done.appendChild(txRow);
    }

    var foot = el('div', 'modal-foot');
    var doneBtn = el('button', 'modal-submit'); doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', function () { if (requestClose) requestClose(); });
    foot.appendChild(doneBtn);
    done.appendChild(foot);

    wrap.innerHTML = '';
    wrap.appendChild(done);
  }
  return wrap;
}

// REVLoans fee constants (REVLoans.sol). Percents are in MAX_FEE=1000 units (25 = 2.5%).
var LOAN_MIN_PREPAID = 25, LOAN_MAX_PREPAID = 500, LOAN_LIQ_DAYS = 3650, LOAN_MAX_FEE = 1000;

// Human label for when the time-based fee starts (the prepaid window): p/500 of the 10-year liquidation span.
function loanPrepaidDurationLabel(p) {
  var days = p * LOAN_LIQ_DAYS / LOAN_MAX_PREPAID;
  if (days >= LOAN_LIQ_DAYS) return 'never';
  if (days >= 365) { var y = Math.round((days / 365) * 10) / 10; return y + (y === 1 ? ' year' : ' years'); }
  if (days >= 60) { var m = Math.round(days / 30.4); return m + ' months'; }
  return Math.round(days) + ' days';
}

var LOAN_CHART = { W: 460, H: 168, padL: 30, padR: 12, padT: 12, padB: 28 };

// "Additional cost to unlock" (fraction of borrowed principal) at time t years, for prepaid percent p.
// 0 through the prepaid window (p/500 × 10y), then linear up to (1 − p/1000) at year 10.
function loanFeeFracAt(t, p) {
  var pdY = (p / LOAN_MAX_PREPAID) * 10;
  if (t <= pdY) return 0;
  return (1 - p / LOAN_MAX_FEE) * (t - pdY) / (10 - pdY);
}

// Chart of loanFeeFracAt over the 10-year loan life. Shape is amount-independent so the slider always
// shows the trade-off; ETH numbers live in the summary + hover tooltip.
function renderLoanFeeSvg(p) {
  var W = LOAN_CHART.W, H = LOAN_CHART.H, padL = LOAN_CHART.padL, padR = LOAN_CHART.padR, padT = LOAN_CHART.padT, padB = LOAN_CHART.padB;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var pdY = (p / LOAN_MAX_PREPAID) * 10;     // prepaid window in years
  var maxFrac = 1 - p / LOAN_MAX_FEE;        // peak additional cost as a fraction of principal
  var X = function (yr) { return padL + (yr / 10) * plotW; };
  var Y = function (frac) { return padT + (1 - frac) * plotH; };
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="loan-fee-svg" role="img" aria-label="Additional cost to unlock over time">';
  for (var yr = 0; yr <= 10; yr++) {
    s += '<line x1="' + X(yr).toFixed(1) + '" y1="' + padT + '" x2="' + X(yr).toFixed(1) + '" y2="' + (padT + plotH) + '" stroke="rgba(0,0,0,0.1)" stroke-width="0.6" stroke-dasharray="2 3"/>';
  }
  s += '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#7d6858" stroke-width="1"/>';
  s += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" stroke="#7d6858" stroke-width="1"/>';
  if (pdY > 0.02 && pdY < 9.98) s += '<line x1="' + X(pdY).toFixed(1) + '" y1="' + padT + '" x2="' + X(pdY).toFixed(1) + '" y2="' + (padT + plotH) + '" stroke="#b8602e" stroke-width="1" stroke-dasharray="3 2" opacity="0.55"/>';
  s += '<path d="M' + X(0).toFixed(1) + ',' + Y(0).toFixed(1) + ' L' + X(pdY).toFixed(1) + ',' + Y(0).toFixed(1) + ' L' + X(10).toFixed(1) + ',' + Y(maxFrac).toFixed(1) + '" fill="none" stroke="#b8602e" stroke-width="2"/>';
  for (var xl = 0; xl <= 10; xl += 2) {
    s += '<text x="' + X(xl).toFixed(1) + '" y="' + (padT + plotH + 13) + '" font-size="9" fill="#7d6858" text-anchor="middle">' + xl + '</text>';
  }
  s += '<text x="' + (padL + plotW / 2).toFixed(1) + '" y="' + (H - 2) + '" font-size="9" fill="#7d6858" text-anchor="middle">Time (years)</text>';
  s += '</svg>';
  return s;
}

function buildLoanModal(project, requestClose) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'modal-body');
  var state = { chainId: (project.chains && project.chains[0] && project.chains[0].id) || project.chainId, balance: null, prepaidFee: LOAN_MIN_PREPAID, acct: null, loanOut: null };
  // Loans are denominated in the base currency (USD/ETH) and disbursed in the accounting token (USDC/ETH).
  var baseLbl = baseUnitLabel(project);
  var baseCur = BigInt((project.metadata && project.metadata.baseCurrency) || 1);
  function fmtBorrow(v) { return formatBalance(v, 18, baseLbl); }

  var clbl = el('div', 'modal-label'); clbl.textContent = 'Collateral'; wrap.appendChild(clbl);
  var lbl = el('div', 'modal-balance'); lbl.textContent = 'How much ' + sym + ' do you want to collateralize?'; wrap.appendChild(lbl);
  var bal = el('div', 'modal-balance'); wrap.appendChild(bal);

  // Chain selector on its own row above the amount (with per-chain balances).
  var chainRow = el('div', 'ops-chainrow');
  var chainSel = opsChainSelect(project, function (cid) { state.chainId = cid; refreshBalance(); }, { withBalance: true });
  chainRow.appendChild(chainSel);
  wrap.appendChild(chainRow);

  var inRow = el('div', 'ops-inrow');
  var field = el('div', 'ops-field');
  var amt = el('input', 'ops-amount'); amt.type = 'number'; amt.placeholder = '0.00'; field.appendChild(amt);
  var unit = el('span', 'ops-unit'); unit.textContent = sym; field.appendChild(unit);
  inRow.appendChild(field);
  wrap.appendChild(inRow);
  wrap.appendChild(opsPercentButtons(amt, function () { return state.balance; }));

  var preview = el('div', 'ops-preview'); wrap.appendChild(preview);

  // ── Variable fee structure: prepaid-fee slider + cost-over-time chart ──
  var feeSec = el('div', 'loan-section');
  var feeHead = el('div', 'loan-section-head');
  var feeT = el('span'); feeT.textContent = 'Variable fee structure'; feeHead.appendChild(feeT);
  var feeCaret = el('span', 'loan-caret'); feeCaret.textContent = '▶'; feeHead.appendChild(feeCaret);
  feeSec.appendChild(feeHead);
  var feeBody = el('div', 'loan-section-body'); feeBody.style.display = 'none'; feeSec.appendChild(feeBody);
  feeHead.addEventListener('click', function () { var open = feeBody.style.display !== 'none'; feeBody.style.display = open ? 'none' : ''; feeCaret.textContent = open ? '▶' : '▼'; });

  var prepaidLbl = el('div', 'loan-prepaid-label'); feeBody.appendChild(prepaidLbl);
  var slider = el('input', 'loan-slider'); slider.type = 'range'; slider.min = String(LOAN_MIN_PREPAID); slider.max = String(LOAN_MAX_PREPAID); slider.step = '5'; slider.value = String(state.prepaidFee);
  // Drive the orange "filled" portion (left of the thumb) via a CSS var the track gradient reads.
  function syncSliderFill() {
    var pct = (Number(slider.value) - LOAN_MIN_PREPAID) / (LOAN_MAX_PREPAID - LOAN_MIN_PREPAID) * 100;
    slider.style.setProperty('--loan-pct', pct + '%');
  }
  syncSliderFill();
  feeBody.appendChild(slider);
  var sLabels = el('div', 'loan-slider-labels'); var s1 = el('span'); s1.textContent = 'Less upfront cost'; var s2 = el('span'); s2.textContent = 'More upfront cost'; sLabels.appendChild(s1); sLabels.appendChild(s2); feeBody.appendChild(sLabels);
  var chartHolder = el('div', 'loan-fee-chart');
  var svgWrap = el('div', 'loan-fee-svgwrap'); chartHolder.appendChild(svgWrap);
  var cursor = el('div', 'loan-fee-cursor'); var dot = el('div', 'loan-fee-dot'); var tip = el('div', 'loan-fee-tip');
  cursor.style.display = dot.style.display = tip.style.display = 'none';
  chartHolder.appendChild(cursor); chartHolder.appendChild(dot); chartHolder.appendChild(tip);
  feeBody.appendChild(chartHolder);
  var feeCaption = el('div', 'loan-fee-caption'); feeBody.appendChild(feeCaption);
  wrap.appendChild(feeSec);

  function updateFeeViz() {
    var p = state.prepaidFee;
    var amtStr = '';
    if (state.borrowable && state.borrowable > 0n) amtStr = ' | ~' + fmtBorrow(state.borrowable * BigInt(p) / BigInt(LOAN_MAX_FEE)) + ' now';
    prepaidLbl.textContent = 'Prepaid fee: ' + (p / 10) + '%' + amtStr;
    svgWrap.innerHTML = renderLoanFeeSvg(p);
    feeCaption.textContent = p >= LOAN_MAX_PREPAID ? 'Fully prepaid — no additional cost over time.' : ('Fees increase after ' + loanPrepaidDurationLabel(p) + '.');
  }
  slider.addEventListener('input', function () { state.prepaidFee = Number(slider.value); syncSliderFill(); updateFeeViz(); updateSummary(); });

  // Hover: explain what's owed to unlock at the hovered point in time.
  function onChartMove(e) {
    var svg = svgWrap.querySelector('svg'); if (!svg) return;
    var rect = svg.getBoundingClientRect(); var G = LOAN_CHART;
    var plotH = G.H - G.padT - G.padB;
    var plotL = rect.left + (G.padL / G.W) * rect.width, plotR = rect.left + ((G.W - G.padR) / G.W) * rect.width;
    var plotT = rect.top + (G.padT / G.H) * rect.height, plotB = rect.top + ((G.padT + plotH) / G.H) * rect.height;
    var cx = Math.max(plotL, Math.min(plotR, e.clientX));
    var t = (cx - plotL) / (plotR - plotL) * 10;
    var p = state.prepaidFee, frac = loanFeeFracAt(t, p), pdY = (p / LOAN_MAX_PREPAID) * 10;
    var cy = plotB - frac * (plotB - plotT);
    var hr = chartHolder.getBoundingClientRect();
    cursor.style.display = ''; cursor.style.left = (cx - hr.left) + 'px'; cursor.style.top = (plotT - hr.top) + 'px'; cursor.style.height = (plotB - plotT) + 'px';
    dot.style.display = ''; dot.style.left = (cx - hr.left) + 'px'; dot.style.top = (cy - hr.top) + 'px';
    var head = '<div class="loan-fee-tip-t">Year ' + t.toFixed(1) + '</div>';
    var bodyTxt;
    if (t <= pdY) {
      bodyTxt = 'Prepaid window — repay just the principal, no extra fee to unlock.';
    } else {
      var amt = (state.borrowable && state.borrowable > 0n) ? (' | ~' + fmtBorrow(state.borrowable * BigInt(Math.round(frac * 1e6)) / 1000000n)) : '';
      bodyTxt = 'Extra fee to unlock: ' + (frac * 100).toFixed(1) + '% of your borrow' + amt;
    }
    tip.innerHTML = head + '<div>' + bodyTxt + '</div>';
    tip.style.display = '';
    tip.style.left = Math.max(2, Math.min((cx - hr.left) + 10, hr.width - tip.offsetWidth - 2)) + 'px';
    tip.style.top = (plotT - hr.top + 2) + 'px';
  }
  chartHolder.addEventListener('mousemove', onChartMove);
  chartHolder.addEventListener('mouseleave', function () { cursor.style.display = 'none'; dot.style.display = 'none'; tip.style.display = 'none'; });

  // ── Summary: computed loan terms + the things to know ──
  var summary = el('div', 'loan-summary'); wrap.appendChild(summary);
  var feeTokSeq = 0;
  function summaryRow(k, v, cls) { var r = el('div', 'loan-summary-row' + (cls ? ' ' + cls : '')); var ks = el('span', 'loan-summary-k'); ks.textContent = k; var vs = el('span', 'loan-summary-v'); vs.textContent = v; r.appendChild(ks); r.appendChild(vs); return r; }
  function feeTokRow() { var r = el('div', 'loan-summary-feetok'); summary.appendChild(r); return r; }
  function updateSummary() {
    summary.innerHTML = '';
    var seq = ++feeTokSeq;
    var collateral; try { collateral = parseAmount(amt.value, 18); } catch (_) { collateral = 0n; }
    var p = state.prepaidFee;
    if (state.borrowable && state.borrowable > 0n) {
      var gross = state.borrowable;
      // Opening a loan disburses via the terminal (2.5% protocol fee → JB #1), then deducts the 1% REV fee
      // (→ the $REV revnet) and the chosen prepaid source fee. The borrower receives what's left now.
      var protocolFee = gross / 40n;                                             // 2.5% via useAllowanceOf
      var revFee = gross * BigInt(LOAN_REV_FEE_PERCENT) / BigInt(LOAN_MAX_FEE);   // 1%
      var sourceFee = gross * BigInt(p) / BigInt(LOAN_MAX_FEE);                   // prepaid source fee (now)
      var net = gross - protocolFee - revFee - sourceFee;
      // Snapshot for the success panel (token amounts fill in as their previews resolve).
      state.loanOut = { net: net, sym: baseLbl, collateral: collateral, protoTok: null, revTok: null, src: null };

      summary.appendChild(summaryRow('You borrow', '~ ' + fmtBorrow(gross)));
      summary.appendChild(summaryRow('2.5% protocol fee', '~ ' + fmtBorrow(protocolFee)));
      var protoTok = feeTokRow();
      summary.appendChild(summaryRow('1% revnet fee', '~ ' + fmtBorrow(revFee)));
      var revTok = feeTokRow();
      summary.appendChild(summaryRow((p / 10) + '% prepaid source fee (now)', '~ ' + fmtBorrow(sourceFee)));
      var srcTok = feeTokRow();
      summary.appendChild(summaryRow('You receive now', '~ ' + fmtBorrow(net), 'loan-summary-net'));
      summary.appendChild(summaryRow('Later unlock fee', 'grows after ' + loanPrepaidDurationLabel(p) + ', up to ~ ' + fmtBorrow(gross - sourceFee) + ' by year 10'));

      // Each fee pays into a project on the borrower's behalf, minting that project's token to them:
      // protocol fee → JB #1, REV fee → the $REV revnet, source fee → THIS revnet (its own token).
      // Native-ETH only — base == disbursed token there; for USDC the base→token conversion isn't 1:1.
      var acct = state.acct || { address: NATIVE_TOKEN, decimals: 18 };
      var isNative = (acct.address || NATIVE_TOKEN) === NATIVE_TOKEN;
      if (isNative) {
        var who = (getAccount && getAccount()) || undefined;
        var cid = state.chainId;
        // Resolve the token amount each fee mints, then label the row. `id` may be a promise (REV id).
        function fillTok(row, feeAmt, idP, symP, label, onAmount) {
          if (feeAmt <= 0n) { row.textContent = ''; return; }
          row.textContent = '↳ minting ' + label + ' to you…';
          Promise.resolve(idP).then(function (id) {
            if (seq !== feeTokSeq) return;
            if (id == null) { row.textContent = ''; return; }
            return Promise.all([feeTokenEstimate(cid, id, NATIVE_TOKEN, feeAmt, who), Promise.resolve(symP).then(function (s) { return s; })]).then(function (r) {
              if (seq !== feeTokSeq) return;
              var got = r[0], tsym = r[1] || 'tokens';
              if (got && got > 0n) {
                row.textContent = '↳ get ~ ' + formatTokens(got) + ' ' + tsym + ' in ' + label + ' for the fee';
                if (onAmount) onAmount(got, tsym);
              } else { row.textContent = '↳ fee funds ' + label; }
            });
          }).catch(function () { if (seq === feeTokSeq) row.textContent = ''; });
        }
        fillTok(protoTok, protocolFee, FEE_BENEFICIARY_PROJECT_ID, projectTokenSymbol(cid, FEE_BENEFICIARY_PROJECT_ID), 'JB #' + String(FEE_BENEFICIARY_PROJECT_ID), function (got, tsym) { if (state.loanOut) state.loanOut.protoTok = { amount: got, sym: tsym, id: String(FEE_BENEFICIARY_PROJECT_ID) }; });
        loanRevIdOf(cid).then(function (rid) {
          if (seq !== feeTokSeq || rid == null) { if (seq === feeTokSeq) revTok.textContent = ''; return; }
          fillTok(revTok, revFee, rid, projectTokenSymbol(cid, rid), 'revnet #' + String(rid), function (got, tsym) { if (state.loanOut) state.loanOut.revTok = { amount: got, sym: tsym, id: String(rid) }; });
        });
        // Source fee mints THIS revnet's token (same token as the burned collateral), so it nets against
        // the collateral — mirror the wallet, which shows a single net `−(collateral − sourceMint)` change.
        if (sourceFee > 0n) {
          srcTok.textContent = '↳ minting ' + sym + ' back to you…';
          feeTokenEstimate(cid, BigInt(project.id), NATIVE_TOKEN, sourceFee, who).then(function (got) {
            if (seq !== feeTokSeq) return;
            if (got && got > 0n) {
              var netColl = collateral > got ? collateral - got : 0n;
              srcTok.textContent = '↳ get ~ ' + formatTokens(got) + ' ' + sym + ' back → net ' + formatTokens(netColl) + ' ' + sym + ' collateral out';
              if (state.loanOut) state.loanOut.src = { got: got, netColl: netColl };
            } else { srcTok.textContent = '↳ fee funds this revnet'; }
          }).catch(function () { if (seq === feeTokSeq) srcTok.textContent = ''; });
        }
      }
    }
    var bl = el('ul', 'loan-summary-bullets');
    [(collateral > 0n ? formatTokenCount(collateral) : 'Your') + ' ' + sym + ' is burned as collateral while the loan is open.',
     'You receive an NFT to reclaim it when you repay.',
     'After 10 years the loan is liquidated and the collateral is lost.',
     'First-time loans need a one-off approval to let the loan contract burn your collateral.'].forEach(function (t) {
      var li = document.createElement('li'); li.textContent = t; bl.appendChild(li);
    });
    summary.appendChild(bl);
  }
  updateFeeViz();
  updateSummary();

  var status = el('div', 'modal-status'); wrap.appendChild(status);
  var foot = el('div', 'modal-foot');
  var btn = document.createElement('button'); btn.className = 'modal-submit'; btn.textContent = 'Open loan';
  foot.appendChild(btn); wrap.appendChild(foot);

  var pid = BigInt(project.id);
  function refreshBalance() {
    bal.textContent = 'Your balance: …';
    readUserBalance(project, state.chainId).then(function (b) {
      state.balance = b;
      bal.textContent = b == null ? 'Connect a wallet to see your balance.' : ('Your balance: ' + formatTokens(b) + ' ' + sym);
    });
  }
  var previewSeq = 0;
  function updatePreview() {
    var collateral; try { collateral = parseAmount(amt.value, 18); } catch (_) { collateral = 0n; }
    if (!collateral || collateral === 0n) { preview.textContent = ''; state.borrowable = null; updateSummary(); return; }
    var loans = getAddress('REVLoans', state.chainId);
    if (!loans) { preview.textContent = ''; return; }
    var seq = ++previewSeq; preview.textContent = 'Calculating…';
    read(state.chainId, 'REVLoans', borrowableAbi, 'borrowableAmountFrom', [pid, collateral, 18n, baseCur])
      .then(function (r) {
        if (seq !== previewSeq) return;
        var b = Array.isArray(r) ? r[0] : r;
        state.borrowable = toBigInt(b);
        // borrowableAmountFrom returns 0 for ALL collateral while the revnet's cash-out delay is still in
        // effect (REVLoans gates loans on it) — so a 0 here means loans are time-locked, not "too little".
        preview.textContent = state.borrowable > 0n
          ? 'You’ll borrow ~ ' + fmtBorrow(state.borrowable)
          : 'Nothing borrowable yet — loans unlock after this revnet’s cash-out delay passes.';
        updateFeeViz(); updateSummary();
      }).catch(function () { if (seq === previewSeq) { preview.textContent = ''; state.borrowable = null; updateFeeViz(); updateSummary(); } });
  }
  amt.addEventListener('input', updatePreview);
  function onChainChange() {
    refreshBalance(); updatePreview();
    state.acct = null;
    if (getAddress('JBMultiTerminal', state.chainId)) resolveAcctToken(state.chainId, pid).then(function (a) { state.acct = a; });
  }
  onChainChange();

  btn.addEventListener('click', function () {
    var acct = getAccount && getAccount();
    if (!acct) { connect(); return; }
    var collateral; try { collateral = parseAmount(amt.value, 18); } catch (_) { status.textContent = 'Invalid amount'; return; }
    if (collateral === 0n) { status.textContent = 'Enter an amount'; return; }
    if (state.borrowable === 0n) { status.textContent = 'Nothing borrowable yet — loans are locked until this revnet’s cash-out delay passes.'; return; }
    var loans = getAddress('REVLoans', state.chainId);
    var perms = getAddress('JBPermissions', state.chainId);
    if (!loans || !perms) { status.textContent = 'Loans not available on this chain'; return; }
    btn.disabled = true; status.textContent = '';
    var onStatus = function (m, kind) { status.classList.toggle('pending', kind === 'pending'); status.textContent = m; };
    var fail = function (m) { status.classList.remove('pending'); status.textContent = m; btn.disabled = false; };

    // token = native, minBorrowAmount 0 (best price), prepaidFeePercent from the slider, holder/beneficiary = caller.
    function doBorrow(approved) {
      var loanToken = (state.acct && state.acct.address) || NATIVE_TOKEN; // disburse in the accounting token
      // No slippage floor: REVLoans checks minBorrowAmount against the GROSS borrow in the SOURCE token's
      // decimals/currency (REVLoans.sol:517-527,1383), but our `state.borrowable` preview is in the BASE
      // currency at 18 decimals (borrowableAmountFrom(…, 18n, baseCur), :12108). Those scales differ for a
      // 6-dec USDC source (floor always reverts) and whenever base ≠ source-token currency. A correct floor
      // needs borrowableAmountFrom read in the source token's own decimals+currency — follow-up; until then 0.
      var minBorrow = 0n;
      executeTransaction(Object.assign(buildBorrowArgs({
        chainId: state.chainId, loansAddr: loans, revnetId: pid, token: loanToken, minBorrow: minBorrow,
        collateral: collateral, beneficiary: acct, prepaidFeePercent: state.prepaidFee, holder: acct,
      }), {
        confirmTitle: approved ? 'Open loan — step 2 of 2' : 'Open loan',
        confirmText: 'Open loan',
        confirmNote: approved ? 'Approval done. This second transaction opens the loan — it burns your ' + sym + ' collateral and sends you the funds.' : undefined,
        onStatus: onStatus, onError: fail,
        onSuccess: function (m, meta) { refreshBalance(); document.dispatchEvent(new CustomEvent('jb:bridge-updated')); renderLoanSuccess(collateral, state.loanOut, meta); },
      }));
    }

    // Opening a loan burns the collateral via the controller, so REVLoans needs BURN_TOKENS on the holder.
    // Grant it once (if missing) before borrowing — otherwise borrowFrom reverts. Make the two-step nature
    // explicit so the approval tx isn't mistaken for the loan itself.
    onStatus('Checking approval…', 'pending');
    read(state.chainId, 'JBPermissions', jbHasPermissionAbi, 'hasPermission', [loans, acct, pid, BigInt(JB_PERMISSION_BURN_TOKENS), true, false])
      .then(function (has) {
        if (has) { doBorrow(false); return; }
        status.classList.remove('pending');
        status.textContent = 'First-time loan: this needs 2 transactions — a one-off approval, then the loan.';
        executeTransaction({
          chainId: state.chainId, address: perms, abi: jbSetPermissionsAbi, functionName: 'setPermissionsFor',
          args: [acct, { operator: loans, projectId: pid, permissionIds: [JB_PERMISSION_BURN_TOKENS] }],
          confirmTitle: 'Approve the loan contract — step 1 of 2',
          confirmText: 'Approve',
          confirmNote: 'This is NOT the loan yet. First-time loans need a one-off approval letting the loan contract burn your ' + sym + ' collateral. After you sign this, a second transaction will open the loan and send you the funds.',
          onStatus: function (m, kind) { onStatus(m === 'Awaiting wallet confirmation...' ? 'Step 1 of 2 — approve the loan contract…' : m, kind); },
          onError: fail,
          onSuccess: function () { onStatus('Approved — now confirm step 2 to open the loan…', 'pending'); doBorrow(true); },
        });
      }).catch(function () { doBorrow(false); }); // if the permission read fails, attempt the borrow (it will revert clearly if truly unauthorized)
  });

  // Replace the form with a summary of what landed: the funds received, the loan NFT, the fee-minted
  // tokens, and the net collateral burned. Closes via "Done" (or the modal's ✕).
  function renderLoanSuccess(collateral, o, meta) {
    o = o || {};
    var done = el('div', 'cashout-success');
    var title = el('div', 'cashout-success-title'); title.textContent = 'Loan opened'; done.appendChild(title);
    var sub = el('div', 'cashout-success-sub');
    sub.textContent = (collateral > 0n ? formatTokens(collateral) : 'Your') + ' ' + sym + ' is now collateral — repay anytime to reclaim it.';
    done.appendChild(sub);

    var recvLbl = el('div', 'cashout-success-reclbl'); recvLbl.textContent = 'You received'; done.appendChild(recvLbl);
    var recv = el('div', 'cashout-success-amount');
    recv.textContent = o.net != null ? fmtBorrow(o.net) : 'your loan';
    done.appendChild(recv);

    var extras = [];
    if (o.protoTok) extras.push('+ ' + formatTokens(o.protoTok.amount) + ' ' + o.protoTok.sym + ' (JB #' + o.protoTok.id + ')');
    if (o.revTok) extras.push('+ ' + formatTokens(o.revTok.amount) + ' ' + o.revTok.sym + ' (revnet #' + o.revTok.id + ')');
    if (o.src) extras.push('+ ' + formatTokens(o.src.got) + ' ' + sym + ' back → net ' + formatTokens(o.src.netColl) + ' ' + sym + ' collateral out');
    extras.push('a loan NFT to reclaim your collateral when you repay');
    extras.forEach(function (t) { var e = el('div', 'cashout-success-extra'); e.textContent = t; done.appendChild(e); });

    if (meta && meta.hash) {
      var txRow = el('div', 'cashout-success-tx');
      txRow.appendChild(renderExplorerTxLink(state.chainId, meta.hash, 'View transaction ↗'));
      done.appendChild(txRow);
    }
    var foot = el('div', 'modal-foot');
    var doneBtn = el('button', 'modal-submit'); doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', function () { if (requestClose) requestClose(); });
    foot.appendChild(doneBtn); done.appendChild(foot);

    wrap.innerHTML = '';
    wrap.appendChild(done);
  }
  return wrap;
}

// Repay an open loan: reads the exact on-chain loan + current source fee, repays principal + fee and
// reclaims all collateral. Native (ETH) loans pay via msg.value (excess auto-refunded by REVLoans); the
// arg `maxRepayBorrowAmount` is ignored for native, so a small buffer over the fee covers per-second drift.
function buildRepayModal(project, loanRow, requestClose) {
  var sym = project.tokenSymbol || 'tokens';
  var baseLbl = baseUnitLabel(project);
  var pid = BigInt(project.id);
  var chainId = Number(loanRow.chainId) || project.chainId;
  var loanId = BigInt(loanRow.id);
  var wrap = el('div', 'modal-body');
  var info = el('div', 'detail-card-body'); info.textContent = 'Reading loan…'; wrap.appendChild(info);
  var status = el('div', 'modal-status'); wrap.appendChild(status);
  var foot = el('div', 'modal-foot');
  var btn = el('button', 'modal-submit'); btn.textContent = 'Repay loan'; btn.disabled = true;
  foot.appendChild(btn); wrap.appendChild(foot);

  var st = { principal: null, fee: 0n, collateral: null, sourceToken: NATIVE_TOKEN };
  function fmt(v) { return formatBalance(v, 18, baseLbl); }

  var loans = getAddress('REVLoans', chainId);
  Promise.all([
    loans ? clientFor(chainId).readContract({ address: loans, abi: loanOfAbi, functionName: 'loanOf', args: [loanId] }).catch(function () { return null; }) : Promise.resolve(null),
  ]).then(function (r) {
    var loan = r[0];
    if (!loan) { info.textContent = 'Could not read this loan.'; return; }
    st.principal = toBigInt(loan.amount); st.collateral = toBigInt(loan.collateral); st.sourceToken = loan.sourceToken;
    return clientFor(chainId).readContract({ address: loans, abi: determineSourceFeeAbi, functionName: 'determineSourceFeeAmount', args: [loan, loan.amount] })
      .then(function (f) { st.fee = toBigInt(f); }).catch(function () { st.fee = loanOutstandingFee(loanRow, Math.floor(Date.now() / 1000)) || 0n; });
  }).then(function () {
    if (st.principal == null) return;
    var total = st.principal + st.fee;
    info.innerHTML = '';
    info.className = '';
    function row(k, v, cls) { var d = el('div', 'loan-summary-row' + (cls ? ' ' + cls : '')); var a = el('span', 'loan-summary-k'); a.textContent = k; var b = el('span', 'loan-summary-v'); b.textContent = v; d.appendChild(a); d.appendChild(b); return d; }
    var s = el('div', 'loan-summary'); s.style.marginTop = '0'; s.style.borderTop = 'none'; s.style.paddingTop = '0';
    s.appendChild(row('Principal', fmt(st.principal)));
    s.appendChild(row('Outstanding fee', st.fee > 0n ? '+ ' + fmt(st.fee) : '— (within prepaid window)'));
    s.appendChild(row('Total to repay', fmt(total), 'loan-summary-net'));
    s.appendChild(row('Reclaim collateral', formatTokens(st.collateral) + ' ' + sym));
    info.appendChild(s);
    btn.disabled = false;
  });

  btn.addEventListener('click', function () {
    if (st.done) { if (requestClose) requestClose(); return; }
    var acct = getAccount && getAccount();
    if (!acct) { connect(); return; }
    if (st.principal == null) return;
    if ((st.sourceToken || NATIVE_TOKEN) !== NATIVE_TOKEN) { status.textContent = 'Repaying ERC-20 loans isn’t supported here yet — repay from the protocol UI.'; return; }
    // Buffer the fee 2% for per-second drift; excess native is refunded by REVLoans.
    var value = st.principal + st.fee + st.fee / 50n;
    btn.disabled = true; status.textContent = '';
    executeTransaction(Object.assign(buildRepayArgs({
      chainId: chainId, loansAddr: loans, loanId: loanId, maxRepay: value, collateralToReturn: st.collateral, beneficiary: acct, value: value,
    }), {
      confirmTitle: 'Repay loan #' + String(loanId),
      confirmText: 'Repay loan',
      confirmNote: 'Repays the principal + outstanding fee and returns your ' + formatTokens(st.collateral) + ' ' + sym + ' collateral. Any overpayment from fee drift is refunded.',
      onStatus: function (m, kind) { status.classList.toggle('pending', kind === 'pending'); status.textContent = m; },
      onError: function (m) { status.classList.remove('pending'); status.textContent = m; btn.disabled = false; },
      onSuccess: function () {
        status.classList.remove('pending');
        document.dispatchEvent(new CustomEvent('jb:bridge-updated'));
        info.innerHTML = '';
        var ok = el('div', 'cashout-success');
        var t = el('div', 'cashout-success-title'); t.textContent = 'Loan repaid'; ok.appendChild(t);
        var sub = el('div', 'cashout-success-sub'); sub.textContent = 'Your ' + formatTokens(st.collateral) + ' ' + sym + ' collateral is back in your wallet.'; ok.appendChild(sub);
        info.appendChild(ok);
        status.textContent = '';
        st.done = true; btn.textContent = 'Done'; btn.disabled = false;
      },
    }));
  });
  return wrap;
}

// --- Cross-chain bridging (JBSucker). Verified against nana-suckers-v6/src/JBSucker.sol + JBSuckerRegistry.sol. ---
var suckerRegistryBridgeAbi = [
  { type: 'function', name: 'suckerPairsOf', stateMutability: 'view',
    inputs: [{ name: 'projectId', type: 'uint256' }],
    outputs: [{ name: 'pairs', type: 'tuple[]', components: [
      { name: 'local', type: 'address' }, { name: 'remote', type: 'bytes32' }, { name: 'remoteChainId', type: 'uint256' }] }] },
  { type: 'function', name: 'toRemoteFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
var suckerBridgeAbi = [
  { type: 'function', name: 'prepare', stateMutability: 'nonpayable', inputs: [
    { name: 'projectTokenCount', type: 'uint256' }, { name: 'beneficiary', type: 'bytes32' },
    { name: 'minTokensReclaimed', type: 'uint256' }, { name: 'token', type: 'address' }, { name: 'metadata', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'toRemote', stateMutability: 'payable', inputs: [{ name: 'token', type: 'address' }], outputs: [] },
];
// Pure builder for JBSucker.prepare (queue a cross-chain move). `o`: { chainId, sucker, projectTokenCount
// (bigint), beneficiary32 (bytes32), minReclaimed (bigint), termToken (the accounting token bridged),
// metadata (bytes32), approvalToken, approvalAmount }.
export function buildSuckerPrepareArgs(o) {
  return {
    chainId: o.chainId, address: o.sucker, abi: suckerBridgeAbi, functionName: 'prepare', contractName: 'JBSucker',
    args: [o.projectTokenCount, o.beneficiary32, o.minReclaimed || 0n, o.termToken, o.metadata],
    tokenAddr: o.approvalToken, spenderAddr: o.sucker, approvalAmount: o.approvalAmount,
  };
}
// Pure builder for JBSucker.toRemote (ship the queued outbox to the remote chain). `value` = bridge fee.
export function buildSuckerToRemoteArgs(o) {
  return {
    chainId: o.chainId, address: o.sucker, abi: suckerBridgeAbi, functionName: 'toRemote', contractName: 'JBSucker',
    args: [o.termToken], value: o.value || 0n,
  };
}
var erc20BalanceOfAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }];

function moveChainName(cid) { return SHORT_CHAIN_NAME[Number(cid)] || (CHAINS[cid] && CHAINS[cid].name) || ('chain ' + cid); }

// Active sucker pairs for a project on `chainId`: [{ local, remoteChainId }]. Empty on failure.
function readSuckerPairsOf(projectId, chainId) {
  var reg = getAddress('JBSuckerRegistry', chainId);
  if (!reg) return Promise.resolve([]);
  return clientFor(chainId).readContract({ address: reg, abi: suckerRegistryBridgeAbi, functionName: 'suckerPairsOf', args: [BigInt(projectId)] })
    .then(function (pairs) { return (pairs || []).map(function (p) { return { local: p.local, remoteChainId: Number(p.remoteChainId), remote: '0x' + String(p.remote).slice(-40) }; }); })
    .catch(function () { return []; });
}

// CCIP suckers expose CCIP_ROUTER(); native-bridge suckers (OP/Base/Arb) don't (they have OPMESSENGER/
// ARBINBOX). Probe it to label a sucker's bridge infra.
var ccipRouterAbi = [{ type: 'function', name: 'CCIP_ROUTER', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];

// Distinct bridge routes for a project with the infra each uses: [{ a, b, infra: 'CCIP'|'native' }].
// Routes are symmetric, so dedup by the sorted chain pair. Reads the actual deployed suckers (not inferred).
// A sucker routes through CCIP when it exposes a non-zero CCIP_ROUTER; otherwise it's a native bridge.
function classifySuckerInfra(chainId, local) {
  return clientFor(chainId).readContract({ address: local, abi: ccipRouterAbi, functionName: 'CCIP_ROUTER', args: [] })
    .then(function (r) { return (r && String(r).toLowerCase() !== ZERO_ADDRESS) ? 'CCIP' : 'native'; })
    .catch(function () { return 'native'; });
}

function fetchProjectSuckerInfra(project) {
  var chains = (project.chains || []).map(function (c) { return c.id; });
  // Collect every local sucker across all chains. A chain-pair can carry BOTH a native and a CCIP sucker
  // (the native+CCIP cohort wires both on each L1↔L2 pair for redundancy), so a pair is NOT a unique bridge.
  return Promise.all(chains.map(function (C) {
    return readSuckerPairsOf(project.id, C)
      .then(function (pairs) { return pairs.map(function (p) { return { a: C, b: p.remoteChainId, local: p.local }; }); })
      .catch(function () { return []; });
  })).then(function (lists) {
    var all = [];
    lists.forEach(function (l) { all = all.concat(l); });
    // Classify each sucker by whether it routes through CCIP (has CCIP_ROUTER) or is a native bridge.
    return Promise.all(all.map(function (s) {
      return classifySuckerInfra(s.a, s.local).then(function (i) { s.infra = i; return s; });
    }));
  }).then(function (all) {
    // One row per distinct bridge edge: dedup by (sorted pair + infra) so the two chain-side readings of the
    // same edge collapse, but a native edge and a CCIP edge on the same pair both stay.
    var seen = {}, routes = [];
    all.forEach(function (s) {
      var pair = [s.a, s.b].sort(function (x, y) { return x - y; });
      var key = pair.join('-') + ':' + s.infra;
      if (seen[key]) return;
      seen[key] = true;
      routes.push({ a: s.a, b: s.b, infra: s.infra, _lo: pair[0], _hi: pair[1] });
    });
    routes.sort(function (a, b) { return (a._lo - b._lo) || (a._hi - b._hi) || a.infra.localeCompare(b.infra); });
    return routes;
  }).catch(function () { return []; });
}

// Currency symbol for a peer accounting context (currency = uint32(uint160(token))). 61166 = native ETH.
// Symbol for an accounting-context token by ADDRESS (registry records key contexts by token, not currency).
function acctTokenSymbol(addr, decimals) {
  if (!addr || /^0x0+$/.test(addr) || addr.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return 'ETH';
  var lc = addr.toLowerCase();
  for (var k in USDC_BY_CHAIN) { if (USDC_BY_CHAIN[k] && USDC_BY_CHAIN[k].toLowerCase() === lc) return 'USDC'; }
  return decimals === 6 ? 'USDC' : 'tokens';
}
// Registry's aggregated cross-chain accounting: folds every sucker's direct + virtually-known (gossiped)
// records per source chain. The authoritative "what chain A knows" — reads one call instead of per-sucker.
var suckerRegistryAccountsAbi = [{
  type: 'function', name: 'peerChainAccountsOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'exceptChainId', type: 'uint256' }],
  outputs: [{ type: 'tuple[]', components: [
    { name: 'chainId', type: 'uint256' }, { name: 'totalSupply', type: 'uint256' },
    { name: 'contexts', type: 'tuple[]', components: [{ name: 'token', type: 'bytes32' }, { name: 'decimals', type: 'uint8' }, { name: 'surplus', type: 'uint128' }, { name: 'balance', type: 'uint128' }] },
    { name: 'timestamp', type: 'uint256' },
  ] }],
}];

// "Snapshot N ago" age label for a unix timestamp (0 → never).
function snapshotAge(ts) {
  if (!ts) return 'never';
  var s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// What each chain knows about its peers' accounting (supply + balance). Read from the REGISTRY's aggregated
// view (`peerChainAccountsOf`) — NOT individual suckers — because a transitively-gossiped record can live on
// a different sucker than the direct A↔B one (e.g. Ethereum gossiped to Arbitrum lands on Arbitrum's Base
// sucker). The registry folds every sucker's direct + virtually-known records, so it sees the full picture.
function fetchCrossChainKnowledge(project) {
  var chains = (project.chains || []).map(function (c) { return c.id; });
  if (chains.length < 2) return Promise.resolve([]);
  function unpackTs(raw) { var v = toBigInt(raw || 0); return Number(v >> 128n); } // packed (ts<<128|seq) → seconds
  return Promise.all(chains.map(function (C) {
    return readSuckerPairsOf(project.id, C).then(function (p) { return { chain: C, pairs: p || [] }; }).catch(function () { return { chain: C, pairs: [] }; });
  })).then(function (lists) {
    var pairsByChain = {};
    lists.forEach(function (x) { pairsByChain[x.chain] = x.pairs; });
    return Promise.all(lists.map(function (x) {
      var A = x.chain;
      var reg = getAddress('JBSuckerRegistry', A);
      var acctJob = reg
        ? clientFor(A).readContract({ address: reg, abi: suckerRegistryAccountsAbi, functionName: 'peerChainAccountsOf', args: [BigInt(project.id), BigInt(A)] }).catch(function () { return []; })
        : Promise.resolve([]);
      return acctJob.then(function (accts) {
        // Index the registry's aggregated records by source chain.
        var byChain = {};
        (accts || []).forEach(function (a) {
          var cid = Number(a.chainId);
          var balances = (a.contexts || []).map(function (c) {
            var tokenAddr = '0x' + String(c.token).slice(-40);
            return { balance: toBigInt(c.balance), decimals: Number(c.decimals), symbol: acctTokenSymbol(tokenAddr, Number(c.decimals)) };
          });
          byChain[cid] = { supply: toBigInt(a.totalSupply), balances: balances, snapshot: unpackTs(a.timestamp) };
        });
        // One row per peer chain the project spans (so even not-yet-known peers show as "never").
        var peers = chains.filter(function (cid) { return cid !== A; }).map(function (B) {
          var rec = byChain[B] || { supply: 0n, balances: [], snapshot: 0 };
          var bPairs = pairsByChain[B] || [];
          var syncSucker = (bPairs.filter(function (q) { return q.remoteChainId === A; })[0] || {}).local || null;
          return { peerChainId: B, peerName: moveChainName(B), supply: rec.supply, balances: rec.balances, snapshot: rec.snapshot, syncSucker: syncSucker };
        });
        return { chainId: A, name: moveChainName(A), peers: peers };
      });
    }));
  }).catch(function () { return []; });
}

// "Sync from {peer}" — runs syncAccountingData on the PEER's sucker so the peer re-pushes its accounting to
// this chain (refreshes what this chain knows about the peer). Payable AMB fee.
// Gossip syncs land asynchronously over the AMB (minutes). Track in-flight pushes by row key ("A:B" — A
// learns about B) so the row shows "Syncing…" across re-renders until B's fresh snapshot arrives at A.
// In-flight gossip syncs, keyed "projectId:fromChain:peerChain" → unix seconds the push was sent. Persisted
// to localStorage so a page reload keeps showing "Syncing…" until the fresher snapshot lands (the push rides
// the AMB for minutes; an in-memory-only marker was forgotten on refresh). Pruned of entries older than 1h.
var GOSSIP_SYNC_LS = 'jb-gossip-sync-at';
function loadGossipSyncAt() {
  var m; try { m = JSON.parse(localStorage.getItem(GOSSIP_SYNC_LS) || '{}') || {}; } catch (_) { m = {}; }
  var now = Math.floor(Date.now() / 1000), changed = false;
  Object.keys(m).forEach(function (k) { if (!(now - m[k] < 3600)) { delete m[k]; changed = true; } });
  if (changed) saveGossipSyncAt(m);
  return m;
}
function saveGossipSyncAt(m) { try { localStorage.setItem(GOSSIP_SYNC_LS, JSON.stringify(m)); } catch (_) {} }
var _gossipSyncAt = loadGossipSyncAt();
// The msg.value syncAccountingData needs. syncAccountingData forwards msg.value as the bridge TRANSPORT
// payment (no registry fee, unlike toRemote). On a CCIP sucker, value 0 → LINK-fee mode, which pulls LINK
// from the caller via transferFrom (reverts without an approval, or silently spends LINK if one exists) — so
// we MUST send a positive native budget covering CCIP getFee; excess is refunded. Discover it by simulating
// syncAccountingData ITSELF (not toRemote — that reverts when the outbox is empty, the bug a tx-auditor
// caught). Native bridges may accept 0. Returns bigint, or null if no tier simulates cleanly.
async function findSyncValue(chainId, sucker, account) {
  if (!account) return null;
  var data;
  try { data = encodeFunctionData({ abi: suckerSyncAbi, functionName: 'syncAccountingData', args: [] }); } catch (_) { return null; }
  var infra = await classifySuckerInfra(chainId, sucker).catch(function () { return 'native'; });
  var ladder = infra === 'CCIP'
    ? [1000000000000000n, 5000000000000000n, 20000000000000000n, 50000000000000000n, 200000000000000000n, 500000000000000000n]
    : [0n, 1000000000000000n, 10000000000000000n, 50000000000000000n];
  var fundedBalance = 10n ** 21n;
  for (var i = 0; i < ladder.length; i++) {
    try {
      await clientFor(chainId).call({ account: account, to: sucker, data: data, value: ladder[i], stateOverride: [{ address: account, balance: fundedBalance }] });
      return ladder[i];
    } catch (_) { /* insufficient / sim limitation — try a larger budget */ }
  }
  return null;
}
function syncAccountingFromPeer(peerChainId, peerSucker, btn, key, project) {
  var acct = getAccount && getAccount();
  if (!acct) { connect(); return; }
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Syncing…';
  findSyncValue(peerChainId, peerSucker, acct).then(function (fee) {
    // Never send 0 native on a CCIP sucker — that triggers LINK-fee mode (pulls unapproved LINK). Bail instead.
    if (fee == null) { btn.disabled = false; btn.textContent = 'Fee?'; btn.title = 'Could not determine the bridge fee — try again shortly.'; return; }
    executeTransaction({
      chainId: peerChainId, address: peerSucker, abi: suckerSyncAbi, functionName: 'syncAccountingData', contractName: 'JBSucker', value: fee,
      confirmTitle: 'Sync accounting snapshot',
      confirmDescription: 'Pushes ' + moveChainName(peerChainId) + '’s accounting snapshot (and everything it knows about other chains) over the bridge. The value shown is the bridge messaging fee — you pay it to relay the snapshot; excess is refunded.',
      onStatus: function (m, kind, meta) {
        btn.textContent = m === 'Awaiting wallet confirmation...' ? 'Confirm…' : 'Syncing…';
        // Mark "in flight" the moment the tx hits the mempool (not just on confirmation) and re-render so the
        // row shows "Syncing…" immediately and survives a reload while it's still confirming.
        if (meta && meta.phase === 'submitted' && key) {
          _gossipSyncAt[key] = Math.floor(Date.now() / 1000); saveGossipSyncAt(_gossipSyncAt);
          document.dispatchEvent(new CustomEvent('jb:bridge-updated'));
        }
      },
      onError: function () {
        btn.disabled = false; btn.textContent = orig;
        // Cancelled/reverted → clear any in-flight marker so the row doesn't stick on "Syncing…".
        if (key && _gossipSyncAt[key]) { delete _gossipSyncAt[key]; saveGossipSyncAt(_gossipSyncAt); document.dispatchEvent(new CustomEvent('jb:bridge-updated')); }
      },
      onSuccess: function () {
        if (key) { _gossipSyncAt[key] = Math.floor(Date.now() / 1000); saveGossipSyncAt(_gossipSyncAt); }
        document.dispatchEvent(new CustomEvent('jb:bridge-updated'));
        // Re-check a few times so the row clears "Syncing…" once the snapshot lands (no manual refresh needed).
        [30000, 90000, 180000].forEach(function (ms) { setTimeout(function () { document.dispatchEvent(new CustomEvent('jb:bridge-updated')); }, ms); });
      },
    });
  });
}

// Relative staleness of a gossiped snapshot vs the peer's actual current values. Worst of supply/balance.
function gossipStaleness(snapSupply, actualSupply, snapBal, actualBal) {
  function rel(a, b) {
    if (a === 0n && b === 0n) return 0;
    var hi = a > b ? a : b; if (hi === 0n) return 0;
    var d = a > b ? a - b : b - a;
    return Number(d * 10000n / hi) / 10000;
  }
  var worst = Math.max(rel(snapSupply, actualSupply), rel(snapBal, actualBal));
  if (worst === 0) return { level: 'synced', label: 'In sync' };
  if (worst <= 0.05) return { level: 'slight', label: 'Slightly stale' };
  return { level: 'danger', label: 'Stale' };
}

// "Gossip" — its own table (between the settlement table and Bridges): per chain, what it knows about each
// peer's accounting, a freshness status vs the peer's ACTUAL current values, and a Sync button.
function renderGossipSection(project) {
  if ((project.chains || []).length < 2) return null;
  var box = el('div', 'xchain-knowledge');
  var wrap = el('div');
  var desc = el('div', 'detail-card-body');
  desc.textContent = "Each chain's cash out and loan availability depends on knowledge of the project's composition on other chains.";
  wrap.appendChild(desc); wrap.appendChild(box);
  var section = ownersCard('Gossip', wrap);
  var sym = project.tokenSymbol || 'tokens';
  function fill() {
    Promise.all([fetchCrossChainKnowledge(project), fetchOps(project)]).then(function (out) {
      if (!section.isConnected) return;
      var data = out[0], ops = out[1];
      if (!data.some(function (d) { return d.peers.length; })) { section.remove(); return; }
      var actual = {};
      ops.forEach(function (o) { actual[o.id] = o; });
      // Which chains each chain already knows (with a real snapshot). A sync from B re-gossips everything B
      // knows (minus the receiver), so one sync can also cover those — we surface that so the user doesn't
      // pay for redundant syncs.
      var knownByChain = {};
      data.forEach(function (d) { knownByChain[d.chainId] = d.peers.filter(function (p) { return p.snapshot; }).map(function (p) { return p.peerChainId; }); });
      box.innerHTML = '';
      data.forEach(function (d) {
        if (!d.peers.length) return;
        var block = el('div', 'xchain-block');
        var head = el('div', 'xchain-head');
        head.appendChild(chainLogo(d.chainId, d.name));
        var hn = el('span'); hn.textContent = d.name + ' knows'; head.appendChild(hn);
        block.appendChild(head);

        var table = el('div', 'gossip-table');
        var hr = el('div', 'gossip-row gossip-head');
        ['Chain', 'Status', '', 'Supply', 'Balance', 'Snapshot'].forEach(function (h) { var c = el('span', 'gossip-cell'); c.textContent = h; hr.appendChild(c); });
        table.appendChild(hr);

        // Dedup redundant Syncs: a stale peer's sync re-gossips everything it knows (its `extras`), so a chain
        // covered by ANOTHER (syncable) peer's sync doesn't need its own Sync. Only stale rows that will show a
        // Sync contribute coverage. A peer that itself covers others keeps its Sync (avoids mutual-hide).
        var extrasByPeer = {}, coveredByOther = {};
        d.peers.forEach(function (p) {
          var ex = (knownByChain[p.peerChainId] || []).filter(function (cid) { return cid !== d.chainId && cid !== p.peerChainId; });
          extrasByPeer[p.peerChainId] = ex;
          var snapBal0 = p.balances.reduce(function (s, b) { return s + b.balance; }, 0n);
          var a0 = actual[p.peerChainId] || {};
          var st0 = gossipStaleness(p.supply, a0.supply != null ? toBigInt(a0.supply) : 0n, snapBal0, a0.balance != null ? toBigInt(a0.balance) : 0n);
          if (p.syncSucker && st0.level !== 'synced') ex.forEach(function (cid) { coveredByOther[cid] = true; });
        });

        d.peers.forEach(function (p) {
          var snapBal = p.balances.reduce(function (s, b) { return s + b.balance; }, 0n);
          var a = actual[p.peerChainId] || {};
          var st = gossipStaleness(p.supply, a.supply != null ? toBigInt(a.supply) : 0n, snapBal, a.balance != null ? toBigInt(a.balance) : 0n);
          var balStr = p.balances.length ? p.balances.map(function (b) { return formatBalance(b.balance, b.decimals, b.symbol); }).join(' | ') : '0';

          // In-flight sync: a push was sent and the fresher snapshot hasn't landed yet.
          var key = project.id + ':' + d.chainId + ':' + p.peerChainId;
          var syncedAt = _gossipSyncAt[key];
          if (syncedAt && p.snapshot && p.snapshot >= syncedAt) { delete _gossipSyncAt[key]; saveGossipSyncAt(_gossipSyncAt); syncedAt = null; }
          var nowS = Math.floor(Date.now() / 1000);
          var localPending = !!(syncedAt && (nowS - syncedAt) < 1800);

          var row = el('div', 'gossip-row');
          var c0 = el('span', 'gossip-cell gossip-peer');
          c0.appendChild(chainLogo(p.peerChainId, p.peerName));
          c0.appendChild(document.createTextNode(p.peerName));
          var c1 = el('span', 'gossip-cell'); c1.textContent = formatTokens(p.supply);
          var c2 = el('span', 'gossip-cell'); c2.textContent = balStr;
          var c3 = el('span', 'gossip-cell'); c3.textContent = snapshotAge(p.snapshot);
          var c4 = el('span', 'gossip-cell');
          var c5 = el('span', 'gossip-cell gossip-sync-cell');
          // Order: Chain, Status, Sync, then Supply / Balance / Snapshot — so the actionable Status + Sync
          // are visible without scrolling the table on a narrow screen.
          row.appendChild(c0); row.appendChild(c4); row.appendChild(c5);
          row.appendChild(c1); row.appendChild(c2); row.appendChild(c3);
          // Repaint status + sync action for a given pending state. Called once now (cheap, no log scan) and
          // again if the lazy on-chain in-flight check finds a sync mid-flight — so the table never blocks.
          function paint(pending) {
            c4.innerHTML = ''; c5.innerHTML = '';
            if (pending) {
              var pLbl = el('span', 'xchain-status-label xchain-status-label--slight'); pLbl.textContent = 'Syncing…'; pLbl.title = 'A snapshot was pushed and is arriving over the bridge (a few minutes).'; c4.appendChild(pLbl);
            } else {
              var stLbl = el('span', 'xchain-status-label xchain-status-label--' + st.level); stLbl.textContent = st.label; c4.appendChild(stLbl);
            }
            // Redundant when another (syncable) peer's sync already covers this chain AND this row covers
            // nothing itself — then hide its Sync (the covering sync handles it). A covering row keeps its Sync.
            var extras = extrasByPeer[p.peerChainId] || [];
            var redundant = coveredByOther[p.peerChainId] && extras.length === 0;
            // Sync button only when there's drift to reconcile (or a push is mid-flight), and it isn't redundant.
            if (p.syncSucker && (pending || (st.level !== 'synced' && !redundant))) {
              var syncWrap = el('span', 'gossip-sync-wrap');
              var btn = el('button', 'xchain-sync'); btn.textContent = pending ? 'Sent' : 'Sync'; btn.disabled = pending;
              btn.title = pending ? 'Sync in flight — arrives in a few minutes' : ('Run syncAccountingData on ' + p.peerName + ' so it re-pushes its accounting here');
              btn.addEventListener('click', function () { syncAccountingFromPeer(p.peerChainId, p.syncSucker, btn, key, project); });
              syncWrap.appendChild(btn);
              if (!pending && extras.length) {
                var note = el('span', 'gossip-sync-note');
                note.textContent = 'also syncs ' + extras.map(function (cid) { return moveChainName(cid); }).join(', ');
                note.title = 'Syncing ' + p.peerName + ' re-gossips everything it knows, so this one transaction also updates ' + d.name + ' about ' + extras.map(function (cid) { return moveChainName(cid); }).join(', ') + '.';
                syncWrap.appendChild(note);
              }
              c5.appendChild(syncWrap);
            }
          }
          paint(localPending);
          table.appendChild(row);
          // Lazy ON-CHAIN in-flight check (universal, reload-proof) — only for stale rows (an in-sync row
          // can't have a pending sync) and only when not already shown pending. Runs AFTER render, off the
          // critical path, so it never delays the table; patches the row to "Syncing…" if a push is bridging.
          if (!localPending && p.syncSucker && st.level !== 'synced') {
            readLatestSyncSent(p.peerChainId, p.syncSucker).then(function (sent) {
              if (!row.isConnected) return;
              if (sent && sent > (p.snapshot || 0) && (Math.floor(Date.now() / 1000) - sent) < 3600) paint(true);
            });
          }
        });
        block.appendChild(table);
        box.appendChild(block);
      });
    }).catch(function () { if (section.isConnected) section.remove(); });
  }
  box.appendChild(skelOpsTable(['Chain', 'Knows'], 3));
  fill();
  document.addEventListener('jb:bridge-updated', function () { if (section.isConnected) fill(); });
  return section;
}

// { chainId -> { lowercased local sucker address -> remoteChainId } }. Used to relabel the cash-out a
// sucker performs under the hood on prepare() as a bridge in the activity feed (not "cashed out"). MUST be
// keyed by chain: native-bridge suckers share the SAME address on both chains, so a flat map would collide.
function fetchProjectSuckerMap(project) {
  var chains = (project.chains || []).map(function (c) { return c.id; });
  return Promise.all(chains.map(function (C) { return readSuckerPairsOf(project.id, C).then(function (pairs) { return { C: C, pairs: pairs }; }); }))
    .then(function (lists) {
      var map = {};
      lists.forEach(function (x) { var m = map[x.C] = map[x.C] || {}; x.pairs.forEach(function (p) { if (p.local) m[p.local.toLowerCase()] = p.remoteChainId; }); });
      return map;
    }).catch(function () { return {}; });
}

// The connected wallet's CLAIMED ERC-20 balance — the only kind a sucker can bridge — plus the token
// address. { token: address|null, balance: bigint }. token=null when no ERC-20 is deployed on this chain.
function readBridgeableBalance(project, chainId) {
  var acct = getAccount && getAccount();
  var tokens = getAddress('JBTokens', chainId);
  if (!acct || !tokens) return Promise.resolve({ token: null, balance: 0n });
  var client = clientFor(chainId);
  return client.readContract({ address: tokens, abi: tokenOfAbi, functionName: 'tokenOf', args: [BigInt(project.id)] })
    .then(function (erc20) {
      if (!erc20 || erc20 === ZERO_ADDRESS) return { token: null, balance: 0n };
      return client.readContract({ address: erc20, abi: erc20BalanceOfAbi, functionName: 'balanceOf', args: [acct] })
        .then(function (b) { return { token: erc20, balance: BigInt(b) }; });
    })
    .catch(function () { return { token: null, balance: 0n }; });
}

// claim(JBClaim{token, JBLeaf{index,beneficiary,projectTokenCount,terminalTokenAmount,metadata}, bytes32[32] proof})
// Cross-chain accounting snapshot a sucker holds about its PEER (per-context oracle-free surplus). Read on
// a chain's sucker, these report what that chain knows about the peer's supply + per-currency balance.
var suckerPeerAbi = [
  { type: 'function', name: 'peerChainTotalSupplyValue', stateMutability: 'view', inputs: [{ name: 'chainId', type: 'uint256' }],
    outputs: [{ type: 'tuple', components: [{ name: 'value', type: 'uint256' }, { name: 'peerChainId', type: 'uint256' }, { name: 'snapshotTimestamp', type: 'uint256' }] }] },
  { type: 'function', name: 'peerChainContextsOf', stateMutability: 'view', inputs: [{ name: 'chainId', type: 'uint256' }], outputs: [
    { name: 'contexts', type: 'tuple[]', components: [{ name: 'currency', type: 'uint32' }, { name: 'decimals', type: 'uint8' }, { name: 'surplus', type: 'uint128' }, { name: 'balance', type: 'uint128' }] },
    { name: 'snapshot', type: 'uint256' }] },
];
// syncAccountingData() snapshots the LOCAL chain's accounting and bridges it to the peer (payable AMB fee).
var suckerSyncAbi = [{ type: 'function', name: 'syncAccountingData', stateMutability: 'payable', inputs: [], outputs: [] }];
// Emitted on the SOURCE sucker each time a snapshot is pushed. We scan this (like the Movement table scans
// InsertToOutboxTree) to detect an in-flight sync ON-CHAIN — universal (any caller) and reload-proof.
var ACCOUNTING_SYNCED_EVENT = { type: 'event', name: 'AccountingDataSynced', inputs: [{ name: 'sourceTimestamp', type: 'uint256', indexed: false }, { name: 'caller', type: 'address', indexed: false }] };
// Latest accounting-snapshot push from `sucker` (its `peerChainId` is the destination), as unix seconds
// (sourceTimestamp is packed (block.timestamp << 128 | seq) — unpack >> 128). 0 if none / unreadable.
async function readLatestSyncSent(chainId, sucker) {
  if (!sucker) return 0;
  var lc = lpLogsClient(chainId) || clientFor(chainId);
  var latest; try { latest = await lc.getBlockNumber(); } catch (_) { return 0; }
  var W = 45000n, windows = [];
  for (var n = 0; n < 4 && latest - BigInt(n) * W > 0n; n++) { var hi = latest - BigInt(n) * W, lo = hi > W ? hi - W + 1n : 0n; windows.push({ lo: lo, hi: hi }); if (lo === 0n) break; }
  var batches = await Promise.all(windows.map(function (w) {
    return lc.getLogs({ address: sucker, event: ACCOUNTING_SYNCED_EVENT, fromBlock: w.lo, toBlock: w.hi }).catch(function () { return []; });
  }));
  var maxTs = 0n;
  batches.forEach(function (b) { b.forEach(function (l) { var ts = toBigInt(l.args.sourceTimestamp) >> 128n; if (ts > maxTs) maxTs = ts; }); });
  return Number(maxTs);
}

// + inboxOf / executedLeafHashOf. Verified against JBSucker.sol + structs/JBClaim.sol/JBLeaf.sol.
var suckerClaimAbi = [
  { type: 'function', name: 'inboxOf', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'tuple', components: [{ name: 'nonce', type: 'uint64' }, { name: 'root', type: 'bytes32' }] }] },
  { type: 'function', name: 'executedLeafHashOf', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'index', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'outboxOf', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'tuple', components: [{ name: 'nonce', type: 'uint64' }, { name: 'numberOfClaimsSent', type: 'uint192' },
      { name: 'balance', type: 'uint256' }, { name: 'tree', type: 'tuple', components: [{ name: 'branch', type: 'bytes32[32]' }, { name: 'count', type: 'uint256' }] }] }] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'claimData', type: 'tuple', components: [
    { name: 'token', type: 'address' },
    { name: 'leaf', type: 'tuple', components: [
      { name: 'index', type: 'uint256' }, { name: 'beneficiary', type: 'bytes32' },
      { name: 'projectTokenCount', type: 'uint256' }, { name: 'terminalTokenAmount', type: 'uint256' }, { name: 'metadata', type: 'bytes32' }] },
    { name: 'proof', type: 'bytes32[32]' }] }], outputs: [] },
];
var INSERT_TO_OUTBOX_EVENT = { type: 'event', name: 'InsertToOutboxTree', inputs: [
  { name: 'beneficiary', type: 'bytes32', indexed: true }, { name: 'token', type: 'address', indexed: true },
  { name: 'hashed', type: 'bytes32', indexed: false }, { name: 'index', type: 'uint256', indexed: false },
  { name: 'root', type: 'bytes32', indexed: false }, { name: 'projectTokenCount', type: 'uint256', indexed: false },
  { name: 'terminalTokenAmount', type: 'uint256', indexed: false }, { name: 'metadata', type: 'bytes32', indexed: false },
  { name: 'caller', type: 'address', indexed: false }] };
var SUCKER_BYTES32_ZERO = '0x' + '0'.repeat(64);

// MerkleLib depth-32 incremental tree (Z[i+1]=keccak(Z[i]‖Z[i]); leaf-left when index bit==0).
function suckerHashPair(a, b) { return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [a, b])); }
var _suckerZ = null;
function suckerZeroHashes() {
  if (_suckerZ) return _suckerZ;
  var z = [SUCKER_BYTES32_ZERO];
  for (var i = 0; i < 32; i++) z.push(suckerHashPair(z[i], z[i]));
  _suckerZ = z; return z; // z[0..32]; z[32] === 0x27ae5ba0… (empty-tree root)
}
// Sibling path (32 elements) for the leaf at `index`, given the dense leaf-hash array [0,count).
function suckerLeafProof(leafHashes, index) {
  var Z = suckerZeroHashes(), level = leafHashes.slice(), proof = [], pos = index;
  for (var l = 0; l < 32; l++) {
    var sib = pos ^ 1;
    proof.push(sib < level.length ? level[sib] : Z[l]);
    var next = [];
    for (var i = 0; i * 2 < level.length; i++) {
      var left = level[i * 2];
      var right = (i * 2 + 1 < level.length) ? level[i * 2 + 1] : Z[l];
      next.push(suckerHashPair(left, right));
    }
    level = next; pos = Math.floor(pos / 2);
  }
  return proof;
}
// Recompute the root from a leaf + proof (mirrors MerkleLib.branchRoot) — used to verify before submitting.
function suckerBranchRoot(leaf, proof, index) {
  var cur = leaf, pos = index;
  for (var i = 0; i < 32; i++) { cur = (pos & 1) ? suckerHashPair(proof[i], cur) : suckerHashPair(cur, proof[i]); pos = Math.floor(pos / 2); }
  return cur;
}

// The msg.value toRemote needs. Two regimes:
//
// • Native-bridge suckers (OP/Base/Arb ↔ L1) are zero-cost beyond the registry fee — msg.value must EQUAL
//   toRemoteFee() (the bridge reverts on any non-zero transportPayment = msg.value − fee).
//
// • CCIP suckers ALSO need to cover the CCIP messaging fee in native ETH. transportPayment (msg.value − fee)
//   is passed to CCIP_ROUTER.ccipSend{value:}; if it's 0, JBCCIPSucker switches to LINK-fee mode and pulls
//   LINK from the caller via transferFrom — which the wallet hasn't approved, so it reverts (the exact bug a
//   tx-auditor caught on project 8's Ethereum↔Base USDC move). We discover the needed native budget by
//   simulating toRemote at escalating values: the contract computes getFee() internally (ground truth, no
//   fragile off-chain message reconstruction) and excess transportPayment is refunded to the caller
//   (JBCCIPLib refunds msg.value − fees), so the smallest working tier is safe. Returns bigint, or null when
//   a CCIP fee couldn't be determined (so callers surface an error instead of prompting a reverting tx).
async function findToRemoteValue(chainId, sucker, token, account) {
  var fee = 0n;
  try { fee = BigInt(await clientFor(chainId).readContract({ address: getAddress('JBSuckerRegistry', chainId), abi: suckerRegistryBridgeAbi, functionName: 'toRemoteFee', args: [] })); } catch (_) {}
  var infra = await classifySuckerInfra(chainId, sucker).catch(function () { return 'native'; });
  if (infra !== 'CCIP') return fee; // native bridge: fee only
  if (!account) return null; // need a caller to simulate against
  var data;
  try { data = encodeFunctionData({ abi: suckerBridgeAbi, functionName: 'toRemote', args: [token] }); } catch (_) { return null; }
  // 0.001 … 0.5 ETH of CCIP budget on top of the registry fee. CCIP testnet fees are small; the ladder caps
  // generously. A tier that's too low reverts (insufficient CCIP fee); the first that succeeds is returned.
  var ladder = [1000000000000000n, 5000000000000000n, 20000000000000000n, 50000000000000000n, 200000000000000000n, 500000000000000000n];
  var fundedBalance = 10n ** 21n; // 1000 ETH override so the sim never fails on the caller's balance
  for (var i = 0; i < ladder.length; i++) {
    var value = fee + ladder[i];
    try {
      await clientFor(chainId).call({
        account: account, to: sucker, data: data, value: value,
        stateOverride: [{ address: account, balance: fundedBalance }],
      });
      return value; // succeeded — this budget covers getFee; excess refunds on-chain
    } catch (_) { /* insufficient (or sim limitation) — try a larger budget */ }
  }
  return null;
}

function buildMoveModal(project) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'modal-body');
  var chains = project.chains || [];
  var state = { from: chains[0] && chains[0].id, to: chains[1] && chains[1].id, balance: 0n, token: null, pairs: null, sucker: null, kinds: null, backingKey: null };

  // Per-chain balances at the top (card) — your tokens + the project's accounting balances.
  var moveBalTable = el('div', 'cashout-bal-table'); wrap.appendChild(moveBalTable);

  // "From [chain] to [chain] with [token]" — one sentence. The "with [token]" backing picker shows only for
  // multi-token projects (the sucker reclaims + bridges that specific token; it must be mapped on the route).
  var sent = el('div', 'cashout-selrow');
  sent.appendChild(document.createTextNode('From'));
  var fromSel = opsChainSelect(project, function (cid) { state.from = cid; onFromChange(); }); sent.appendChild(fromSel);
  sent.appendChild(document.createTextNode('to'));
  var toSel = opsChainSelect(project, function (cid) { state.to = cid; resolveRoute(); }); if (chains[1]) toSel.value = String(chains[1].id); sent.appendChild(toSel);
  var withWrap = el('span', 'cashout-reclaim'); withWrap.style.display = 'none';
  withWrap.appendChild(document.createTextNode('with'));
  var bringSel = el('select', 'field create-input'); bringSel.style.width = 'auto'; bringSel.style.minWidth = '0';
  bringSel.addEventListener('change', function () { state.backingKey = bringSel.value; loadBacking(); updateBacking(); });
  withWrap.appendChild(bringSel); sent.appendChild(withWrap);
  wrap.appendChild(sent);

  // Bridge route — and when a pair carries both a native and a CCIP sucker, a picker + tradeoff blurb.
  var route = el('div', 'modal-status modal-route'); wrap.appendChild(route);
  var bridgeRow = el('div', 'ops-bridge-row'); bridgeRow.style.display = 'none';
  var bridgeSel = el('select', 'field create-input'); bridgeSel.style.width = 'auto'; bridgeSel.style.minWidth = '0'; bridgeRow.appendChild(bridgeSel);
  var bridgeNote = el('div', 'ops-bridge-note'); bridgeRow.appendChild(bridgeNote);
  bridgeSel.addEventListener('change', function () {
    var m = state._matches && state._matches[Number(bridgeSel.value)];
    if (m) state.sucker = m.local;
    updateBridgeNote();
  });
  wrap.appendChild(bridgeRow);

  var lbl = el('div', 'modal-label move-label'); lbl.textContent = 'Amount'; lbl.style.marginTop = '12px'; wrap.appendChild(lbl);
  var bal = el('div', 'modal-balance'); wrap.appendChild(bal);
  var inRow = el('div', 'ops-inrow');
  var amtField = el('div', 'ops-field');
  var amt = el('input', 'ops-amount'); amt.type = 'number'; amt.placeholder = '0.00'; amtField.appendChild(amt);
  var unit = el('span', 'ops-unit'); unit.textContent = sym; amtField.appendChild(unit);
  inRow.appendChild(amtField);
  wrap.appendChild(inRow);
  wrap.appendChild(opsPercentButtons(amt, function () { return state.balance; }));

  var note = el('div', 'modal-status');
  function updateMoveNote() { var s = (state.backing && state.backing.symbol) || sym; note.textContent = 'A proportional share of the revnet’s ' + s + ' surplus (funds beyond payouts) moves too.'; }
  updateMoveNote();
  wrap.appendChild(note);

  // "Amount that will move" — the proportional backing (ETH) that bridges alongside the tokens.
  var backing = el('div', 'modal-status move-backing'); backing.style.display = 'none'; wrap.appendChild(backing);
  amt.addEventListener('input', function () { updateBacking(); updateMoveBtn(); });

  var status = el('div', 'modal-status'); wrap.appendChild(status);

  var hint = el('div', 'modal-status');
  hint.textContent = 'Once it’s bridged, claim it on the destination from the Movement table below.';
  wrap.appendChild(hint);

  var foot = el('div', 'modal-foot');
  var btn = document.createElement('button'); btn.className = 'modal-submit'; btn.textContent = 'Move ' + sym;
  foot.appendChild(btn); wrap.appendChild(foot);

  function onFromChange() { refreshBalance(); loadPairs(); loadBacking(); }
  function refreshBalance() {
    bal.textContent = 'Your balance: …';
    readBridgeableBalance(project, state.from).then(function (r) {
      state.balance = r.balance; state.token = r.token;
      if (!(getAccount && getAccount())) { bal.textContent = 'Connect a wallet to see your balance.'; updateMoveBtn(); return; }
      if (!r.token) { bal.textContent = 'No ERC-20 ' + sym + ' on ' + moveChainName(state.from) + ' — claim your tokens there first to bridge.'; updateMoveBtn(); return; }
      bal.textContent = 'Your ' + sym + ' available on ' + moveChainName(state.from) + ': ' + formatTokens(r.balance) + ' ' + sym;
      updateMoveBtn();
    });
  }
  // Disable Move with a clear reason when there's nothing to bridge — otherwise the button looks active
  // but the click silently no-ops (the #1 "I clicked and nothing happened" confusion). Suckers bridge the
  // ERC-20, so credits-only / zero-balance / same-chain all block it.
  function moveBlockReason() {
    if (!(getAccount && getAccount())) return ''; // allow click → connect()
    if (state.from === state.to) return 'Pick two different chains to bridge between.';
    if (!state.token) return 'No ERC-20 ' + sym + ' on ' + moveChainName(state.from) + ' yet — claim your ' + sym + ' to an ERC-20 there first, then bridge.';
    if (state.balance != null && state.balance === 0n) return 'You have no ' + sym + ' to bridge on ' + moveChainName(state.from) + '.';
    return '';
  }
  function updateMoveBtn() {
    var why = moveBlockReason();
    btn.disabled = !!why;
    btn.title = why || '';
    if (why) { status.classList.remove('pending'); status.textContent = why; }
    else if (status.textContent === btn.title || /no ERC-20|to bridge on|Pick two different/i.test(status.textContent)) status.textContent = '';
  }
  // The proportional backing that bridges with the tokens: terminalBalance × amount / totalSupply (suckers
  // move the full proportional share, no cash-out tax). Read on the FROM chain.
  function loadBacking() {
    state.fromSupply = null; state.fromBacking = null; state.backing = null; updateBacking();
    var pid = BigInt(project.id);
    // The chosen backing token (multi-token picker), else the project's primary accounting token.
    var chosen = null;
    if (state.kinds && state.backingKey) { var k = state.kinds.filter(function (x) { return x.key === state.backingKey; })[0]; if (k) { var a = k.addrForChain(state.from); if (a) chosen = { address: a, decimals: k.decimals, symbol: k.symbol }; } }
    var acctP = chosen ? Promise.resolve(chosen) : resolveAcctToken(state.from, pid);
    acctP.then(function (acct) {
      state.backing = acct;
      var term = getAddress('JBMultiTerminal', state.from);
      var cur = Number(BigInt(acct.address) & 0xffffffffn);
      return Promise.all([
        read(state.from, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return null; }),
        // What bridges = the sucker's cash-out of the moved tokens, which draws from this token's SURPLUS
        // (balance − payout limit) at 0% tax — not the full balance. A token with unlimited payouts has 0.
        term ? read(state.from, 'JBTerminalStore', currentSurplusOfAbi, 'currentSurplusOf', [pid, [], [acct.address], BigInt(acct.decimals), BigInt(cur)]).catch(function () { return null; }) : Promise.resolve(null),
      ]);
    }).then(function (res) {
      state.fromSupply = res[0] != null ? BigInt(res[0]) : null;
      state.fromBacking = res[1] != null ? BigInt(res[1]) : null;
      updateBacking();
    }).catch(function () {});
  }
  function updateBacking() {
    updateMoveNote(); // reflect the chosen backing token in the "proportional share" note
    backing.style.display = 'none';
    if (!state.backing || state.fromSupply == null || state.fromBacking == null || state.fromSupply === 0n) return;
    var amount; try { amount = parseAmount(amt.value, 18); } catch (_) { return; }
    if (amount === 0n) return;
    var moved = state.fromBacking * amount / state.fromSupply;
    backing.innerHTML = '';
    var b = el('strong'); b.textContent = 'Surplus that will move: ';
    backing.appendChild(b);
    backing.appendChild(document.createTextNode(formatBalance(moved, state.backing.decimals, state.backing.symbol)));
    // Explain a zero: the token's payout limit covers its whole balance, so there's no surplus to bridge.
    if (state.fromBacking === 0n) {
      var why = el('div', 'move-backing-why'); why.textContent = 'No ' + state.backing.symbol + ' surplus on ' + moveChainName(state.from) + ' — its payout limit covers the whole balance' + (state.kinds && state.kinds.length > 1 ? '. Try another token above.' : '.');
      backing.appendChild(why);
    }
    backing.style.display = '';
  }
  // Tradeoff blurb under the bridge picker, with a docs link for DYOR.
  function updateBridgeNote() {
    var m = state._matches && state._matches[Number(bridgeSel.value)];
    if (!m) { bridgeNote.style.display = 'none'; return; }
    bridgeNote.innerHTML = '';
    var txt, href, linkLabel;
    if (m._infra === 'CCIP') {
      txt = 'CCIP delivers in minutes by relaying through Chainlink’s cross-chain network — faster, but it depends on Chainlink.';
      href = 'https://docs.chain.link/ccip'; linkLabel = 'About Chainlink CCIP ↗';
    } else {
      txt = 'Native bridges route through the chain’s own canonical bridge — slower, but their security comes from the chain itself, not a third party.';
      href = 'https://docs.juicebox.money/v4/learn/glossary/sucker/'; linkLabel = 'About suckers ↗';
    }
    bridgeNote.appendChild(document.createTextNode(txt + ' '));
    var a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = linkLabel;
    bridgeNote.appendChild(a);
    bridgeNote.style.display = '';
  }
  function loadPairs() {
    state.pairs = null; resolveRoute();
    readSuckerPairsOf(project.id, state.from).then(function (pairs) { state.pairs = pairs; resolveRoute(); });
  }
  function resolveRoute() {
    state.sucker = null; state._matches = null; bridgeRow.style.display = 'none'; bridgeNote.style.display = 'none';
    updateMoveBtn();
    if (state.from === state.to) { route.textContent = 'Pick two different chains.'; return; }
    if (state.pairs == null) { route.textContent = 'Finding bridge route…'; return; }
    var matches = state.pairs.filter(function (x) { return x.remoteChainId === state.to; });
    if (!matches.length) { route.textContent = 'No bridge from ' + moveChainName(state.from) + ' to ' + moveChainName(state.to) + '.'; return; }
    if (matches.length === 1) {
      state.sucker = matches[0].local;
      route.textContent = 'Bridges via sucker ' + truncAddr(matches[0].local) + '.';
      return;
    }
    // Two suckers connect this pair (a native bridge and a CCIP bridge) — classify each and let the user pick.
    route.textContent = 'Two bridges connect these chains — pick one:';
    var to = state.to; // guard against the user switching chains mid-classification
    Promise.all(matches.map(function (m) {
      return m._infra ? Promise.resolve(m._infra) : classifySuckerInfra(state.from, m.local).then(function (i) { m._infra = i; return i; });
    })).then(function (infras) {
      if (state.to !== to) return;
      bridgeSel.innerHTML = '';
      matches.forEach(function (m, i) {
        var o = document.createElement('option'); o.value = String(i);
        o.textContent = (infras[i] === 'CCIP' ? 'CCIP' : 'Native') + ' bridge | ' + truncAddr(m.local);
        bridgeSel.appendChild(o);
      });
      // Default to the native (canonical) bridge when one exists — it's zero-cost (only the registry fee),
      // whereas CCIP also charges a messaging fee. The user can still switch to CCIP.
      var nativeIdx = infras.indexOf('native');
      var def = nativeIdx >= 0 ? nativeIdx : 0;
      bridgeSel.value = String(def);
      state._matches = matches;
      state.sucker = matches[def].local;
      bridgeRow.style.display = '';
      updateBridgeNote();
    });
  }

  onFromChange();
  renderBalanceTables(moveBalTable, project, sym);
  // Multi-token projects: offer a backing-token picker (default to the primary), then recompute backing.
  acctKindsForFunds(project).then(function (kinds) {
    state.kinds = kinds;
    if (kinds && kinds.length > 1) {
      bringSel.innerHTML = '';
      kinds.forEach(function (k) { var o = document.createElement('option'); o.value = k.key; o.textContent = k.symbol; bringSel.appendChild(o); });
      state.backingKey = kinds[0].key; bringSel.value = state.backingKey;
      withWrap.style.display = 'inline-flex';
      loadBacking();
    }
  }).catch(function () {});

  btn.addEventListener('click', function () {
    var acct = getAccount && getAccount();
    if (!acct) { connect(); return; }
    if (state.from === state.to) { status.textContent = 'Pick two different chains.'; return; }
    if (!state.token) { status.textContent = 'No ERC-20 ' + sym + ' to bridge on ' + moveChainName(state.from) + '.'; return; }
    if (!state.sucker) { status.textContent = 'No bridge route between these chains.'; return; }
    var amount; try { amount = parseAmount(amt.value, 18); } catch (_) { status.textContent = 'Invalid amount'; return; }
    if (amount === 0n) { status.textContent = 'Enter an amount'; return; }
    if (amount > state.balance) { status.textContent = 'Amount exceeds your bridgeable balance'; return; }

    // beneficiary is the recipient on the remote chain — the caller, left-padded to bytes32.
    var beneficiary32 = '0x' + acct.slice(2).toLowerCase().padStart(64, '0');
    var metadata = '0x' + '0'.repeat(64);
    var sucker = state.sucker, token = state.token, from = state.from, to = state.to;
    btn.disabled = true; status.textContent = '';
    var onStatus = function (m, kind) { status.classList.toggle('pending', kind === 'pending'); status.textContent = m; };
    var fail = function (m) { status.classList.remove('pending'); status.textContent = m; btn.disabled = false; };

    // The TERMINAL (backing) token the sucker reclaims + bridges alongside the project tokens. This is the
    // project's accounting token — USDC for a USDC project, NATIVE_TOKEN only for an ETH project. The sucker
    // keys its token mapping/outbox tree by this address, so passing the wrong token reverts or bridges the
    // wrong tree. Use the resolved backing token (loadBacking), re-resolving if it hasn't populated yet.
    var termP = (state.backing && state.backing.address)
      ? Promise.resolve(state.backing.address)
      : resolveAcctToken(from, BigInt(project.id)).then(function (a) { return a && a.address; });
    termP.then(function (termToken) {
      if (!termToken) { fail('Could not resolve the backing token to bridge.'); return; }
      // Step 1: approve the sucker for the ERC-20, then prepare (cash out to terminal funds + insert outbox
      // leaf). minTokensReclaimed=0: the remote chain re-mints the same projectTokenCount regardless; the
      // local cash-out is internal sucker plumbing.
      executeTransaction(Object.assign(buildSuckerPrepareArgs({
        chainId: from, sucker: sucker, projectTokenCount: amount, beneficiary32: beneficiary32, minReclaimed: 0n,
        termToken: termToken, metadata: metadata, approvalToken: token, approvalAmount: amount,
      }), {
        onStatus: onStatus, onError: fail,
        onSuccess: function () {
          // Step 2: ship the outbox root to the remote chain. Discover the exact msg.value the bridge needs
          // by simulating toRemote at increasing values (handles native-bridge fee-only AND CCIP messaging).
          onStatus('Prepared — finding bridge fee…', 'pending');
          findToRemoteValue(from, sucker, termToken, acct).then(function (fee) {
            if (fee == null) { fail('Prepared, but the bridge queue isn’t ready to send yet — reopen and try again shortly.'); return; }
            onStatus('Sending to ' + moveChainName(to) + '…', 'pending');
            executeTransaction(Object.assign(buildSuckerToRemoteArgs({
              chainId: from, sucker: sucker, termToken: termToken, value: fee,
            }), {
              confirmTitle: 'Transfer all queued movements',
              confirmDescription: 'Step 2 of 2. Step 1 (“prepare”) queued your move into the bridge’s outbox. '
                + 'This step ships that queued batch to ' + moveChainName(to) + ' — it delivers every pending move in the '
                + 'queue (yours and anyone else’s) in one bridge message, so anyone can trigger it. The small value is the '
                + 'bridge’s messaging fee — you pay it to relay the message; it’s not the bridged tokens (those move from the '
                + 'project’s funds). Once it lands, claim your tokens on ' + moveChainName(to) + ' from the Movement table.',
              onStatus: onStatus, onError: fail,
              onSuccess: function () {
                status.classList.remove('pending');
                status.textContent = 'Bridging to ' + moveChainName(to) + ' — once it delivers (a few minutes for native bridges) claim it from the Movement table.';
                btn.disabled = false;
                document.dispatchEvent(new CustomEvent('jb:bridge-updated'));
              },
            }));
          });
        },
      }));
    });
  });
  return wrap;
}

// Native ETH balance (wei) for an address on a chain. Null on failure.
function readEthBalance(chainId, account) {
  if (!account) return Promise.resolve(null);
  var c = clientFor(chainId);
  if (!c) return Promise.resolve(null);
  return c.getBalance({ address: account }).catch(function () { return null; });
}

// The wallet's spendable balance of a pay token on a chain (native ETH or ERC-20). Null on failure.
function readWalletTokenBalance(chainId, tokenAddr, account) {
  if (!account) return Promise.resolve(null);
  if (!tokenAddr || tokenAddr.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return readEthBalance(chainId, account);
  var c = clientFor(chainId);
  if (!c) return Promise.resolve(null);
  return c.readContract({ address: tokenAddr, abi: erc20BalanceOfAbi, functionName: 'balanceOf', args: [account] })
    .then(function (b) { return BigInt(b); }).catch(function () { return null; });
}

// Concentrated-liquidity deposit counterpart. Given one side's amount, the current price `p` and the
// range [pa, pb] (all ETH-per-token), return the other side's amount using Uniswap V3/V4 math.
// driverIsEth=true → input is ETH, returns token; false → input is token, returns ETH.
// Outside the range it's single-sided: returns 0 for the side that isn't needed, or null if the
// requested side can't fund the position.
function lpCounterpart(amount, driverIsEth, p, pa, pb) {
  if (!(amount > 0) || !(p > 0) || !(pa > 0) || !(pb > pa)) return null;
  var sp = Math.sqrt(p), sa = Math.sqrt(pa), sb = Math.sqrt(pb);
  if (p <= pa) return driverIsEth ? null : 0;   // all token: no ETH side
  if (p >= pb) return driverIsEth ? 0 : null;   // all ETH: no token side
  if (driverIsEth) {
    var L = amount / (sp - sa);
    return L * (1 / sp - 1 / sb); // token amount
  }
  var Lx = amount / (1 / sp - 1 / sb);
  return Lx * (sp - sa); // ETH amount
}

// Trim a float for an input field (no thousands separators; ~6 significant digits).
function lpTrimNum(n) {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1) return String(Math.round(n * 1e4) / 1e4);
  return String(Number(n.toPrecision(6)));
}

// A compact number-line of the LP price range relative to the cash-out floor, current pool price,
// and issuance ceiling. All values are ETH per token.
function renderLpRangeSvg(floor, ceiling, poolP, pa, pb) {
  var pts = [floor, ceiling, poolP, pa, pb].filter(function (v) { return v > 0; });
  if (!pts.length) return '<div class="modal-balance">Range preview unavailable.</div>';
  var maxV = Math.max.apply(null, pts) * 1.12;
  var W = 320, H = 60, padL = 6, padR = 6, baseY = 38;
  function X(v) { return padL + (W - padL - padR) * (v / maxV); }
  // Uniform scaling (no preserveAspectRatio="none") so the text labels don't render horizontally stretched.
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" class="lp-graph-svg">';
  svg += '<line x1="' + padL + '" y1="' + baseY + '" x2="' + (W - padR) + '" y2="' + baseY + '" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>';
  if (pa > 0 && pb > pa) {
    svg += '<rect x="' + X(pa).toFixed(1) + '" y="' + (baseY - 9) + '" width="' + Math.max(1, X(pb) - X(pa)).toFixed(1) + '" height="18" fill="rgba(110,196,196,0.35)" stroke="#1a8a8a" stroke-width="1"/>';
  }
  function marker(v, color, label, up) {
    if (!(v > 0)) return '';
    var xv = X(v);
    // Keep the whole label inside the chart: anchor by where its half-width would overflow an edge.
    // (~0.3 ≈ half the ~0.6em monospace glyph advance at font-size 8.)
    var half = label.length * 8 * 0.3;
    var anchor = 'middle', tx = xv;
    if (xv - half < padL) { anchor = 'start'; tx = padL; }
    else if (xv + half > W - padR) { anchor = 'end'; tx = W - padR; }
    var x = xv.toFixed(1);
    return '<line x1="' + x + '" y1="' + (baseY - 13) + '" x2="' + x + '" y2="' + (baseY + 13) + '" stroke="' + color + '" stroke-width="1.5"/>'
      + '<text x="' + tx.toFixed(1) + '" y="' + (up ? 11 : H - 3) + '" font-size="8" fill="' + color + '" text-anchor="' + anchor + '">' + label + '</text>';
  }
  svg += marker(floor, '#2c2018', 'Cash out floor', true);
  svg += marker(poolP, '#b8602e', 'Current pool price', false);
  svg += marker(ceiling, '#1a8a8a', 'Issuance ceiling', true);
  svg += '</svg>';
  return svg;
}

// --- Uniswap V4 mint (Add liquidity) — exact encoding per v4-periphery PositionManager ---
var PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
var LP_Q96 = 1n << 96n;
// The site's default RPCs (e.g. thirdweb on Sepolia) don't serve eth_getLogs; use CORS-friendly
// publicnode endpoints for the LP-position log scan only (reads still go through clientFor).
var LP_LOGS_RPC = {
  1: 'https://ethereum-rpc.publicnode.com', 10: 'https://optimism-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com', 42161: 'https://arbitrum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com', 11155420: 'https://optimism-sepolia-rpc.publicnode.com',
  84532: 'https://base-sepolia-rpc.publicnode.com', 421614: 'https://arbitrum-sepolia-rpc.publicnode.com',
};
var _lpLogClients = {};
function lpLogsClient(chainId) {
  if (_lpLogClients[chainId]) return _lpLogClients[chainId];
  var url = LP_LOGS_RPC[chainId]; if (!url || !CHAINS[chainId]) return null;
  _lpLogClients[chainId] = createPublicClient({ chain: CHAINS[chainId], transport: http(url) });
  return _lpLogClients[chainId];
}

var lpErc20Abi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
var lpPermit2Abi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }], outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }], outputs: [] },
];
var LP_PERMIT_SINGLE_COMPONENTS = [
  { name: 'details', type: 'tuple', components: [
    { name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' },
  ] },
  { name: 'spender', type: 'address' },
  { name: 'sigDeadline', type: 'uint256' },
];
var lpPositionManagerAbi = [
  { type: 'function', name: 'modifyLiquidities', stateMutability: 'payable', inputs: [{ name: 'unlockData', type: 'bytes' }, { name: 'deadline', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'permit', stateMutability: 'payable', inputs: [{ name: 'owner', type: 'address' }, { name: 'permitSingle', type: 'tuple', components: LP_PERMIT_SINGLE_COMPONENTS }, { name: 'signature', type: 'bytes' }], outputs: [{ name: 'err', type: 'bytes' }] },
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ type: 'bytes[]' }] },
];
// Permit2 AllowanceTransfer EIP-712 types (domain has NO version field; name = "Permit2").
var LP_PERMIT2_TYPES = {
  PermitDetails: [
    { name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' },
  ],
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' },
  ],
};

// TickMath.getSqrtPriceAtTick — exact integer port (v4-core).
function lpSqrtAtTick(tick) {
  tick = Number(tick);
  var absTick = tick < 0 ? -tick : tick;
  if (absTick > 887272) throw new Error('tick out of range');
  var price = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : (1n << 128n);
  if (absTick & 0x2) price = (price * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4) price = (price * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8) price = (price * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10) price = (price * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20) price = (price * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40) price = (price * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80) price = (price * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100) price = (price * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200) price = (price * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400) price = (price * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800) price = (price * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000) price = (price * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000) price = (price * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000) price = (price * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000) price = (price * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000) price = (price * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000) price = (price * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000) price = (price * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000) price = (price * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) price = ((1n << 256n) - 1n) / price;
  return (price + 0xffffffffn) >> 32n; // Q128.128 -> sqrtPriceX96, round up
}
function lpSortPair(a, b) { return a > b ? [b, a] : [a, b]; }
function lpLiqForAmount0(sa, sb, amount0) { var p = lpSortPair(sa, sb); sa = p[0]; sb = p[1]; var inter = (sa * sb) / LP_Q96; return (amount0 * inter) / (sb - sa); }
function lpLiqForAmount1(sa, sb, amount1) { var p = lpSortPair(sa, sb); sa = p[0]; sb = p[1]; return (amount1 * LP_Q96) / (sb - sa); }
function lpGetLiquidityForAmounts(sp, sa, sb, amount0, amount1) {
  var pr = lpSortPair(sa, sb); sa = pr[0]; sb = pr[1];
  if (sp <= sa) return lpLiqForAmount0(sa, sb, amount0);
  if (sp < sb) { var l0 = lpLiqForAmount0(sp, sb, amount0); var l1 = lpLiqForAmount1(sa, sp, amount1); return l0 < l1 ? l0 : l1; }
  return lpLiqForAmount1(sa, sb, amount1);
}
function lpAmount0ForL(sa, sb, L) { var p = lpSortPair(sa, sb); sa = p[0]; sb = p[1]; return (((L << 96n) * (sb - sa)) / sb) / sa; }
function lpAmount1ForL(sa, sb, L) { var p = lpSortPair(sa, sb); sa = p[0]; sb = p[1]; return (L * (sb - sa)) / LP_Q96; }
function lpGetAmountsForLiquidity(sp, sa, sb, L) {
  var pr = lpSortPair(sa, sb); sa = pr[0]; sb = pr[1];
  if (sp <= sa) return { amount0: lpAmount0ForL(sa, sb, L), amount1: 0n };
  if (sp < sb) return { amount0: lpAmount0ForL(sp, sb, L), amount1: lpAmount1ForL(sa, sp, L) };
  return { amount0: 0n, amount1: lpAmount1ForL(sa, sb, L) };
}
function lpAlignDown(tick, s) { var r = tick % s; if (r !== 0 && tick < 0) r += s; return tick - r; }
function lpAlignUp(tick, s) { return lpAlignDown(tick + s - 1, s); }
// Read the buyback pool key + current sqrtPriceX96. Null if no pool.
async function readPoolState(project, chainId) {
  var hook = getAddress('JBBuybackHook', chainId);
  var pm = POOL_MANAGER_BY_CHAIN[chainId];
  if (!hook || !pm) return null;
  try {
    var pair = await lpPairFor(project, chainId);
    var client = clientFor(chainId);
    var key = await client.readContract({ address: hook, abi: poolKeyOfAbi, functionName: 'poolKeyOf', args: [BigInt(project.id), pair.addr] });
    if (!key) return null;
    var c0 = (key.currency0 || ZERO_ADDRESS).toLowerCase(), c1 = (key.currency1 || ZERO_ADDRESS).toLowerCase();
    if (c0 === ZERO_ADDRESS && c1 === ZERO_ADDRESS) return null;
    var poolId = keccak256(encodeAbiParameters(POOLKEY_TUPLE, [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
    var stateSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
    var slot0 = await client.readContract({ address: pm, abi: extsloadAbi, functionName: 'extsload', args: [stateSlot] });
    var sqrtP = BigInt(slot0) & ((1n << 160n) - 1n);
    if (sqrtP === 0n) return null;
    return { key: key, sqrtP: sqrtP, pair: pair };
  } catch (e) { return null; }
}

// Send one tx from the connected wallet and wait for its receipt. Returns the hash.
async function lpSendTx(chainId, p) {
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet');
  var acct = getAccount();
  var hash = await wallet.writeContract({ account: acct, chain: CHAINS[chainId], address: p.address, abi: p.abi, functionName: p.functionName, args: p.args, value: p.value || 0n });
  await clientFor(chainId).waitForTransactionReceipt({ hash: hash });
  return hash;
}

var lpPositionViewAbi = [
  { type: 'function', name: 'nextTokenId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'positionInfo', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getPositionLiquidity', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'liquidity', type: 'uint128' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: 'owner', type: 'address' }] },
];
function lpSignExtend24(v) { return (v & 0x800000n) ? v - 0x1000000n : v; }
// PoolManager.ModifyLiquidity — salt == bytes32(tokenId), so this maps a pool to its position tokenIds.
var LP_MODIFY_LIQUIDITY_EVENT = {
  type: 'event', name: 'ModifyLiquidity', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'tickLower', type: 'int24', indexed: false }, { name: 'tickUpper', type: 'int24', indexed: false },
    { name: 'liquidityDelta', type: 'int256', indexed: false }, { name: 'salt', type: 'bytes32', indexed: false },
  ],
};

// Enumerate this pool's V4 LP positions (provider, range, liquidity → ETH/token amounts). Finds the pool's
// position tokenIds from the PoolManager's ModifyLiquidity logs (salt = tokenId), then reads each position.
// Aggregates by owner; totals are exact reserves. Null on failure.
async function readLpPositions(project, chainId) {
  try {
    var posm = POSITION_MANAGER_BY_CHAIN[chainId];
    var pm = POOL_MANAGER_BY_CHAIN[chainId];
    if (!posm || !pm) return null;
    var st = await readPoolState(project, chainId);
    if (!st || !st.key) return null;
    var key = st.key, sqrtP = st.sqrtP, pair = st.pair;
    // The pair (terminal) token may be currency0 or currency1; everything below is in pair/token terms
    // ("eth" fields hold the PAIR amount — native ETH or USDC — and "rev" the project token).
    var pairIsC0 = ((key.currency0 || '').toLowerCase() === pair.addr);
    var pairDec = pair.decimals;
    var sp = Number(sqrtP) / Math.pow(2, 96), rawP = sp * sp;
    var rawRatio = pairIsC0 ? (rawP > 0 ? 1 / rawP : 0) : rawP;
    var poolPrice = rawRatio * Math.pow(10, 18 - pairDec); // pair per token (human)
    var poolId = keccak256(encodeAbiParameters(POOLKEY_TUPLE, [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
    var client = clientFor(chainId);
    var empty = { owners: [], totalEth: 0n, totalRev: 0n, poolPrice: poolPrice, count: 0, positions: [], pair: pair, pairIsC0: pairIsC0 };

    var seen = {}, tokenIds = [];
    function collect(lg) { lg.forEach(function (l) { if (!l.args || l.args.salt == null) return; var tid = BigInt(l.args.salt); if (tid > 0n && !seen[tid.toString()]) { seen[tid.toString()] = true; tokenIds.push(tid); } }); }
    // Scan the PoolManager's ModifyLiquidity logs for this poolId via a getLogs-capable RPC, in recent
    // ~45k-block windows (public RPCs cap the range; V6 testnet history is short so a few windows cover it).
    var logClient = lpLogsClient(chainId) || client;
    var latest = await logClient.getBlockNumber();
    var W = 45000n, windows = [];
    for (var n = 0; n < 8 && latest - BigInt(n) * W > 0n; n++) {
      var hiB = latest - BigInt(n) * W;
      var loB = hiB > W ? hiB - W + 1n : 0n;
      windows.push({ lo: loB, hi: hiB });
      if (loB === 0n) break;
    }
    var batches = await Promise.all(windows.map(function (w) {
      return logClient.getLogs({ address: pm, event: LP_MODIFY_LIQUIDITY_EVENT, args: { id: poolId }, fromBlock: w.lo, toBlock: w.hi }).catch(function () { return []; });
    }));
    batches.forEach(collect);
    if (!tokenIds.length) return empty;

    var det = await Promise.all(tokenIds.map(function (tid) {
      return Promise.all([
        client.readContract({ address: posm, abi: lpPositionViewAbi, functionName: 'positionInfo', args: [tid] }).then(function (x) { return BigInt(x); }).catch(function () { return 0n; }),
        client.readContract({ address: posm, abi: lpPositionViewAbi, functionName: 'ownerOf', args: [tid] }).catch(function () { return null; }),
        client.readContract({ address: posm, abi: lpPositionViewAbi, functionName: 'getPositionLiquidity', args: [tid] }).then(function (x) { return BigInt(x); }).catch(function () { return 0n; }),
      ]).then(function (r) { return { info: r[0], owner: r[1], liquidity: r[2] }; });
    }));

    var totalEth = 0n, totalRev = 0n, byOwner = {}, positions = [];
    var pairScale = Math.pow(10, pairDec);
    det.forEach(function (p) {
      if (!p.owner || p.liquidity <= 0n || p.info === 0n) return;
      var tickUpper = Number(lpSignExtend24((p.info >> 32n) & 0xffffffn));
      var tickLower = Number(lpSignExtend24((p.info >> 8n) & 0xffffffn));
      var amounts = lpGetAmountsForLiquidity(sqrtP, lpSqrtAtTick(tickLower), lpSqrtAtTick(tickUpper), p.liquidity);
      // amount0/amount1 are currency-ordered; map to pair ("eth") and project token ("rev").
      var pairAmt = pairIsC0 ? amounts.amount0 : amounts.amount1;
      var tokAmt = pairIsC0 ? amounts.amount1 : amounts.amount0;
      totalEth += pairAmt; totalRev += tokAmt;
      positions.push({ tickLower: tickLower, tickUpper: tickUpper, liquidity: p.liquidity, eth: pairAmt, rev: tokAmt });
      var val = Number(pairAmt) / pairScale + (Number(tokAmt) / 1e18) * poolPrice; // value in pair-token terms
      var k = p.owner.toLowerCase();
      if (!byOwner[k]) byOwner[k] = { address: p.owner, valueEth: 0, eth: 0n, rev: 0n, positions: 0 };
      byOwner[k].valueEth += val; byOwner[k].eth += pairAmt; byOwner[k].rev += tokAmt; byOwner[k].positions++;
    });
    var owners = Object.keys(byOwner).map(function (k) { return byOwner[k]; }).sort(function (a, b) { return b.valueEth - a.valueEth; });
    return { owners: owners, totalEth: totalEth, totalRev: totalRev, poolPrice: poolPrice, sqrtP: sqrtP, count: owners.length, positions: positions, pair: pair, pairIsC0: pairIsC0 };
  } catch (e) { return null; }
}

// V4 liquidity-depth histogram: how much active liquidity sits in each price band. Bars are colored by
// side of the current pool price (below = teal/support, above = orange); dashed markers show the cash-out
// floor, current AMM price, and issuance ceiling. Price axis is log-scaled (ranges span orders of magnitude).
function renderLpDepthChart(lp, amm, issuance, cashout, sym) {
  var positions = (lp && lp.positions) || [];
  if (!positions.length) return null;
  var sqrtP = lp.sqrtP;
  // pair (terminal) token per project token, accounting for currency ordering + decimals (ETH pools: factor 1, pair=c0).
  var pairIsC0 = lp.pairIsC0 !== false;
  var pairDec = (lp.pair && lp.pair.decimals) || 18;
  var pairSym = (lp.pair && lp.pair.symbol) || 'ETH';
  var decFactor = Math.pow(10, 18 - pairDec);
  var priceAtTick = function (t) { return (pairIsC0 ? 1 / Math.pow(1.0001, t) : Math.pow(1.0001, t)) * decFactor; };
  var tickAtPrice = function (p) { return Math.log(pairIsC0 ? (decFactor / p) : (p / decFactor)) / Math.log(1.0001); };
  var pmin = Infinity, pmax = -Infinity;
  positions.forEach(function (p) { var a = priceAtTick(p.tickLower), b = priceAtTick(p.tickUpper); pmin = Math.min(pmin, a, b); pmax = Math.max(pmax, a, b); });
  [amm, issuance, cashout].forEach(function (v) { if (v && v > 0) { pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); } });
  if (!(pmax > pmin) || !isFinite(pmin) || !isFinite(pmax) || pmin <= 0) return null;
  var lmin = Math.log(pmin), lmax = Math.log(pmax), span = (lmax - lmin) || 1;
  var N = 56;
  // Per band: liquidity (bar height) + the REV/ETH it holds at the current price (hover tooltip).
  var bands = [];
  for (var i = 0; i < N; i++) {
    var pLo = Math.exp(lmin + (i / N) * span), pHi = Math.exp(lmin + ((i + 1) / N) * span);
    var mid = Math.exp(lmin + ((i + 0.5) / N) * span);
    var bTickLo = tickAtPrice(pHi), bTickHi = tickAtPrice(pLo); // price 1/1.0001^tick → tick falls as price rises
    var liq = 0, ethW = 0n, revW = 0n;
    positions.forEach(function (p) {
      var plo = priceAtTick(p.tickUpper), phi = priceAtTick(p.tickLower);
      if (mid >= plo && mid <= phi) liq += Number(p.liquidity);
      var oLo = Math.max(bTickLo, p.tickLower), oHi = Math.min(bTickHi, p.tickUpper);
      if (oLo < oHi && sqrtP) {
        var am = lpGetAmountsForLiquidity(sqrtP, lpSqrtAtTick(Math.round(oLo)), lpSqrtAtTick(Math.round(oHi)), p.liquidity);
        ethW += pairIsC0 ? am.amount0 : am.amount1; revW += pairIsC0 ? am.amount1 : am.amount0;
      }
    });
    bands.push({ mid: mid, pLo: pLo, pHi: pHi, liq: liq, eth: ethW, rev: revW });
  }
  var maxL = Math.max.apply(null, bands.map(function (b) { return b.liq; })) || 1;
  // viewBox aspect ≈ the container (left column ≈ 300px) so the SVG scales ~uniformly — otherwise the
  // <text> labels render horizontally stretched/thin under preserveAspectRatio="none".
  var W = 300, H = 150, padL = 0, padR = 0, labelH = 20, padT = 4, padB = 24;
  var plotTop = padT + labelH, plotW = W - padL - padR, plotH = H - plotTop - padB;
  var xOf = function (price) { return padL + ((Math.log(price) - lmin) / span) * plotW; };
  var bw = plotW / N, svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="lp-depth-svg" preserveAspectRatio="none" role="img" aria-label="Pool liquidity by price band">';
  for (var j = 0; j < N; j++) {
    if (bands[j].liq <= 0) continue;
    var h = (bands[j].liq / maxL) * plotH, x = padL + j * bw;
    var color = (amm && bands[j].mid < amm) ? '#6ec4c4' : '#cca080'; // below price: teal-light, above: orange-light
    svg += '<rect x="' + x.toFixed(1) + '" y="' + (plotTop + plotH - h).toFixed(1) + '" width="' + Math.max(0.5, bw - 0.5).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + color + '" opacity="0.5"/>';
  }
  // Markers: dashed line spans the bars; label sits in the row ABOVE the bars (no overlap).
  function marker(price, color, label) {
    if (!(price > 0) || price < pmin * (1 - 1e-9) || price > pmax * (1 + 1e-9)) return ''; // tol: exp(log(pmin)) can round just above pmin
    var x = Math.max(0.8, Math.min(W - 0.8, xOf(price))); // full-bleed: keep edge markers fully visible
    return '<line x1="' + x.toFixed(1) + '" y1="' + plotTop + '" x2="' + x.toFixed(1) + '" y2="' + (plotTop + plotH) + '" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="3 2"/>'
      + '<text x="' + Math.max(28, Math.min(W - 28, x)).toFixed(1) + '" y="' + (padT + 12) + '" font-size="12" fill="#7d6858" text-anchor="middle">' + label + '</text>';
  }
  svg += marker(cashout, '#2c2018', 'floor');
  svg += marker(amm, '#b8602e', 'price');
  svg += marker(issuance, '#6ec4c4', 'ceiling');
  svg += '<text x="' + padL + '" y="' + (H - 7) + '" font-size="12" fill="#7d6858" text-anchor="start">' + formatPrice(Math.exp(lmin)) + '</text>';
  svg += '<text x="' + (W - padR) + '" y="' + (H - 7) + '" font-size="12" fill="#7d6858" text-anchor="end">' + formatPrice(Math.exp(lmax)) + '</text>';
  svg += '</svg>';
  var panel = el('div', 'lp-depth');
  var title = el('div', 'detail-card-title lp-depth-title'); title.textContent = 'Depth'; panel.appendChild(title);
  var holder = el('div', 'lp-depth-holder'); holder.innerHTML = svg;
  var tip = el('div', 'lp-depth-tip'); tip.style.display = 'none'; holder.appendChild(tip);
  holder.addEventListener('mousemove', function (e) {
    var rect = holder.getBoundingClientRect();
    var vx = (e.clientX - rect.left) / rect.width * W;
    var idx = Math.floor((vx - padL) / bw);
    if (idx < 0 || idx >= N) { tip.style.display = 'none'; return; }
    var b = bands[idx];
    var hasLiq = b.eth > 0n || b.rev > 0n || b.liq > 0;
    var sideTxt = amm ? (b.mid < amm ? ' | buy-side' : ' | sell-side') : '';
    // textContent, not innerHTML — `sym`/`pairSym` are project-controlled ERC-20 symbols (XSS sink otherwise).
    tip.textContent = '';
    var tipPrice = el('div', 'lp-depth-tip-price'); tipPrice.textContent = '≈ ' + formatPrice(b.mid) + ' ' + pairSym + '/' + sym + sideTxt;
    var tipAmt = el('div', 'lp-depth-tip-amt'); tipAmt.textContent = hasLiq
      ? (formatCompactTokenAmount(b.rev) + ' ' + sym + ' + ' + formatPrice(Number(b.eth) / Math.pow(10, pairDec)) + ' ' + pairSym)
      : 'no liquidity here';
    tip.appendChild(tipPrice); tip.appendChild(tipAmt);
    tip.style.display = '';
    tip.style.left = Math.max(2, Math.min(rect.width - 150, e.clientX - rect.left + 10)) + 'px';
  });
  holder.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  panel.appendChild(holder);
  return panel;
}

// Donut of LP ownership — each LP provider's share of the pooled liquidity (by ETH-value). Null if none.
function renderLpOwnersPie(lp) {
  var owners = lp.owners.filter(function (o) { return o.valueEth > 0; });
  if (!owners.length) return null;
  var total = owners.reduce(function (s, o) { return s + o.valueEth; }, 0);
  if (!(total > 0)) return null;
  var panel = el('div', 'owners-chart-panel');
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 240 240'); svg.setAttribute('class', 'owners-pie-svg'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'LP owner distribution');
  var cx = 120, cy = 120, outer = 92, inner = 54, angle = -Math.PI / 2;
  // Pink-light fill, borders distinguish slices (matches the owners donut).
  if (owners.length === 1) {
    var ring = document.createElementNS(svgNS, 'path');
    ring.setAttribute('d', donutSlicePath(cx, cy, outer, inner, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 - 0.001));
    ring.setAttribute('class', 'owners-pie-slice');
    tagPieSlice(ring, owners[0].address, isAmmAddress(owners[0].address), ' (100%)');
    svg.appendChild(ring);
  } else {
    owners.forEach(function (o) {
      var frac = o.valueEth / total; if (!(frac > 0)) return;
      var next = angle + frac * Math.PI * 2;
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', donutSlicePath(cx, cy, outer, inner, angle, next));
      path.setAttribute('class', 'owners-pie-slice');
      tagPieSlice(path, o.address, isAmmAddress(o.address), ' (' + (frac * 100).toFixed(1) + '%)');
      svg.appendChild(path); angle = next;
    });
  }
  var cA = document.createElementNS(svgNS, 'text'); cA.setAttribute('x', String(cx)); cA.setAttribute('y', '113'); cA.setAttribute('class', 'owners-pie-center owners-pie-center-main'); cA.textContent = String(owners.length); svg.appendChild(cA);
  var cB = document.createElementNS(svgNS, 'text'); cB.setAttribute('x', String(cx)); cB.setAttribute('y', '132'); cB.setAttribute('class', 'owners-pie-center owners-pie-center-sub'); cB.textContent = owners.length === 1 ? 'LP' : 'LPs'; svg.appendChild(cB);
  panel.appendChild(svg);
  attachPieHover(panel, svg);
  return panel;
}

// Tag a donut slice with the data its hover tooltip shows: address (for ENS), suffix (amount | share),
// and the composed `data-tip` text. No <title> → no slow native tooltip; the custom one reads `data-tip`.
function tagPieSlice(slice, address, isAmm, suffix) {
  slice.setAttribute('data-addr', address);
  slice.setAttribute('data-suffix', suffix);
  if (isAmm) slice.setAttribute('data-amm', '1');
  slice.setAttribute('data-tip', (isAmm ? 'AMM (Uniswap V4 pool) ' : '') + truncAddr(address) + suffix);
}
// Reverse-resolve each slice's address to an ENS name (mainnet, cached) and swap it into the tooltip.
function resolvePieEns(root) {
  var seen = {};
  root.querySelectorAll('.owners-pie-slice[data-addr]').forEach(function (s) {
    var addr = s.getAttribute('data-addr');
    if (!addr || s.getAttribute('data-amm')) return;
    var k = addr.toLowerCase();
    if (!seen[k]) seen[k] = ensNameOf(addr);
    seen[k].then(function (name) {
      if (!name) return;
      root.querySelectorAll('.owners-pie-slice[data-addr="' + addr + '"]').forEach(function (el2) {
        el2.setAttribute('data-tip', name + (el2.getAttribute('data-suffix') || ''));
      });
    });
  });
}
// Immediate styled tooltip on donut hover + pink highlight of the hovered slice. ENS names where available.
function attachPieHover(panel, svg) {
  panel.style.position = 'relative';
  var tip = el('div', 'owners-pie-tip'); tip.style.display = 'none'; panel.appendChild(tip);
  var current = null;
  function clear() { if (current) { current.classList.remove('is-hover'); current = null; } }
  svg.addEventListener('mousemove', function (e) {
    var slice = e.target && e.target.closest && e.target.closest('.owners-pie-slice');
    if (!slice) { clear(); tip.style.display = 'none'; return; }
    if (slice !== current) { clear(); slice.classList.add('is-hover'); current = slice; }
    tip.textContent = slice.getAttribute('data-tip') || '';
    tip.style.display = '';
    var r = panel.getBoundingClientRect();
    tip.style.left = Math.max(4, Math.min(e.clientX - r.left + 10, r.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, e.clientY - r.top + 10) + 'px';
  });
  svg.addEventListener('mouseleave', function () { clear(); tip.style.display = 'none'; });
  resolvePieEns(svg);
}

// Table of LP providers (mirrors the owners table) with per-LP position info: ETH, token, share.
function renderLpTable(lp, sym, chainId) {
  var owners = lp.owners.filter(function (o) { return o.valueEth > 0; });
  if (!owners.length) return null;
  var total = owners.reduce(function (s, o) { return s + o.valueEth; }, 0);
  var wrap = el('div', 'owners-table-wrap lp-pos-table-wrap');
  var table = el('div', 'owners-table lp-pos-table');
  var pairSym = (lp.pair && lp.pair.symbol) || 'ETH';
  var pairScale = Math.pow(10, (lp.pair && lp.pair.decimals) || 18);
  var head = el('div', 'owners-row owners-head');
  ['Account', pairSym, sym, 'Share'].forEach(function (h) { var c = el('span'); c.textContent = h; head.appendChild(c); });
  table.appendChild(head);
  owners.forEach(function (o) {
    var tr = el('div', 'owners-row');
    var acct = el('span', 'owners-account');
    acct.appendChild(addressNode(o.address));
    if (o.positions > 1) { var pc = el('span', 'lp-pos-count'); pc.textContent = o.positions + ' positions'; acct.appendChild(pc); }
    tr.appendChild(acct);
    var ethC = el('span', 'owners-balance'); ethC.textContent = lpTrimNum(Number(o.eth) / pairScale) + ' ' + pairSym; tr.appendChild(ethC);
    var revC = el('span', 'owners-balance'); revC.textContent = formatCompactTokenAmount(o.rev) + ' ' + sym; tr.appendChild(revC);
    var shareC = el('span'); var st = el('strong'); st.textContent = (o.valueEth / total * 100).toFixed(1) + '%'; shareC.appendChild(st); tr.appendChild(shareC);
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

// Horizontal bar of the pool's pair (ETH/USDC) vs token split (by pair-value). Null if nothing to show.
function renderLpCompositionBar(lp, sym) {
  var pairSym = (lp.pair && lp.pair.symbol) || 'ETH';
  var pairScale = Math.pow(10, (lp.pair && lp.pair.decimals) || 18);
  var ethF = Number(lp.totalEth) / pairScale;
  var revVal = (Number(lp.totalRev) / 1e18) * lp.poolPrice;
  var total = ethF + revVal;
  if (!(total > 0)) return null;
  var ethPct = ethF / total * 100, revPct = revVal / total * 100;
  var ethColor = '#6ec4c4', revColor = '#cca080'; // teal-light (pair) / orange-light (REV)
  var wrap = el('div', 'lp-bar-wrap');
  var bar = el('div', 'lp-bar');
  var s0 = el('div', 'lp-bar-seg'); s0.style.width = ethPct + '%'; s0.style.background = ethColor; s0.title = pairSym + ' ' + ethPct.toFixed(1) + '%'; bar.appendChild(s0);
  var s1 = el('div', 'lp-bar-seg'); s1.style.width = revPct + '%'; s1.style.background = revColor; s1.title = sym + ' ' + revPct.toFixed(1) + '%'; bar.appendChild(s1);
  wrap.appendChild(bar);
  var legend = el('div', 'lp-comp-legend lp-comp-legend-h');
  [[pairSym, formatPrice(ethF), ethPct, ethColor], [sym, formatCompactTokenAmount(lp.totalRev), revPct, revColor]].forEach(function (r) {
    var row = el('div', 'lp-comp-legend-row');
    var d = el('span', 'lp-comp-dot'); d.style.background = r[3]; row.appendChild(d);
    var txt = el('span'); txt.textContent = r[0] + ' ' + r[1] + ' (' + r[2].toFixed(1) + '%)'; row.appendChild(txt);
    legend.appendChild(row);
  });
  wrap.appendChild(legend);
  return wrap;
}

// Full V4 mint: derive ticks/liquidity from the range + amounts, do Permit2 approvals, then
// PositionManager.modifyLiquidities (MINT_POSITION, CLOSE c0, CLOSE c1, SWEEP native refund).
// Read-only: derive ticks, liquidity, required amounts, and the encoded modifyLiquidities calldata.
// No wallet/txs — used to build the preview before the user signs.
async function prepareAddLiquidity(opts) {
  var project = opts.project, chainId = opts.chainId;
  var acct = getAccount();
  if (!acct) throw new Error('Connect a wallet');
  var posm = POSITION_MANAGER_BY_CHAIN[chainId];
  if (!posm) throw new Error('No position manager on this chain');

  var st = await readPoolState(project, chainId);
  if (!st || !st.key) throw new Error('Pool not initialized on this chain');
  var key = st.key, sqrtP = st.sqrtP, pair = st.pair;
  var c0 = (key.currency0 || '').toLowerCase();
  var pairIsC0 = (c0 === pair.addr); // else the project token (always ERC-20) is currency0
  var pairDec = pair.decimals;
  // Map the pair/token deposit amounts (raw, in their own decimals) onto currency0/currency1 by ordering.
  var amount0 = pairIsC0 ? opts.pairAmount : opts.tokenAmount;
  var amount1 = pairIsC0 ? opts.tokenAmount : opts.pairAmount;

  var s = Number(key.tickSpacing);
  var maxUsable = Math.trunc(887272 / s) * s, minUsable = Math.trunc(-887272 / s) * s;
  // UI range is in pair-per-token (q). Pool price is raw currency1/currency0:
  //   pair=c0 → P_raw = 10^(18−pairDec)/q ;  token=c0 → P_raw = q·10^(pairDec−18).
  // ticks are monotonic in P_raw, so derive both ends and sort (order-agnostic across the two cases).
  var pRawFromQ = function (q) { return pairIsC0 ? (Math.pow(10, 18 - pairDec) / q) : (q * Math.pow(10, pairDec - 18)); };
  var tA = Math.log(pRawFromQ(opts.pa)) / Math.log(1.0001);
  var tB = Math.log(pRawFromQ(opts.pb)) / Math.log(1.0001);
  var tickLower = Math.max(minUsable, lpAlignDown(Math.floor(Math.min(tA, tB)), s));
  var tickUpper = Math.min(maxUsable, lpAlignUp(Math.ceil(Math.max(tA, tB)), s));
  if (tickUpper <= tickLower) tickUpper = Math.min(maxUsable, tickLower + s);

  var sqrtA = lpSqrtAtTick(tickLower), sqrtB = lpSqrtAtTick(tickUpper);
  var liquidity = lpGetLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1);
  if (liquidity <= 0n) throw new Error('Amounts too small for this range');
  var need = lpGetAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
  // 1% headroom over the exact requirement (SWEEP refunds unused native; Permit2/CLOSE pull the exact ERC-20).
  var amount0Max = need.amount0 + need.amount0 / 100n + 1n;
  var amount1Max = need.amount1 + need.amount1 / 100n + 1n;

  // The native side (only ever the pair, when it's ETH) is sent as msg.value; ERC-20 sides go via Permit2.
  var c0Native = pairIsC0 && pair.isNative;
  var c1Native = !pairIsC0 && pair.isNative;
  var value = c0Native ? amount0Max : (c1Native ? amount1Max : 0n);
  var erc20 = [];
  if (!c0Native && amount0Max > 1n) erc20.push({ currency: key.currency0, max: amount0Max });
  if (!c1Native && amount1Max > 1n) erc20.push({ currency: key.currency1, max: amount1Max });

  var mintParams = encodeAbiParameters(
    [
      { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] },
      { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' },
    ],
    [
      [key.currency0, key.currency1, BigInt(key.fee), BigInt(key.tickSpacing), key.hooks],
      BigInt(tickLower), BigInt(tickUpper), liquidity, amount0Max, amount1Max, acct, '0x',
    ]
  );
  var closeC0 = encodeAbiParameters([{ type: 'address' }], [key.currency0]);
  var closeC1 = encodeAbiParameters([{ type: 'address' }], [key.currency1]);
  var parts = [mintParams, closeC0, closeC1];
  var actions = '0x021212'; // MINT_POSITION, CLOSE_CURRENCY(c0), CLOSE_CURRENCY(c1)
  if (pair.isNative) {
    // Refund unused native (sent as msg.value) to the user. ERC-20 sides need no sweep (CLOSE pulls exact).
    var nativeCur = c0Native ? key.currency0 : key.currency1;
    parts.push(encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [nativeCur, acct]));
    actions = '0x02121214'; // … + SWEEP(native)
  }
  var unlockData = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, parts]);

  return {
    posm: posm, key: key, acct: acct, tickLower: tickLower, tickUpper: tickUpper,
    liquidity: liquidity, need: need, amount0Max: amount0Max, amount1Max: amount1Max, value: value,
    unlockData: unlockData, pairIsC0: pairIsC0, pair: pair, erc20: erc20,
  };
}

// Execute: a one-time exact ERC20→Permit2 approval (if needed), then a GASLESS Permit2 signature batched
// with the mint via PositionManager.multicall — so it's 2 txs + 1 instant signature instead of 3 txs.
// Returns the mint tx hash.
async function runAddLiquidityTxs(chainId, prep, onStatus) {
  var acct = getAccount();
  if (!acct) throw new Error('Connect a wallet');
  var key = prep.key, posm = prep.posm;
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet');
  var wc = await wallet.getChainId();
  if (wc !== chainId) { onStatus('Switching network…', 'pending'); await switchChain(chainId); }

  var deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  var permitDatas = [];
  var now = Math.floor(Date.now() / 1000);

  // Each ERC-20 side (the project token always; the pair too when it's USDC) needs a Permit2 allowance.
  for (var i = 0; i < (prep.erc20 || []).length; i++) {
    var side = prep.erc20[i];
    // 1. ERC20 → Permit2 (exact, bounded; only when the current allowance is short).
    var erc20Allow = await clientFor(chainId).readContract({ address: side.currency, abi: lpErc20Abi, functionName: 'allowance', args: [acct, PERMIT2_ADDRESS] });
    if (BigInt(erc20Allow) < side.max) {
      onStatus('Approving token for Permit2…', 'pending');
      await lpSendTx(chainId, { address: side.currency, abi: lpErc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, side.max] });
    }
    // 2. Permit2 → PositionManager allowance. Reuse if still valid; else sign one (gasless) and fold it
    //    into the mint multicall — no separate on-chain approval tx.
    var p2 = await clientFor(chainId).readContract({ address: PERMIT2_ADDRESS, abi: lpPermit2Abi, functionName: 'allowance', args: [acct, side.currency, posm] });
    var p2amount = BigInt(p2[0]), p2exp = Number(p2[1]), p2nonce = Number(p2[2]);
    if (!(p2amount >= side.max && p2exp > now)) {
      onStatus('Sign token approval…', 'pending');
      var permitMessage = {
        details: { token: side.currency, amount: side.max, expiration: BigInt(now + 30 * 24 * 3600), nonce: BigInt(p2nonce) },
        spender: posm,
        sigDeadline: BigInt(now + 1800),
      };
      var signature = await wallet.signTypedData({
        account: acct,
        domain: { name: 'Permit2', chainId: chainId, verifyingContract: PERMIT2_ADDRESS },
        types: LP_PERMIT2_TYPES,
        primaryType: 'PermitSingle',
        message: permitMessage,
      });
      permitDatas.push(encodeFunctionData({ abi: lpPositionManagerAbi, functionName: 'permit', args: [acct, permitMessage, signature] }));
    }
  }

  onStatus('Adding liquidity…', 'pending');
  if (permitDatas.length) {
    var mintData = encodeFunctionData({ abi: lpPositionManagerAbi, functionName: 'modifyLiquidities', args: [prep.unlockData, deadline] });
    return lpSendTx(chainId, { address: posm, abi: lpPositionManagerAbi, functionName: 'multicall', args: [permitDatas.concat([mintData])], value: prep.value });
  }
  return lpSendTx(chainId, { address: posm, abi: lpPositionManagerAbi, functionName: 'modifyLiquidities', args: [prep.unlockData, deadline], value: prep.value });
}

// Build the "exact transaction" preview payload (mirrors the Pay confirm), for openTxConfirm.
function buildAddLiquidityPayload(chainId, chainName, sym, prep) {
  var pair = prep.pair || { symbol: 'ETH', decimals: 18, isNative: true };
  // amount0Max/amount1Max are currency-ordered; map back to pair vs project token for display.
  var pairMax = prep.pairIsC0 ? prep.amount0Max : prep.amount1Max;
  var tokenMax = prep.pairIsC0 ? prep.amount1Max : prep.amount0Max;
  return {
    chain: chainName,
    chainId: chainId,
    contract: 'Uniswap V4 PositionManager',
    address: prep.posm,
    'function': 'modifyLiquidities',
    value: prep.value > 0n ? (prep.value.toString() + ' wei (' + formatEth(prep.value) + ')') : '0',
    erc20Approvals: (prep.erc20 || []).map(function (s) {
      return { token: s.currency, via: 'Permit2', spender: prep.posm, amount: s.max.toString() };
    }),
    position: {
      actions: pair.isNative ? 'MINT_POSITION, CLOSE, CLOSE, SWEEP (0x02121214)' : 'MINT_POSITION, CLOSE, CLOSE (0x021212)',
      poolFee: Number(prep.key.fee),
      hooks: prep.key.hooks,
      tickLower: prep.tickLower,
      tickUpper: prep.tickUpper,
      liquidity: prep.liquidity.toString(),
      ['max' + pair.symbol]: formatBalance(pairMax, pair.decimals, pair.symbol),
      maxToken: formatTokens(tokenMax) + ' ' + sym,
      recipient: prep.acct,
    },
    args: { unlockData: prep.unlockData, deadline: 'set at signing (~20 min)' },
  };
}

function buildAddLiquidityModal(project) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'modal-body');
  var lpChains = (project.chains || []).filter(function (c) { return POSITION_MANAGER_BY_CHAIN[c.id] && POOL_MANAGER_BY_CHAIN[c.id]; });
  if (!lpChains.length) {
    var n = el('div', 'modal-status'); n.textContent = 'No Uniswap V4 position manager on this project’s chains.'; wrap.appendChild(n); return wrap;
  }
  // Issuance ceiling = ETH per token at the current issuance weight (the top of the AMM band).
  var weight = project.ruleset ? Number(project.ruleset.weight) : 0;
  var ceiling = weight > 0 ? 1e18 / weight : 0;
  // ethBal holds the PAIR-token balance (native ETH or USDC); pair is the resolved accounting/pair token.
  var state = { chainId: lpChains[0].id, poolP: 0, floor: 0, ceiling: ceiling, revBal: null, ethBal: null, driver: null, pair: { addr: ZERO_ADDRESS, decimals: 18, symbol: 'ETH', isNative: true } };
  function pairSym() { return state.pair.symbol; }
  function pairDec() { return state.pair.decimals; }

  var intro = el('div', 'modal-balance');
  intro.textContent = 'Seed the buyback pool so payers can route through the AMM. Liquidity is added at the current pool price.';
  wrap.appendChild(intro);

  var lbl0 = el('div', 'modal-label'); lbl0.textContent = 'Chain'; wrap.appendChild(lbl0);
  var chainSel = el('select', 'ops-select');
  chainSel.style.maxWidth = '100%'; chainSel.style.borderRight = '2px solid var(--write)';
  lpChains.forEach(function (c) { var o = document.createElement('option'); o.value = String(c.id); o.textContent = c.name; chainSel.appendChild(o); });
  chainSel.addEventListener('change', function () { state.chainId = Number(chainSel.value); refreshPair(); });
  wrap.appendChild(chainSel);

  var balLine = el('div', 'modal-balance'); balLine.style.marginTop = '8px'; wrap.appendChild(balLine);
  var priceLine = el('div', 'modal-balance'); wrap.appendChild(priceLine);

  // Number-line of where the selected range sits relative to floor / pool price / issuance ceiling.
  var graphWrap = el('div', 'lp-graph'); wrap.appendChild(graphWrap);

  var lblR = el('div', 'modal-label'); lblR.textContent = 'Price range (ETH per ' + sym + ')'; wrap.appendChild(lblR);
  var rnote = el('div', 'modal-balance'); rnote.textContent = 'Defaults span the current cash-out floor to the issuance ceiling.'; wrap.appendChild(rnote);
  var rangeRow = el('div', 'ops-rangerow');
  var minField = el('div', 'ops-field ops-field--grow');
  var minInput = el('input', 'ops-amount'); minInput.type = 'number'; minInput.placeholder = 'Min'; minField.appendChild(minInput);
  rangeRow.appendChild(minField);
  var toSpan = el('span', 'ops-between'); toSpan.textContent = 'to'; rangeRow.appendChild(toSpan);
  var maxField = el('div', 'ops-field ops-field--grow');
  var maxInput = el('input', 'ops-amount'); maxInput.type = 'number'; maxInput.placeholder = 'Max'; maxField.appendChild(maxInput);
  rangeRow.appendChild(maxField);
  wrap.appendChild(rangeRow);
  minInput.addEventListener('input', onRangeChange);
  maxInput.addEventListener('input', onRangeChange);

  // Token + ETH amounts — editing one auto-fills the other at the current price within the range.
  // Both sides share one row (two columns).
  var addGrid = el('div', 'lp-add-grid'); wrap.appendChild(addGrid);
  var tokCol = el('div', 'lp-add-col'); addGrid.appendChild(tokCol);
  var tokHead = el('div', 'lp-add-head'); tokCol.appendChild(tokHead);
  var lbl1 = el('div', 'modal-label'); lbl1.textContent = sym + ' to add'; tokHead.appendChild(lbl1);
  var tokMax = el('button', 'lp-max'); tokMax.textContent = 'Max'; tokHead.appendChild(tokMax);
  var tokField = el('div', 'ops-field ops-field--grow');
  var tokAmt = el('input', 'ops-amount'); tokAmt.type = 'number'; tokAmt.placeholder = '0.00'; tokField.appendChild(tokAmt);
  var tu = el('span', 'ops-unit'); tu.textContent = sym; tokField.appendChild(tu); tokCol.appendChild(tokField);

  var ethCol = el('div', 'lp-add-col'); addGrid.appendChild(ethCol);
  var ethHead = el('div', 'lp-add-head'); ethCol.appendChild(ethHead);
  var lbl2 = el('div', 'modal-label'); lbl2.textContent = 'ETH to add'; ethHead.appendChild(lbl2);
  var ethMax = el('button', 'lp-max'); ethMax.textContent = 'Max'; ethHead.appendChild(ethMax);
  var ethField = el('div', 'ops-field ops-field--grow');
  var ethAmt = el('input', 'ops-amount'); ethAmt.type = 'number'; ethAmt.placeholder = '0.00'; ethField.appendChild(ethAmt);
  var eu = el('span', 'ops-unit'); eu.textContent = 'ETH'; ethField.appendChild(eu); ethCol.appendChild(ethField);

  var pairNote = el('div', 'modal-balance'); pairNote.style.marginTop = '6px';
  wrap.appendChild(pairNote);

  // Re-label everything that names the pair token (range unit, second amount, ratio note) once it's known.
  function applyPairLabels() {
    var ps = pairSym();
    lblR.textContent = 'Price range (' + ps + ' per ' + sym + ')';
    lbl2.textContent = ps + ' to add';
    eu.textContent = ps;
    pairNote.textContent = 'Concentrated liquidity is deposited as a fixed ' + sym + ':' + ps + ' ratio set by the current pool '
      + 'price within your range — so entering one side fills the other. The ratio shifts as you move the range: '
      + 'when the pool price sits near the top of your range the deposit is mostly ' + sym + ', near the bottom mostly ' + ps + '.';
  }
  applyPairLabels();

  tokAmt.addEventListener('input', function () { state.driver = 'tok'; autofill(); });
  ethAmt.addEventListener('input', function () { state.driver = 'eth'; autofill(); });
  tokMax.addEventListener('click', function () {
    if (state.revBal == null) { connect(); return; }
    tokAmt.value = formatAmount(state.revBal, 18); state.driver = 'tok'; autofill();
  });
  ethMax.addEventListener('click', function () {
    if (state.ethBal == null) { connect(); return; }
    // Keep ~0.001 ETH for gas only when the pair IS native ETH; an ERC-20 pair (USDC) can go to the brim.
    var buf = state.pair.isNative ? 1000000000000000n : 0n;
    var v = state.ethBal > buf ? state.ethBal - buf : 0n;
    ethAmt.value = formatAmount(v, pairDec()); state.driver = 'eth'; autofill();
  });

  var status = el('div', 'modal-status'); wrap.appendChild(status);
  var foot = el('div', 'modal-foot');
  var btn = document.createElement('button'); btn.className = 'modal-submit'; btn.textContent = 'Add liquidity';
  foot.appendChild(btn); wrap.appendChild(foot);

  function currentRange() {
    var pa = parseFloat(minInput.value), pb = parseFloat(maxInput.value);
    return { pa: pa > 0 ? pa : 0, pb: pb > 0 ? pb : 0 };
  }
  function drawGraph() {
    var r = currentRange();
    graphWrap.innerHTML = renderLpRangeSvg(state.floor, state.ceiling, state.poolP, r.pa, r.pb);
  }
  function autofill() {
    var r = currentRange();
    if (state.driver === 'eth') {
      var eth = parseFloat(ethAmt.value);
      if (!(eth > 0)) { tokAmt.value = ''; return; }
      var tok = lpCounterpart(eth, true, state.poolP, r.pa, r.pb);
      if (tok != null) tokAmt.value = lpTrimNum(tok);
    } else if (state.driver === 'tok') {
      var t = parseFloat(tokAmt.value);
      if (!(t > 0)) { ethAmt.value = ''; return; }
      var e = lpCounterpart(t, false, state.poolP, r.pa, r.pb);
      if (e != null) ethAmt.value = lpTrimNum(e);
    }
  }
  function onRangeChange() { drawGraph(); autofill(); }

  // Resolve the pair (accounting) token for the selected chain, then refresh labels, balances, and price.
  function refreshPair() {
    lpPairFor(project, state.chainId).then(function (p) {
      state.pair = p; applyPairLabels();
      refreshBalances(); refreshPrice();
    });
  }

  function refreshBalances() {
    var acct = getAccount && getAccount();
    if (!acct) { balLine.textContent = 'Connect a wallet to see your balance.'; state.revBal = null; state.ethBal = null; return; }
    balLine.textContent = 'Your balance: …';
    var pairTokenAddr = state.pair.isNative ? NATIVE_TOKEN : state.pair.addr;
    Promise.all([readUserBalance(project, state.chainId), readWalletTokenBalance(state.chainId, pairTokenAddr, acct)]).then(function (r) {
      state.revBal = r[0]; state.ethBal = r[1];
      balLine.textContent = 'Your balance: ' + (r[0] != null ? formatTokens(r[0]) : '—') + ' ' + sym
        + ' | ' + (r[1] != null ? formatBalance(r[1], pairDec(), pairSym()) : '—');
    });
  }

  function refreshPrice() {
    priceLine.textContent = 'Pool price: …';
    Promise.all([readAmmPrice(project, state.chainId), readCashoutPrice(project, state.chainId)]).then(function (res) {
      var amm = res[0], floor = res[1];
      state.poolP = (amm && amm > 0) ? amm : 0;
      state.floor = (floor && floor > 0) ? floor : 0;
      priceLine.textContent = amm ? ('Pool price: ~' + formatPrice(amm) + ' ' + pairSym() + ' / ' + sym) : 'Pool not initialized on this chain.';
      var hasFloor = state.floor > 0;
      var poolP = state.poolP > 0 ? state.poolP : (ceiling > 0 ? ceiling / 10 : 0);
      var minDefault;
      if (hasFloor) minDefault = state.floor;
      else if (poolP > 0 && ceiling > poolP) { var mirror = 2 * poolP - ceiling; minDefault = mirror > 0 ? mirror : poolP * 0.1; }
      else minDefault = poolP;
      if (minDefault > 0) minInput.value = formatPrice(minDefault);
      if (ceiling > 0) maxInput.value = formatPrice(ceiling);
      rnote.textContent = hasFloor
        ? 'Defaults span the current cash-out floor to the issuance ceiling.'
        : 'No cash-out value yet — Min mirrors the gap up to the issuance ceiling on the downside; Max is the ceiling.';
      onRangeChange();
    });
  }

  refreshPair();

  btn.addEventListener('click', function () {
    if (!(getAccount && getAccount())) { connect(); return; }
    var pairAmount, tokenAmount;
    try { pairAmount = ethAmt.value ? parseAmount(ethAmt.value, pairDec()) : 0n; } catch (_) { status.className = 'modal-status error'; status.textContent = 'Invalid ' + pairSym() + ' amount'; return; }
    try { tokenAmount = tokAmt.value ? parseAmount(tokAmt.value, 18) : 0n; } catch (_) { status.className = 'modal-status error'; status.textContent = 'Invalid ' + sym + ' amount'; return; }
    if (pairAmount <= 0n && tokenAmount <= 0n) { status.className = 'modal-status error'; status.textContent = 'Enter an amount'; return; }
    var r = currentRange();
    if (!(r.pa > 0) || !(r.pb > r.pa)) { status.className = 'modal-status error'; status.textContent = 'Set a valid price range'; return; }
    btn.disabled = true;
    status.className = 'modal-status'; status.textContent = 'Preparing…';
    var lpOpts = { project: project, chainId: state.chainId, pairAmount: pairAmount, tokenAmount: tokenAmount, pa: r.pa, pb: r.pb };
    prepareAddLiquidity(lpOpts).then(function (prep) {
      btn.disabled = false;
      status.textContent = '';
      var chainName = (lpChains.filter(function (c) { return c.id === state.chainId; })[0] || {}).name || ('Chain ' + state.chainId);
      // Show the exact transaction before signing — same confirm modal as the Pay flow.
      openTxConfirm(buildAddLiquidityPayload(state.chainId, chainName, sym, prep), function (ctx) {
        ctx.confirm.disabled = true; ctx.cancel.disabled = true;
        runAddLiquidityTxs(state.chainId, prep, function (m, kind) { ctx.showStatus(m, kind); }).then(function (hash) {
          ctx.modal.close();
          status.className = 'modal-status success';
          status.innerHTML = '';
          status.appendChild(document.createTextNode('Liquidity added | TX: '));
          status.appendChild(renderExplorerTxLink(state.chainId, hash, truncAddr(hash)));
          refreshBalances(); refreshPrice();
        }).catch(function (e) {
          ctx.confirm.disabled = false; ctx.cancel.disabled = false;
          var msg = errMessage(e, 'Add liquidity failed');
          ctx.showStatus(msg.length > 160 ? msg.slice(0, 160) + '…' : msg, 'error');
        });
      }, { title: 'Confirm add liquidity', confirmText: 'Confirm & add liquidity', closeOnConfirm: false });
    }).catch(function (e) {
      btn.disabled = false;
      status.className = 'modal-status error';
      var msg = errMessage(e, 'Could not prepare');
      status.textContent = msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
    });
  });
  return wrap;
}

function opsRow(c, s, b, u, isHead, isTotal, chainId) {
  // `u === undefined` → 3-column row (e.g. the You table without the Max-loan column for custom projects).
  var threeCol = (u === undefined);
  var row = el('div', 'detail-ops-row' + (threeCol ? ' detail-ops-3' : '') + (isHead ? ' detail-ops-head' : '') + (isTotal ? ' detail-ops-total' : ''));
  (threeCol ? [c, s, b] : [c, s, b, u]).forEach(function (v, i) {
    var cell = el('span', 'detail-ops-cell');
    if (i === 0 && chainId != null) {
      cell.classList.add('detail-ops-chain');
      cell.appendChild(chainLogo(chainId, c));
      cell.appendChild(document.createTextNode(c));
    } else if (v && typeof v === 'object' && v.lines) {
      // { lines: [...] } — one value per line (per-token balance). A line may be a plain string OR a
      // { main, sub } pair, where `sub` renders as the same muted sub-line the Supply column uses.
      v.lines.forEach(function (ln, li) {
        if (li) cell.appendChild(document.createElement('br'));
        if (ln && typeof ln === 'object') {
          cell.appendChild(document.createTextNode(ln.main));
          if (ln.sub) { var s2 = el('span', 'detail-ops-sub'); s2.textContent = ln.sub; cell.appendChild(s2); }
        } else { cell.appendChild(document.createTextNode(ln)); }
      });
    } else if (v && typeof v === 'object') {
      // { main, sub } — main value with a muted secondary (e.g. a share-of-total percentage).
      cell.appendChild(document.createTextNode(v.main));
      if (v.sub) { var sub = el('span', 'detail-ops-sub'); sub.textContent = v.sub; cell.appendChild(sub); }
    } else {
      cell.textContent = v;
    }
    row.appendChild(cell);
  });
  return row;
}

// A part's share of a total, formatted as a percent with adaptive precision (so tiny chains still read).
function pctOf(part, total) {
  if (part == null || !total || total === 0n) return null;
  var pct = Number(part * 100000000n / total) / 1000000; // percent, 6-dec internal precision
  if (pct === 0) return '0%';
  var dec = pct >= 1 ? 2 : pct >= 0.001 ? 3 : 4;
  return pct.toFixed(dec) + '%';
}

function fetchOps(project) {
  var pid = BigInt(project.id);
  var chains = (project.chains && project.chains.length) ? project.chains : DISCOVER_CHAINS;
  return Promise.all(chains.map(function (chain) {
    var cid = chain.id;
    var terminal = getAddress('JBMultiTerminal', cid);
    return Promise.all([
      read(cid, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return null; }),
      // Undistributed reserved tokens count toward the effective supply (the cash-out denominator and the
      // sucker's gossiped total both include them) — add them so Composition matches reality.
      read(cid, 'JBController', pendingReservedAbi, 'pendingReservedTokenBalanceOf', [pid]).catch(function () { return 0n; }),
      // Balance is held in the chain's accounting token (USDC/ETH), not necessarily native ETH.
      terminal ? resolveAcctToken(cid, pid) : Promise.resolve({ address: NATIVE_TOKEN, decimals: 18, symbol: 'ETH' }),
    ]).then(function (res) {
      var supply = res[0] != null ? (toBigInt(res[0]) + toBigInt(res[1] || 0n)) : null, acct = res[2];
      var balP = terminal
        // Actual reclaimable surplus (net of payout limit), not raw balanceOf — overstated the unit value.
        ? read(cid, 'JBTerminalStore', currentSurplusOfAbi, 'currentSurplusOf', [pid, [], [acct.address], BigInt(acct.decimals || 18), BigInt(Number(BigInt(acct.address) & 0xffffffffn))]).catch(function () { return null; })
        : Promise.resolve(null);
      // All accounting tokens this chain holds (a project can settle in ETH + USDC).
      var toksP = terminal ? readChainBalances(cid, pid).then(function (cr) { return cr.tokens; }).catch(function () { return []; }) : Promise.resolve([]);
      return Promise.all([balP, toksP]).then(function (arr) {
        var balance = arr[0], tokens = arr[1];
        // Unit value = reclaim for 1 token at current supply + surplus; only meaningful once there's at
        // least a token of supply. No currency conversion → no price-feed revert.
        if (supply && supply >= ONE_TOKEN && balance != null) {
          return read(cid, 'JBTerminalStore', reclaimableAbi, 'currentReclaimableSurplusOf', [pid, ONE_TOKEN, supply, balance])
            .then(function (uv) { return { id: cid, name: chain.name, supply: supply, balance: balance, tokens: tokens, unitValue: uv, acct: acct }; })
            .catch(function () { return { id: cid, name: chain.name, supply: supply, balance: balance, tokens: tokens, unitValue: null, acct: acct }; });
        }
        return { id: cid, name: chain.name, supply: supply, balance: balance, tokens: tokens, unitValue: null, acct: acct };
      });
    });
  }));
}

function emptyCard(title, message) {
  var card = el('div', 'detail-card');
  var t = el('div', 'detail-card-title');
  t.textContent = title;
  card.appendChild(t);
  var body = el('div', 'detail-card-body');
  body.textContent = message;
  card.appendChild(body);
  return card;
}

function kvRow(key, value) {
  var row = el('div', 'detail-ruleset-row');
  var k = el('span', 'detail-ruleset-key');
  k.textContent = key;
  row.appendChild(k);
  var v = el('span', 'detail-ruleset-val');
  v.textContent = value;
  row.appendChild(v);
  return row;
}

// A ruleset-detail row whose key is a node (a split recipient) and value is a percentage.
function splitConfigRow(recipientNode, pct) {
  var row = el('div', 'detail-ruleset-row');
  var k = el('span', 'detail-ruleset-key'); k.appendChild(recipientNode); row.appendChild(k);
  var v = el('span', 'detail-ruleset-val'); v.textContent = (Math.round(pct * 100) / 100) + '%'; row.appendChild(v);
  return row;
}

