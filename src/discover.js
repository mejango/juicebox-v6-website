// src/discover.js
// Discover tab: live project cards + detail page, read directly from the V6 contracts.
// No indexer dependency — every value here is an on-chain read via component-base's
// executeRead. Projects 1–7 are the canonical V6 set deployed across the testnets.

import { createPublicClient, http, keccak256, encodeAbiParameters, encodeFunctionData } from 'viem';
import { el, getAddress, formatAmount, parseAmount, truncAddr, getAccount, connect, executeTransaction, getWalletClient, switchChain, onWalletChange } from './component-base.js';
import { CHAINS, getCustomRpc, getChainTokens } from './chain.js';
import { computePayPreview, formatTokenCount, renderRoutingTag, renderAmmSub, shortHex } from './pay-preview.js';
import { bendystrawQuery } from './bendystraw-client.js';
import { encodeCalldata } from './encoding.js';

// One batched client per chain. `batch.multicall` makes viem fold all the concurrent
// readContract calls (7 projects × ~7 reads) into a couple of Multicall3 requests, so a
// public RPC doesn't rate-limit (429) the burst.
var _clients = {};
function clientFor(chainId) {
  if (_clients[chainId]) return _clients[chainId];
  var chain = CHAINS[chainId];
  if (!chain) throw new Error('Unknown chain ' + chainId);
  var customRpc = getCustomRpc(chainId);
  // viem's default mainnet RPC (eth.merkle.io) blocks browser CORS, which breaks ENS reverse
  // lookups. Fall back to a CORS-enabled public endpoint for mainnet unless a custom one is set.
  var rpc = customRpc || (chainId === 1 ? 'https://ethereum-rpc.publicnode.com' : undefined);
  var client = createPublicClient({
    chain: chain,
    transport: http(rpc),
    batch: { multicall: { wait: 32 } },
  });
  _clients[chainId] = client;
  return client;
}

// The V6 contracts are deployed (same CREATE2 addresses) on these testnets. Default to the
// first; the selector lets a viewer switch chains.
var DISCOVER_CHAINS = [
  { id: 11155111, name: 'Sepolia', short: 'Eth' },
  { id: 421614, name: 'Arbitrum Sepolia', short: 'Arb' },
  { id: 84532, name: 'Base Sepolia', short: 'Base' },
  { id: 11155420, name: 'OP Sepolia', short: 'OP' },
];

var IPFS_GATEWAY = 'https://jbm.infura-ipfs.io/ipfs/';
var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
var NATIVE_TOKEN = '0x000000000000000000000000000000000000EEEe';

var LOGO_COLORS = ['#1a8a8a','#3d7a5a','#c43550','#2c2018','#b8602e','#6ec4c4','#82b89e'];
function logoColor(id) { return LOGO_COLORS[(id - 1) % LOGO_COLORS.length]; }
var OWNER_PIE_COLORS = [
  '#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896',
  '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7',
  '#bcbd22', '#dbdb8d', '#17becf', '#9edae5',
];
var BENDYSTRAW_VERSION = 6;
var OWNERS_PAGE_SIZE = 250;
var OWNERS_MAX_PARTICIPANTS = 1000;
var AUTO_ISSUE_PAGE_SIZE = 250;
var AUTO_ISSUE_MAX_EVENTS = 1000;
var PRICE_HISTORY_PAGE_SIZE = 1000;
var PRICE_HISTORY_MAX_POINTS = 3000;
var ACTIVITY_PAGE_SIZE = 10;
var BRIDGE_TX_PAGE_SIZE = 20;
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

// ---- 721 NFT tiers (Shop). Verified against nana-721-hook-v6 + REVOwner.tiered721HookOf. ----
var REVO_TIERED_HOOK_ABI = [{ type: 'function', name: 'tiered721HookOf', stateMutability: 'view', inputs: [{ name: 'revnetId', type: 'uint256' }], outputs: [{ type: 'address' }] }];
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
  var revo = getAddress('REVOwner', project.chainId);
  if (!revo) return Promise.resolve(null);
  return clientFor(project.chainId).readContract({ address: revo, abi: REVO_TIERED_HOOK_ABI, functionName: 'tiered721HookOf', args: [BigInt(project.id)] })
    .then(function (h) { return (h && !/^0x0+$/.test(h)) ? h : null; }).catch(function () { return null; });
}

// All sellable tiers for a project: { hook, idTarget, store, resolver, tiers:[...] }. Null if no shop.
// idTarget = the hook's METADATA_ID_TARGET — the address the 721 hook uses to derive the "pay" metadata id.
// It is NOT the clone hook address: METADATA_ID_TARGET is an immutable set to address(this) in the
// implementation's constructor, so for a delegatecall clone it reads back as the IMPLEMENTATION address.
// The mint metadata id MUST be keyed to this, or the hook never sees the tierIds and no NFT is minted.
async function fetchProjectTiers(project) {
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
      category: Number(t.category), encodedIpfsUri: t.encodedIpfsUri, allowOwnerMint: t.flags && t.flags.allowOwnerMint };
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
  var pick = function (j) { return { name: j.productName || j.name, image: resolveImage(j.image || j.imageUri), category: j.categoryName }; };
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
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Shop'; card.appendChild(title);
  var intro = el('div', 'detail-card-body owners-intro');
  intro.textContent = 'Mint these NFTs by paying the project — your payment also mints ' + (project.tokenSymbol || 'tokens') + ', and any overpayment becomes credits.';
  card.appendChild(intro);
  var body = el('div', 'shop-body'); card.appendChild(body);
  wrap.appendChild(card);

  var ready = shop ? Promise.resolve(shop) : fetchProjectTiers(project);
  body.textContent = 'Loading items…';
  ready.then(function (s) {
    if (!wrap.isConnected) return;
    body.innerHTML = '';
    if (!s || !s.tiers.length) { body.className = 'detail-card-body owners-empty'; body.textContent = 'No items for sale.'; return; }
    // Group tiers under category headings (juicy-vision layout), sorted by category number.
    var cats = [], seen = {};
    s.tiers.forEach(function (t) { if (!seen[t.category]) { seen[t.category] = true; cats.push(t.category); } });
    cats.sort(function (a, b) { return a - b; });
    var catNames = {}, headingEls = {}, refreshers = {};
    function catLabel(c) { return catNames[c] || (c === 0 ? 'General' : 'Category ' + c); }
    cats.forEach(function (c) {
      var group = el('div', 'shop-cat-group');
      var heading = el('div', 'shop-cat-heading'); heading.textContent = catLabel(c); group.appendChild(heading);
      headingEls[c] = heading;
      var grid = el('div', 'shop-grid'); group.appendChild(grid);
      s.tiers.filter(function (t) { return t.category === c; }).forEach(function (t) {
        grid.appendChild(renderTierCard(project, s, t, function (cat, name) {
          if (cat != null && name && !catNames[cat]) { catNames[cat] = name; if (headingEls[cat]) headingEls[cat].textContent = name; }
        }, cart, refreshers));
      });
      body.appendChild(group);
    });
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
  return wrap;
}

function renderTierCard(project, shop, tier, onCat, cart, refreshers) {
  var soldOut = tier.remaining === 0;
  var cap = (tier.initial >= 999999999) ? Infinity : tier.remaining; // unlimited tiers have no per-tx cap
  var c = el('div', 'shop-tier');
  c.setAttribute('data-tier-id', String(tier.id));
  var imgWrap = el('div', 'shop-tier-img'); var ph = el('span', 'shop-tier-ph'); ph.textContent = '#' + tier.id; imgWrap.appendChild(ph); c.appendChild(imgWrap);

  var info = el('div', 'shop-tier-info');
  var nameEl = el('div', 'shop-tier-name'); nameEl.textContent = 'Tier ' + tier.id; info.appendChild(nameEl);
  var row = el('div', 'shop-tier-row');
  var left = el('div', 'shop-tier-pricecol');
  var priceEl = el('span', 'shop-tier-price'); priceEl.textContent = formatEth(tier.price); left.appendChild(priceEl);
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
    if (m.image) { imgWrap.innerHTML = ''; var img = document.createElement('img'); img.loading = 'lazy'; img.src = m.image; img.alt = nm; imgWrap.appendChild(img); }
    if (m.category && onCat) onCat(tier.category, m.category);
  });
  return c;
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

  var foot = el('div', 'paybox-shop-foot');
  var price = el('span', 'paybox-shop-price'); price.textContent = formatEth(tier.price); foot.appendChild(price);
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
    it.title = nm + ' · ' + formatEth(tier.price);
    if (m.image) { imgWrap.innerHTML = ''; var img = document.createElement('img'); img.loading = 'lazy'; img.src = m.image; img.alt = nm; imgWrap.appendChild(img); }
  });
  return it;
}

// -- ABIs (minimal, view-only) --

var uriOfAbi = [{
  type: 'function', name: 'uriOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }],
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
var totalBalanceOfAbi = [{
  type: 'function', name: 'totalBalanceOf', stateMutability: 'view',
  inputs: [{ name: 'holder', type: 'address' }, { name: 'projectId', type: 'uint256' }],
  outputs: [{ type: 'uint256' }],
}];
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
async function readAmmPrice(project, chainId) {
  var hook = getAddress('JBBuybackHook', chainId);
  var pm = POOL_MANAGER_BY_CHAIN[chainId];
  if (!hook || !pm) return null;
  try {
    var client = clientFor(chainId);
    var key = await client.readContract({ address: hook, abi: poolKeyOfAbi, functionName: 'poolKeyOf', args: [BigInt(project.id), ZERO_ADDRESS] });
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
    var p = sp * sp; // token1 per token0 (both 18 decimals here)
    // ETH is currency0 → p = projectTokens/ETH → invert; else (project token is currency0) p = ETH/token.
    var ethPerToken = (c0 === ZERO_ADDRESS) ? (p > 0 ? 1 / p : null) : p;
    return (ethPerToken && isFinite(ethPerToken) && ethPerToken > 0) ? ethPerToken : null;
  } catch (e) { return null; }
}

// Current cash-out price (ETH reclaimed per token) — the price floor. Null when supply/surplus is 0.
async function readCashoutPrice(project, chainId) {
  var pid = BigInt(project.id);
  var terminal = getAddress('JBMultiTerminal', chainId);
  if (!terminal) return null;
  try {
    var supply = await read(chainId, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]);
    if (!supply || supply === 0n) return null;
    var bal = await read(chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, pid, NATIVE_TOKEN]);
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
var sendPayoutsAbi = [{
  type: 'function', name: 'sendPayoutsOf', stateMutability: 'nonpayable',
  inputs: [
    { name: 'projectId', type: 'uint256' }, { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' }, { name: 'currency', type: 'uint256' },
    { name: 'minTokensPaidOut', type: 'uint256' },
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
var borrowableAbi = [{
  type: 'function', name: 'borrowableAmountFrom', stateMutability: 'view',
  inputs: [
    { name: 'revnetId', type: 'uint256' },
    { name: 'collateralCount', type: 'uint256' },
    { name: 'decimals', type: 'uint256' },
    { name: 'currency', type: 'uint256' },
  ],
  // borrowableNow = min(capacity, live treasury surplus); 0 while the revnet's cash-out delay is active.
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

function stripHtml(html) {
  if (!html) return '';
  var tmp = document.createElement('div');
  tmp.innerHTML = String(html);
  return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
}

function formatEth(wei) {
  if (wei === null || wei === undefined) return '—';
  return formatTokenCount(wei) + ' ETH';
}

function formatTokens(raw) {
  if (raw === null || raw === undefined) return '—';
  // Adaptive significant digits: big numbers drop decimals (and get thousands separators),
  // small numbers keep more — see formatTokenCount.
  return formatTokenCount(raw);
}

// Append indexed volume + payment/contributor counts (Bendystraw) to a stat line. No-op when absent.
function appendIndexedStats(statLine, stats) {
  if (!stats) return;
  if (stats.volume && toBigInt(stats.volume) > 0n) {
    statLine.appendChild(document.createTextNode(' · '));
    var vStrong = el('strong'); vStrong.textContent = formatEth(toBigInt(stats.volume));
    statLine.appendChild(vStrong);
    statLine.appendChild(document.createTextNode(' raised'));
  }
  statLine.appendChild(document.createTextNode(' · '));
  var pStrong = el('strong'); pStrong.textContent = String(stats.paymentsCount);
  statLine.appendChild(pStrong);
  statLine.appendChild(document.createTextNode(stats.paymentsCount === 1 ? ' payment' : ' payments'));
  statLine.appendChild(document.createTextNode(' · '));
  var cStrong = el('strong'); cStrong.textContent = String(stats.contributorsCount);
  statLine.appendChild(cStrong);
  statLine.appendChild(document.createTextNode(stats.contributorsCount === 1 ? ' contributor' : ' contributors'));
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

var _operatorCache = {};
function addressOrNull(address) {
  if (!address || String(address).toLowerCase() === ZERO_ADDRESS.toLowerCase()) return null;
  return address;
}

async function bendystrawRevnetOperatorOf(projectId, chainId) {
  // The revnet operator = the permissionHolder flagged `isRevnetOperator`. Bendystraw's V6 reindex now sets
  // this flag (the v6-isrevnet-revowner PR), so filter on it directly — no REVOwner-address lookup needed.
  var data = await bendystrawQuery(BENDYSTRAW_PROJECT_OPERATOR_QUERY, {
    chainId: Number(chainId),
    projectId: Number(projectId),
    version: BENDYSTRAW_VERSION,
  });
  var rows = data && data.permissionHolders && data.permissionHolders.items;
  return addressOrNull(rows && rows[0] && rows[0].operator);
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


function chainById(chainId) {
  var cid = Number(chainId);
  return CHAINS[cid] ? { id: cid, name: CHAINS[cid].name } : { id: cid, name: 'Chain ' + cid };
}

// A span that shows the truncated address immediately, then upgrades to the ENS name
// (keeping the address as a tooltip) if one resolves.
function addressNode(address) {
  var span = el('span', 'detail-address');
  if (!address || address === ZERO_ADDRESS) { span.textContent = '—'; return span; }
  span.textContent = truncAddr(address);
  span.title = address;
  ensNameOf(address).then(function (name) {
    if (name) { span.textContent = name; span.title = name + '  ·  ' + address; }
  });
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

function fullAddressNode(address) {
  var wrap = el('span', 'detail-address-copy');
  var value = el('span', 'detail-full-address');
  value.textContent = address || '—';
  wrap.appendChild(value);

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
  return wrap;
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
      project.description = stripHtml(meta.description);
      project.tagline = stripHtml(meta.projectTagline || meta.tagline) || null;
      project.logoUri = meta.logoUri ? ipfsToHttp(meta.logoUri) : null;
      project.infoUri = meta.infoUri || null;
      project.tags = Array.isArray(meta.tags) ? meta.tags : [];
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
    jobs.push(read(chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminalAddr, pid, NATIVE_TOKEN])
      .then(function (s) { project.balance = s; }).catch(function () {}));
  }

  jobs.push(read(chainId, 'JBController', currentRulesetAbi, 'currentRulesetOf', [pid])
    .then(async function (result) {
      project.ruleset = result[0];
      project.metadata = result[1];
      // Reserved-token splits are keyed by the current ruleset id.
      try {
        var splits = await read(chainId, 'JBSplits', splitsOfAbi, 'splitsOf', [pid, BigInt(project.ruleset.id), RESERVED_TOKEN_SPLIT_GROUP]);
        project.reservedSplits = splits || [];
      } catch (e) { /* leave null */ }
    }).catch(function () {}));

  await Promise.all(jobs);

  if (project.isRevnet) {
    project.operator = await revnetOperatorOf(id, chainId);
  }

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
var _activeDetail = null; // { key, showTab } for the currently open project detail

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
  var m = /^([a-z0-9]+):(\d+)(?:\/([a-z0-9]+))?$/i.exec(route);
  if (!m) { showProjectGrid(true); return; }
  // Hide the grid immediately (before the async fetch) so it doesn't flash before the detail loads.
  if (_gridWrapper) _gridWrapper.style.display = 'none';
  var chainId = chainForSlug(m[1].toLowerCase());
  var id = Number(m[2]);
  var tab = m[3] ? m[3].toLowerCase() : null;
  var key = m[1].toLowerCase() + ':' + id;

  // Same project already open → just switch the tab (no re-fetch / re-render).
  if (_activeDetail && _activeDetail.key === key) {
    if (tab) _activeDetail.showTab(tab);
    return;
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
      showProjectDetail(project, tab, true);
    }).catch(function () { showProjectGrid(true); });
  });
}

function renderGrid() {
  _gridWrapper = el('div', 'discover-grid-wrapper');

  var header = el('div', 'discover-header');
  header.textContent = 'Work in progress';
  _gridWrapper.appendChild(header);

  var grid = el('div', 'discover-grid');
  _gridWrapper.appendChild(grid);
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
      var err = skeleton.querySelector('.discover-card-desc');
      if (err) err.textContent = 'Could not load this project from chain.';
    }
  });
}

function renderSkeletonCard(id) {
  var card = el('div', 'discover-card discover-card--loading');
  var head = el('div', 'discover-card-header');
  var logo = el('div', 'discover-card-logo');
  logo.textContent = '#' + id;
  logo.style.background = logoColor(id);
  head.appendChild(logo);
  var name = el('span', 'discover-card-name');
  name.textContent = 'Loading project #' + id + '…';
  head.appendChild(name);
  card.appendChild(head);
  var desc = el('div', 'discover-card-desc');
  desc.textContent = 'Reading from chain…';
  card.appendChild(desc);
  return card;
}

function renderProjectCard(project) {
  var card = el('div', 'discover-card');
  card.style.cursor = 'pointer';
  card.addEventListener('click', function () { showProjectDetail(project); });

  var cardLbl = function (text) { var s = el('span', 'discover-card-lbl'); s.textContent = text; return s; };
  var cardSep = function () { var s = el('span', 'discover-card-sep'); s.textContent = '|'; return s; };

  // Line 1: logo + name + #id.
  var head = el('div', 'discover-card-header');
  head.appendChild(renderLogo(project, 'discover-card-logo'));
  var name = el('span', 'discover-card-name');
  name.textContent = project.name;
  head.appendChild(name);
  card.appendChild(head);

  // Line 2: Type · On (chain logos).
  var meta1 = el('div', 'discover-card-meta');
  meta1.appendChild(cardLbl('Type: '));
  var typeVal = el('span', 'discover-card-val'); typeVal.textContent = project.isRevnet ? 'REVNET' : 'BASIC';
  meta1.appendChild(typeVal);
  if (project.chains && project.chains.length) {
    meta1.appendChild(cardSep());
    meta1.appendChild(cardLbl('On: '));
    var cardLogos = el('span', 'discover-chain-logos');
    project.chains.forEach(function (c) { cardLogos.appendChild(projectChainLogo(project, c)); });
    meta1.appendChild(cardLogos);
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
  stats.appendChild(statItem('Balance', formatEth(project.balance)));
  stats.appendChild(statItem('Token', project.tokenSymbol ? (project.tokenSymbol) : 'credits'));
  stats.appendChild(statItem('Token supply', formatTokens(project.totalSupply)));
  stats.appendChild(statItem('Reserved', project.metadata ? percentFromRuleset(project.metadata.reservedPercent) : '—'));
  if (project.indexedStats) {
    stats.appendChild(statItem('Volume', formatEth(toBigInt(project.indexedStats.volume || 0))));
    stats.appendChild(statItem('Payments', String(project.indexedStats.paymentsCount)));
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
  val.textContent = value;
  item.appendChild(val);
  return item;
}

// -- Navigation --

// URL-safe slug for a detail tab name (e.g. "Rulesets & Funds" → "rulesetsfunds").
function tabSlug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function projectHash(project, tabName) {
  var h = '#' + slugForChain(project._urlChainId) + ':' + project.id;
  if (tabName) h += '/' + tabSlug(tabName);
  return h;
}

function showProjectDetail(project, initialTab, fromRoute) {
  if (project._urlChainId == null) {
    project._urlChainId = defaultChainId(project.chains || [{ id: project.chainId }]);
  }
  _gridWrapper.style.display = 'none';
  var existing = _container.querySelector('.project-detail');
  if (existing) existing.remove();
  _container.appendChild(renderProjectDetail(project, initialTab));
  if (!fromRoute) routerSetHash(projectHash(project, _activeDetail && _activeDetail.current));
}

function showProjectGrid(fromRoute) {
  var detail = _container.querySelector('.project-detail');
  if (detail) detail.remove();
  _activeDetail = null;
  _gridWrapper.style.display = '';
  if (!fromRoute) routerSetHash('#discover');
}

// -- Detail Page --

function renderProjectDetail(project, initialTab) {
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

  // Auto-refresh balance/supply (+ owners via the rebuilt header) when a tx confirms in this view —
  // a bubbling 'jb:project-updated' event is dispatched by the pay/cash-out/distribute flows.
  wrap.addEventListener('jb:project-updated', function () {
    var pid = BigInt(project.id);
    var terminal = getAddress('JBMultiTerminal', project.chainId);
    Promise.all([
      terminal ? read(project.chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, pid, NATIVE_TOKEN]).catch(function () { return null; }) : Promise.resolve(null),
      read(project.chainId, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return null; }),
    ]).then(function (res) {
      if (res[0] != null) project.balance = res[0];
      if (res[1] != null) project.totalSupply = res[1];
      var fresh = renderDetailHeader(project);
      if (headerEl.parentNode) { headerEl.parentNode.replaceChild(fresh, headerEl); headerEl = fresh; }
    });
  });

  var columns = el('div', 'project-detail-columns');

  var leftCol = el('div', 'project-detail-left');
  leftCol.appendChild(renderPayCard(project, nftCart));
  leftCol.appendChild(renderActivityCard(project));
  columns.appendChild(leftCol);

  var rightCol = el('div', 'project-detail-right');
  // Sections build lazily on first view so the cross-chain "Ops" fan-out only fires when opened.
  // The price chart (revnets' issuance-price ladder) lives at the top of the About tab.
  var builders = {
    About: function () {
      var wrap = el('div');
      if (project.isRevnet && project.stages && project.stages.length) wrap.appendChild(renderPriceChart(project, project.stages));
      wrap.appendChild(renderAboutSection(project));
      return wrap;
    },
    Treasury: function () { return renderTreasurySection(project); },
    Tokens: function () { return renderTokensSection(project); },
    Owners: function () { return renderOwnersSection(project); },
    Ops: function () { return renderOpsSection(project); },
  };
  var tabs;
  if (project.isRevnet) {
    // Revnets express rules through stages (Terms) and holders through Owners (splits + auto-issuance).
    builders.Terms = function () { return renderStagesSection(project); };
    // Revnets carry the wallet actions in the Owners → "You" card, so no separate Ops tab.
    tabs = ['About', 'Terms', 'Owners'];
  } else {
    // Owned projects get a combined Rulesets & Funds view (rules timeline + balance/payouts).
    builders['Rulesets & Funds'] = function () { return renderRulesetsFundsSection(project); };
    tabs = ['About', 'Rulesets & Funds', 'Tokens', 'Ops'];
  }
  var tabRow = el('div', 'project-detail-tabs');
  var contentArea = el('div', 'project-detail-content');
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
    if (!built[tabName]) built[tabName] = builders[tabName]();
    contentArea.innerHTML = '';
    contentArea.appendChild(built[tabName]);
    var btns = tabRow.querySelectorAll('.detail-tab-btn');
    for (var b = 0; b < btns.length; b++) btns[b].classList.toggle('active', btns[b].textContent === tabName);
    if (_activeDetail) _activeDetail.current = tabName;
  }
  for (var i = 0; i < tabs.length; i++) {
    (function (tabName) {
      var btn = document.createElement('button');
      btn.className = 'detail-tab-btn';
      btn.textContent = tabName;
      btn.addEventListener('click', function () {
        showTab(tabName);
        routerSetHash(projectHash(project, tabName));
      });
      tabRow.appendChild(btn);
    })(tabs[i]);
  }
  // Shop tab: only present when the project has 721 tiers. Inject async (after "About") once detected.
  fetchProjectTiers(project).then(function (shop) {
    if (!shop || !shop.tiers.length || !wrap.isConnected || builders.Shop) return;
    builders.Shop = function () { return renderShopSection(project, shop, nftCart); };
    tabs.splice(1, 0, 'Shop');
    var sbtn = document.createElement('button');
    sbtn.className = 'detail-tab-btn'; sbtn.textContent = 'Shop';
    sbtn.addEventListener('click', function () { showTab('Shop'); routerSetHash(projectHash(project, 'Shop')); });
    var first = tabRow.querySelector('.detail-tab-btn');
    if (first && first.nextSibling) tabRow.insertBefore(sbtn, first.nextSibling); else tabRow.appendChild(sbtn);
    if (initialTab && tabSlug(initialTab) === 'shop') showTab('Shop');
  }).catch(function () {});

  rightCol.appendChild(tabRow);
  _activeDetail = { key: detailKey, showTab: showTab, current: startTab };
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
    slippageBps: 100, // AMM-route max slippage (default 1%)
    shop: null,       // { hook, tiers, ... } once the strip loads
  };
  state.token = state.tokens[0] || null;
  loadAcceptedTokens(state.chainId); // refine direct-vs-router from the project's accounting contexts

  var previewTimer = null;
  var previewGen = 0;

  function nativeToken() { return state.tokens.filter(function (t) { return t.address.toLowerCase() === NATIVE_TOKEN.toLowerCase(); })[0]; }
  function nftTierById(id) { return state.shop ? state.shop.tiers.filter(function (t) { return t.id === id; })[0] : null; }
  function nftTotalWei() {
    var s = 0n, sel = cart.entries();
    Object.keys(sel).forEach(function (id) { var t = nftTierById(Number(id)); if (t) s += t.price * BigInt(sel[id]); });
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

  // Row 1: "Pay on <chain>"  ...  <currency>
  var topRow = el('div', 'paybox-top');
  var payOn = el('div', 'paybox-payon');
  var payOnLabel = el('span', 'paybox-payon-label');
  payOnLabel.textContent = 'Pay on';
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

  // AMM-only: let the payer pick how much slippage they'll tolerate below the quote.
  function renderSlippageRow() {
    var row = el('div', 'paybox-slippage');
    var lbl = el('span', 'paybox-slippage-label'); lbl.textContent = 'Max slippage'; row.appendChild(lbl);
    [50, 100, 300, 500].forEach(function (bps) {
      var b = el('button', 'paybox-slippage-btn' + (state.slippageBps === bps ? ' active' : ''));
      b.textContent = (bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(1)) + '%';
      b.addEventListener('click', function () { state.slippageBps = bps; renderFeedback(); });
      row.appendChild(b);
    });
    return row;
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    state.preview = null;
    state.phase = 'idle';
    renderFeedback();
    previewTimer = setTimeout(loadPreview, 400);
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
      renderFeedback();
    }).catch(function () {
      if (gen !== previewGen) return;
      state.phase = 'ready';
      state.preview = null;
      renderFeedback();
    });
  }

  function doPay() {
    status.className = 'paybox-status';
    status.textContent = '';
    if (!state.amount || !state.token) { status.textContent = 'Enter an amount'; return; }
    var amt;
    try { amt = parseAmount(state.amount, state.token.decimals || 18); } catch (_) { status.textContent = 'Invalid amount'; return; }

    // Selected 721 tiers mint via the pay metadata; the amount must cover their ETH total (overpay → tokens).
    var tierIds = selectedTierIds();
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
    // Require back what the user was quoted (issuance exact; AMM minus chosen slippage). Only when the
    // preview matches the current amount; otherwise leave unprotected rather than risk a stale floor.
    var minTokens = (state.phase === 'ready') ? payMinTokens(state.preview, state.slippageBps) : 0n;
    var args = [BigInt(project.id), state.token.address, amt, beneficiary, minTokens, state.memo || '', metadata];
    var txParams = {
      chainId: state.chainId,
      address: terminal,
      abi: payAbi,
      functionName: 'pay',
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
    confirmArgs.beneficiary = beneficiary;
    confirmArgs.minReturnedTokens = minTokens.toString() + (minTokens > 0n
      ? ' (' + formatTokenCount(minTokens) + ' ' + sym
        + (state.preview && state.preview.routing === 'amm' ? ', ' + (state.slippageBps / 100) + '% max slippage' : '')
        + ')'
      : '');
    confirmArgs.memo = state.memo || '';
    confirmArgs.metadata = viaRouter ? 'Permit2 single-allowance signature (added when you sign)' : metadata;
    openPayConfirm({
      chain: chainName,
      chainId: state.chainId,
      contract: viaRouter ? 'JBRouterTerminalRegistry' : 'JBMultiTerminal',
      address: terminal,
      'function': 'pay',
      value: isNative ? (amt.toString() + ' wei (' + human + ')') : '0',
      erc20Approval: isNative ? null
        : (viaRouter
          ? { token: state.token.address, authorize: 'Permit2 signature (gasless); one-time approval to Permit2 only if needed', spender: terminal }
          : { token: state.token.address, spender: terminal, amount: amt.toString() }),
      args: confirmArgs,
    }, function send() {
      if (!viaRouter) { sendPay(txParams); return; }
      // Swap-via-router: authorize with a Permit2 signature (replaces the scary router-approve tx), then pay.
      var statusCb = function (m, kind) { status.className = 'paybox-status' + (kind === 'pending' ? ' pending' : ''); status.textContent = m; };
      buildRouterPermit2Metadata(state.chainId, state.token.address, beneficiary, terminal, amt, statusCb)
        .then(function (meta) { var p = Object.assign({}, txParams); p.args = args.slice(); p.args[6] = meta; sendPay(p); })
        .catch(function (e) { status.className = 'paybox-status error'; status.textContent = (e && (e.shortMessage || e.message)) || 'Permit2 authorization failed'; });
    });
  }

  // Render a pay status line with an Etherscan tx link once a hash exists; plain text otherwise.
  function setPayStatus(cls, message, meta) {
    status.className = cls;
    if (meta && meta.hash) {
      status.innerHTML = '';
      status.appendChild(document.createTextNode(message + ' · TX: '));
      status.appendChild(renderExplorerTxLink(meta.chainId, meta.hash, truncAddr(meta.hash)));
    } else {
      status.textContent = message;
    }
  }

  function sendPay(txParams) {
    executeTransaction(Object.assign({}, txParams, {
      onStatus: function (m, kind, meta) {
        var cls = 'paybox-status' + (kind === 'pending' ? ' pending' : '');
        if (meta && meta.phase === 'submitted') setPayStatus(cls, 'Payment processing', meta);
        else { status.className = cls; status.textContent = m; }
      },
      onSuccess: function (m, meta) {
        setPayStatus('paybox-status success', 'Payment confirmed', meta);
        status.dispatchEvent(new CustomEvent('jb:project-updated', { bubbles: true }));
      },
      onError: function (m) { status.className = 'paybox-status error'; status.textContent = m; },
    }));
  }

  renderFeedback();
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

  // Stat line: balance · supply (under the title).
  var statLine = el('div', 'detail-head-stats');
  var bStrong = el('strong'); bStrong.textContent = formatEth(project.balance);
  statLine.appendChild(bStrong);
  statLine.appendChild(document.createTextNode(' balance'));
  if (!project.isRevnet && project.tokenSymbol) {
    statLine.appendChild(document.createTextNode(' '));
    var sStrong = el('strong'); sStrong.textContent = formatTokens(project.totalSupply) + ' ' + project.tokenSymbol;
    statLine.appendChild(sStrong);
    statLine.appendChild(document.createTextNode(' supply'));
  }
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

  // Meta line: type · chains · owner/operator · site.
  var metaLine = el('div', 'detail-head-meta');
  var lbl = function (text) { var s = el('span', 'detail-head-lbl'); s.textContent = text; return s; };
  var sep = function () { var s = el('span', 'detail-head-sep'); s.textContent = '|'; return s; };
  metaLine.appendChild(lbl('Type: '));
  var typeVal = el('span', 'detail-head-val'); typeVal.textContent = project.isRevnet ? 'REVNET' : 'BASIC';
  metaLine.appendChild(typeVal);
  if (project.chains && project.chains.length) {
    metaLine.appendChild(sep());
    metaLine.appendChild(lbl('On: '));
    var logos = el('span', 'detail-chain-logos');
    for (var c = 0; c < project.chains.length; c++) logos.appendChild(projectChainLogo(project, project.chains[c]));
    metaLine.appendChild(logos);
  }
  metaLine.appendChild(sep());
  metaLine.appendChild(lbl(projectAuthorityLabel(project) + ': '));
  metaLine.appendChild(addressNode(projectAuthorityAddress(project)));
  if (project.infoUri) {
    metaLine.appendChild(sep());
    metaLine.appendChild(lbl("Site: "));
    var href = project.infoUri.indexOf('http') === 0 ? project.infoUri : ('https://' + project.infoUri);
    var a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = project.infoUri.replace(/^https?:\/\//, '');
    metaLine.appendChild(a);
  }
  header.appendChild(metaLine);
  return header;
}

// About tab: the full description + tags, then the on-chain identity details.
function renderAboutSection(project) {
  var section = el('div', 'detail-section');
  if (project.description) {
    var descCard = el('div', 'detail-card');
    var t = el('div', 'detail-card-title'); t.textContent = 'About'; descCard.appendChild(t);
    var d = el('div', 'detail-card-body detail-about-desc'); d.textContent = project.description; descCard.appendChild(d);
    section.appendChild(descCard);
  }
  section.appendChild(renderInfoPanel(project));
  return section;
}

// Left column: identity / links / owner/operator (all onchain), no fabricated pay flow.
function renderInfoPanel(project) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title');
  title.textContent = 'Info';
  card.appendChild(title);

  var grid = el('div', 'detail-info-grid');

  // Per-chain project IDs (a project can have a different ID per chain) — chain logo + name / #id,
  // the whole cell routes to the project on that chain.
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

  grid.appendChild(infoItem(projectAuthorityLabel(project), fullAddressNode(projectAuthorityAddress(project))));
  if (project.tokenAddress) grid.appendChild(infoItem('Token', fullAddressNode(project.tokenAddress)));
  if (project.infoUri) {
    var href = project.infoUri.indexOf('http') === 0 ? project.infoUri : ('https://' + project.infoUri);
    var a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = project.infoUri.replace(/^https?:\/\//, '');
    grid.appendChild(infoItem('Website', a));
  }
  card.appendChild(grid);
  return card;
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

function renderActivityCard(project) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title');
  title.textContent = 'Activity';
  card.appendChild(title);
  var body = el('div', 'detail-card-body activity-feed');
  body.textContent = 'Loading activity from Bendystraw…';
  card.appendChild(body);

  // Load the sucker map first so the feed can relabel under-the-hood sucker cash-outs as bridges.
  fetchProjectSuckerMap(project).then(function (map) {
    project._suckerMap = map;
    return fetchProjectActivity(project);
  }).then(function (rows) {
    if (!body.isConnected) return;
    body.innerHTML = '';
    if (!rows.length) {
      body.className = 'detail-card-body activity-empty';
      body.textContent = 'No indexed V6 activity yet.';
      return;
    }
    body.className = 'activity-feed';
    rows.forEach(function (row) {
      body.appendChild(renderActivityRow(row, project));
    });
  }).catch(function () {
    if (!body.isConnected) return;
    body.className = 'detail-card-body activity-empty';
    body.textContent = 'Could not load activity from Bendystraw.';
  });

  return card;
}

function renderActivityRow(row, project) {
  var item = el('div', 'activity-row');
  var avatar = el('span', 'activity-avatar');
  avatar.style.background = identGradient(row.account || row.from || row.txHash || String(row.timestamp || '0'));
  item.appendChild(avatar);

  var main = el('div', 'activity-main');
  var meta = el('div', 'activity-meta');
  meta.appendChild(renderExplorerTxLink(row.chainId, row.txHash, timeAgo(row.timestamp)));
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
  side.appendChild(chainLogo(row.chainId, chainById(row.chainId).name));
  meta.appendChild(side);
  main.appendChild(meta);

  var line = el('div', 'activity-line');
  line.appendChild(addressNode(row.account || row.from));
  line.appendChild(document.createTextNode(' ' + row.action + (row.tokenAmount ? (' ' + row.tokenAmount + ' ' + (project.tokenSymbol || 'tokens')) : '')));
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
      baseAmount: formatActivityAmount(pay.amount, 'ETH'),
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
        action: 'sent ' + formatCompactTokenAmount(toBigInt(cash.cashOutCount)) + ' ' + sym + ' to ' + moveChainName(bridgeRemote),
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
      baseAmount: formatActivityAmount(cash.reclaimAmount, 'ETH'),
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
      baseAmount: formatActivityAmount(po.amountPaidOut || po.amount, 'ETH'),
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
      type: 'auto_issue', direction: 'in', chainId: chainId,
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
      baseAmount: formatActivityAmount(bo.borrowAmount, 'ETH'),
      tokenAmount: '', action: 'borrowed against ' + formatCompactTokenAmount(toBigInt(bo.collateral)) + ' ' + sym, memo: '',
    };
  }
  if (event.repayLoanEvent) {
    var rp = event.repayLoanEvent;
    return {
      type: 'repay', direction: 'in', chainId: chainId,
      txHash: rp.txHash || event.txHash, timestamp: Number(rp.timestamp || event.timestamp),
      account: rp.from || event.from, from: rp.from || event.from,
      baseAmount: formatActivityAmount(rp.repayBorrowAmount, 'ETH'),
      tokenAmount: '', action: 'repaid loan', memo: '',
    };
  }
  if (event.liquidateLoanEvent) {
    var lq = event.liquidateLoanEvent;
    return {
      type: 'liquidate', direction: 'out', chainId: chainId,
      txHash: lq.txHash || event.txHash, timestamp: Number(lq.timestamp || event.timestamp),
      account: lq.from || event.from, from: lq.from || event.from,
      baseAmount: formatActivityAmount(lq.borrowAmount, 'ETH'),
      tokenAmount: '', action: 'loan liquidated', memo: '',
    };
  }
  if (event.mintNftEvent) {
    var nft = event.mintNftEvent;
    return {
      type: 'mint_nft', direction: 'in', chainId: chainId,
      txHash: nft.txHash || event.txHash, timestamp: Number(nft.timestamp || event.timestamp),
      account: nft.beneficiary || nft.from || event.from, from: nft.from || event.from,
      baseAmount: formatActivityAmount(nft.totalAmountPaid, 'ETH'),
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

function renderRulesSection(project) {
  var section = el('div', 'detail-section');
  if (!project.ruleset || !project.metadata) {
    section.appendChild(emptyCard('Current ruleset', 'No active ruleset found onchain.'));
    return section;
  }
  var r = project.ruleset, m = project.metadata;
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title');
  title.textContent = 'Current ruleset (cycle #' + r.cycleNumber + ')';
  card.appendChild(title);

  var rows = [
    ['Duration', formatDuration(r.duration)],
    ['Weight', formatAmount(r.weight, 18) + ' / unit'],
    ['Weight cut', (Number(r.weightCutPercent) / 10000000).toFixed(2) + '%'],
    ['Reserved %', percentFromRuleset(m.reservedPercent)],
    ['Cash out tax', percentFromRuleset(m.cashOutTaxRate)],
    ['Base currency', Number(m.baseCurrency) === 2 ? 'USD' : 'ETH'],
    ['Pay paused', m.pausePay ? 'Yes' : 'No'],
    ['Owner minting', m.allowOwnerMinting ? 'Allowed' : 'Disabled'],
    ['Data hook', m.dataHook && m.dataHook !== ZERO_ADDRESS ? truncAddr(m.dataHook) : 'None'],
  ];
  for (var i = 0; i < rows.length; i++) card.appendChild(kvRow(rows[i][0], rows[i][1]));
  section.appendChild(card);
  return section;
}

var WEIGHT_CUT_DEN = 1000000000; // 1e9

// Full decoded ruleset rows grouped by section. r = ruleset tuple, m = decoded metadata tuple.
function rulesetRows(r, m) {
  return [
    ['CYCLE', 'Duration', Number(r.duration) ? formatDuration(r.duration) : 'Not set'],
    ['CYCLE', 'Start time', formatDateTime(r.start)],
    ['CYCLE', 'Rule change deadline', (r.approvalHook && r.approvalHook !== ZERO_ADDRESS) ? truncAddr(r.approvalHook) : 'No deadline'],
    ['TOKEN', 'Total issuance rate', (Number(r.weight) === 0 ? '0' : formatAmount(r.weight, 18)) + ' / ETH'],
    ['TOKEN', 'Reserved rate', percentFromRuleset(m.reservedPercent)],
    ['TOKEN', 'Issuance cut percent', (Number(r.weightCutPercent) / 1e7).toFixed(2) + '%'],
    ['TOKEN', 'Cash out tax rate', percentFromRuleset(m.cashOutTaxRate)],
    ['TOKEN', 'Base currency', Number(m.baseCurrency) === 2 ? 'USD' : 'ETH'],
    ['TOKEN', 'Owner token minting', m.allowOwnerMinting ? 'Enabled' : 'Disabled'],
    ['TOKEN', 'Token transfers', m.pauseCreditTransfers ? 'Disabled' : 'Enabled'],
    ['OTHER RULES', 'Payments to this project', m.pausePay ? 'Disabled' : 'Enabled'],
    ['OTHER RULES', 'Hold fees', m.holdFees ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Set payment terminals', m.allowSetTerminals ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Set controller', m.allowSetController ? 'Enabled' : 'Disabled'],
    ['OTHER RULES', 'Migrate payment terminal', m.allowTerminalMigration ? 'Enabled' : 'Disabled'],
    ['EXTENSION', 'Data hook', (m.dataHook && m.dataHook !== ZERO_ADDRESS) ? truncAddr(m.dataHook) : 'None'],
    ['EXTENSION', 'Use for payments', m.useDataHookForPay ? 'Enabled' : 'Disabled'],
    ['EXTENSION', 'Use for cash outs', m.useDataHookForCashOut ? 'Enabled' : 'Disabled'],
  ];
}

function formatDateTime(sec) {
  try { return new Date(Number(sec) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch (e) { return '—'; }
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

  // ---- Rulesets viewer ----
  var rulesCard = el('div', 'detail-card');
  var headRow = el('div', 'rf-head');
  var headLeft = el('div', 'rf-headleft');
  var hTitle = el('div', 'detail-card-title'); hTitle.textContent = 'Rulesets'; hTitle.style.borderBottom = 'none'; hTitle.style.margin = '0';
  headLeft.appendChild(hTitle);
  var chainCtl = el('span', 'rf-chainctl'); headLeft.appendChild(chainCtl);
  headRow.appendChild(headLeft);
  var nav = el('div', 'rf-nav');
  var prevBtn = document.createElement('button'); prevBtn.className = 'rf-arrow'; prevBtn.textContent = '←'; prevBtn.title = 'Earlier cycle';
  var nextBtn = document.createElement('button'); nextBtn.className = 'rf-arrow'; nextBtn.textContent = '→'; nextBtn.title = 'Later cycle';
  var curToggle = document.createElement('button'); curToggle.className = 'rf-toggle'; curToggle.textContent = 'Current';
  var upToggle = document.createElement('button'); upToggle.className = 'rf-toggle'; upToggle.textContent = 'Upcoming';
  nav.appendChild(prevBtn); nav.appendChild(curToggle); nav.appendChild(upToggle); nav.appendChild(nextBtn);
  headRow.appendChild(nav);
  rulesCard.appendChild(headRow);

  var tiles = el('div', 'rf-tiles'); rulesCard.appendChild(tiles);
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
    // Tiles.
    tiles.innerHTML = '';
    tiles.appendChild(rfTile('Cycle #', String(v.r.cycleNumber)));
    tiles.appendChild(rfTile('Status', (v.r.approvalHook && v.r.approvalHook !== ZERO_ADDRESS) ? 'Approval hook' : 'Unlocked'));
    var remaining = '—';
    if (offset === 0 && Number(v.r.duration) > 0) {
      var end = Number(v.r.start) + Number(v.r.duration);
      remaining = end > now ? formatCountdown(end - now) : 'Ended';
    } else if (Number(v.r.duration) > 0) {
      remaining = formatDuration(v.r.duration);
    }
    tiles.appendChild(rfTile(offset === 0 ? 'Remaining time' : 'Ruleset duration', remaining));

    // Toggle active states.
    curToggle.classList.toggle('active', offset === 0);
    upToggle.classList.toggle('active', offset === 1);

    // Rules detail (with diff vs current when not the current cycle).
    rulesBox.innerHTML = '';
    var lbl = el('div', 'rf-cyclelabel');
    lbl.textContent = (offset === 0 ? 'Current' : (offset === 1 ? 'Upcoming' : (offset > 0 ? 'Projected (+' + offset + ')' : 'Projected (' + offset + ')'))) + ' ruleset cycle';
    rulesBox.appendChild(lbl);
    var rows = rulesetRows(v.r, v.m);
    var section_ = '';
    rows.forEach(function (row, i) {
      if (row[0] !== section_) { section_ = row[0]; var sh = el('div', 'rf-section'); sh.textContent = row[0]; rulesBox.appendChild(sh); }
      var changed = offset !== 0 && curRows[i] && curRows[i][2] !== row[2];
      rulesBox.appendChild(changed ? rfDiffRow(row[1], curRows[i][2], row[2]) : kvRow(row[1], row[2]));
    });
  }

  prevBtn.addEventListener('click', function () { offset -= 1; render(); });
  nextBtn.addEventListener('click', function () { offset += 1; ensureUpcoming(render); });
  curToggle.addEventListener('click', function () { offset = 0; render(); });
  upToggle.addEventListener('click', function () { offset = 1; ensureUpcoming(render); });

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

  // ---- Funds ----
  section.appendChild(renderFundsCard(project));
  return section;
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

function rfTile(label, value) {
  var t = el('div', 'rf-tile');
  var l = el('div', 'rf-tile-label'); l.textContent = label; t.appendChild(l);
  var v = el('div', 'rf-tile-value'); v.textContent = value; t.appendChild(v);
  return t;
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

// Funds card: balance (per chain), available to pay out, surplus, payouts + Send payouts.
function renderFundsCard(project) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Funds'; card.appendChild(title);

  // Balance (total + per chain).
  var balHead = el('div', 'rf-funds-label'); balHead.textContent = 'Balance'; card.appendChild(balHead);
  var balTotal = el('div', 'rf-funds-big'); balTotal.textContent = formatEth(project.balance); card.appendChild(balTotal);
  var perChain = el('div', 'rf-perchain'); card.appendChild(perChain);
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId, name: 'This chain' }];
  Promise.all(chains.map(function (c) {
    var terminal = getAddress('JBMultiTerminal', c.id);
    if (!terminal) return Promise.resolve({ c: c, bal: null });
    return read(c.id, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, BigInt(project.id), NATIVE_TOKEN])
      .then(function (b) { return { c: c, bal: b }; }).catch(function () { return { c: c, bal: null }; });
  })).then(function (rows) {
    var total = 0n;
    rows.forEach(function (x) {
      if (x.bal != null) total += x.bal;
      var row = el('div', 'rf-perchain-row');
      var nm = el('span', 'rf-perchain-name'); nm.appendChild(chainLogo(x.c.id, x.c.name));
      var t = el('span'); t.textContent = ' ' + x.c.name; nm.appendChild(t);
      row.appendChild(nm);
      var val = el('span', 'rf-perchain-val'); val.textContent = x.bal == null ? '—' : formatEth(x.bal); row.appendChild(val);
      perChain.appendChild(row);
    });
    balTotal.textContent = formatEth(total);
  });

  // Available to pay out + Surplus.
  var twoCol = el('div', 'rf-funds-two');
  var availCell = el('div', 'rf-funds-cell');
  var aL = el('div', 'rf-funds-label'); aL.textContent = 'Available to pay out'; availCell.appendChild(aL);
  var aV = el('div', 'rf-funds-mid'); aV.textContent = '…'; availCell.appendChild(aV);
  var surCell = el('div', 'rf-funds-cell');
  var sL = el('div', 'rf-funds-label'); sL.textContent = 'Surplus'; surCell.appendChild(sL);
  var sV = el('div', 'rf-funds-mid'); sV.textContent = '…'; surCell.appendChild(sV);
  twoCol.appendChild(availCell); twoCol.appendChild(surCell);
  card.appendChild(twoCol);

  var terminal = getAddress('JBMultiTerminal', project.chainId);
  var limits = getAddress('JBFundAccessLimits', project.chainId);
  var payoutLimitNative = 0n;
  if (limits && terminal && project.ruleset) {
    read(project.chainId, 'JBFundAccessLimits', payoutLimitsAbi, 'payoutLimitsOf',
      [BigInt(project.id), BigInt(project.ruleset.id), terminal, NATIVE_TOKEN])
      .then(function (lims) {
        (lims || []).forEach(function (l) { if (Number(l.currency) === 1) payoutLimitNative += l.amount; });
        aV.textContent = formatEth(payoutLimitNative);
        var bal = project.balance || 0n;
        sV.textContent = formatEth(bal > payoutLimitNative ? bal - payoutLimitNative : 0n);
      }).catch(function () { aV.textContent = '—'; sV.textContent = formatEth(project.balance); });
  } else { aV.textContent = formatEth(0n); sV.textContent = formatEth(project.balance); }

  // Payouts (payout-group splits) + Send payouts.
  var payHead = el('div', 'rf-funds-label'); payHead.style.marginTop = '14px'; payHead.textContent = 'Payouts'; card.appendChild(payHead);
  var payBox = el('div'); payBox.textContent = 'Reading…'; card.appendChild(payBox);
  var splitsAddr = getAddress('JBSplits', project.chainId);
  var payoutGroup = BigInt(NATIVE_TOKEN); // payout splits are keyed by uint256(uint160(token))
  if (splitsAddr && project.ruleset) {
    read(project.chainId, 'JBSplits', splitsOfAbi, 'splitsOf', [BigInt(project.id), BigInt(project.ruleset.id), payoutGroup])
      .then(function (splits) {
        payBox.innerHTML = '';
        if (!splits || !splits.length) { payBox.textContent = 'None'; return; }
        splits.forEach(function (sp) {
          var pct = Number(sp.percent) / 1e9 * 100;
          var row = el('div', 'detail-split-row');
          var nm = el('span', 'detail-split-name');
          if (Number(sp.projectId) > 0) nm.textContent = 'Project #' + sp.projectId;
          else if (sp.beneficiary && sp.beneficiary !== ZERO_ADDRESS) nm.appendChild(addressNode(sp.beneficiary));
          else nm.textContent = projectOwnerRecipientLabel(project);
          row.appendChild(nm);
          var p = el('span', 'detail-split-percent'); p.textContent = pct.toFixed(pct % 1 === 0 ? 0 : 2) + '%'; row.appendChild(p);
          payBox.appendChild(row);
        });
        var sendBtn = document.createElement('button');
        sendBtn.className = 'detail-check-btn'; sendBtn.style.marginTop = '10px'; sendBtn.textContent = 'Send payouts';
        sendBtn.addEventListener('click', function () {
          if (!(getAccount && getAccount())) { connect(); return; }
          if (!terminal) return;
          sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
          executeTransaction({
            chainId: project.chainId, address: terminal, abi: sendPayoutsAbi, functionName: 'sendPayoutsOf',
            args: [BigInt(project.id), NATIVE_TOKEN, payoutLimitNative, 1n, 0n],
            onStatus: function () {},
            onSuccess: function () { sendBtn.textContent = 'Sent √'; },
            onError: function (m) { sendBtn.disabled = false; sendBtn.textContent = 'Send payouts'; alert(m); },
          });
        });
        payBox.appendChild(sendBtn);
      }).catch(function () { payBox.textContent = 'Could not read payouts.'; });
  } else { payBox.textContent = 'None'; }

  // Recent payout distributions (Bendystraw history).
  var poHead = el('div', 'rf-funds-label'); poHead.style.marginTop = '14px'; poHead.textContent = 'Recent payouts'; card.appendChild(poHead);
  var poBox = el('div'); card.appendChild(poBox);
  appendBendystrawHistory(poBox,
    function () { return fetchProjectEventRows(BENDYSTRAW_PAYOUTS_QUERY, 'sendPayoutsEvents', project, 25); },
    function (r) {
      var v = formatEth(toBigInt(r.amountPaidOut || r.amount));
      if (r.fee && toBigInt(r.fee) > 0n) v += ' (fee ' + formatEth(toBigInt(r.fee)) + ')';
      return historyRow(Number(r.chainId), r.txHash, Number(r.timestamp), v);
    },
    'No payouts indexed yet.');

  return card;
}

function renderTreasurySection(project) {
  var section = el('div', 'detail-section');

  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title');
  title.textContent = 'Treasury';
  card.appendChild(title);
  card.appendChild(kvRow('Balance (native)', formatEth(project.balance)));
  card.appendChild(kvRow('Token supply', formatTokens(project.totalSupply)));
  card.appendChild(kvRow('Pending reserved', formatTokens(project.pendingReserved)));
  section.appendChild(card);

  // Reserved-token splits (read from JBSplits for the current ruleset).
  var splitsCard = el('div', 'detail-card');
  var splitsTitle = el('div', 'detail-card-title');
  splitsTitle.textContent = 'Reserved token recipients';
  splitsCard.appendChild(splitsTitle);
  if (project.reservedSplits && project.reservedSplits.length) {
    for (var s = 0; s < project.reservedSplits.length; s++) {
      var sp = project.reservedSplits[s];
      var pct = (Number(sp.percent) / 1e9 * 100);
      var sRow = el('div', 'detail-split-row');
      var sName = el('span', 'detail-split-name');
      if (Number(sp.projectId) > 0) sName.textContent = 'Project #' + sp.projectId;
      else if (sp.beneficiary && sp.beneficiary !== ZERO_ADDRESS) sName.appendChild(addressNode(sp.beneficiary));
      else sName.textContent = projectOwnerRecipientLabel(project);
      sRow.appendChild(sName);
      var sPct = el('span', 'detail-split-percent'); sPct.textContent = pct.toFixed(pct % 1 === 0 ? 0 : 2) + '%'; sRow.appendChild(sPct);
      splitsCard.appendChild(sRow);
    }
  } else {
    var body = el('div', 'detail-card-body');
    body.textContent = project.reservedSplits ? 'No reserved-token splits configured.' : 'Could not read splits.';
    splitsCard.appendChild(body);
  }
  section.appendChild(splitsCard);

  // RevLoans exposure (revnet-only).
  if (project.isRevnet) {
    var loanCard = el('div', 'detail-card');
    var lt = el('div', 'detail-card-title');
    lt.textContent = 'Loans (RevLoans)';
    loanCard.appendChild(lt);
    loanCard.appendChild(kvRow('Total borrowed', formatEth(project.loanBorrowed)));
    loanCard.appendChild(kvRow('Collateral locked', formatTokens(project.loanCollateral) + (project.tokenSymbol ? ' ' + project.tokenSymbol : '')));

    // Borrowable-amount quote: how much ETH a given collateral could borrow now, + the source fee.
    var qpid = BigInt(project.id);
    var q = el('div', 'detail-autoissue-row');
    var qin = document.createElement('input');
    qin.type = 'number';
    qin.className = 'field detail-autoissue-input';
    qin.placeholder = (project.tokenSymbol ? project.tokenSymbol : 'token') + ' to lock as collateral';
    q.appendChild(qin);
    var qbtn = document.createElement('button');
    qbtn.className = 'detail-check-btn';
    qbtn.textContent = 'Quote';
    q.appendChild(qbtn);
    loanCard.appendChild(q);
    var qres = el('div', 'detail-autoissue-results');
    loanCard.appendChild(qres);
    qbtn.addEventListener('click', function () {
      var v = parseFloat(qin.value);
      if (!(v > 0)) { qres.textContent = 'Enter a collateral amount.'; return; }
      qres.textContent = 'Quoting…';
      // v tokens → 18-decimal bigint (6-decimal input precision is plenty for a quote).
      var collateral = BigInt(Math.round(v * 1e6)) * 1000000000000n;
      read(project.chainId, 'REVLoans', borrowableAbi, 'borrowableAmountFrom', [qpid, collateral, 18n, 1n])
        .then(function (r) {
          qres.textContent = 'Borrowable: ' + formatAmount(r[0], 18) + ' ETH · source fee: ' + formatAmount(r[1], 18) + ' ETH';
        })
        .catch(function () { qres.textContent = 'Quote unavailable (needs a price feed / nonzero treasury).'; });
    });

    section.appendChild(loanCard);
  }

  return section;
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
  ['Stage', 'Period', 'Issuance (' + sym + '/ETH)', 'Split limit', 'Auto issuance (' + sym + ')', 'Cash out tax'].forEach(function (h) {
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
    if (isCurrent) { var cur = el('div', 'terms-sub'); cur.textContent = 'active'; c1.appendChild(cur); }
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
    var v = el('span', 'price-chip-val'); v.textContent = '…'; col.appendChild(v);
    var liq = el('span', 'price-chip-val price-chip-liq'); liq.style.display = 'none'; col.appendChild(liq);
    c.appendChild(col); c._val = v; c._liq = liq;
    if (note) c.title = note;
    return c;
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
  issChip._val.textContent = issPrice ? formatPrice(issPrice) : '—';

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
    // Plot realized AMM trade prices as a time series; extend it to the live pool price.
    if (swaps.series && swaps.series.length) {
      ammHistory = swaps.series.slice();
    }
    if (p && p > 0) {
      amm = p;
      ammHistory.push({ timestamp: now, value: p });
      ammChip.classList.remove('muted'); ammChip.classList.add('active');
      var volNote = swaps.count
        ? swaps.count + ' trade' + (swaps.count === 1 ? '' : 's') + ' · '
          + formatPrice(swaps.buyVolume + swaps.sellVolume) + ' ETH volume · '
        : '';
      ammChip.title = volNote + '~' + formatPrice(p) + ' ETH / ' + sym + ' (current pool price)';
    } else if (swaps.count) {
      ammChip.classList.remove('muted'); ammChip.classList.add('active');
      ammChip.title = swaps.count + ' trade' + (swaps.count === 1 ? '' : 's') + ' · '
        + formatPrice(swaps.buyVolume + swaps.sellVolume) + ' ETH volume';
    } else { ammChip.title = 'No pool price yet'; }
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
      if (!history.length) cashChip.title = '~' + formatPrice(f) + ' ETH / ' + sym + ' (current cash-out floor)';
    } else if (!history.length) {
      cashChip.title = 'No cash-out floor indexed yet';
    }
    if (amm || cashout || cashoutHistory.length || ammHistory.length) draw();

    // Fill the chip value subtexts (no ETH/REV unit — the chart axis carries it). AMM is one line:
    // "<price> on <x REV> + <y ETH> liq".
    var liq = (lp && (lp.totalRev > 0n || lp.totalEth > 0n))
      ? formatCompactTokenAmount(lp.totalRev) + ' ' + sym + ' + ' + formatPrice(Number(lp.totalEth) / 1e18) + ' ETH'
      : '';
    ammChip._val.textContent = amm
      ? (formatPrice(amm) + (liq ? ' on ' + liq + ' liq' : ''))
      : (swaps.count ? '—' : 'no pool yet');
    cashChip._val.textContent = cashout ? formatPrice(cashout) : '—';
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
  big.textContent = cur > 0 ? (formatRate(cur) + ' ' + sym + ' / ETH') : 'No issuance';
  card.appendChild(big);

  var now = Math.floor(Date.now() / 1000);
  if (r && cur > 0 && Number(r.weightCutPercent) > 0 && Number(r.duration) > 0) {
    var next = cur * (1e9 - Number(r.weightCutPercent)) / 1e9;
    var when = Number(r.start) + Number(r.duration) - now;
    var sub = el('div', 'issuance-sub');
    sub.textContent = 'Cuts to ' + formatRate(next) + ' ' + sym + ' / ETH in ' + (when > 0 ? formatCountdown(when) : 'the next cycle');
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
  var nowLine = (now > t0 && now < t1)
    ? '<line x1="' + X(now).toFixed(1) + '" y1="' + padT + '" x2="' + X(now).toFixed(1) + '" y2="' + (H - padB) + '" stroke="#1a8a8a" stroke-width="1.5" stroke-dasharray="4 3"/>'
      + '<text x="' + (X(now) + 4).toFixed(1) + '" y="' + (padT + 12) + '" font-size="10" fill="#1a8a8a">Today</text>'
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
    cashLine = '<path d="' + cashLine + '" fill="none" stroke="#2c2018" stroke-width="1.7"/>';
  } else if (cashoutPrice && cashoutPrice > 0) {
    cashLine = '<line x1="' + padL + '" y1="' + Y(cashoutPrice).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(cashoutPrice).toFixed(1) + '" stroke="#2c2018" stroke-width="1.5" stroke-dasharray="2 4"/>';
  }

  var y0 = new Date(t0 * 1000).getFullYear();
  var y1 = new Date(t1 * 1000).getFullYear();

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="none" class="issuance-svg">'
    + '<path d="' + area + '" fill="rgba(110,196,196,0.18)"/>'
    + '<path d="' + line + '" fill="none" stroke="#6ec4c4" stroke-width="2"/>'
    + dividers + nowLine + ammLine + cashLine
    + '<text x="' + padL + '" y="' + (H - 6) + '" font-size="10" fill="rgba(0,0,0,0.5)">' + y0 + '</text>'
    + '<text x="' + (W - padR) + '" y="' + (H - 6) + '" font-size="10" fill="rgba(0,0,0,0.5)" text-anchor="end">' + y1 + '</text>'
    + '</svg>';
  return { svg: svg, geo: { t0: t0, t1: t1, W: W, padL: padL, padR: padR } };
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
      if (floor) html += row('Cash out', floor, '#2c2018');
      wrap._tip.innerHTML = html;
      wrap._guide.style.display = ''; wrap._guide.style.left = x + 'px';
      wrap._tip.style.display = '';
      wrap._tip.style.left = Math.max(4, Math.min(rect.width - 130, x + 8)) + 'px';
    });
  }
  holder.innerHTML = c.svg;
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

function formatActivityAmount(raw, symbol) {
  var value = toBigInt(raw);
  if (value === 0n) return '0 ' + (symbol || 'ETH');
  // Adaptive truncation (same as project Balance via formatEth), not full 18-dp precision.
  return formatTokenCount(value) + ' ' + (symbol || 'ETH');
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

  var body = el('div', 'autoissue-load');
  body.textContent = 'Loading auto issuance across chains…';
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
        setConfirmStatus(ctx, (err && (err.shortMessage || err.message)) || 'Could not connect wallet', 'error');
      });
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Distributing…';
    setConfirmBusy(ctx, true);
    executeTransaction({
      chainId: row.chain.id,
      address: row.revOwnerAddr,
      abi: autoIssueForAbi,
      functionName: 'autoIssueFor',
      args: args,
      onStatus: function (m, kind) { setConfirmStatus(ctx, m, kind); },
      onSuccess: function () {
        row.remaining = 0n;
        row.distributed = true;
        btn.textContent = 'Distributed √';
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

// Owners tab (revnets): All (holder distribution), Splits (reserved splits + distribute),
// Auto issue (full cross-chain auto-issuance table). Replaces the old Tokens tab for revnets.
function renderOwnersSection(project) {
  var section = el('div', 'detail-section');
  var stages = (project.stages || []).slice().sort(function (a, b) { return Number(a.start) - Number(b.start); });

  // Reserved-token distribution history (Bendystraw): each time pending reserves were sent to splits.
  var reservedDistBox = el('div', 'detail-card-body');
  appendBendystrawHistory(reservedDistBox,
    function () { return fetchProjectEventRows(BENDYSTRAW_RESERVED_DIST_QUERY, 'sendReservedTokensToSplitsEvents', project, 25); },
    function (r) {
      return historyRow(Number(r.chainId), r.txHash, Number(r.timestamp),
        formatCompactTokenAmount(toBigInt(r.tokenCount)) + ' ' + (project.tokenSymbol || 'tokens'));
    },
    'No reserved-token distributions indexed yet.');

  // Active loans (Bendystraw RevLoans): each loan's borrow + locked collateral.
  var loansBox = el('div', 'detail-card-body');
  appendBendystrawHistory(loansBox,
    function () { return fetchProjectEventRows(BENDYSTRAW_LOANS_QUERY, 'loans', project, 25); },
    function (r) {
      var row = el('div', 'rf-perchain-row');
      var left = el('span', 'rf-perchain-name');
      left.appendChild(chainLogo(Number(r.chainId), chainById(Number(r.chainId)).name));
      var t = el('span'); t.textContent = ' #' + r.id + ' · ' + timeAgo(Number(r.createdAt)); left.appendChild(t);
      row.appendChild(left);
      var val = el('span', 'rf-perchain-val');
      val.textContent = formatEth(toBigInt(r.borrowAmount)) + ' / '
        + formatCompactTokenAmount(toBigInt(r.collateral)) + ' ' + (project.tokenSymbol || 'tokens');
      row.appendChild(val);
      return row;
    },
    'No active loans indexed.');

  // "Settlement" gets Movement as a bottom activity-feed subsection.
  var acrossWrap = el('div');
  acrossWrap.appendChild(renderAcrossChainsBody(project));
  acrossWrap.appendChild(renderBridgesSubsection(project));
  acrossWrap.appendChild(renderBridgeTransactions(project));

  // "Splits" gets the Reserved-distribution history as a bottom activity-feed subsection.
  var splitsWrap = el('div');
  splitsWrap.appendChild(renderOwnersSplits(project));
  splitsWrap.appendChild(detailSubSection('Latest distributions', reservedDistBox));

  [
    ['You', renderYouCard(project)],
    ['All', renderOwnersAll(project)],
    [null, renderOwnersAmm(project)], // null title: the AMM card supplies its own "AMM <addr>" heading
    ['Settlement', acrossWrap],
    ['Splits', splitsWrap],
    ['Auto issue', renderAutoIssuance(project, stages)],
    ['Active loans', loansBox],
  ].forEach(function (s) {
    var card = el('div', 'detail-card');
    if (s[0]) { var label = el('div', 'detail-card-title'); label.textContent = s[0]; card.appendChild(label); }
    card.appendChild(s[1]);
    section.appendChild(card);
  });
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
  + 'permissionHolders(where: { chainId: $chainId, projectId: $projectId, version: $version, isRevnetOperator: true }, limit: 1) { '
  + 'items { operator } } }';
// Buyback-hook AMM trades (V6 swapEvent model). Each buy/sell is a realized
// AMM price; mints are the issuance route, not a market trade.
var BENDYSTRAW_SWAP_EVENTS_QUERY = 'query($suckerGroupId: String!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'swapEvents(where: { suckerGroupId: $suckerGroupId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "timestamp", orderDirection: "asc", limit: $limit, offset: $offset) { '
  + 'items { timestamp direction terminalTokenAmount projectTokenAmount poolId chainId txHash } totalCount } }';
var BENDYSTRAW_PARTICIPANTS_BY_GROUP_QUERY = 'query($suckerGroupId: String!, $chainIds: [Int!], $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'participants(where: { suckerGroupId: $suckerGroupId, chainId_in: $chainIds, version: $version, balance_gt: "0" }, '
  + 'orderBy: "balance", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { address balance volume chainId projectId version suckerGroupId } totalCount } }';
var BENDYSTRAW_PARTICIPANTS_BY_PROJECT_QUERY = 'query($projectId: Int!, $chainIds: [Int!], $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'participants(where: { projectId: $projectId, chainId_in: $chainIds, version: $version, balance_gt: "0" }, '
  + 'orderBy: "balance", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { address balance volume chainId projectId version suckerGroupId } totalCount } }';
var BENDYSTRAW_STORE_AUTO_ISSUANCE_QUERY = 'query($projectId: Int!, $chainId: Int!, $limit: Int!, $offset: Int!) { '
  + 'storeAutoIssuanceAmountEvents(where: { projectId: $projectId, chainId: $chainId }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { timestamp txHash caller beneficiary stageId count } totalCount } }';
var BENDYSTRAW_AUTO_ISSUE_EVENTS_QUERY = 'query($projectId: Int!, $chainId: Int!, $limit: Int!, $offset: Int!) { '
  + 'autoIssueEvents(where: { projectId: $projectId, chainId: $chainId }, '
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
  + '{ mintNftEvent_not: null }, { deployErc20Event_not: null }, { projectCreateEvent_not: null }]';
var BENDYSTRAW_ACTIVITY_ITEM_FIELDS = 'items { id chainId timestamp txHash from type '
  + 'payEvent { amount beneficiary memo newlyIssuedTokenCount from txHash timestamp } '
  + 'cashOutTokensEvent { cashOutCount reclaimAmount holder beneficiary from txHash timestamp } '
  + 'mintTokensEvent { beneficiary beneficiaryTokenCount caller from txHash timestamp } '
  + 'sendPayoutsEvent { amount amountPaidOut fee caller from txHash timestamp } '
  + 'sendReservedTokensToSplitsEvent { tokenCount from txHash timestamp } '
  + 'autoIssueEvent { beneficiary count stageId from txHash timestamp } '
  + 'borrowLoanEvent { borrowAmount collateral beneficiary from txHash timestamp } '
  + 'repayLoanEvent { repayBorrowAmount collateralCountToReturn from txHash timestamp } '
  + 'liquidateLoanEvent { borrowAmount collateral from txHash timestamp } '
  + 'mintNftEvent { tierId tokenId beneficiary totalAmountPaid from txHash timestamp } '
  + 'deployErc20Event { symbol name token from txHash timestamp } '
  + 'projectCreateEvent { from txHash timestamp } } totalCount';
var BENDYSTRAW_ACTIVITY_EVENTS_QUERY = 'query($suckerGroupId: String!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'activityEvents(where: { suckerGroupId: $suckerGroupId, version: $version, chainId_in: $chainIds, ' + BENDYSTRAW_ACTIVITY_OR + ' }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + BENDYSTRAW_ACTIVITY_ITEM_FIELDS + ' } }';
var BENDYSTRAW_ACTIVITY_EVENTS_BY_PROJECT_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'activityEvents(where: { projectId: $projectId, version: $version, chainId_in: $chainIds, ' + BENDYSTRAW_ACTIVITY_OR + ' }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + BENDYSTRAW_ACTIVITY_ITEM_FIELDS + ' } }';
var BENDYSTRAW_SUCKER_TRANSACTIONS_QUERY = 'query($suckerGroupId: String!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'suckerTransactions(where: { suckerGroupId: $suckerGroupId, version: $version }, '
  + 'orderBy: "createdAt", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { index chainId peerChainId beneficiary projectTokenCount terminalTokenAmount status createdAt sucker token peer } totalCount } }';
var BENDYSTRAW_SUCKER_TRANSACTIONS_BY_PROJECT_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'suckerTransactions(where: { projectId: $projectId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "createdAt", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { index chainId peerChainId beneficiary projectTokenCount terminalTokenAmount status createdAt sucker token peer } totalCount } }';
// History lists (Bendystraw): payout distributions, reserved-token distributions, and loans.
var BENDYSTRAW_PAYOUTS_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'sendPayoutsEvents(where: { projectId: $projectId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { amount amountPaidOut fee timestamp txHash chainId } totalCount } }';
var BENDYSTRAW_RESERVED_DIST_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'sendReservedTokensToSplitsEvents(where: { projectId: $projectId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { tokenCount timestamp txHash chainId } totalCount } }';
var BENDYSTRAW_LOANS_QUERY = 'query($projectId: Int!, $version: Int!, $chainIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'loans(where: { projectId: $projectId, version: $version, chainId_in: $chainIds }, '
  + 'orderBy: "createdAt", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'items { id borrowAmount collateral beneficiary owner createdAt chainId } totalCount } }';

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

function renderTxHashLink(chainId, txHash) {
  var url = CHAINS[chainId] && CHAINS[chainId].blockExplorers
    && CHAINS[chainId].blockExplorers.default
    && CHAINS[chainId].blockExplorers.default.url;
  if (!url || !txHash) {
    var span = el('span');
    span.textContent = txHash ? truncAddr(txHash) : 'Distributed';
    return span;
  }
  var a = document.createElement('a');
  a.href = url.replace(/\/$/, '') + '/tx/' + txHash;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = truncAddr(txHash);
  return a;
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
    chainCell.appendChild(document.createTextNode(row.chain.name.replace(' Sepolia', '')));
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

function projectTestnetChainIds(project) {
  var chains = (project.chains && project.chains.length) ? project.chains : [{ id: project.chainId }];
  var seen = {};
  return chains.map(function (c) { return Number(c.id); }).filter(function (cid) {
    if (!CHAINS[cid] || seen[cid]) return false;
    seen[cid] = true;
    return cid !== 1 && cid !== 10 && cid !== 8453 && cid !== 42161;
  });
}

function projectBendystrawChainIds(project) {
  var source = projectTestnetChainIds(project);
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
  var result = groupId
    ? await fetchBendystrawCollectionPages(BENDYSTRAW_ACTIVITY_EVENTS_QUERY, 'activityEvents', {
      suckerGroupId: groupId,
      version: BENDYSTRAW_VERSION,
      chainIds: chainIds,
    }, ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE)
    : await fetchBendystrawCollectionPages(BENDYSTRAW_ACTIVITY_EVENTS_BY_PROJECT_QUERY, 'activityEvents', {
      projectId: Number(project.id),
      version: BENDYSTRAW_VERSION,
      chainIds: chainIds,
    }, ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE);
  return (result.items || []).map(function (event) {
    return activityRowFromEvent(event, project);
  }).filter(Boolean);
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
    await Promise.all(pairs.map(async function (p) {
      var srcSucker = p.local, R = p.remoteChainId, peerSucker = p.remote;
      var logClient = lpLogsClient(C) || clientFor(C);
      var latest; try { latest = await logClient.getBlockNumber(); } catch (_) { return; }
      var W = 45000n, windows = [];
      for (var n = 0; n < 8 && latest - BigInt(n) * W > 0n; n++) { var hi = latest - BigInt(n) * W, lo = hi > W ? hi - W + 1n : 0n; windows.push({ lo: lo, hi: hi }); if (lo === 0n) break; }
      var batches = await Promise.all(windows.map(function (w) {
        return logClient.getLogs({ address: srcSucker, event: INSERT_TO_OUTBOX_EVENT, args: { token: NATIVE_TOKEN }, fromBlock: w.lo, toBlock: w.hi }).catch(function () { return []; });
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
      try { var ob = await clientFor(C).readContract({ address: srcSucker, abi: suckerClaimAbi, functionName: 'outboxOf', args: [NATIVE_TOKEN] }); sentCount = Number(ob.numberOfClaimsSent); } catch (_) {}
      var inboxRoot = SUCKER_BYTES32_ZERO;
      try { var ib = await clientFor(R).readContract({ address: peerSucker, abi: suckerClaimAbi, functionName: 'inboxOf', args: [NATIVE_TOKEN] }); inboxRoot = (ib && ib.root) || SUCKER_BYTES32_ZERO; } catch (_) {}
      var deliveredCount = 0;
      if (!/^0x0+$/.test(inboxRoot)) Object.keys(byIndex).forEach(function (k) { if ((byIndex[k].root || '').toLowerCase() === inboxRoot.toLowerCase()) deliveredCount = Number(k) + 1; });

      // block timestamps for "Initiated"
      var ts = {};
      await Promise.all(Object.keys(blockOf).map(async function (k) { try { var blk = await logClient.getBlock({ blockNumber: blockOf[k] }); ts[k] = Number(blk.timestamp); } catch (_) { ts[k] = 0; } }));

      for (var k = 0; k < count; k++) {
        var a = byIndex[k]; if (!a) continue;
        var executed = false;
        try { var ex = await clientFor(R).readContract({ address: peerSucker, abi: suckerClaimAbi, functionName: 'executedLeafHashOf', args: [NATIVE_TOKEN, BigInt(k)] }); executed = ex && !/^0x0+$/.test(ex); } catch (_) {}
        var status, proof = null, canExecute = false;
        if (executed) status = 'claimed';
        else if (complete && k < deliveredCount && suckerBranchRoot(a.hashed, (proof = suckerLeafProof(leafHashes.slice(0, deliveredCount), k)), k).toLowerCase() === inboxRoot.toLowerCase()) status = 'claimable';
        else { status = 'pending'; proof = null; canExecute = (k >= sentCount); }
        rows.push({
          createdAt: ts[k] || 0, chainId: C, peerChainId: R, beneficiary: '0x' + String(a.beneficiary).slice(-40),
          projectTokenCount: a.projectTokenCount, terminalTokenAmount: a.terminalTokenAmount, status: status,
          index: k, sourceSucker: srcSucker, peerSucker: peerSucker, metadata: a.metadata, beneficiary32: a.beneficiary,
          proof: proof, canExecute: canExecute,
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
        chains: {},
      };
    }
    byAddress[key].balance += toBigInt(p.balance);
    byAddress[key].volume += toBigInt(p.volume);
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

// Count of unique owners (holders, deduped across chains) — matches the Owners tab. Null on failure.
async function fetchOwnersCount(project) {
  try {
    var chainIds = projectTestnetChainIds(project);
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
  var chainIds = projectTestnetChainIds(project);
  if (!chainIds.length) return { participants: [], totalCount: 0, totalSupply: 0n, totalBalance: 0n, truncated: false };

  var groupId = await resolveBendystrawSuckerGroupId(project, chainIds);
  var result = null;
  if (groupId) {
    result = await fetchBendystrawParticipantPages(BENDYSTRAW_PARTICIPANTS_BY_GROUP_QUERY, {
      suckerGroupId: groupId,
      chainIds: chainIds,
      version: BENDYSTRAW_VERSION,
    });
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
  body.textContent = 'Loading owner distribution from Bendystraw…';
  wrap.appendChild(body);
  fetchOwnersDistribution(project).then(function (data) {
    if (!body.isConnected) return;
    body.innerHTML = '';
    if (!data.participants.length || data.totalBalance === 0n) {
      body.className = 'detail-card-body owners-empty';
      body.textContent = 'No indexed owners yet. Bendystraw is testnet-only here and has not reported V6 owner balances for this project.';
      return;
    }
    body.className = 'owners-distribution';
    body.appendChild(renderOwnersPieChart(data.participants, data.totalBalance, data.totalSupply, sym));
    body.appendChild(renderOwnersTable(data.participants, data.totalSupply || data.totalBalance, sym));
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
  var loading = el('div', 'owners-load'); loading.textContent = 'Reading the buyback pool…'; wrap.appendChild(loading);
  readLpPositions(project, project.chainId).then(function (lp) {
    if (!wrap.isConnected) return;
    loading.remove();
    if (!lp) { lpHead.textContent = 'No buyback pool configured on this chain.'; return; }
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

function renderOwnersPieChart(participants, totalBalance, totalSupply, sym) {
  var panel = el('div', 'owners-chart-panel');
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 240 240');
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
    ring.appendChild(svgTitle(drawable[0], totalSupply, sym));
    svg.appendChild(ring);
  } else {
    drawable.forEach(function (row) {
      var slice = Number(row.balance) / Number(totalBalance);
      if (!isFinite(slice) || slice <= 0) return;
      var next = angle + slice * Math.PI * 2;
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', donutSlicePath(cx, cy, outer, inner, angle, next));
      path.setAttribute('class', 'owners-pie-slice');
      path.appendChild(svgTitle(row, totalSupply, sym));
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
  var total = el('div', 'owners-chart-total');
  total.textContent = formatCompactTokenAmount(totalBalance) + ' ' + sym;
  panel.appendChild(total);
  return panel;
}

function svgTitle(row, totalSupply, sym) {
  var title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = (isAmmAddress(row.address) ? 'AMM (Uniswap V4 pool) ' : '') + truncAddr(row.address) + ' · ' + formatCompactTokenAmount(row.balance) + ' ' + sym
    + ' · ' + formatOwnerPortion(row.balance, totalSupply);
  return title;
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

function renderOwnersTable(participants, totalSupply, sym) {
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
      acct.appendChild(document.createTextNode('Market '));
      var ammTag = el('span', 'owners-amm-tag'); ammTag.textContent = 'AMM';
      ammTag.title = row.address + ' — Uniswap V4 pool holding pooled LP liquidity';
      acct.appendChild(ammTag);
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
    paid.textContent = formatCompactTokenAmount(row.volume) + ' ETH';
    tr.appendChild(paid);
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

function renderOwnersSplits(project) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'splits-wrap');

  var intro = el('div', 'splits-intro');
  intro.textContent = 'Newly issued and bought back ' + sym + ' are split between these accounts. The operator can adjust the splits at any time within each stage’s permanent split limit.';
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
    limitLine.textContent = 'The split limit for this stage is ' + percentFromRuleset(md.reservedPercent) + ' of issuance.';
    tableWrap.innerHTML = ''; var loading = el('div', 'detail-card-body'); loading.textContent = 'Reading…'; tableWrap.appendChild(loading);
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
          ? (project.isRevnet
            ? 'No splits configured for this stage — reserved tokens go to REVOwner.'
            : 'No splits configured for this stage — reserved tokens go to the project owner.')
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

  stages.forEach(function (s, idx) {
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
  return wrap;
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
  chainrow.appendChild(makeChainDistribute(project, pc, hasPending, isCurrent));
  block.appendChild(chainrow);

  var table = el('div', 'splits-table');
  splits.forEach(function (sp) {
    var frac = Number(sp.percent) / 1e9;          // share of the reserved group (0..1)
    var effective = limitPct * frac;              // share of total issuance
    var ofLimit = frac * 100;                     // share of the limit
    var row = el('div', 'splits-row');
    var acct = el('span', 'splits-acct');
    if (Number(sp.projectId) > 0) acct.textContent = 'Project #' + sp.projectId;
    else if (sp.beneficiary && sp.beneficiary !== ZERO_ADDRESS) acct.appendChild(addressNode(sp.beneficiary));
    else acct.textContent = projectOwnerRecipientLabel(project);
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
        .catch(function (err) { btn.disabled = false; btn.textContent = 'Distribute'; status.className = 'modal-status splits-status error'; status.textContent = (err && (err.shortMessage || err.message)) || 'Could not connect wallet'; });
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

function renderTokensSection(project) {
  var section = el('div', 'detail-section');
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title');
  title.textContent = project.tokenSymbol ? ('Token: ' + project.tokenSymbol) : 'Token';
  card.appendChild(title);
  card.appendChild(kvRow('ERC-20', project.tokenAddress ? truncAddr(project.tokenAddress) : 'Not deployed (credits only)'));
  card.appendChild(kvRow('Total supply', formatTokens(project.totalSupply)));
  card.appendChild(kvRow('Pending reserved', formatTokens(project.pendingReserved)));
  card.appendChild(kvRow('Reserved %', project.metadata ? percentFromRuleset(project.metadata.reservedPercent) : '—'));
  section.appendChild(card);
  return section;
}

// Ops: the same project across every chain. Reads per-chain supply / native balance / unit cash-out
// value directly from each chain (one Multicall3 batch per chain), then totals supply + balance.
// The per-chain supply / native balance / unit cash-out value table (omnichain). Returns a body node
// (desc + async table) — the caller wraps it in a titled card. Shown in Owners (revnets) or Ops (others).
function renderAcrossChainsBody(project) {
  var body = el('div');
  var desc = el('div', 'detail-card-body');
  desc.textContent = 'A project can settle funds on many chains, and holders can move funds between them.';
  body.appendChild(desc);
  var status = el('div', 'detail-card-body');
  status.textContent = 'Reading across chains…';
  body.appendChild(status);
  fetchOps(project).then(function (rows) {
    status.remove();
    // Totals first, so each row can show its share of supply / balance (how relevant the chain is).
    var totSupply = 0n, totBalance = 0n;
    rows.forEach(function (r) { if (r.supply != null) totSupply += r.supply; if (r.balance != null) totBalance += r.balance; });
    var table = el('div', 'detail-ops-table');
    table.appendChild(opsRow('Chain', 'Supply', 'Balance', 'Unit value', true, false));
    rows.forEach(function (r) {
      table.appendChild(opsRow(
        r.name,
        r.supply == null ? '—' : { main: formatTokens(r.supply), sub: pctOf(r.supply, totSupply) },
        r.balance == null ? '—' : { main: formatEth(r.balance), sub: pctOf(r.balance, totBalance) },
        r.unitValue == null ? '—' : formatEth(r.unitValue),
        false, false, r.id));
    });
    table.appendChild(opsRow('Total', formatTokens(totSupply), formatEth(totBalance), '', false, true));
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
  ['Chains', 'Type'].forEach(function (label) { var c = el('span', 'detail-ops-cell'); c.textContent = label; head.appendChild(c); });
  table.appendChild(head);
  var section = detailSubSection('Bridges', table);
  fetchProjectSuckerInfra(project).then(function (routes) {
    if (!section.isConnected) return;
    if (!routes.length) { section.remove(); return; }
    routes.forEach(function (r) {
      var row = el('div', 'detail-ops-row');
      // A sucker bridges both ways — show the pair joined by a bidirectional arrow, not a From→To direction.
      var chains = el('span', 'detail-ops-cell bridge-pair');
      chains.appendChild(chainLogo(r.a, moveChainName(r.a)));
      chains.appendChild(document.createTextNode(moveChainName(r.a)));
      var arrow = el('span', 'bridge-pair-arrow');
      arrow.innerHTML = '<svg viewBox="0 0 30 12" width="30" height="12" aria-hidden="true">'
        + '<line x1="5" y1="6" x2="25" y2="6" stroke="currentColor" stroke-width="1.4"/>'
        + '<path d="M9 2.5 L4.5 6 L9 9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M21 2.5 L25.5 6 L21 9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg>';
      chains.appendChild(arrow);
      chains.appendChild(chainLogo(r.b, moveChainName(r.b)));
      chains.appendChild(document.createTextNode(moveChainName(r.b)));
      row.appendChild(chains);
      var type = el('span', 'detail-ops-cell');
      var tag = el('span', 'settlement-infra-tag settlement-infra-tag--' + r.infra.toLowerCase());
      tag.textContent = r.infra;
      type.appendChild(tag);
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
    var card = el('div', 'detail-card');
    var title = el('div', 'detail-card-title');
    title.textContent = 'Settlement';
    card.appendChild(title);
    card.appendChild(renderAcrossChainsBody(project));
    card.appendChild(renderBridgesSubsection(project));
    section.appendChild(card);
  } else {
    // Revnet bridge-transactions live under Owners → Settlement; Ops keeps just the action buttons.
    section.appendChild(renderOpsActions(project));
  }
  return section;
}

// The row of wallet actions (cash out, borrow, move, add liquidity), each opening a modal.
function opsActionsRow(project) {
  var row = el('div', 'ops-actions');
  [
    ['Cash out', function () { openModal('Cash out', buildCashOutModal(project)); }],
    ['Get a loan', function () { openModal('Get a loan', buildLoanModal(project)); }],
    ['Move between chains', function () { openModal('Move between chains', buildMoveModal(project)); }],
    ['Add liquidity', function () { openModal('Add liquidity', buildAddLiquidityModal(project)); }],
  ].forEach(function (a) {
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
    return Promise.all([
      readUserBalance(project, cid),
      read(cid, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return null; }),
      terminal ? read(cid, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, pid, NATIVE_TOKEN]).catch(function () { return null; }) : Promise.resolve(null),
    ]).then(function (res) {
      var bal = res[0], supply = res[1], surplus = res[2];
      var hasBal = bal != null && bal > 0n;
      // Cash-out value: what `bal` tokens reclaim now (native, no price feed → no revert).
      var cashJob = (hasBal && supply && supply >= bal && surplus != null)
        ? read(cid, 'JBTerminalStore', reclaimableAbi, 'currentReclaimableSurplusOf', [pid, bal, supply, surplus]).catch(function () { return null; })
        : Promise.resolve(hasBal ? null : 0n);
      // Max loan: borrowable ETH against `bal` collateral. Returns 0 while the cash-out delay is active.
      var loanJob = (hasBal && revLoans)
        ? read(cid, 'REVLoans', borrowableAbi, 'borrowableAmountFrom', [pid, bal, 18n, 1n]).then(function (r) { return toBigInt(Array.isArray(r) ? r[0] : r); }).catch(function () { return null; })
        : Promise.resolve(revLoans ? (hasBal ? null : 0n) : null);
      return Promise.all([cashJob, loanJob]).then(function (out) {
        return { id: cid, name: chain.name, balance: bal, cashout: out[0], maxLoan: out[1] };
      });
    });
  }));
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
function renderYouCard(project) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'you-card');
  var body = el('div', 'you-body');
  wrap.appendChild(body);
  wrap.appendChild(opsActionsRow(project));

  function load() {
    var acct = getAccount && getAccount();
    body.innerHTML = '';
    if (!acct) {
      var m = el('div', 'detail-card-body you-empty');
      m.textContent = 'Connect a wallet to see your ' + sym + ' across chains, its cash-out value, and your max loan.';
      var c = document.createElement('button'); c.className = 'ops-action-btn you-connect'; c.textContent = 'Connect wallet';
      c.addEventListener('click', function () { connect().then(load).catch(function () {}); });
      body.appendChild(m); body.appendChild(c);
      return;
    }
    var status = el('div', 'detail-card-body'); status.textContent = 'Reading your position across chains…'; body.appendChild(status);
    Promise.all([fetchYouPosition(project), readCashOutDelay(project)]).then(function (out) {
      if (!body.isConnected) return;
      var rows = out[0], delay = out[1];
      // The revnet's cash-out delay gates BOTH direct cash-outs (REVOwner.beforeCashOutRecordedWith
      // reverts) AND loans (borrowableAmountFrom returns 0). The cash-out *value* still computes (pure
      // bonding-curve calc), so we show it but mark it locked; loans can't compute, so they read "Locked".
      var locked = delay != null && delay > 0n && Number(delay) > Math.floor(Date.now() / 1000);
      function cashCell(r) {
        if (r.cashout == null) return '—';
        return locked ? { main: formatEth(r.cashout), sub: 'locked' } : formatEth(r.cashout);
      }
      // While locked, borrowableAmountFrom returns 0, but the contract's borrowable capacity IS the
      // bonding-curve reclaim — i.e. ≈ the cash-out value. Show that as the would-be loan, marked locked.
      function loanCell(r) {
        if (r.maxLoan == null) return '—'; // no REVLoans on this chain
        if (r.maxLoan > 0n) return formatEth(r.maxLoan); // unlocked: the real borrowable
        if (locked && r.cashout != null && r.cashout > 0n) return { main: formatEth(r.cashout), sub: 'locked' };
        return locked ? 'Locked' : formatEth(0n);
      }
      status.remove();
      var held = rows.filter(function (r) { return r.balance && r.balance > 0n; });
      if (!held.length) {
        var none = el('div', 'detail-card-body you-empty');
        none.textContent = 'You don’t hold any ' + sym + ' yet. Pay the project to get some.';
        body.appendChild(none);
        return;
      }
      var table = el('div', 'detail-ops-table');
      table.appendChild(opsRow('Chain', 'Balance', 'Cash out', 'Max loan', true, false));
      var totBal = 0n, totCash = 0n, totLoan = 0n, anyLoan = false;
      held.forEach(function (r) {
        table.appendChild(opsRow(
          r.name,
          formatTokenCount(r.balance) + ' ' + sym,
          cashCell(r),
          loanCell(r),
          false, false, r.id));
        totBal += r.balance;
        if (r.cashout != null) totCash += r.cashout;
        if (r.maxLoan != null && r.maxLoan > 0n) { totLoan += r.maxLoan; anyLoan = true; }
      });
      var totCashCell = locked ? { main: formatEth(totCash), sub: 'locked' } : formatEth(totCash);
      // Locked total loan ≈ total cash-out value (same bonding-curve reclaim).
      var totLoanCell = anyLoan ? formatEth(totLoan) : (locked && totCash > 0n ? { main: formatEth(totCash), sub: 'locked' } : (locked ? 'Locked' : '—'));
      table.appendChild(opsRow('Total', formatTokenCount(totBal) + ' ' + sym, totCashCell, totLoanCell, false, true));
      body.appendChild(table);
      if (locked) {
        var note = el('div', 'you-footnote');
        note.textContent = 'Cash-outs and loans unlock ' + formatDateShort(delay) + '. Locked values estimate what you could redeem or borrow then.';
        body.appendChild(note);
      }
    }).catch(function () {
      if (!body.isConnected) return;
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
  title.textContent = 'Recent movement';
  head.appendChild(title);

  var filter = document.createElement('select');
  filter.className = 'bridge-filter';
  [
    ['all', 'All statuses'],
    ['pending', 'Pending'],
    ['claimable', 'Claimable'],
    ['claimed', 'Claimed'],
  ].forEach(function (opt) {
    var o = document.createElement('option');
    o.value = opt[0];
    o.textContent = opt[1];
    filter.appendChild(o);
  });
  head.appendChild(filter);
  card.appendChild(head);

  var body = el('div', 'detail-card-body bridge-load');
  body.textContent = 'Loading bridge transactions…';
  card.appendChild(body);

  var rows = [];
  function draw() {
    body.innerHTML = '';
    body.className = 'bridge-table-wrap';
    var status = filter.value;
    var visible = status === 'all' ? rows : rows.filter(function (row) { return String(row.status) === status; });
    body.appendChild(renderBridgeTransactionsTable(visible, project));
  }
  function load() {
    fetchBridgeTransactions(project).then(function (data) {
      if (!body.isConnected) return;
      rows = data || [];
      draw();
    }).catch(function () {
      if (!body.isConnected) return;
      body.className = 'detail-card-body bridge-empty';
      body.textContent = 'Could not load bridge transactions.';
    });
  }

  filter.addEventListener('change', draw);
  // A move/claim/execute elsewhere dispatches this; re-read chain state so statuses stay fresh.
  document.addEventListener('jb:bridge-updated', load);
  load();

  return card;
}

function renderBridgeTransactionsTable(rows, project) {
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
    empty.textContent = 'No bridge transactions found.';
    table.appendChild(empty);
    return table;
  }

  rows.forEach(function (tx) {
    var row = el('div', 'bridge-row');
    var when = el('span');
    when.textContent = timeAgo(tx.createdAt);
    row.appendChild(when);

    var chains = el('span', 'bridge-chain-pair');
    chains.appendChild(chainLogo(Number(tx.chainId), chainById(tx.chainId).name));
    chains.appendChild(el('span', 'bridge-arrow')).textContent = '→';
    chains.appendChild(chainLogo(Number(tx.peerChainId), chainById(tx.peerChainId).name));
    row.appendChild(chains);

    var beneficiary = el('span', 'bridge-beneficiary');
    beneficiary.appendChild(addressNode(tx.beneficiary));
    row.appendChild(beneficiary);

    var tokens = el('span', 'bridge-num');
    tokens.textContent = formatCompactTokenAmount(toBigInt(tx.projectTokenCount)) + ' ' + (project.tokenSymbol || '');
    row.appendChild(tokens);

    var value = el('span', 'bridge-num');
    value.textContent = formatActivityAmount(tx.terminalTokenAmount, 'ETH');
    row.appendChild(value);

    var status = el('span');
    var badge = el('span', 'bridge-status bridge-status--' + String(tx.status || 'unknown').toLowerCase());
    badge.textContent = tx.status || 'unknown';
    status.appendChild(badge);
    row.appendChild(status);

    var action = el('span', 'bridge-action');
    var sym = project.tokenSymbol || 'tokens';
    if (tx.status === 'claimable') {
      var claimBtn = document.createElement('button'); claimBtn.className = 'ops-percent-btn'; claimBtn.textContent = 'Claim';
      var cstat = el('span', 'bridge-action-stat');
      claimBtn.addEventListener('click', function () {
        var acct = getAccount && getAccount(); if (!acct) { connect(); return; }
        var leaf = { index: BigInt(tx.index), beneficiary: tx.beneficiary32, projectTokenCount: toBigInt(tx.projectTokenCount), terminalTokenAmount: toBigInt(tx.terminalTokenAmount), metadata: tx.metadata };
        // Confirm modal showing exactly what's being signed (proof summarized — it's mechanical).
        var payload = {
          action: 'Claim ' + formatCompactTokenAmount(toBigInt(tx.projectTokenCount)) + ' ' + sym + ' on ' + moveChainName(tx.peerChainId),
          chainId: tx.peerChainId, contract: tx.peerSucker, function: 'claim',
          args: { token: NATIVE_TOKEN, leaf: { index: tx.index, beneficiary: tx.beneficiary, projectTokenCount: leaf.projectTokenCount, terminalTokenAmount: leaf.terminalTokenAmount, metadata: tx.metadata }, proof: '[32-element merkle proof]' },
        };
        // Claiming runs on the DESTINATION chain — its gas is paid in that chain's native ETH. Warn early if
        // the wallet has none there (the most common reason a valid claim "doesn't work").
        cstat.classList.add('pending'); cstat.textContent = 'Checking…';
        readEthBalance(tx.peerChainId, acct).then(function (bal) {
          cstat.classList.remove('pending'); cstat.textContent = '';
          var lowGas = bal != null && bal < 200000000000000n; // < 0.0002 ETH ≈ not enough for gas
          openTxConfirm(payload, function (ctx) {
            executeTransaction({
              chainId: tx.peerChainId, address: tx.peerSucker, abi: suckerClaimAbi, functionName: 'claim',
              args: [{ token: NATIVE_TOKEN, leaf: leaf, proof: tx.proof }],
              onStatus: function (m, kind) { ctx.showStatus(m, kind); },
              onError: function (m) { ctx.showStatus(m, 'error'); },
              onSuccess: function () { ctx.showStatus('Claimed √', 'success'); ctx.modal.close(); cstat.textContent = 'Claimed √'; document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
            });
          }, { title: 'Confirm claim', confirmText: 'Confirm & Claim', closeOnConfirm: false,
            note: lowGas ? 'Heads up: claiming is a transaction on ' + moveChainName(tx.peerChainId) + ', and your wallet looks low on ' + moveChainName(tx.peerChainId) + ' ETH for gas. Fund it there first if the wallet can’t submit.' : undefined });
        });
      });
      action.appendChild(claimBtn); action.appendChild(cstat);
    } else if (tx.status === 'pending' && tx.canExecute) {
      var execBtn = document.createElement('button'); execBtn.className = 'ops-percent-btn'; execBtn.textContent = 'Execute';
      execBtn.title = 'Send the bridge message to the destination chain';
      var estat = el('span', 'bridge-action-stat');
      execBtn.addEventListener('click', function () {
        var acct = getAccount && getAccount(); if (!acct) { connect(); return; }
        execBtn.disabled = true;
        var onS = function (m, kind) { estat.classList.toggle('pending', kind === 'pending'); estat.textContent = m; };
        onS('Reading bridge fee…', 'pending');
        findToRemoteValue(tx.chainId, tx.sourceSucker, NATIVE_TOKEN, acct).then(function (fee) {
          estat.classList.remove('pending'); estat.textContent = ''; execBtn.disabled = false;
          var payload = {
            action: 'Send bridge message to ' + moveChainName(tx.peerChainId),
            chainId: tx.chainId, contract: tx.sourceSucker, function: 'toRemote',
            value: formatAmount(fee, 18) + ' ETH', args: { token: NATIVE_TOKEN },
          };
          openTxConfirm(payload, function (ctx) {
            executeTransaction({
              chainId: tx.chainId, address: tx.sourceSucker, abi: suckerBridgeAbi, functionName: 'toRemote', args: [NATIVE_TOKEN], value: fee,
              onStatus: function (m, kind) { ctx.showStatus(m, kind); },
              onError: function (m) { ctx.showStatus(m, 'error'); },
              onSuccess: function () { ctx.showStatus('Sent √', 'success'); ctx.modal.close(); estat.textContent = 'Sent √'; document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
            });
          }, { title: 'Confirm bridge send', confirmText: 'Confirm & Send', closeOnConfirm: false });
        });
      });
      action.appendChild(execBtn); action.appendChild(estat);
    } else {
      action.textContent = tx.status === 'claimed' ? '—' : 'Bridging…';
    }
    row.appendChild(action);
    table.appendChild(row);
  });

  return table;
}

// -- Modal primitive --
function openModal(titleText, contentNode) {
  var overlay = el('div', 'modal-overlay');
  var dialog = el('div', 'modal-dialog');
  var head = el('div', 'modal-head');
  var h = el('div', 'modal-title'); h.textContent = titleText; head.appendChild(h);
  var x = document.createElement('button'); x.className = 'modal-close'; x.textContent = '✕';
  x.addEventListener('click', close); head.appendChild(x);
  dialog.appendChild(head);
  dialog.appendChild(contentNode);
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
  var note = el('div', 'tx-confirm-note');
  note.textContent = opts.note || 'This is the exact transaction that will be sent to your wallet. Review it before signing.';
  content.appendChild(note);
  var pre = el('pre', 'create-payload');
  // Unquote object keys (identifier keys only) for a lighter, less JSON-y read; string values stay quoted.
  pre.textContent = JSON.stringify(payload, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; }, 2)
    .replace(/^(\s*)"([A-Za-z_][\w]*)":/gm, '$1$2:');
  content.appendChild(pre);
  var status = el('div', 'modal-status tx-confirm-status');
  status.style.display = 'none';
  content.appendChild(status);
  var foot = el('div', 'create-modal-foot');
  var cancel = el('button', 'create-btn ghost'); cancel.textContent = 'Cancel';
  var confirm = el('button', 'create-btn primary'); confirm.textContent = opts.confirmText || 'Confirm';
  foot.appendChild(cancel); foot.appendChild(confirm);
  content.appendChild(foot);
  var modal = openModal(opts.title || 'Confirm transaction', content);
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
function opsChainSelect(project, onChange) {
  var sel = el('select', 'ops-select');
  (project.chains || []).forEach(function (c) {
    var o = document.createElement('option'); o.value = String(c.id); o.textContent = c.name; sel.appendChild(o);
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

function buildCashOutModal(project) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'modal-body');
  var pid = BigInt(project.id);
  var state = { chainId: (project.chains && project.chains[0] && project.chains[0].id) || project.chainId, balance: null, supply: null, surplus: null, reclaim: null };

  var lbl1 = el('div', 'modal-label'); lbl1.textContent = 'Cash out amount'; wrap.appendChild(lbl1);
  var bal = el('div', 'modal-balance'); wrap.appendChild(bal);

  var inRow = el('div', 'ops-inrow');
  var chainSel = opsChainSelect(project, function (cid) { state.chainId = cid; onChainChange(); });
  inRow.appendChild(chainSel);
  var amt = el('input', 'ops-amount'); amt.type = 'number'; amt.placeholder = '0.00'; inRow.appendChild(amt);
  var unit = el('span', 'ops-unit'); unit.textContent = sym; inRow.appendChild(unit);
  wrap.appendChild(inRow);
  wrap.appendChild(opsPercentButtons(amt, function () { return state.balance; }));

  var preview = el('div', 'ops-preview'); wrap.appendChild(preview);
  var status = el('div', 'modal-status'); wrap.appendChild(status);
  var foot = el('div', 'modal-foot');
  var btn = document.createElement('button'); btn.className = 'modal-submit'; btn.textContent = 'Cash out';
  foot.appendChild(btn); wrap.appendChild(foot);

  function refreshBalance() {
    bal.textContent = 'Your balance: …';
    readUserBalance(project, state.chainId).then(function (b) {
      state.balance = b;
      bal.textContent = b == null ? 'Connect a wallet to see your balance.' : ('Your balance: ' + formatTokens(b) + ' ' + sym);
    });
  }
  function onChainChange() {
    refreshBalance();
    state.supply = null; state.surplus = null; updatePreview();
    var terminal = getAddress('JBMultiTerminal', state.chainId);
    Promise.all([
      read(state.chainId, 'JBTokens', totalSupplyAbi, 'totalSupplyOf', [pid]).catch(function () { return null; }),
      terminal ? read(state.chainId, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, pid, NATIVE_TOKEN]).catch(function () { return null; }) : Promise.resolve(null),
    ]).then(function (r) { state.supply = r[0]; state.surplus = r[1]; updatePreview(); });
  }
  var previewSeq = 0;
  function updatePreview() {
    var count; try { count = parseAmount(amt.value, 18); } catch (_) { count = 0n; }
    if (!count || count === 0n || state.supply == null || state.surplus == null || state.surplus === 0n) { preview.textContent = ''; state.reclaim = null; return; }
    var seq = ++previewSeq;
    preview.textContent = 'Calculating…';
    read(state.chainId, 'JBTerminalStore', reclaimableAbi, 'currentReclaimableSurplusOf', [pid, count, state.supply, state.surplus])
      .then(function (rec) {
        if (seq !== previewSeq) return;
        state.reclaim = toBigInt(rec);
        preview.textContent = 'You’ll receive ~ ' + formatEth(state.reclaim);
      }).catch(function () { if (seq === previewSeq) { preview.textContent = ''; state.reclaim = null; } });
  }
  amt.addEventListener('input', updatePreview);
  onChainChange();

  btn.addEventListener('click', function () {
    var acct = getAccount && getAccount();
    if (!acct) { connect(); return; }
    var count; try { count = parseAmount(amt.value, 18); } catch (_) { status.textContent = 'Invalid amount'; return; }
    if (count === 0n) { status.textContent = 'Enter an amount'; return; }
    var terminal = getAddress('JBMultiTerminal', state.chainId);
    if (!terminal) { status.textContent = 'No terminal on this chain'; return; }
    // Slippage floor: 1% under the previewed reclaim (the surplus can shift before the tx lands). 0 if no preview.
    var minReclaimed = state.reclaim != null ? state.reclaim * 9900n / 10000n : 0n;
    btn.disabled = true; status.textContent = '';
    executeTransaction({
      chainId: state.chainId, address: terminal, abi: cashOutTokensAbi, functionName: 'cashOutTokensOf',
      args: [acct, pid, count, NATIVE_TOKEN, minReclaimed, acct, '0x'],
      onStatus: function (m, kind) { status.classList.toggle('pending', kind === 'pending'); status.textContent = m; },
      onSuccess: function () { status.classList.remove('pending'); status.textContent = 'Cashed out √'; btn.disabled = false; refreshBalance(); },
      onError: function (m) { status.classList.remove('pending'); status.textContent = m; btn.disabled = false; },
    });
  });
  return wrap;
}

function buildLoanModal(project) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'modal-body');
  var state = { chainId: (project.chains && project.chains[0] && project.chains[0].id) || project.chainId, balance: null };

  var lbl = el('div', 'modal-label'); lbl.textContent = 'How much ' + sym + ' do you want to collateralize?'; wrap.appendChild(lbl);
  var bal = el('div', 'modal-balance'); wrap.appendChild(bal);

  var inRow = el('div', 'ops-inrow');
  var chainSel = opsChainSelect(project, function (cid) { state.chainId = cid; refreshBalance(); });
  inRow.appendChild(chainSel);
  var amt = el('input', 'ops-amount'); amt.type = 'number'; amt.placeholder = '0.00'; inRow.appendChild(amt);
  var unit = el('span', 'ops-unit'); unit.textContent = sym; inRow.appendChild(unit);
  wrap.appendChild(inRow);
  wrap.appendChild(opsPercentButtons(amt, function () { return state.balance; }));

  var preview = el('div', 'ops-preview'); wrap.appendChild(preview);

  var info = el('ul', 'modal-info');
  ['Your collateralized ' + sym + ' is burned while the loan is open.',
   'You receive an NFT to reclaim it when you repay.',
   'Borrow against your token’s cash-out value; fees grow over time.',
   'First-time loans need a one-off approval letting the loan contract burn your collateral.'].forEach(function (t) {
    var li = document.createElement('li'); li.textContent = t; info.appendChild(li);
  });
  wrap.appendChild(info);

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
    if (!collateral || collateral === 0n) { preview.textContent = ''; state.borrowable = null; return; }
    var loans = getAddress('REVLoans', state.chainId);
    if (!loans) { preview.textContent = ''; return; }
    var seq = ++previewSeq; preview.textContent = 'Calculating…';
    read(state.chainId, 'REVLoans', borrowableAbi, 'borrowableAmountFrom', [pid, collateral, 18n, 1n])
      .then(function (r) {
        if (seq !== previewSeq) return;
        var b = Array.isArray(r) ? r[0] : r;
        state.borrowable = toBigInt(b);
        // borrowableAmountFrom returns 0 for ALL collateral while the revnet's cash-out delay is still in
        // effect (REVLoans gates loans on it) — so a 0 here means loans are time-locked, not "too little".
        preview.textContent = state.borrowable > 0n
          ? 'You’ll borrow ~ ' + formatEth(state.borrowable)
          : 'Nothing borrowable yet — loans unlock after this revnet’s cash-out delay passes.';
      }).catch(function () { if (seq === previewSeq) { preview.textContent = ''; state.borrowable = null; } });
  }
  amt.addEventListener('input', updatePreview);
  function onChainChange() { refreshBalance(); updatePreview(); }
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

    // token = native, minBorrowAmount 0 (best price), prepaidFeePercent 0 (pay fees over time), holder/beneficiary = caller.
    function doBorrow() {
      executeTransaction({
        chainId: state.chainId, address: loans, abi: borrowFromAbi, functionName: 'borrowFrom',
        args: [pid, NATIVE_TOKEN, 0n, collateral, acct, 0n, acct],
        onStatus: onStatus, onError: fail,
        onSuccess: function () { status.classList.remove('pending'); status.textContent = 'Loan opened √'; btn.disabled = false; refreshBalance(); document.dispatchEvent(new CustomEvent('jb:bridge-updated')); },
      });
    }

    // Opening a loan burns the collateral via the controller, so REVLoans needs BURN_TOKENS on the holder.
    // Grant it once (if missing) before borrowing — otherwise borrowFrom reverts.
    onStatus('Checking approval…', 'pending');
    read(state.chainId, 'JBPermissions', jbHasPermissionAbi, 'hasPermission', [loans, acct, pid, BigInt(JB_PERMISSION_BURN_TOKENS), true, false])
      .then(function (has) {
        if (has) { doBorrow(); return; }
        executeTransaction({
          chainId: state.chainId, address: perms, abi: jbSetPermissionsAbi, functionName: 'setPermissionsFor',
          args: [acct, { operator: loans, projectId: pid, permissionIds: [JB_PERMISSION_BURN_TOKENS] }],
          onStatus: function (m, kind) { onStatus(m === 'Awaiting wallet confirmation...' ? 'Approve the loan contract…' : m, kind); },
          onError: fail,
          onSuccess: function () { onStatus('Approved √ — opening loan…', 'pending'); doBorrow(); },
        });
      }).catch(function () { doBorrow(); }); // if the permission read fails, attempt the borrow (it will revert clearly if truly unauthorized)
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
var erc20BalanceOfAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }];

function moveChainName(cid) { return (CHAINS[cid] && CHAINS[cid].name) || ('chain ' + cid); }

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
function fetchProjectSuckerInfra(project) {
  var chains = (project.chains || []).map(function (c) { return c.id; });
  var routes = {};
  return Promise.all(chains.map(function (C) {
    return readSuckerPairsOf(project.id, C).then(function (pairs) {
      return Promise.all(pairs.map(function (p) {
        var key = [C, p.remoteChainId].sort(function (x, y) { return x - y; }).join('-');
        if (routes[key]) return null;
        var entry = { a: C, b: p.remoteChainId, infra: 'native' };
        routes[key] = entry;
        return clientFor(C).readContract({ address: p.local, abi: ccipRouterAbi, functionName: 'CCIP_ROUTER', args: [] })
          .then(function (r) { if (r && String(r).toLowerCase() !== ZERO_ADDRESS) entry.infra = 'CCIP'; })
          .catch(function () {}); // no CCIP_ROUTER → native bridge
      }));
    });
  })).then(function () {
    return Object.keys(routes).map(function (k) { return routes[k]; }).sort(function (a, b) { return a.b - b.b; });
  }).catch(function () { return []; });
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

// The msg.value toRemote needs. Native-bridge suckers (our entire testnet set — every pair routes through
// Sepolia/L1) require it to EQUAL toRemoteFee() exactly (the bridge reverts on any non-zero transportPayment
// = msg.value − fee). So just read the fee and use it — no simulate-based search (simulate conflates
// fee-correctness with the caller's ETH balance and depends on RPC stateOverride support; it was the reason
// Execute appeared to hang). The wallet surfaces any balance shortfall. CCIP suckers (none here) would need
// fee + a messaging-fee estimate; add that when a CCIP pair actually ships. Returns bigint.
async function findToRemoteValue(chainId, sucker, token, account) {
  try { return BigInt(await clientFor(chainId).readContract({ address: getAddress('JBSuckerRegistry', chainId), abi: suckerRegistryBridgeAbi, functionName: 'toRemoteFee', args: [] })); }
  catch (_) { return 0n; }
}

// Find the connected wallet's claimable leaves on `toChainId` for tokens bridged from `fromChainId`.
// Reconstructs the merkle proof client-side from the source sucker's InsertToOutboxTree logs and the
// delivered inbox root; only returns leaves whose proof re-derives the on-chain root (and aren't executed).
async function findClaimableBridges(project, fromChainId, toChainId, account) {
  if (!account || fromChainId === toChainId) return [];
  try {
    var destPairs = await readSuckerPairsOf(project.id, toChainId);
    var destPair = destPairs.filter(function (p) { return p.remoteChainId === fromChainId; })[0];
    if (!destPair) return [];
    var destSucker = destPair.local, destClient = clientFor(toChainId);
    var inbox = await destClient.readContract({ address: destSucker, abi: suckerClaimAbi, functionName: 'inboxOf', args: [NATIVE_TOKEN] });
    var inboxRoot = (inbox && inbox.root || SUCKER_BYTES32_ZERO);
    if (/^0x0+$/.test(inboxRoot)) return []; // nothing delivered to this chain yet

    var srcPairs = await readSuckerPairsOf(project.id, fromChainId);
    var srcPair = srcPairs.filter(function (p) { return p.remoteChainId === toChainId; })[0];
    if (!srcPair) return [];
    var srcSucker = srcPair.local;

    // Enumerate every InsertToOutboxTree for the native token (to rebuild the tree). getLogs via the
    // CORS/log-capable publicnode client (the default RPC doesn't serve eth_getLogs).
    var logClient = lpLogsClient(fromChainId) || clientFor(fromChainId);
    var latest = await logClient.getBlockNumber();
    var W = 45000n, windows = [];
    for (var n = 0; n < 8 && latest - BigInt(n) * W > 0n; n++) {
      var hi = latest - BigInt(n) * W, lo = hi > W ? hi - W + 1n : 0n;
      windows.push({ lo: lo, hi: hi }); if (lo === 0n) break;
    }
    var batches = await Promise.all(windows.map(function (w) {
      return logClient.getLogs({ address: srcSucker, event: INSERT_TO_OUTBOX_EVENT, args: { token: NATIVE_TOKEN }, fromBlock: w.lo, toBlock: w.hi }).catch(function () { return []; });
    }));
    var byIndex = {};
    batches.forEach(function (b) { b.forEach(function (l) { if (l.args) byIndex[Number(l.args.index)] = l.args; }); });
    if (!Object.keys(byIndex).length) return [];

    // The delivered inbox root matches the outbox root recorded right after some insert → that index+1 = count.
    var count = null;
    Object.keys(byIndex).forEach(function (k) { if ((byIndex[k].root || '').toLowerCase() === inboxRoot.toLowerCase()) count = Number(k) + 1; });
    if (count == null) return []; // delivered root is older/newer than any insert we found
    var leafHashes = [];
    for (var i = 0; i < count; i++) { if (!byIndex[i]) return []; leafHashes.push(byIndex[i].hashed); }

    var benef32 = '0x' + account.slice(2).toLowerCase().padStart(64, '0');
    var out = [];
    for (var k2 = 0; k2 < count; k2++) {
      var a = byIndex[k2];
      if ((a.beneficiary || '').toLowerCase() !== benef32) continue;
      var ex = await destClient.readContract({ address: destSucker, abi: suckerClaimAbi, functionName: 'executedLeafHashOf', args: [NATIVE_TOKEN, BigInt(k2)] }).catch(function () { return SUCKER_BYTES32_ZERO; });
      if (ex && !/^0x0+$/.test(ex)) continue; // already claimed
      var proof = suckerLeafProof(leafHashes, k2);
      if (suckerBranchRoot(a.hashed, proof, k2).toLowerCase() !== inboxRoot.toLowerCase()) continue; // proof safety net
      out.push({ destSucker: destSucker, index: k2, beneficiary: a.beneficiary, metadata: a.metadata,
        projectTokenCount: BigInt(a.projectTokenCount), terminalTokenAmount: BigInt(a.terminalTokenAmount), proof: proof });
    }
    return out;
  } catch (_) { return []; }
}

function buildMoveModal(project) {
  var sym = project.tokenSymbol || 'tokens';
  var wrap = el('div', 'modal-body');
  var chains = project.chains || [];
  var state = { from: chains[0] && chains[0].id, to: chains[1] && chains[1].id, balance: 0n, token: null, pairs: null, sucker: null };

  var grid = el('div', 'ops-move-grid');
  var fromCol = el('div'); var fl = el('div', 'modal-label'); fl.textContent = 'From chain'; fromCol.appendChild(fl);
  var fromSel = opsChainSelect(project, function (cid) { state.from = cid; onFromChange(); }); fromCol.appendChild(fromSel);
  grid.appendChild(fromCol);
  var toCol = el('div'); var tl = el('div', 'modal-label'); tl.textContent = 'To chain'; toCol.appendChild(tl);
  var toSel = opsChainSelect(project, function (cid) { state.to = cid; resolveRoute(); }); if (chains[1]) toSel.value = String(chains[1].id); toCol.appendChild(toSel);
  grid.appendChild(toCol);
  wrap.appendChild(grid);

  var lbl = el('div', 'modal-label'); lbl.textContent = 'Amount'; lbl.style.marginTop = '12px'; wrap.appendChild(lbl);
  var bal = el('div', 'modal-balance'); wrap.appendChild(bal);
  var inRow = el('div', 'ops-inrow');
  var amt = el('input', 'ops-amount'); amt.type = 'number'; amt.placeholder = '0.00'; inRow.appendChild(amt);
  var unit = el('span', 'ops-unit'); unit.textContent = sym; inRow.appendChild(unit);
  wrap.appendChild(inRow);
  wrap.appendChild(opsPercentButtons(amt, function () { return state.balance; }));

  var route = el('div', 'modal-status modal-route'); wrap.appendChild(route);
  var note = el('div', 'modal-status');
  note.textContent = 'Moving ' + sym + ' bridges it between chains via the revnet’s suckers; a proportional share of the revnet’s funds moves too.';
  wrap.appendChild(note);

  var status = el('div', 'modal-status'); wrap.appendChild(status);
  var foot = el('div', 'modal-foot');
  var btn = document.createElement('button'); btn.className = 'modal-submit'; btn.textContent = 'Move ' + sym;
  foot.appendChild(btn); wrap.appendChild(foot);

  var hint = el('div', 'modal-status');
  hint.textContent = 'Once it’s bridged, claim it on the destination from the Movement table below.';
  wrap.appendChild(hint);

  function onFromChange() { refreshBalance(); loadPairs(); }
  function refreshBalance() {
    bal.textContent = 'Your balance: …';
    readBridgeableBalance(project, state.from).then(function (r) {
      state.balance = r.balance; state.token = r.token;
      if (!(getAccount && getAccount())) { bal.textContent = 'Connect a wallet to see your balance.'; return; }
      if (!r.token) { bal.textContent = 'No ERC-20 ' + sym + ' on ' + moveChainName(state.from) + ' — claim your tokens there first to bridge.'; return; }
      bal.textContent = 'Bridgeable: ' + formatTokens(r.balance) + ' ' + sym;
    });
  }
  function loadPairs() {
    state.pairs = null; resolveRoute();
    readSuckerPairsOf(project.id, state.from).then(function (pairs) { state.pairs = pairs; resolveRoute(); });
  }
  function resolveRoute() {
    state.sucker = null;
    if (state.from === state.to) { route.textContent = 'Pick two different chains.'; return; }
    if (state.pairs == null) { route.textContent = 'Finding bridge route…'; return; }
    var p = state.pairs.filter(function (x) { return x.remoteChainId === state.to; })[0];
    if (!p) { route.textContent = 'No bridge from ' + moveChainName(state.from) + ' to ' + moveChainName(state.to) + '.'; return; }
    state.sucker = p.local;
    route.textContent = 'Bridges via sucker ' + truncAddr(p.local) + '.';
  }

  onFromChange();

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

    // Step 1: approve the sucker for the ERC-20, then prepare (cash out to terminal funds + insert outbox leaf).
    // minTokensReclaimed=0: the remote chain re-mints the same projectTokenCount regardless; the local
    // cash-out is internal sucker plumbing. NATIVE_TOKEN is the terminal (backing) token being moved.
    executeTransaction({
      chainId: from, address: sucker, abi: suckerBridgeAbi, functionName: 'prepare',
      args: [amount, beneficiary32, 0n, NATIVE_TOKEN, metadata],
      tokenAddr: token, spenderAddr: sucker, approvalAmount: amount,
      onStatus: onStatus, onError: fail,
      onSuccess: function () {
        // Step 2: ship the outbox root to the remote chain. Discover the exact msg.value the bridge needs
        // by simulating toRemote at increasing values (handles native-bridge fee-only AND CCIP messaging).
        onStatus('Prepared √ — finding bridge fee…', 'pending');
        findToRemoteValue(from, sucker, NATIVE_TOKEN, acct).then(function (fee) {
          if (fee == null) { fail('Prepared, but the bridge queue isn’t ready to send yet — reopen and try again shortly.'); return; }
          onStatus('Sending to ' + moveChainName(to) + '…', 'pending');
          executeTransaction({
            chainId: from, address: sucker, abi: suckerBridgeAbi, functionName: 'toRemote',
            args: [NATIVE_TOKEN], value: fee,
            onStatus: onStatus, onError: fail,
            onSuccess: function () {
              status.classList.remove('pending');
              status.textContent = 'Bridging to ' + moveChainName(to) + ' √ — once it delivers (a few minutes for native bridges) claim it from the Movement table.';
              btn.disabled = false;
              document.dispatchEvent(new CustomEvent('jb:bridge-updated'));
            },
          });
        });
      },
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
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="none" class="lp-graph-svg">';
  svg += '<line x1="' + padL + '" y1="' + baseY + '" x2="' + (W - padR) + '" y2="' + baseY + '" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>';
  if (pa > 0 && pb > pa) {
    svg += '<rect x="' + X(pa).toFixed(1) + '" y="' + (baseY - 9) + '" width="' + Math.max(1, X(pb) - X(pa)).toFixed(1) + '" height="18" fill="rgba(110,196,196,0.35)" stroke="#1a8a8a" stroke-width="1"/>';
  }
  function marker(v, color, label, up) {
    if (!(v > 0)) return '';
    var xv = X(v);
    // Keep edge labels from clipping: left-anchor near the left edge, right-anchor near the right.
    var anchor = 'middle', tx = xv;
    if (xv < 24) { anchor = 'start'; tx = padL; }
    else if (xv > W - 24) { anchor = 'end'; tx = W - padR; }
    var x = xv.toFixed(1);
    return '<line x1="' + x + '" y1="' + (baseY - 13) + '" x2="' + x + '" y2="' + (baseY + 13) + '" stroke="' + color + '" stroke-width="1.5"/>'
      + '<text x="' + tx.toFixed(1) + '" y="' + (up ? 11 : H - 3) + '" font-size="8" fill="' + color + '" text-anchor="' + anchor + '">' + label + '</text>';
  }
  svg += marker(floor, '#2c2018', 'Cash out floor', true);
  svg += marker(poolP, '#b8602e', 'pool', false);
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
function lpTickFromPoolPrice(poolPrice) { return Math.floor(Math.log(poolPrice) / Math.log(1.0001)); }

// Read the buyback pool key + current sqrtPriceX96. Null if no pool.
async function readPoolState(project, chainId) {
  var hook = getAddress('JBBuybackHook', chainId);
  var pm = POOL_MANAGER_BY_CHAIN[chainId];
  if (!hook || !pm) return null;
  try {
    var client = clientFor(chainId);
    var key = await client.readContract({ address: hook, abi: poolKeyOfAbi, functionName: 'poolKeyOf', args: [BigInt(project.id), ZERO_ADDRESS] });
    if (!key) return null;
    var c0 = (key.currency0 || ZERO_ADDRESS).toLowerCase(), c1 = (key.currency1 || ZERO_ADDRESS).toLowerCase();
    if (c0 === ZERO_ADDRESS && c1 === ZERO_ADDRESS) return null;
    var poolId = keccak256(encodeAbiParameters(POOLKEY_TUPLE, [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
    var stateSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
    var slot0 = await client.readContract({ address: pm, abi: extsloadAbi, functionName: 'extsload', args: [stateSlot] });
    var sqrtP = BigInt(slot0) & ((1n << 160n) - 1n);
    if (sqrtP === 0n) return null;
    return { key: key, sqrtP: sqrtP };
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
    var key = st.key, sqrtP = st.sqrtP;
    var sp = Number(sqrtP) / Math.pow(2, 96), rawP = sp * sp;
    var poolPrice = ((key.currency0 || '').toLowerCase() === ZERO_ADDRESS) ? (rawP > 0 ? 1 / rawP : 0) : rawP;
    var poolId = keccak256(encodeAbiParameters(POOLKEY_TUPLE, [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
    var client = clientFor(chainId);
    var empty = { owners: [], totalEth: 0n, totalRev: 0n, poolPrice: poolPrice, count: 0, positions: [] };

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
    det.forEach(function (p) {
      if (!p.owner || p.liquidity <= 0n || p.info === 0n) return;
      var tickUpper = Number(lpSignExtend24((p.info >> 32n) & 0xffffffn));
      var tickLower = Number(lpSignExtend24((p.info >> 8n) & 0xffffffn));
      var amounts = lpGetAmountsForLiquidity(sqrtP, lpSqrtAtTick(tickLower), lpSqrtAtTick(tickUpper), p.liquidity);
      totalEth += amounts.amount0; totalRev += amounts.amount1;
      positions.push({ tickLower: tickLower, tickUpper: tickUpper, liquidity: p.liquidity, eth: amounts.amount0, rev: amounts.amount1 });
      var val = Number(amounts.amount0) / 1e18 + (Number(amounts.amount1) / 1e18) * poolPrice;
      var k = p.owner.toLowerCase();
      if (!byOwner[k]) byOwner[k] = { address: p.owner, valueEth: 0, eth: 0n, rev: 0n, positions: 0 };
      byOwner[k].valueEth += val; byOwner[k].eth += amounts.amount0; byOwner[k].rev += amounts.amount1; byOwner[k].positions++;
    });
    var owners = Object.keys(byOwner).map(function (k) { return byOwner[k]; }).sort(function (a, b) { return b.valueEth - a.valueEth; });
    return { owners: owners, totalEth: totalEth, totalRev: totalRev, poolPrice: poolPrice, sqrtP: sqrtP, count: owners.length, positions: positions };
  } catch (e) { return null; }
}

// V4 liquidity-depth histogram: how much active liquidity sits in each price band. Bars are colored by
// side of the current pool price (below = teal/support, above = orange); dashed markers show the cash-out
// floor, current AMM price, and issuance ceiling. Price axis is log-scaled (ranges span orders of magnitude).
function renderLpDepthChart(lp, amm, issuance, cashout, sym) {
  var positions = (lp && lp.positions) || [];
  if (!positions.length) return null;
  var sqrtP = lp.sqrtP;
  var priceAtTick = function (t) { return 1 / Math.pow(1.0001, t); }; // ETH per token (ETH = currency0)
  var tickAtPrice = function (p) { return -Math.log(p) / Math.log(1.0001); };
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
        ethW += am.amount0; revW += am.amount1;
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
    var sideTxt = amm ? (b.mid < amm ? ' · buy-side' : ' · sell-side') : '';
    tip.innerHTML = '<div class="lp-depth-tip-price">≈ ' + formatPrice(b.mid) + ' ETH/' + sym + sideTxt + '</div>'
      + '<div class="lp-depth-tip-amt">' + (hasLiq
        ? (formatCompactTokenAmount(b.rev) + ' ' + sym + ' + ' + formatPrice(Number(b.eth) / 1e18) + ' ETH')
        : 'no liquidity here') + '</div>';
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
    var t0 = document.createElementNS(svgNS, 'title'); t0.textContent = truncAddr(owners[0].address) + ' · 100%'; ring.appendChild(t0);
    svg.appendChild(ring);
  } else {
    owners.forEach(function (o) {
      var frac = o.valueEth / total; if (!(frac > 0)) return;
      var next = angle + frac * Math.PI * 2;
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', donutSlicePath(cx, cy, outer, inner, angle, next));
      path.setAttribute('class', 'owners-pie-slice');
      var t = document.createElementNS(svgNS, 'title'); t.textContent = truncAddr(o.address) + ' · ' + (frac * 100).toFixed(1) + '%'; path.appendChild(t);
      svg.appendChild(path); angle = next;
    });
  }
  var cA = document.createElementNS(svgNS, 'text'); cA.setAttribute('x', String(cx)); cA.setAttribute('y', '113'); cA.setAttribute('class', 'owners-pie-center owners-pie-center-main'); cA.textContent = String(owners.length); svg.appendChild(cA);
  var cB = document.createElementNS(svgNS, 'text'); cB.setAttribute('x', String(cx)); cB.setAttribute('y', '132'); cB.setAttribute('class', 'owners-pie-center owners-pie-center-sub'); cB.textContent = owners.length === 1 ? 'LP' : 'LPs'; svg.appendChild(cB);
  panel.appendChild(svg);
  return panel;
}

// Table of LP providers (mirrors the owners table) with per-LP position info: ETH, token, share.
function renderLpTable(lp, sym, chainId) {
  var owners = lp.owners.filter(function (o) { return o.valueEth > 0; });
  if (!owners.length) return null;
  var total = owners.reduce(function (s, o) { return s + o.valueEth; }, 0);
  var wrap = el('div', 'owners-table-wrap lp-pos-table-wrap');
  var table = el('div', 'owners-table lp-pos-table');
  var head = el('div', 'owners-row owners-head');
  ['Account', 'ETH', sym, 'Share'].forEach(function (h) { var c = el('span'); c.textContent = h; head.appendChild(c); });
  table.appendChild(head);
  owners.forEach(function (o) {
    var tr = el('div', 'owners-row');
    var acct = el('span', 'owners-account');
    acct.appendChild(addressNode(o.address));
    if (o.positions > 1) { var pc = el('span', 'lp-pos-count'); pc.textContent = o.positions + ' positions'; acct.appendChild(pc); }
    tr.appendChild(acct);
    var ethC = el('span', 'owners-balance'); ethC.textContent = lpTrimNum(Number(o.eth) / 1e18) + ' ETH'; tr.appendChild(ethC);
    var revC = el('span', 'owners-balance'); revC.textContent = formatCompactTokenAmount(o.rev) + ' ' + sym; tr.appendChild(revC);
    var shareC = el('span'); var st = el('strong'); st.textContent = (o.valueEth / total * 100).toFixed(1) + '%'; shareC.appendChild(st); tr.appendChild(shareC);
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

// Horizontal bar of the pool's ETH vs token split (by ETH-value). Null if nothing to show.
function renderLpCompositionBar(lp, sym) {
  var ethF = Number(lp.totalEth) / 1e18;
  var revVal = (Number(lp.totalRev) / 1e18) * lp.poolPrice;
  var total = ethF + revVal;
  if (!(total > 0)) return null;
  var ethPct = ethF / total * 100, revPct = revVal / total * 100;
  var ethColor = '#6ec4c4', revColor = '#cca080'; // teal-light (ETH) / orange-light (REV)
  var wrap = el('div', 'lp-bar-wrap');
  var bar = el('div', 'lp-bar');
  var s0 = el('div', 'lp-bar-seg'); s0.style.width = ethPct + '%'; s0.style.background = ethColor; s0.title = 'ETH ' + ethPct.toFixed(1) + '%'; bar.appendChild(s0);
  var s1 = el('div', 'lp-bar-seg'); s1.style.width = revPct + '%'; s1.style.background = revColor; s1.title = sym + ' ' + revPct.toFixed(1) + '%'; bar.appendChild(s1);
  wrap.appendChild(bar);
  var legend = el('div', 'lp-comp-legend lp-comp-legend-h');
  [['ETH', formatPrice(ethF), ethPct, ethColor], [sym, formatCompactTokenAmount(lp.totalRev), revPct, revColor]].forEach(function (r) {
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
  var key = st.key, sqrtP = st.sqrtP;
  if ((key.currency0 || '').toLowerCase() !== ZERO_ADDRESS) throw new Error('Unexpected pool ordering (native not currency0)');

  var s = Number(key.tickSpacing);
  // UI range is ETH-per-REV [pa, pb]; pool price = REV/ETH = 1/(ETH per REV).
  // Lower tick ↔ smaller pool price ↔ 1/pb; upper tick ↔ 1/pa.
  var maxUsable = Math.trunc(887272 / s) * s, minUsable = Math.trunc(-887272 / s) * s;
  var rawLower = lpTickFromPoolPrice(1 / opts.pb);
  var rawUpper = Math.ceil(Math.log(1 / opts.pa) / Math.log(1.0001));
  var tickLower = Math.max(minUsable, lpAlignDown(rawLower, s));
  var tickUpper = Math.min(maxUsable, lpAlignUp(rawUpper, s));
  if (tickUpper <= tickLower) tickUpper = Math.min(maxUsable, tickLower + s);

  var sqrtA = lpSqrtAtTick(tickLower), sqrtB = lpSqrtAtTick(tickUpper);
  var liquidity = lpGetLiquidityForAmounts(sqrtP, sqrtA, sqrtB, opts.amount0, opts.amount1);
  if (liquidity <= 0n) throw new Error('Amounts too small for this range');
  var need = lpGetAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
  // 1% headroom over the exact requirement (SWEEP refunds unused native; Permit2 caps the token pull).
  var amount0Max = need.amount0 + need.amount0 / 100n + 1n;
  var amount1Max = need.amount1 + need.amount1 / 100n + 1n;
  var value = amount0Max; // native ETH side; excess refunded by SWEEP

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
  var sweep = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [key.currency0, acct]);
  var actions = '0x02121214'; // MINT_POSITION, CLOSE_CURRENCY(c0), CLOSE_CURRENCY(c1), SWEEP(c0)
  var unlockData = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [mintParams, closeC0, closeC1, sweep]]);

  return {
    posm: posm, key: key, acct: acct, tickLower: tickLower, tickUpper: tickUpper,
    liquidity: liquidity, need: need, amount0Max: amount0Max, amount1Max: amount1Max, value: value, unlockData: unlockData,
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
  var permitData = null;

  if (prep.amount1Max > 1n && prep.need.amount1 > 0n) {
    // 1. ERC20 → Permit2 (exact amount, bounded; only when the current allowance is short).
    var erc20Allow = await clientFor(chainId).readContract({ address: key.currency1, abi: lpErc20Abi, functionName: 'allowance', args: [acct, PERMIT2_ADDRESS] });
    if (BigInt(erc20Allow) < prep.amount1Max) {
      onStatus('Approving token for Permit2…', 'pending');
      await lpSendTx(chainId, { address: key.currency1, abi: lpErc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, prep.amount1Max] });
    }
    // 2. Permit2 → PositionManager allowance. Reuse it if still valid; otherwise sign one (gasless) and
    //    fold it into the mint multicall — no separate on-chain approval tx.
    var p2 = await clientFor(chainId).readContract({ address: PERMIT2_ADDRESS, abi: lpPermit2Abi, functionName: 'allowance', args: [acct, key.currency1, posm] });
    var p2amount = BigInt(p2[0]), p2exp = Number(p2[1]), p2nonce = Number(p2[2]);
    var now = Math.floor(Date.now() / 1000);
    if (!(p2amount >= prep.amount1Max && p2exp > now)) {
      onStatus('Sign token approval…', 'pending');
      var permitMessage = {
        details: { token: key.currency1, amount: prep.amount1Max, expiration: BigInt(now + 30 * 24 * 3600), nonce: BigInt(p2nonce) },
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
      permitData = encodeFunctionData({ abi: lpPositionManagerAbi, functionName: 'permit', args: [acct, permitMessage, signature] });
    }
  }

  onStatus('Adding liquidity…', 'pending');
  if (permitData) {
    var mintData = encodeFunctionData({ abi: lpPositionManagerAbi, functionName: 'modifyLiquidities', args: [prep.unlockData, deadline] });
    return lpSendTx(chainId, { address: posm, abi: lpPositionManagerAbi, functionName: 'multicall', args: [[permitData, mintData]], value: prep.value });
  }
  return lpSendTx(chainId, { address: posm, abi: lpPositionManagerAbi, functionName: 'modifyLiquidities', args: [prep.unlockData, deadline], value: prep.value });
}

// Build the "exact transaction" preview payload (mirrors the Pay confirm), for openTxConfirm.
function buildAddLiquidityPayload(chainId, chainName, sym, prep) {
  return {
    chain: chainName,
    chainId: chainId,
    contract: 'Uniswap V4 PositionManager',
    address: prep.posm,
    'function': 'modifyLiquidities',
    value: prep.value.toString() + ' wei (' + formatEth(prep.value) + ')',
    erc20Approval: (prep.need.amount1 > 0n)
      ? { token: prep.key.currency1, via: 'Permit2', spender: prep.posm, amount: prep.amount1Max.toString() }
      : null,
    position: {
      actions: 'MINT_POSITION, CLOSE, CLOSE, SWEEP (0x02121214)',
      poolFee: Number(prep.key.fee),
      hooks: prep.key.hooks,
      tickLower: prep.tickLower,
      tickUpper: prep.tickUpper,
      liquidity: prep.liquidity.toString(),
      maxETH: formatEth(prep.amount0Max),
      maxToken: formatTokens(prep.amount1Max) + ' ' + sym,
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
  var state = { chainId: lpChains[0].id, poolP: 0, floor: 0, ceiling: ceiling, revBal: null, ethBal: null, driver: null };

  var intro = el('div', 'modal-balance');
  intro.textContent = 'Seed the buyback pool so payers can route through the AMM. Liquidity is added at the current pool price.';
  wrap.appendChild(intro);

  var lbl0 = el('div', 'modal-label'); lbl0.textContent = 'Chain'; wrap.appendChild(lbl0);
  var chainSel = el('select', 'ops-select');
  chainSel.style.maxWidth = '100%'; chainSel.style.borderRight = '2px solid var(--write)';
  lpChains.forEach(function (c) { var o = document.createElement('option'); o.value = String(c.id); o.textContent = c.name; chainSel.appendChild(o); });
  chainSel.addEventListener('change', function () { state.chainId = Number(chainSel.value); refreshBalances(); refreshPrice(); });
  wrap.appendChild(chainSel);

  var balLine = el('div', 'modal-balance'); balLine.style.marginTop = '8px'; wrap.appendChild(balLine);
  var priceLine = el('div', 'modal-balance'); wrap.appendChild(priceLine);

  // Number-line of where the selected range sits relative to floor / pool price / issuance ceiling.
  var graphWrap = el('div', 'lp-graph'); wrap.appendChild(graphWrap);

  var lblR = el('div', 'modal-label'); lblR.textContent = 'Price range (ETH per ' + sym + ')'; wrap.appendChild(lblR);
  var rnote = el('div', 'modal-balance'); rnote.textContent = 'Defaults span the current cash-out floor to the issuance ceiling.'; wrap.appendChild(rnote);
  var rangeRow = el('div', 'ops-inrow');
  var minInput = el('input', 'ops-amount'); minInput.type = 'number'; minInput.placeholder = 'Min'; rangeRow.appendChild(minInput);
  var toSpan = el('span', 'ops-unit'); toSpan.textContent = 'to'; rangeRow.appendChild(toSpan);
  var maxInput = el('input', 'ops-amount'); maxInput.type = 'number'; maxInput.placeholder = 'Max';
  maxInput.style.borderLeft = 'none'; maxInput.style.borderRight = '2px solid var(--write)'; rangeRow.appendChild(maxInput);
  wrap.appendChild(rangeRow);
  minInput.addEventListener('input', onRangeChange);
  maxInput.addEventListener('input', onRangeChange);

  // Token + ETH amounts — editing one auto-fills the other at the current price within the range.
  var lbl1 = el('div', 'modal-label'); lbl1.textContent = sym + ' to add'; wrap.appendChild(lbl1);
  var tokRow = el('div', 'ops-inrow');
  var tokAmt = el('input', 'ops-amount'); tokAmt.type = 'number'; tokAmt.placeholder = '0.00'; tokRow.appendChild(tokAmt);
  var tokMax = el('button', 'lp-max'); tokMax.textContent = 'Max'; tokRow.appendChild(tokMax);
  var tu = el('span', 'ops-unit'); tu.textContent = sym; tokRow.appendChild(tu); wrap.appendChild(tokRow);

  var lbl2 = el('div', 'modal-label'); lbl2.textContent = 'ETH to add'; wrap.appendChild(lbl2);
  var ethRow = el('div', 'ops-inrow');
  var ethAmt = el('input', 'ops-amount'); ethAmt.type = 'number'; ethAmt.placeholder = '0.00'; ethRow.appendChild(ethAmt);
  var ethMax = el('button', 'lp-max'); ethMax.textContent = 'Max'; ethRow.appendChild(ethMax);
  var eu = el('span', 'ops-unit'); eu.textContent = 'ETH'; ethRow.appendChild(eu); wrap.appendChild(ethRow);

  var pairNote = el('div', 'modal-balance'); pairNote.style.marginTop = '6px';
  pairNote.textContent = 'Concentrated liquidity is deposited as a fixed ' + sym + ':ETH ratio set by the current pool '
    + 'price within your range — so entering one side fills the other. The ratio shifts as you move the range: '
    + 'when the pool price sits near the top of your range the deposit is mostly ' + sym + ', near the bottom mostly ETH.';
  wrap.appendChild(pairNote);

  tokAmt.addEventListener('input', function () { state.driver = 'tok'; autofill(); });
  ethAmt.addEventListener('input', function () { state.driver = 'eth'; autofill(); });
  tokMax.addEventListener('click', function () {
    if (state.revBal == null) { connect(); return; }
    tokAmt.value = formatAmount(state.revBal, 18); state.driver = 'tok'; autofill();
  });
  ethMax.addEventListener('click', function () {
    if (state.ethBal == null) { connect(); return; }
    var buf = 1000000000000000n; // keep ~0.001 ETH for gas
    var v = state.ethBal > buf ? state.ethBal - buf : 0n;
    ethAmt.value = formatAmount(v, 18); state.driver = 'eth'; autofill();
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

  function refreshBalances() {
    var acct = getAccount && getAccount();
    if (!acct) { balLine.textContent = 'Connect a wallet to see your balance.'; state.revBal = null; state.ethBal = null; return; }
    balLine.textContent = 'Your balance: …';
    Promise.all([readUserBalance(project, state.chainId), readEthBalance(state.chainId, acct)]).then(function (r) {
      state.revBal = r[0]; state.ethBal = r[1];
      balLine.textContent = 'Your balance: ' + (r[0] != null ? formatTokens(r[0]) : '—') + ' ' + sym
        + ' · ' + (r[1] != null ? formatEth(r[1]) : '—');
    });
  }

  function refreshPrice() {
    priceLine.textContent = 'Pool price: …';
    Promise.all([readAmmPrice(project, state.chainId), readCashoutPrice(project, state.chainId)]).then(function (res) {
      var amm = res[0], floor = res[1];
      state.poolP = (amm && amm > 0) ? amm : 0;
      state.floor = (floor && floor > 0) ? floor : 0;
      priceLine.textContent = amm ? ('Pool price: ~' + formatPrice(amm) + ' ETH / ' + sym) : 'Pool not initialized on this chain.';
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

  refreshBalances();
  refreshPrice();

  btn.addEventListener('click', function () {
    if (!(getAccount && getAccount())) { connect(); return; }
    var amount0, amount1;
    try { amount0 = ethAmt.value ? parseAmount(ethAmt.value, 18) : 0n; } catch (_) { status.className = 'modal-status error'; status.textContent = 'Invalid ETH amount'; return; }
    try { amount1 = tokAmt.value ? parseAmount(tokAmt.value, 18) : 0n; } catch (_) { status.className = 'modal-status error'; status.textContent = 'Invalid ' + sym + ' amount'; return; }
    if (amount0 <= 0n && amount1 <= 0n) { status.className = 'modal-status error'; status.textContent = 'Enter an amount'; return; }
    var r = currentRange();
    if (!(r.pa > 0) || !(r.pb > r.pa)) { status.className = 'modal-status error'; status.textContent = 'Set a valid price range'; return; }
    btn.disabled = true;
    status.className = 'modal-status'; status.textContent = 'Preparing…';
    var lpOpts = { project: project, chainId: state.chainId, amount0: amount0, amount1: amount1, pa: r.pa, pb: r.pb };
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
          status.appendChild(document.createTextNode('Liquidity added · TX: '));
          status.appendChild(renderExplorerTxLink(state.chainId, hash, truncAddr(hash)));
          refreshBalances(); refreshPrice();
        }).catch(function (e) {
          ctx.confirm.disabled = false; ctx.cancel.disabled = false;
          var msg = (e && (e.shortMessage || e.message)) || 'Add liquidity failed';
          ctx.showStatus(msg.length > 160 ? msg.slice(0, 160) + '…' : msg, 'error');
        });
      }, { title: 'Confirm add liquidity', confirmText: 'Confirm & add liquidity', closeOnConfirm: false });
    }).catch(function (e) {
      btn.disabled = false;
      status.className = 'modal-status error';
      var msg = (e && (e.shortMessage || e.message)) || 'Could not prepare';
      status.textContent = msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
    });
  });
  return wrap;
}

function opsRow(c, s, b, u, isHead, isTotal, chainId) {
  var row = el('div', 'detail-ops-row' + (isHead ? ' detail-ops-head' : '') + (isTotal ? ' detail-ops-total' : ''));
  [c, s, b, u].forEach(function (v, i) {
    var cell = el('span', 'detail-ops-cell');
    if (i === 0 && chainId != null) {
      cell.classList.add('detail-ops-chain');
      cell.appendChild(chainLogo(chainId, c));
      cell.appendChild(document.createTextNode(c));
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
      terminal
        ? read(cid, 'JBTerminalStore', storeBalanceAbi, 'balanceOf', [terminal, pid, NATIVE_TOKEN]).catch(function () { return null; })
        : Promise.resolve(null),
    ]).then(function (res) {
      var supply = res[0], balance = res[1];
      // Unit value = reclaim for 1 token at current supply + surplus(≈native balance); only meaningful
      // once there's at least a token of supply. No currency conversion → no price-feed revert.
      if (supply && supply >= ONE_TOKEN && balance != null) {
        return read(cid, 'JBTerminalStore', reclaimableAbi, 'currentReclaimableSurplusOf', [pid, ONE_TOKEN, supply, balance])
          .then(function (uv) { return { id: cid, name: chain.name, supply: supply, balance: balance, unitValue: uv }; })
          .catch(function () { return { id: cid, name: chain.name, supply: supply, balance: balance, unitValue: null }; });
      }
      return { id: cid, name: chain.name, supply: supply, balance: balance, unitValue: null };
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

function kvRowNode(key, node) {
  var row = el('div', 'detail-ruleset-row');
  var k = el('span', 'detail-ruleset-key');
  k.textContent = key;
  row.appendChild(k);
  var v = el('span', 'detail-ruleset-val');
  v.appendChild(node);
  row.appendChild(v);
  return row;
}
