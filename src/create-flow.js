// src/create-flow.js
// "Create a project" wizard — a juicebox.money/create-style multi-step flow that launches a V6
// project, feature-complete with what the contracts allow. It reuses the calldata encoder exported by
// launch-component.js (single source of truth) and routes the deploy by (chain count, NFTs):
//
//   1 chain,  no NFTs -> JBController.launchProjectFor
//   1 chain,  NFTs    -> JB721TiersHookProjectDeployer.launchProjectFor
//   >1 chain, no NFTs -> JBOmnichainDeployer.launchProjectFor (one tx per chain, shared salt + suckers)
//   >1 chain, NFTs    -> JBOmnichainDeployer.launchProjectFor (721 overload, one tx per chain)
//
// Project metadata (name/logo/description/links) is pinned to IPFS via Pinata (src/ipfs-pin.js); the
// JWT lives in localStorage only.

import { keccak256, stringToHex, parseEther, parseUnits, encodeFunctionData, formatEther, createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize as ensNormalize } from 'viem/ens';
import {
  el, executeTransaction, simulateTransaction, confirmTransactionModal, getAddress, getAccount, connect, NATIVE_TOKEN,
  createPublicClientForChain, getWalletClient, switchChain, truncAddr,
} from './component-base.js';
import {
  launchProjectAbi, buildRulesetConfigs, createDefaultRuleset, ZERO,
} from './launch-component.js';
import { pinFile, pinJson, hasPinata, setPinataJwt, encodeIpfsUriToBytes32 } from './ipfs-pin.js';
import { buildForwardedTx, relayrPostBundle, relayrPay, relayrPoll } from './relayr.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Steps depend on the chosen project type (defaults to Custom). Type is always the first step.
// Revnet is a reduced flow (no Shop/Settlement — ETH-only, single canonical terminal, suckers on Deploy).
function stepsFor(state) {
  if (state.projectType === 'revnet') return ['Flavor', 'Details', 'Stages', 'Shop', 'Settlement', 'Deploy'];
  return ['Flavor', 'Details', 'Rulesets', 'Shop', 'Settlement', 'Deploy'];
}

// The chain selector shows canonical (mainnet) names; the mainnet/testnet toggle (at Deploy) maps each to
// the actual chain to deploy on. Per-chain overrides are keyed by `canon` so they survive a network switch.
var CHAIN_PAIRS = [
  { canon: 1, name: 'Ethereum', testnet: 11155111 },
  { canon: 10, name: 'Optimism', testnet: 11155420 },
  { canon: 42161, name: 'Arbitrum', testnet: 421614 },
  { canon: 8453, name: 'Base', testnet: 84532 },
];
function actualChainId(canon, network) { var p = CHAIN_PAIRS.find(function (x) { return x.canon === canon; }); return p ? (network === 'mainnet' ? p.canon : p.testnet) : canon; }
function canonChainId(id) { var p = CHAIN_PAIRS.find(function (x) { return x.canon === id || x.testnet === id; }); return p ? p.canon : id; }

var CHAIN_OPTIONS = [
  { id: 1, name: 'Ethereum', testnet: false }, { id: 10, name: 'Optimism', testnet: false },
  { id: 42161, name: 'Arbitrum', testnet: false }, { id: 8453, name: 'Base', testnet: false },
  { id: 11155111, name: 'Sepolia', testnet: true }, { id: 11155420, name: 'OP Sepolia', testnet: true },
  { id: 84532, name: 'Base Sepolia', testnet: true }, { id: 421614, name: 'Arb Sepolia', testnet: true },
];

var L1_CHAINS = { 1: true, 11155111: true };

// USDC per chain (for the "Accepts" accounting-context option). 6 decimals.
var USDC_BY_CHAIN = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  84532: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', 11155111: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  11155420: '0x5fd84259d66cd46123540766be93dfe6d43130d7', 421614: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
};

export var DURATION_PRESETS = [
  { label: '1 day', seconds: 86400 }, { label: '3 days', seconds: 259200 },
  { label: '7 days', seconds: 604800 }, { label: '14 days', seconds: 1209600 },
  { label: '28 days', seconds: 2419200 }, { label: '30 days', seconds: 2592000 },
  { label: '90 days', seconds: 7776000 }, { label: '365 days', seconds: 31536000 },
];

var DEADLINE_OPTIONS = [
  { key: '3hours', label: '3-hour deadline', short: '3h', contract: 'JBDeadline3Hours' },
  { key: '1day', label: '1-day deadline', short: '1 day', contract: 'JBDeadline1Day', def: true },
  { key: '3days', label: '3-day deadline', short: '3 days', contract: 'JBDeadline3Days' },
  { key: '7days', label: '7-day deadline', short: '7 days', contract: 'JBDeadline7Days' },
  { key: 'none', label: 'No deadline', short: '', contract: null },
];

var TAG_OPTIONS = ['AI', 'Art', 'Brand', 'Business', 'Charity', 'Climate', 'Collectibles', 'Community',
  'Creator', 'DAO', 'DeFi', 'DeSci', 'Education', 'Events', 'Film', 'Fundraising', 'Games', 'Grants',
  'Hackathon', 'Media', 'Memes', 'Music', 'NFT', 'Open Source', 'Podcast', 'Public Goods', 'Research',
  'Social', 'Software', 'Sports', 'Tooling', 'Writing'];

var UINT224_MAX = (1n << 224n) - 1n;
var UINT112_MAX = (1n << 112n) - 1n;
var UINT104_MAX = (1n << 104n) - 1n;
var SPLITS_TOTAL = 1000000000; // 1e9

// Parse a user-typed token amount (whole or decimal, any size) to its 18-dec fixed-point BigInt, clamped
// to `maxV` and never negative. Returns 0n on empty/garbage (never throws — parseEther throws on bad input).
function tokenAmount18(v, maxV) {
  var n;
  try { n = (v == null || String(v).trim() === '') ? 0n : parseEther(String(v).trim()); }
  catch (_) { return 0n; }
  if (n < 0n) return 0n;
  return (maxV != null && n > maxV) ? maxV : n;
}

// ---------------------------------------------------------------------------
// ABI building blocks (shared struct components)
// ---------------------------------------------------------------------------

// Field order MUST match the on-chain JBSplit struct exactly (the selector hashes the tuple types in
// order): percent, projectId, beneficiary, preferAddToBalance, lockedUntil, hook.
var SPLIT_COMPONENTS = [
  { name: 'percent', type: 'uint32' },
  { name: 'projectId', type: 'uint64' },
  { name: 'beneficiary', type: 'address' },
  { name: 'preferAddToBalance', type: 'bool' },
  { name: 'lockedUntil', type: 'uint48' },
  { name: 'hook', type: 'address' },
];
var SPLIT_GROUP_COMPONENTS = [
  { name: 'groupId', type: 'uint256' },
  { name: 'splits', type: 'tuple[]', components: SPLIT_COMPONENTS },
];
var FUND_ACCESS_COMPONENTS = [
  { name: 'terminal', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'payoutLimits', type: 'tuple[]', components: [
    { name: 'amount', type: 'uint224' }, { name: 'currency', type: 'uint32' }] },
  { name: 'surplusAllowances', type: 'tuple[]', components: [
    { name: 'amount', type: 'uint224' }, { name: 'currency', type: 'uint32' }] },
];
var METADATA_FULL = [
  { name: 'reservedPercent', type: 'uint16' }, { name: 'cashOutTaxRate', type: 'uint16' },
  { name: 'baseCurrency', type: 'uint32' }, { name: 'pausePay', type: 'bool' },
  { name: 'pauseCreditTransfers', type: 'bool' }, { name: 'allowOwnerMinting', type: 'bool' },
  { name: 'allowSetCustomToken', type: 'bool' }, { name: 'allowTerminalMigration', type: 'bool' },
  { name: 'allowSetTerminals', type: 'bool' }, { name: 'allowSetController', type: 'bool' },
  { name: 'allowAddAccountingContext', type: 'bool' }, { name: 'allowAddPriceFeed', type: 'bool' },
  { name: 'ownerMustSendPayouts', type: 'bool' }, { name: 'holdFees', type: 'bool' },
  { name: 'useTotalSurplusForCashOuts', type: 'bool' }, { name: 'useDataHookForPay', type: 'bool' },
  { name: 'useDataHookForCashOut', type: 'bool' }, { name: 'dataHook', type: 'address' },
  { name: 'metadata', type: 'uint16' },
];
var METADATA_PAYHOOK = [
  { name: 'reservedPercent', type: 'uint16' }, { name: 'cashOutTaxRate', type: 'uint16' },
  { name: 'baseCurrency', type: 'uint32' }, { name: 'pausePay', type: 'bool' },
  { name: 'pauseCreditTransfers', type: 'bool' }, { name: 'allowOwnerMinting', type: 'bool' },
  { name: 'allowSetCustomToken', type: 'bool' }, { name: 'allowTerminalMigration', type: 'bool' },
  { name: 'allowSetTerminals', type: 'bool' }, { name: 'allowSetController', type: 'bool' },
  { name: 'allowAddAccountingContext', type: 'bool' }, { name: 'allowAddPriceFeed', type: 'bool' },
  { name: 'ownerMustSendPayouts', type: 'bool' }, { name: 'holdFees', type: 'bool' },
  { name: 'scopeCashOutsToLocalBalances', type: 'bool' }, { name: 'useDataHookForCashOut', type: 'bool' },
  { name: 'metadata', type: 'uint16' },
];
function rulesetConfigComponents(metaComponents) {
  return [
    { name: 'mustStartAtOrAfter', type: 'uint48' }, { name: 'duration', type: 'uint32' },
    { name: 'weight', type: 'uint112' }, { name: 'weightCutPercent', type: 'uint32' },
    { name: 'approvalHook', type: 'address' },
    { name: 'metadata', type: 'tuple', components: metaComponents },
    { name: 'splitGroups', type: 'tuple[]', components: SPLIT_GROUP_COMPONENTS },
    { name: 'fundAccessLimitGroups', type: 'tuple[]', components: FUND_ACCESS_COMPONENTS },
  ];
}
var TERMINAL_CONFIG_COMPONENTS = [
  { name: 'terminal', type: 'address' },
  { name: 'accountingContextsToAccept', type: 'tuple[]', components: [
    { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }, { name: 'currency', type: 'uint32' }] },
];
// 721
var TIER_FLAGS = [
  { name: 'allowOwnerMint', type: 'bool' }, { name: 'useReserveBeneficiaryAsDefault', type: 'bool' },
  { name: 'transfersPausable', type: 'bool' }, { name: 'useVotingUnits', type: 'bool' },
  { name: 'cantBeRemoved', type: 'bool' }, { name: 'cantIncreaseDiscountPercent', type: 'bool' },
  { name: 'cantBuyWithCredits', type: 'bool' },
];
var TIER_COMPONENTS = [
  { name: 'price', type: 'uint104' }, { name: 'initialSupply', type: 'uint32' },
  { name: 'votingUnits', type: 'uint32' }, { name: 'reserveFrequency', type: 'uint16' },
  { name: 'reserveBeneficiary', type: 'address' }, { name: 'encodedIpfsUri', type: 'bytes32' },
  { name: 'category', type: 'uint24' }, { name: 'discountPercent', type: 'uint8' },
  { name: 'flags', type: 'tuple', components: TIER_FLAGS },
  { name: 'splitPercent', type: 'uint32' },
  { name: 'splits', type: 'tuple[]', components: SPLIT_COMPONENTS },
];
var HOOK_FLAGS = [
  { name: 'noNewTiersWithReserves', type: 'bool' }, { name: 'noNewTiersWithVotes', type: 'bool' },
  { name: 'noNewTiersWithOwnerMinting', type: 'bool' }, { name: 'preventOverspending', type: 'bool' },
  { name: 'issueTokensForSplits', type: 'bool' },
];
var DEPLOY_721_COMPONENTS = [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'baseUri', type: 'string' },
  { name: 'tokenUriResolver', type: 'address' }, { name: 'contractUri', type: 'string' },
  { name: 'tiersConfig', type: 'tuple', components: [
    { name: 'tiers', type: 'tuple[]', components: TIER_COMPONENTS },
    { name: 'currency', type: 'uint32' }, { name: 'decimals', type: 'uint8' }] },
  { name: 'flags', type: 'tuple', components: HOOK_FLAGS },
];
var SUCKER_CONFIG_COMPONENTS = [
  { name: 'deployerConfigurations', type: 'tuple[]', components: [
    { name: 'deployer', type: 'address' }, { name: 'peer', type: 'bytes32' },
    { name: 'mappings', type: 'tuple[]', components: [
      { name: 'localToken', type: 'address' }, { name: 'minGas', type: 'uint32' },
      { name: 'remoteToken', type: 'bytes32' }] }] },
  { name: 'salt', type: 'bytes32' },
];

// ---- Revnet (REVDeployer.deployFor) — structs from revnet-core-v6/src/structs, encoding verified
// against test/REVLifecycle.t.sol. The 4-arg overload deploys a revnet with a default empty 721 hook. ----
var JBCONSTANTS = { MAX_WEIGHT_CUT_PERCENT: 1000000000, MAX_CASH_OUT_TAX_RATE: 10000, MAX_RESERVED_PERCENT: 10000 };
// Revnets price issuance in the native token's own currency id (uint32(uint160(NATIVE_TOKEN)) = 61166) so
// no JBPrices feed is needed — base currency == accounting-context currency. Matches the lifecycle test.
var NATIVE_CURRENCY = Number(BigInt(NATIVE_TOKEN) % (1n << 32n));
var ACCOUNTING_CONTEXT_COMPONENTS = [
  { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }, { name: 'currency', type: 'uint32' },
];
var REV_AUTOISSUANCE_COMPONENTS = [
  { name: 'chainId', type: 'uint32' }, { name: 'count', type: 'uint104' }, { name: 'beneficiary', type: 'address' },
];
var REV_STAGE_COMPONENTS = [
  { name: 'startsAtOrAfter', type: 'uint48' },
  { name: 'autoIssuances', type: 'tuple[]', components: REV_AUTOISSUANCE_COMPONENTS },
  { name: 'splitPercent', type: 'uint16' },
  { name: 'splits', type: 'tuple[]', components: SPLIT_COMPONENTS },
  { name: 'initialIssuance', type: 'uint112' },
  { name: 'issuanceCutFrequency', type: 'uint32' },
  { name: 'issuanceCutPercent', type: 'uint32' },
  { name: 'cashOutTaxRate', type: 'uint16' },
  { name: 'extraMetadata', type: 'uint16' },
];
var REV_CONFIG_COMPONENTS = [
  { name: 'description', type: 'tuple', components: [
    { name: 'name', type: 'string' }, { name: 'ticker', type: 'string' },
    { name: 'uri', type: 'string' }, { name: 'salt', type: 'bytes32' }] },
  { name: 'baseCurrency', type: 'uint32' },
  { name: 'operator', type: 'address' },
  { name: 'scopeCashOutsToLocalBalances', type: 'bool' },
  { name: 'stageConfigurations', type: 'tuple[]', components: REV_STAGE_COMPONENTS },
];
// REVDeployer.deployFor — the 4-arg overload (default empty 721 hook).
var revDeployAbi = [{
  type: 'function', name: 'deployFor', stateMutability: 'payable',
  inputs: [
    { name: 'revnetId', type: 'uint256' },
    { name: 'configuration', type: 'tuple', components: REV_CONFIG_COMPONENTS },
    { name: 'accountingContextsToAccept', type: 'tuple[]', components: ACCOUNTING_CONTEXT_COMPONENTS },
    { name: 'suckerDeploymentConfiguration', type: 'tuple', components: SUCKER_CONFIG_COMPONENTS },
  ],
  outputs: [{ name: 'revnetId', type: 'uint256' }, { name: 'hook', type: 'address' }],
}];

// REVDeployer.deployFor — the 6-arg overload (with a tiered ERC-721 hook for store items + Croptop posts).
var REV721_FLAGS = [
  { name: 'noNewTiersWithReserves', type: 'bool' }, { name: 'noNewTiersWithVotes', type: 'bool' },
  { name: 'noNewTiersWithOwnerMinting', type: 'bool' }, { name: 'preventOverspending', type: 'bool' },
];
var REV_BASELINE_721_COMPONENTS = [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'baseUri', type: 'string' },
  { name: 'tokenUriResolver', type: 'address' }, { name: 'contractUri', type: 'string' },
  { name: 'tiersConfig', type: 'tuple', components: [
    { name: 'tiers', type: 'tuple[]', components: TIER_COMPONENTS },
    { name: 'currency', type: 'uint32' }, { name: 'decimals', type: 'uint8' }] },
  { name: 'flags', type: 'tuple', components: REV721_FLAGS },
];
var REV_DEPLOY_721_COMPONENTS = [
  { name: 'baseline721HookConfiguration', type: 'tuple', components: REV_BASELINE_721_COMPONENTS },
  { name: 'salt', type: 'bytes32' },
  { name: 'preventOperatorAdjustingTiers', type: 'bool' }, { name: 'preventOperatorUpdatingMetadata', type: 'bool' },
  { name: 'preventOperatorMinting', type: 'bool' }, { name: 'preventOperatorIncreasingDiscountPercent', type: 'bool' },
];
var REV_CROPTOP_POST_COMPONENTS = [
  { name: 'category', type: 'uint24' }, { name: 'minimumPrice', type: 'uint104' },
  { name: 'minimumTotalSupply', type: 'uint32' }, { name: 'maximumTotalSupply', type: 'uint32' },
  { name: 'maximumSplitPercent', type: 'uint32' }, { name: 'allowedAddresses', type: 'address[]' },
];
var revDeploy721Abi = [{
  type: 'function', name: 'deployFor', stateMutability: 'payable',
  inputs: [
    { name: 'revnetId', type: 'uint256' },
    { name: 'configuration', type: 'tuple', components: REV_CONFIG_COMPONENTS },
    { name: 'accountingContextsToAccept', type: 'tuple[]', components: ACCOUNTING_CONTEXT_COMPONENTS },
    { name: 'suckerDeploymentConfiguration', type: 'tuple', components: SUCKER_CONFIG_COMPONENTS },
    { name: 'tiered721HookConfiguration', type: 'tuple', components: REV_DEPLOY_721_COMPONENTS },
    { name: 'allowedPosts', type: 'tuple[]', components: REV_CROPTOP_POST_COMPONENTS },
  ],
  outputs: [{ name: 'revnetId', type: 'uint256' }, { name: 'hook', type: 'address' }],
}];

// JB721TiersHookProjectDeployer.launchProjectFor (single-chain + NFTs)
var deployer721Abi = [{
  type: 'function', name: 'launchProjectFor', stateMutability: 'payable',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'deployTiersHookConfig', type: 'tuple', components: DEPLOY_721_COMPONENTS },
    { name: 'launchProjectConfig', type: 'tuple', components: [
      { name: 'projectUri', type: 'string' },
      { name: 'rulesetConfigurations', type: 'tuple[]', components: rulesetConfigComponents(METADATA_PAYHOOK) },
      { name: 'terminalConfigurations', type: 'tuple[]', components: TERMINAL_CONFIG_COMPONENTS },
      { name: 'memo', type: 'string' }] },
    { name: 'controller', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
  outputs: [{ name: 'projectId', type: 'uint256' }, { name: 'hook', type: 'address' }],
}];

// JBOmnichainDeployer.launchProjectFor (no-721 overload)
var omnichainAbi = [{
  type: 'function', name: 'launchProjectFor', stateMutability: 'payable',
  inputs: [
    { name: 'owner', type: 'address' }, { name: 'projectUri', type: 'string' },
    { name: 'rulesetConfigurations', type: 'tuple[]', components: rulesetConfigComponents(METADATA_FULL) },
    { name: 'terminalConfigurations', type: 'tuple[]', components: TERMINAL_CONFIG_COMPONENTS },
    { name: 'memo', type: 'string' },
    { name: 'suckerDeploymentConfiguration', type: 'tuple', components: SUCKER_CONFIG_COMPONENTS },
  ],
  outputs: [{ name: 'projectId', type: 'uint256' }, { name: 'hook', type: 'address' }, { name: 'suckers', type: 'address[]' }],
}];

// JBOmnichainDeployer.launchProjectFor (721 overload)
var omnichain721Abi = [{
  type: 'function', name: 'launchProjectFor', stateMutability: 'payable',
  inputs: [
    { name: 'owner', type: 'address' }, { name: 'projectUri', type: 'string' },
    { name: 'deploy721Config', type: 'tuple', components: [
      { name: 'deployTiersHookConfig', type: 'tuple', components: DEPLOY_721_COMPONENTS },
      { name: 'useDataHookForCashOut', type: 'bool' }, { name: 'salt', type: 'bytes32' }] },
    { name: 'rulesetConfigurations', type: 'tuple[]', components: rulesetConfigComponents(METADATA_FULL) },
    { name: 'terminalConfigurations', type: 'tuple[]', components: TERMINAL_CONFIG_COMPONENTS },
    { name: 'memo', type: 'string' },
    { name: 'suckerDeploymentConfiguration', type: 'tuple', components: SUCKER_CONFIG_COMPONENTS },
  ],
  outputs: [{ name: 'projectId', type: 'uint256' }, { name: 'hook', type: 'address' }, { name: 'suckers', type: 'address[]' }],
}];

// ---------------------------------------------------------------------------
// Sucker deployer selection (per local->remote pair)
// ---------------------------------------------------------------------------

function chainFam(id) {
  if (id === 1 || id === 11155111) return 'eth';
  if (id === 10 || id === 11155420) return 'op';
  if (id === 8453 || id === 84532) return 'base';
  if (id === 42161 || id === 421614) return 'arb';
  return '';
}
function isL1Chain(id) { return chainFam(id) === 'eth'; }

// Resolve a sucker-deployer address on `localId` for one bridge kind to `remoteId`. Native bridges only
// connect Ethereum (L1) with an L2 — null for L2↔L2. CCIP connects any pair. Returns null if undeployable.
function suckerDeployerForBridge(localId, remoteId, bridge) {
  if (bridge === 'native') {
    if (!(isL1Chain(localId) || isL1Chain(remoteId))) return null; // native is Ethereum↔L2 only
    var rollup = isL1Chain(localId) ? chainFam(remoteId) : chainFam(localId);
    var name = rollup === 'op' ? 'JBOptimismSuckerDeployer' : rollup === 'base' ? 'JBBaseSuckerDeployer' : rollup === 'arb' ? 'JBArbitrumSuckerDeployer' : null;
    return name ? (getAddress(name, localId) || null) : null;
  }
  // CCIP — deployers are keyed by the REMOTE chain (e.g. JBCCIPSuckerDeployer__ARB on chain X is the
  // deployer that connects X to Arbitrum). Pick by remoteId, NOT the first suffix that happens to exist on
  // the local chain — otherwise every remote reuses one deployer and gets miswired. No fallback scan: if the
  // route-specific deployer is absent, return null so the pair is reported uncovered instead of silently wrong.
  var suffix = ccipSuffixForRemote(remoteId);
  return suffix ? (getAddress('JBCCIPSuckerDeployer' + suffix, localId) || null) : null;
}

// The route-keyed CCIP deployer suffix for a remote chain: __<FAM> (mainnet) / __<FAM>_SEP (testnet).
function ccipSuffixForRemote(remoteId) {
  var fam = chainFam(remoteId);
  if (!fam) return null;
  var testnet = remoteId === 11155111 || remoteId === 11155420 || remoteId === 84532 || remoteId === 421614;
  return '__' + fam.toUpperCase() + (testnet ? '_SEP' : '');
}

function bridgesForType(suckerType) { return suckerType === 'both' ? ['native', 'ccip'] : [suckerType || 'native']; }

// address → bytes32 (left-padded) for a sucker token mapping's remoteToken.
function addrToBytes32(a) { return '0x000000000000000000000000' + String(a).slice(2).toLowerCase(); }

// The token mapping for one (local→remote) sucker: bridge the accounting token. Native ETH by default;
// USDC when the project's accounting token is USDC (uses each chain's own USDC address).
function tokenMappingFor(localId, remoteId, accepts) {
  if ((accepts && accepts[0]) === 'usdc') {
    var local = USDC_BY_CHAIN[localId], remote = USDC_BY_CHAIN[remoteId];
    if (local && remote) return { localToken: local, minGas: 200000, remoteToken: addrToBytes32(remote) };
  }
  return { localToken: NATIVE_TOKEN, minGas: 200000, remoteToken: addrToBytes32(NATIVE_TOKEN) };
}

function suckerConfigFor(localId, otherChainIds, salt, suckerType, accepts) {
  var deployerConfigurations = [];
  var covered = {};
  otherChainIds.forEach(function (remoteId) {
    bridgesForType(suckerType).forEach(function (bridge) {
      var deployer = suckerDeployerForBridge(localId, remoteId, bridge);
      if (!deployer) return; // bridge not available for this pair
      covered[remoteId] = true;
      deployerConfigurations.push({
        deployer: deployer,
        peer: '0x0000000000000000000000000000000000000000000000000000000000000000',
        mappings: [tokenMappingFor(localId, remoteId, accepts)],
      });
    });
  });
  // A remote is "missing" if NONE of the requested bridges could connect it.
  var missing = otherChainIds.filter(function (r) { return !covered[r]; });
  return { deployerConfigurations: deployerConfigurations, salt: salt, missing: missing };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function initState() {
  return {
    step: 0,
    projectType: 'custom',           // 'custom' | 'revnet' — chosen on the Type step; defaults to Custom
    details: {
      name: '', ticker: '', tagline: '', description: '', logoUri: '', logoUploading: false,
      website: '', twitter: '', discord: '', telegram: '', tags: [],
      coverImageUri: '', payDisclosure: '', owner: '', immutable: false,
      linksOpen: false, ownerOpen: false, tagsOpen: false, customOpen: false,
    },
    revOperator: '',                 // revnet operator (receives splits, can reassign) — blank => owner/wallet
    revBaseCurrency: 1,              // revnet issuance-pricing currency: 1=ETH (native, 61166) | 2=USD
    accepts: ['eth'],                // accounting token(s) the project HOLDS / issues against: 'eth' and/or 'usdc'
    swapRouter: true,                // include the router terminal (any token auto-converts) — on by default
    stages: [createStage()],         // ordered rulesets queued at launch (revnet-style stages)
    afterMode: 'wait',               // what happens after a single timed ruleset: wait | terminal | cycle (custom adds a 2nd stage)
    shopEnabled: false, // off by default — the Shop step starts as a single opt-in checkbox
    storePricingCurrency: 1, // store-item price denomination (1=ETH / 2=USD) — JB721 tiersConfig.currency
    network: 'testnet', // mainnet | testnet — chosen at Deploy; maps the selected canonical chains to actual ids
    suckerType: 'native', // bridge between chains: native (Ethereum↔L2 only) | ccip (any pair) | both
    nfts: [], // item drafts — see itemDraft() for shape
    perChain: {}, // multichain overrides: { [chainId]: { payouts:{[stageIdx]:{[recipIdx]:amtStr}}, items:{[itemIdx]:{include,supply}} } }
    storeCategories: [], // {id, name} named categories the user adds locally in the Shop step
    collection: { // top-level JB721 hook config (name/symbol auto-derive from the project until edited)
      name: '', symbol: '', nameTouched: false, symbolTouched: false, extrasOpen: false,
      preventOverspending: false, noNewTiersWithReserves: false, noNewTiersWithVotes: false,
      noNewTiersWithOwnerMinting: false, issueTokensForSplits: false,
      // revnet-only: extra 721 permissions the operator gets (default on — REVDeployer grants all four).
      opCanAdjustTiers: true, opCanUpdateMetadata: true, opCanMint: true, opCanIncreaseDiscount: true,
    },
    chainIds: [11155111],
    tos: false,
    deploying: false, statusLines: [], done: false, quoteChoice: null,
  };
}

// ---------------------------------------------------------------------------
// Draft persistence + .jb import/export
// ---------------------------------------------------------------------------

var DRAFT_KEY = 'jb-create-draft';

// A JSON-safe snapshot of the form state: drop functions (`_close`), transient deploy flags, and the
// in-flight logo-upload flag so a refresh/import never restores a half-deploy or "uploading…" state.
function sanitizeState(state) {
  var c = {};
  Object.keys(state).forEach(function (k) { if (k === '_close' || typeof state[k] === 'function') return; c[k] = state[k]; });
  c = JSON.parse(JSON.stringify(c)); // deep clone + strip any nested functions
  c.deploying = false; c.statusLines = []; c.done = false; delete c.deployed; c.quoteChoice = null;
  if (c.details) c.details.logoUploading = false;
  return c;
}

// Merge a loaded/imported draft over the current defaults (tolerant of schema drift + partial files).
function mergeDraft(obj) {
  if (!obj || typeof obj !== 'object') return null;
  var s = Object.assign(initState(), obj);
  s.details = Object.assign(initState().details, obj.details || {});
  s.collection = Object.assign(initState().collection, obj.collection || {});
  s.deploying = false; s.statusLines = []; s.done = false; delete s.deployed; s.quoteChoice = null;
  if (s.details) s.details.logoUploading = false;
  s.step = Math.max(0, Math.min(Number(s.step) || 0, stepsFor(s).length - 1));
  return s;
}

function saveDraft(state) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(sanitizeState(state))); } catch (_) {} }
function loadDraft() { try { var r = localStorage.getItem(DRAFT_KEY); return r ? mergeDraft(JSON.parse(r)) : null; } catch (_) { return null; } }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (_) {} }

// Download the current draft as a `.jb` file (plain JSON) to save or share for review.
function exportDraftFile(state) {
  var nm = ((state.details && state.details.name) || 'project').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project';
  var blob = new Blob([JSON.stringify(sanitizeState(state), null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = nm + '.jb';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// ---------------------------------------------------------------------------
// Entry / overlay
// ---------------------------------------------------------------------------

export function openCreateFlow() {
  // Restore a saved draft if one exists (survives refresh); otherwise start fresh.
  var state = loadDraft() || initState();
  var pre = getAccount && getAccount();
  // Owner/operator are required and explicit — prefill the connected wallet only where still blank.
  if (pre) { if (!state.details.owner) state.details.owner = pre; if (!state.revOperator) state.revOperator = pre; }

  var overlay = el('div', 'create-overlay');
  var sheet = el('div', 'create-sheet');
  overlay.appendChild(sheet);

  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }
  state._close = close; // so the success panel's "Go to project" can dismiss the overlay
  function onKey(e) { if (e.key === 'Escape' && !state.deploying) close(); }
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !state.deploying) close(); });
  document.addEventListener('keydown', onKey);

  // Replace the live state object's contents in place (render/handlers close over `state`), then re-render.
  function applyImported(obj) {
    var merged = mergeDraft(obj);
    if (!merged) { alert('That doesn’t look like a valid .jb project file.'); return; }
    Object.keys(state).forEach(function (k) { if (k !== '_close') delete state[k]; });
    Object.assign(state, merged);
    render();
  }
  function onImport(file) {
    var reader = new FileReader();
    reader.onload = function () { try { applyImported(JSON.parse(String(reader.result))); } catch (_) { alert('Could not read that .jb file.'); } };
    reader.onerror = function () { alert('Could not read that file.'); };
    reader.readAsText(file);
  }
  function onExport() { exportDraftFile(state); }

  function render() {
    sheet.innerHTML = '';
    sheet.appendChild(renderHeader(state, close, onImport, onExport));
    sheet.appendChild(renderStepper(state, render));
    var body = el('div', 'create-step');
    body.appendChild(renderStep(state, render));
    sheet.appendChild(body);
    sheet.appendChild(renderFooter(state, render, close));
    // Persist the draft after every render so a refresh restores the work. Clear it once deployed.
    if (state.done) clearDraft(); else saveDraft(state);
  }
  render();

  document.body.appendChild(overlay);
  return { close: close };
}

function renderHeader(state, close, onImport, onExport) {
  var head = el('div', 'create-head');
  var title = el('div', 'create-title');
  title.textContent = 'Create a project';
  head.appendChild(title);

  // .jb import/export — save the in-progress draft to a file, or load one (e.g. to share for review).
  var actions = el('div', 'create-head-actions');
  var imp = el('button', 'create-io-btn'); imp.textContent = 'import';
  imp.title = 'Load a saved or shared project draft (.jb)';
  imp.disabled = !!state.deploying;
  var fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = '.jb,application/json'; fileIn.style.display = 'none';
  fileIn.addEventListener('change', function () { var f = fileIn.files && fileIn.files[0]; if (f && onImport) onImport(f); fileIn.value = ''; });
  imp.addEventListener('click', function () { if (!state.deploying) fileIn.click(); });
  var exp = el('button', 'create-io-btn'); exp.textContent = 'export';
  exp.title = 'Download this draft as a .jb file to save or share for review';
  exp.addEventListener('click', function () { if (onExport) onExport(); });
  actions.appendChild(imp); actions.appendChild(exp); actions.appendChild(fileIn);
  head.appendChild(actions);

  var x = el('button', 'create-close');
  x.textContent = '✕';
  x.title = 'Close';
  x.addEventListener('click', function () { if (!state.deploying) close(); });
  head.appendChild(x);
  return head;
}

function renderStepper(state, render) {
  var row = el('div', 'create-stepper');
  stepsFor(state).forEach(function (label, i) {
    if (i > 0) row.appendChild(el('div', 'create-step-conn' + (i <= state.step ? ' done' : '')));
    var item = el('button', 'create-step-dot' + (i === state.step ? ' active' : (i < state.step ? ' done' : '')));
    var dot = el('span', 'create-dot');
    item.appendChild(dot);
    var t = el('span', 'create-step-label');
    t.textContent = label;
    item.appendChild(t);
    item.addEventListener('click', function () { state.step = i; render(); });
    row.appendChild(item);
  });
  return row;
}

function renderFooter(state, render, close) {
  var foot = el('div', 'create-foot');
  var back = el('button', 'create-btn ghost');
  back.textContent = '← Back';
  back.disabled = state.step === 0 || state.deploying;
  back.addEventListener('click', function () { if (state.step > 0) { state.step--; render(); } });
  foot.appendChild(back);

  if (state.step < stepsFor(state).length - 1) {
    var next = el('button', 'create-btn');
    next.textContent = 'Next →';
    next.addEventListener('click', function () { state.step++; render(); });
    foot.appendChild(next);
  }
  return foot;
}

// ---------------------------------------------------------------------------
// Step dispatch
// ---------------------------------------------------------------------------

function renderStep(state, render) {
  switch (stepsFor(state)[state.step]) {
    case 'Flavor': return renderType(state, render);
    case 'Details': return renderDetails(state, render);
    case 'Rulesets': return renderStages(state, render);
    case 'Stages': return renderRevnetStages(state, render);
    case 'Shop': return renderNfts(state, render);
    case 'Settlement': return renderSettlement(state, render);
    case 'Deploy': return renderDeploy(state, render);
  }
  return el('div');
}

// ---- Step 0: project type ----
function renderType(state, render) {
  var isRev = state.projectType === 'revnet';
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Project flavor', 'Follow a preset, or design your project from scratch.'));

  var sel = el('select', 'field create-input'); sel.style.width = 'auto'; sel.style.minWidth = '0';
  [['custom', 'Custom'], ['revnet', 'Revnet']].forEach(function (o) {
    var op = el('option'); op.value = o[0]; op.textContent = o[1]; if (state.projectType === o[0]) op.selected = true; sel.appendChild(op);
  });
  sel.addEventListener('change', function () {
    state.projectType = sel.value;
    state.step = Math.min(state.step, stepsFor(state).length - 1); // clamp if the new flow has fewer steps
    render();
  });
  wrap.appendChild(fieldBlock('Flavor', false, sel));

  var desc = el('div', 'create-hint');
  desc.textContent = isRev
    ? 'Fixed rules that run forever, guaranteed. Tokens are always backed by revenues and funds raised, allowing for increasing price floors, loans, and predictability.'
    : 'Full control and customizability.';
  desc.style.marginBottom = '18px';
  wrap.appendChild(desc);

  // Owner (custom) or operator (revnet) is collected here.
  wrap.appendChild(isRev ? operatorSection(state, render) : ownerSection(state, render));
  return wrap;
}

// Project-owner field (custom flow) — required. We confirm it exists on each chain at the Settlement step.
function ownerSection(state, render) {
  var d = state.details;
  var ownerInput = textInput(d.owner, '0x…', function (v) { d.owner = v.trim(); });
  var ownerHint = attachEns(ownerInput, function (name, addr) { d.ownerResolvedFor = addr ? name : null; d.ownerResolved = addr || null; });
  var box = el('div', ''); box.appendChild(recipBoxWith(ownerInput, ownerHint));
  var wrap = el('div', '');
  wrap.appendChild(fieldBlock('Project owner', false, box));
  wrap.appendChild(infoNote('The address that can make changes around the configured rulesets.'));
  return wrap;
}

// Revnet operator field — required. We confirm it exists on each chain at the Settlement step.
function operatorSection(state, render) {
  var wrap = el('div', '');
  var opInput = textInput(state.revOperator, '0x…', function (v) { state.revOperator = v.trim(); });
  var opHint = attachEns(opInput, function (name, addr) { state.revOperatorResolvedFor = addr ? name : null; state.revOperatorResolved = addr || null; });
  var box = el('div', ''); box.appendChild(recipBoxWith(opInput, opHint));
  wrap.appendChild(fieldBlock('Operator', false, box));
  wrap.appendChild(infoNote('The address that operates the few controls available in revnets.'));
  return wrap;
}

// ---- small shared field helpers (create-flow look) ----

function stepHead(title, desc) {
  // The stepper already labels each step, so we don't render a big H2 title — just the description.
  var w = el('div', 'create-step-head');
  if (desc) { var p = el('p', 'create-step-desc'); p.textContent = desc; w.appendChild(p); }
  return w;
}

function fieldBlock(label, optional, node) {
  // `optional` is kept in the signature for call-site clarity, but we no longer render an "(optional)"
  // suffix on field labels — optionality is shown on the collapse section titles instead.
  var b = el('div', 'create-field');
  if (label) {
    var l = el('label', 'create-label');
    l.textContent = label;
    b.appendChild(l);
  }
  b.appendChild(node);
  return b;
}

function textInput(value, placeholder, onInput) {
  var i = el('input', 'field create-input');
  i.type = 'text';
  i.placeholder = placeholder || '';
  i.value = value || '';
  i.addEventListener('input', function () { onInput(i.value); });
  return i;
}

function textArea(value, placeholder, onInput) {
  var t = el('textarea', 'field create-textarea');
  t.placeholder = placeholder || '';
  t.value = value || '';
  t.addEventListener('input', function () { onInput(t.value); });
  return t;
}

// desc may be a string or a function(checked) → string, so the subtext reflects the toggle's state and
// updates in place when toggled.
// State-reflective subtext: prefix "On:"/"Off:" so the sentence reads as the current checkbox state.
export function dz(on, off) { return function (checked) { return checked ? 'On: ' + on : 'Off: ' + off; }; }
export function toggleRow(label, desc, checked, onChange) {
  var w = el('div', 'create-toggle-row');
  var lbl = el('label', 'create-toggle');
  var cb = el('input', '');
  cb.type = 'checkbox'; cb.checked = !!checked;
  function descAt(state) { return typeof desc === 'function' ? desc(state) : desc; }
  var d = null;
  cb.addEventListener('change', function () { if (d) d.textContent = descAt(cb.checked); onChange(cb.checked); });
  lbl.appendChild(cb);
  var t = el('span', 'create-toggle-label'); t.textContent = label;
  lbl.appendChild(t);
  w.appendChild(lbl);
  var hasDesc = (typeof desc === 'function') ? (descAt(true) || descAt(false)) : desc;
  if (hasDesc) { d = el('div', 'create-hint'); d.textContent = descAt(!!checked); w.appendChild(d); }
  return w;
}

function infoNote(text) {
  var n = el('div', 'create-hint');
  n.textContent = text;
  return n;
}

function warnNote(text) {
  var n = el('div', 'create-note warn');
  n.textContent = text;
  return n;
}

// Pink notice band, same color treatment as the "Work in progress" band.
function pinkNote(text) {
  var n = el('div', 'create-wip');
  n.style.margin = '0';
  n.style.display = 'block';
  n.textContent = text;
  return n;
}

// The "Afterwards" choice only applies when there's exactly one ruleset and it has a duration —
// otherwise there's nothing "after" (a forever ruleset never ends; multiple rulesets chain themselves).
function afterApplies(state) {
  var last = state.stages[state.stages.length - 1];
  return !!last && last.durationSeconds > 0;
}
// Resolve the rulesets actually deployed, applying the "Afterwards" choice for a single timed ruleset:
//   wait     → append a paused, no-issuance standby (project idles safely after the first cycle)
//   terminal → append a copy that continues on the same terms ~forever (no further cycling)
//   cycle    → leave the single ruleset to auto-repeat its cycle (no second ruleset)
function resolveStages(state) {
  var stages = state.stages;
  if (!afterApplies(state)) return stages;
  var last = stages[stages.length - 1];
  if (state.afterMode === 'wait') return stages.concat([standbyStage(last)]);
  if (state.afterMode === 'terminal') return stages.concat([terminalStage(last)]);
  return stages; // 'cycle'
}
// Standby: zero issuance, no payouts/surplus, payments paused, no expiry; cash-outs preserved so holders can exit.
function standbyStage(s1) {
  var s = createStage();
  s.durationSeconds = 0;            // never expires — sits in standby
  s.baseCurrency = s1.baseCurrency;
  s.deadline = s1.deadline;
  s.tokenMode = 'custom';           // explicit zero issuance
  s.weight = '0'; s.reservedPercent = 0; s.weightCutPercent = 0; s.allowOwnerMinting = false;
  s.cashOutEnabled = s1.cashOutEnabled; s.cashOutTaxRate = s1.cashOutTaxRate; // keep exit liquidity
  s.payoutMode = 'none';            // no payouts, no surplus allowance
  s.pausePay = true;                // paused payments
  return s;
}
// Terminal: the last ruleset's exact terms continue, but with the max (uint32) duration so it
// effectively never cycles again (the issuance cut etc. apply once more then hold).
function terminalStage(s1) {
  var s = JSON.parse(JSON.stringify(s1));
  s.expanded = false;
  s.schedule = ''; s.scheduleOn = false;       // only ruleset 1 schedules its start
  s.durationCustom = false; s.customDurVal = ''; s.customDurUnit = 'days';
  s.durationSeconds = FOREVER_SECONDS;         // uint32 max — effectively permanent
  return s;
}

// Returns the index of the first non-final stage with no duration (which would break sequencing), or -1.
function badStageIndex(state) {
  for (var i = 0; i < state.stages.length - 1; i++) {
    if (!state.stages[i].durationSeconds) return i;
  }
  return -1;
}

function collapse(state, key, label, optional, render, contentFn) {
  var w = el('div', 'create-collapse');
  var head = el('button', 'create-collapse-head');
  var lab = el('span', 'create-collapse-label');
  lab.textContent = label;
  if (optional) { var o = el('span', 'create-optional'); o.textContent = ' (Optional)'; lab.appendChild(o); }
  head.appendChild(lab);
  var caret = el('span', 'create-collapse-caret');
  caret.textContent = state[key] ? '▴' : '▾';
  head.appendChild(caret);
  head.addEventListener('click', function () { state[key] = !state[key]; render(); });
  w.appendChild(head);
  if (state[key]) { var content = contentFn(); content.style.marginTop = '10px'; w.appendChild(content); }
  return w;
}

// ---------------------------------------------------------------------------
// Step 0: Details
// ---------------------------------------------------------------------------

function renderDetails(state, render) {
  var d = state.details;
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Project Details', 'You can edit these at any time.'));

  wrap.appendChild(fieldBlock('Name', false, textInput(d.name, 'My project', function (v) { d.name = v; })));
  // Token ticker — required for revnets (it names the ERC-20 deployed for the token). Optional otherwise.
  wrap.appendChild(fieldBlock('Token symbol', state.projectType !== 'revnet', (function () {
    var n = textInput(d.ticker, 'TOKEN', function (v) { d.ticker = v.trim().toUpperCase().slice(0, 11); });
    n.addEventListener('input', function () { n.value = n.value.toUpperCase(); });
    return n;
  })()));
  wrap.appendChild(fieldBlock('Tagline', true, (function () {
    var n = textInput(d.tagline, 'A brief one-sentence summary of your project.', function (v) { d.tagline = v; });
    return n;
  })()));
  wrap.appendChild(fieldBlock('Description', true, textArea(d.description, 'What is your project about?', function (v) { d.description = v; })));

  // Logo
  wrap.appendChild(fieldBlock('Logo', true, renderImagePicker(d.logoUri, d.logoUploading, function (uri, busy) {
    d.logoUri = uri; d.logoUploading = busy; render();
  })));

  // Project links
  wrap.appendChild(collapse(d, 'linksOpen', 'Project links', true, render, function () {
    var g = el('div', 'create-grid2');
    g.appendChild(fieldBlock('Website', true, textInput(d.website, 'https://…', function (v) { d.website = v; })));
    g.appendChild(fieldBlock('Twitter handle', true, textInput(d.twitter, '@handle', function (v) { d.twitter = v; })));
    g.appendChild(fieldBlock('Discord', true, textInput(d.discord, 'https://discord.gg/…', function (v) { d.discord = v; })));
    g.appendChild(fieldBlock('Telegram', true, textInput(d.telegram, 'https://t.me/…', function (v) { d.telegram = v; })));
    return g;
  }));

  // (Project owner / operator is collected on the Type step.)

  // Tags
  wrap.appendChild(collapse(d, 'tagsOpen', 'Project tags', true, render, function () {
    var c = el('div', 'create-tags');
    TAG_OPTIONS.forEach(function (tag) {
      var on = d.tags.indexOf(tag) !== -1;
      var pill = el('button', 'create-tag' + (on ? ' selected' : ''));
      pill.textContent = tag;
      pill.addEventListener('click', function () {
        if (on) d.tags = d.tags.filter(function (x) { return x !== tag; });
        else if (d.tags.length < 3) d.tags.push(tag);
        render();
      });
      c.appendChild(pill);
    });
    var hint = el('div', 'create-hint'); hint.textContent = 'Select up to 3 tags to help supporters find your project.';
    hint.style.marginBottom = '12px';
    var w = el('div', ''); w.appendChild(hint); w.appendChild(c);
    return w;
  }));

  // Page customizations
  wrap.appendChild(collapse(d, 'customOpen', 'Project page customizations', true, render, function () {
    var c = el('div', '');
    c.appendChild(fieldBlock('Cover image', true, renderImagePicker(d.coverImageUri, false, function (uri) { d.coverImageUri = uri; render(); })));
    c.appendChild(fieldBlock('Payment notice', true, textArea(d.payDisclosure, 'Shown to payers before they pay.', function (v) { d.payDisclosure = v; })));
    return c;
  }));

  return wrap;
}

// Standard image uploader, matching the project page: a square preview thumb + native "Choose File",
// pinned to IPFS on pick. `busy` shows an inline "Uploading…" hint.
function renderImagePicker(uri, busy, onChange) {
  var w = el('div', 'operator-edit-logo');
  var prev = el('img', 'operator-edit-logo-prev');
  if (uri) { prev.src = ipfsHttp(uri); } else { prev.style.display = 'none'; }
  w.appendChild(prev);
  var file = el('input', 'operator-edit-logo-file');
  file.type = 'file'; file.accept = 'image/*';
  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (!f) { onChange('', false); return; } // picker dismissed → clear
    if (!hasPinata()) { alert('Add a Pinata JWT in DATA → settings to upload images.'); return; }
    onChange(uri, true);
    pinFile(f, f.name).then(function (ipfs) { onChange(ipfs, false); })
      .catch(function (e) { alert('Upload failed: ' + (e && e.message || e)); onChange(uri, false); });
  });
  w.appendChild(file);
  if (busy) { var hint = el('span', 'operator-edit-hint'); hint.textContent = 'Uploading…'; w.appendChild(hint); }
  return w;
}

// ---------------------------------------------------------------------------
// Step 1: Stages (one or more rulesets queued at launch, revnet-style)
// ---------------------------------------------------------------------------

// A stage === one JBRulesetConfig. Field names are chosen so the token/payouts/deadline
// section renderers below read straight off the stage object.
export function createStage() {
  return {
    expanded: false,         // collapsed by default — sensible defaults are summarized in the card head
    durationSeconds: 0,      // 0 = no expiry (final stage); non-final stages need a duration to advance
    durationCustom: false, customDurVal: '', customDurUnit: 'days',  // custom duration (value × unit)
    schedule: '', scheduleOn: false,  // stage 1 only: scheduled launch (mustStartAtOrAfter); scheduleOn=false means launch right away
    baseCurrency: 1,         // issuance-rate denomination (ETH=1 / USD=2) — metadata.baseCurrency
    payoutCurrency: 1,       // payout-limit denomination (ETH=1 / USD=2) — JBCurrencyAmount.currency
    // token — by default the project issues 10,000 tokens per ETH/USD
    tokenMode: 'custom', weight: '10000', reservedPercent: 0, weightCutPercent: 0, issuanceCutOn: false,
    cashOutEnabled: false, cashOutTaxRate: 0, allowOwnerMinting: false, pauseTransfers: false,
    reservedRecipients: [], tokenAdvancedOpen: false,
    // revnet-only stage fields (ignored by the custom flow)
    cutFreqDays: '30', autoIssuances: [], startDaysAfter: '30',
    // payouts
    payoutMode: 'none', payoutRecipients: [],
    // surplus allowance — owner can withdraw from surplus (beyond payouts) up to a cap each ruleset
    surplusAllowanceOn: false, surplusAllowanceUnlimited: false, surplusAllowanceAmount: '', surplusAllowanceCurrency: 1,
    // deadline + rules
    deadline: '1day', pausePay: false, holdFees: false,
    allowSetTerminals: false, allowSetController: false, allowTerminalMigration: false,
    allowSetCustomToken: false, allowAddAccountingContext: false, allowAddPriceFeed: false, otherOpen: false,
    // editor section collapses
    tokenOpen: true, payoutsOpen: false, deadlineOpen: false,
  };
}

export function renderStages(state, render, opts) {
  opts = opts || {};
  var wrap = el('div', '');
  if (!opts.noHead) wrap.appendChild(stepHead('Rulesets', 'Set the sequential rulesets your project follows over time.'));

  state.stages.forEach(function (stage, idx) {
    wrap.appendChild(renderStageCard(stage, idx, state, render));
  });

  function addRuleset() {
    var prev = state.stages[state.stages.length - 1];
    var s = createStage();
    if (prev) { s.tokenMode = prev.tokenMode; s.deadline = prev.deadline; s.baseCurrency = prev.baseCurrency; s.payoutCurrency = prev.payoutCurrency; } // sensible carry-over
    state.stages.forEach(function (x) { x.expanded = false; });
    s.expanded = true;
    state.stages.push(s);
  }

  if (afterApplies(state)) {
    // One timed ruleset → choose what happens after its cycle ends.
    var afterRow = el('div', 'create-after-row');
    afterRow.appendChild(document.createTextNode('Afterwards, '));
    var sel = el('select', 'create-after-select');
    [['wait', 'Wait'], ['terminal', 'Terminate'], ['cycle', 'Cycle'], ['custom', 'Custom']].forEach(function (o) {
      var op = el('option', ''); op.value = o[0]; op.textContent = o[1]; if (state.afterMode === o[0]) op.selected = true; sel.appendChild(op);
    });
    sel.addEventListener('change', function () {
      if (sel.value === 'custom') { addRuleset(); state.afterMode = 'wait'; render(); } // adds an editable Ruleset #2
      else { state.afterMode = sel.value; render(); }
    });
    afterRow.appendChild(sel);
    wrap.appendChild(afterRow);
    var notes = {
      wait: 'The project idles safely — no issuance, payments paused, cash-outs preserved — until you change it.',
      terminal: 'Ruleset #1’s terms continue on forever, without cycling again.',
      cycle: 'Ruleset #1 repeats its cycle over and over until you change it. Changes will only be able to be made once a cycled ruleset ends.',
    };
    wrap.appendChild(infoNote(notes[state.afterMode] || ''));

    // Issuance cut only makes sense for a cycling ruleset — opt-in here, applied to the cycling stage.
    if (state.afterMode === 'cycle') {
      var cyStage = state.stages[0];
      wrap.appendChild(toggleRow('Issuance cuts per cycle', dz('The issuance rate drops by a set amount at the end of each cycle.', 'The issuance rate stays the same each cycle.'), !!cyStage.issuanceCutOn, function (v) {
        cyStage.issuanceCutOn = v; if (!v) cyStage.weightCutPercent = 0; render();
      }));
      if (cyStage.issuanceCutOn) {
        var cutRow = el('div', 'create-inline-row');
        var cinp = el('input', 'field create-split-pct'); cinp.type = 'number'; cinp.min = '0'; cinp.max = '100'; cinp.step = '0.5';
        cinp.value = String(cyStage.weightCutPercent || 0);
        cinp.addEventListener('input', function () { cyStage.weightCutPercent = Math.max(0, Math.min(100, Number(cinp.value) || 0)); });
        cutRow.appendChild(cinp);
        cutRow.appendChild(document.createTextNode('% every ' + secondsLabel(cyStage.durationSeconds)));
        wrap.appendChild(cutRow);
      }
    }
  }
  // A flexible (no-duration) last ruleset is terminal — owner-managed, nothing scheduled after it.

  // Edit deadline — project-wide, at the bottom of the tab. Only shown when a future ruleset edit can
  // actually happen, so the deadline has something to govern (see deadlineApplies).
  if (deadlineApplies(state)) {
    var cur = (state.stages[0] && state.stages[0].deadline) || '3days';
    var dField = el('div', 'create-field'); dField.style.marginTop = '22px';
    var dLab = el('label', 'create-label'); dLab.textContent = 'Edit deadline'; dField.appendChild(dLab);
    dField.appendChild(infoNote('Owner edits must be queued this far ahead of the next ruleset, giving token holders time to review changes before they take effect.'));
    var dSel = el('select', 'field create-input'); dSel.style.marginTop = '6px';
    DEADLINE_OPTIONS.forEach(function (o) {
      var op = el('option', ''); op.value = o.key; op.textContent = o.label + (o.def ? ' (default)' : '');
      if (cur === o.key) op.selected = true; dSel.appendChild(op);
    });
    dSel.addEventListener('change', function () { state.stages.forEach(function (s) { s.deadline = dSel.value; }); render(); });
    dField.appendChild(dSel);
    if (cur === 'none') dField.appendChild(warnNote('⚠ No deadline lets the owner make last-second edits before a ruleset takes effect, which supporters may see as risky.'));
    wrap.appendChild(dField);
  }
  return wrap;
}

// The edit deadline governs how far ahead owner edits to a FUTURE ruleset must be queued. It's only
// meaningful when such a boundary exists: not for a forever-duration last ruleset, and not for a single
// timed ruleset set to Terminate (which just continues on the same terms).
function deadlineApplies(state) {
  var last = state.stages[state.stages.length - 1];
  if (!last) return false;
  if (last.durationSeconds === FOREVER_SECONDS) return false;
  if (state.stages.length === 1 && afterApplies(state) && state.afterMode === 'terminal') return false;
  return true;
}

function renderStageCard(stage, idx, state, render) {
  var card = el('div', 'create-stage-card');
  var head = el('div', 'create-stage-head');
  head.addEventListener('click', function (e) { if (e.target.closest('.create-stage-remove')) return; stage.expanded = !stage.expanded; render(); });
  var left = el('div', 'create-stage-headtext');
  var title = el('div', 'create-stage-title'); title.textContent = 'Ruleset #' + (idx + 1); left.appendChild(title);
  var sum = el('div', 'create-stage-sum'); sum.textContent = stageSummary(stage, idx, state); left.appendChild(sum);
  head.appendChild(left);
  if (idx > 0) {
    var rm = el('button', 'create-stage-remove'); rm.textContent = '✕';
    rm.addEventListener('click', function () { state.stages.splice(idx, 1); render(); });
    head.appendChild(rm);
  }
  var caret = el('span', 'create-stage-caret'); caret.textContent = stage.expanded ? '▴' : '▾'; head.appendChild(caret);
  card.appendChild(head);
  if (stage.expanded) card.appendChild(renderStageEditor(stage, idx, state, render));
  return card;
}

// ---------------------------------------------------------------------------
// Revnet Stages (REVStageConfig[]) — a reduced, revnet-oriented stage editor.
// ---------------------------------------------------------------------------

function tickerLabel(state) { return state.details.ticker || 'TOKEN'; }

function renderRevnetStages(state, render) {
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Stages', 'Issuance and cash out rules evolve over time automatically in stages. Staged rules can’t be edited once deployed.'));

  state.stages.forEach(function (stage, idx) {
    wrap.appendChild(revStageCard(stage, idx, state, render));
  });

  var add = el('button', 'create-add-btn');
  add.textContent = '+ Add stage';
  add.addEventListener('click', function () {
    var prev = state.stages[state.stages.length - 1];
    var s = createStage();
    s.weight = ''; // later stages inherit issuance (with the cut applied) unless set
    if (prev) { s.cashOutTaxRate = prev.cashOutTaxRate; s.cutFreqDays = prev.cutFreqDays; }
    state.stages.forEach(function (x) { x.expanded = false; });
    s.expanded = true;
    state.stages.push(s);
    render();
  });
  wrap.appendChild(add);
  return wrap;
}

function revStageCard(stage, idx, state, render) {
  var card = el('div', 'create-stage-card');
  var head = el('div', 'create-stage-head');
  head.addEventListener('click', function (e) { if (e.target.closest('.create-stage-remove')) return; stage.expanded = !stage.expanded; render(); });
  var left = el('div', 'create-stage-headtext');
  var title = el('div', 'create-stage-title'); title.textContent = 'Stage #' + (idx + 1); left.appendChild(title);
  var sum = el('div', 'create-stage-sum'); sum.textContent = revStageSummary(stage, idx, state); left.appendChild(sum);
  head.appendChild(left);
  if (idx > 0) {
    var rm = el('button', 'create-stage-remove'); rm.textContent = '✕';
    rm.addEventListener('click', function () { state.stages.splice(idx, 1); render(); });
    head.appendChild(rm);
  }
  var caret = el('span', 'create-stage-caret'); caret.textContent = stage.expanded ? '▴' : '▾'; head.appendChild(caret);
  card.appendChild(head);
  if (stage.expanded) card.appendChild(revStageEditor(stage, idx, state, render));
  return card;
}

function revStageSummary(stage, idx, state) {
  var tk = tickerLabel(state);
  var unit = state.revBaseCurrency === 2 ? 'USD' : 'ETH';
  var parts = [];
  if (idx === 0 || stage.weight) parts.push((stage.weight || '0') + ' $' + tk + '/' + unit);
  else parts.push('inherits issuance');
  if (stage.issuanceCutOn && Number(stage.weightCutPercent) > 0) parts.push('−' + round2(stage.weightCutPercent) + '%/' + (stage.cutFreqDays || '30') + 'd');
  var splitTotal = revSplitTotalPct(stage);
  if (splitTotal > 0) parts.push(round2(splitTotal) + '% to splits');
  parts.push(round2(Number(stage.cashOutTaxRate)) + '% cash-out tax');
  return parts.join(' | ');
}

function revSplitTotalPct(stage) {
  return (stage.reservedRecipients || []).reduce(function (s, x) { return s + (Number(x.percent) || 0); }, 0);
}

function revStageEditor(stage, idx, state, render) {
  var tk = tickerLabel(state);
  var w = el('div', 'create-stage-editor');

  // 1. Issuance
  var s1 = el('div', 'create-rev-sec');
  var h1 = el('div', 'create-rev-h'); h1.textContent = '$' + tk + ' issuance'; s1.appendChild(h1);
  var d1 = el('div', 'create-hint'); d1.textContent = 'How many $' + tk + ' to issue when receiving ETH.'; s1.appendChild(d1);
  // Issuance row: "[10000] $TOKEN / ETH"
  var issRow = el('div', 'create-inline-row');
  var issIn = el('input', 'field create-inline-num'); issIn.type = 'number'; issIn.min = '0'; issIn.step = 'any';
  issIn.placeholder = idx === 0 ? '10000' : 'inherit'; issIn.value = stage.weight || '';
  issIn.addEventListener('input', function () { stage.weight = issIn.value.trim(); });
  issRow.appendChild(issIn);
  issRow.appendChild(document.createTextNode(' $' + tk + ' per '));
  // Base currency (revnet-wide): issue per ETH or per USD. Small inline dropdown (no full-width `field`).
  issRow.appendChild(currencySelect(state.revBaseCurrency, function (v) { state.revBaseCurrency = v; render(); }));
  // "add auto cuts?" prompt + checkbox sit to the right of the currency selector (kept even when checked).
  var cutPrompt = el('span', 'create-inline-prompt'); cutPrompt.textContent = 'add auto cuts?'; issRow.appendChild(cutPrompt);
  var cutCb = el('input', 'create-inline-check'); cutCb.type = 'checkbox'; cutCb.checked = !!stage.issuanceCutOn;
  cutCb.addEventListener('change', function () { stage.issuanceCutOn = cutCb.checked; if (!cutCb.checked) stage.weightCutPercent = 0; render(); });
  issRow.appendChild(cutCb);
  s1.appendChild(issRow);
  if (idx > 0) s1.appendChild(infoNote('Leave blank to inherit the previous stage’s issuance (with any cut applied).'));

  // When cuts are on, the "[N] % every [D] days" controls reveal on their own line.
  if (stage.issuanceCutOn) {
    var cutRow = el('div', 'create-inline-row');
    var cinp = el('input', 'field create-split-pct'); cinp.type = 'number'; cinp.min = '0'; cinp.max = '100'; cinp.step = '0.5';
    cinp.value = String(stage.weightCutPercent || 0);
    cinp.addEventListener('input', function () { stage.weightCutPercent = Math.max(0, Math.min(100, Number(cinp.value) || 0)); });
    cutRow.appendChild(document.createTextNode('cut'));
    cutRow.appendChild(cinp);
    cutRow.appendChild(document.createTextNode('% every'));
    var freq = el('input', 'field create-split-pct'); freq.type = 'number'; freq.min = '1'; freq.step = '1';
    freq.value = String(stage.cutFreqDays || '30');
    freq.addEventListener('input', function () { stage.cutFreqDays = freq.value.trim(); });
    cutRow.appendChild(freq);
    cutRow.appendChild(document.createTextNode('days'));
    s1.appendChild(cutRow);
  }

  // Splits — inline rows (no box), directly after the issuance fields.
  var splitHead = el('div', 'create-hint');
  function setSplitHead() {
    var tot = revSplitTotalPct(stage);
    if (tot > 100) {
      splitHead.className = 'create-hint warn';
      splitHead.textContent = 'Splits total ' + round2(tot) + '% — over 100%. Reduce a share so they sum to 100% or less.';
    } else {
      splitHead.className = 'create-hint';
      splitHead.textContent = tot > 0
        ? ('Total split limit of ' + round2(tot) + '%, payer always receives ' + round2(100 - tot) + '% of issuance.')
        : 'Without splits, the payer always receives 100% of issuance.';
    }
  }
  setSplitHead();
  (stage.reservedRecipients || []).forEach(function (rec, i) { s1.appendChild(reservedSplitRow(stage, rec, i, render, setSplitHead)); });
  var addSplit = el('button', 'create-add-btn'); addSplit.textContent = '+ Add split';
  addSplit.addEventListener('click', function (e) { e.preventDefault(); stage.reservedRecipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0 }); render(); });
  s1.appendChild(addSplit);
  s1.appendChild(splitHead);

  // Auto-issuance — inline rows (no box).
  var aiHint = el('div', 'create-hint'); aiHint.textContent = 'Optionally, auto-issue $' + tk + ' when the stage starts.'; aiHint.style.marginTop = '22px'; s1.appendChild(aiHint);
  (stage.autoIssuances || []).forEach(function (ai, i) { s1.appendChild(autoIssuanceRow(stage, ai, i, tk, render)); });
  var addAi = el('button', 'create-add-btn'); addAi.textContent = '+ Add auto issuance';
  addAi.addEventListener('click', function (e) { e.preventDefault(); stage.autoIssuances.push({ count: '', address: '' }); render(); });
  s1.appendChild(addAi);
  var aiTotal = (stage.autoIssuances || []).reduce(function (s, a) { return s + (Number(a.count) || 0); }, 0);
  if (aiTotal > 0) { var aiSum = el('div', 'create-hint'); aiSum.textContent = 'Total auto issuance of ' + round2(aiTotal) + ' $' + tk + '.'; s1.appendChild(aiSum); }
  w.appendChild(s1);

  // 2. Cash outs (always on for a revnet — the only exit besides loans)
  var acctSym = (state.accepts[0] || 'eth') === 'usdc' ? 'USDC' : 'ETH';
  var s2 = el('div', 'create-rev-sec');
  var h2 = el('div', 'create-rev-h'); h2.textContent = '$' + tk + ' cash outs'; s2.appendChild(h2);
  var d2 = el('div', 'create-hint'); d2.textContent = 'The only way to access the ' + acctSym + ' used to issue $' + tk + ' is by cashing out or taking a loan. A tax makes cashing out and loans more expensive, rewarding $' + tk + ' holders who stick around.'; s2.appendChild(d2);
  stage.cashOutEnabled = true; // revnets always allow cash outs
  s2.appendChild(cashOutTaxCard(stage, render, acctSym, tk, true));
  w.appendChild(s2);

  // 3. Start time
  var s3 = el('div', 'create-rev-sec');
  var h3 = el('div', 'create-rev-h'); h3.textContent = 'Start time'; s3.appendChild(h3);
  s3.appendChild(revStageTiming(state, stage, idx, render));
  w.appendChild(s3);

  return w;
}

// The previous stage's autocut interval in days (0 if it has none) — the cycle boundary the next stage snaps to.
function revPrevCutFreqDays(state, idx) {
  var prev = state.stages[idx - 1];
  return (prev && prev.issuanceCutOn && Number(prev.cutFreqDays) > 0) ? Math.max(1, Math.round(Number(prev.cutFreqDays))) : 0;
}
// Stage idx's "days after the previous stage", snapped to a positive multiple of the previous stage's cut interval.
function revStageDaysAfter(state, idx) {
  var freq = revPrevCutFreqDays(state, idx);
  var d = Math.max(1, Math.round(Number(state.stages[idx].startDaysAfter) || 30));
  if (freq > 0) d = Math.max(freq, Math.round(d / freq) * freq);
  return d;
}

// Revnet stage timing. Stage 0 starts ~10 min after deploy (or a scheduled future time); later stages
// start a number of days after the previous stage's start. (No "duration" — revnets run forever.)
function revStageTiming(state, stage, idx, render) {
  var w = el('div', '');
  if (idx === 0) {
    var hint = el('div', 'create-hint'); hint.textContent = 'By default, the revnet starts ~10 minutes after deployment.'; w.appendChild(hint);
    w.appendChild(toggleRow('Start the revnet in the future', '', !!stage.scheduleOn, function (v) {
      stage.scheduleOn = v; if (!v) stage.schedule = ''; render();
    }));
    if (stage.scheduleOn) {
      var i = el('input', 'field create-input'); i.type = 'datetime-local'; i.style.marginTop = '6px';
      if (stage.schedule) i.value = tsToLocal(stage.schedule);
      i.addEventListener('input', function () {
        if (!i.value) { stage.schedule = ''; return; }
        var dt = new Date(i.value); stage.schedule = isNaN(dt.getTime()) ? '' : Math.floor(dt.getTime() / 1000);
      });
      w.appendChild(i);
      var tz = el('div', 'create-hint'); tz.textContent = localTimezoneLabel(); w.appendChild(tz);
    }
  } else {
    // If the previous stage has autocuts, its ruleset cycles every `freq` days, so this stage can only begin
    // on a cycle boundary — constrain the input to a positive multiple of that interval.
    var freq = revPrevCutFreqDays(state, idx);
    var hint2 = el('div', 'create-hint');
    hint2.textContent = freq > 0
      ? ('How many days after the last stage’s start time should this stage start? Must be a multiple of the previous stage’s ' + freq + '-day cut interval.')
      : 'How many days after the last stage’s start time should this stage start?';
    w.appendChild(hint2);
    var row = el('div', 'create-inline-row');
    var n = el('input', 'field create-inline-num'); n.type = 'number';
    n.min = String(freq > 0 ? freq : 1); n.step = String(freq > 0 ? freq : 1);
    n.value = String(revStageDaysAfter(state, idx)); // shows the snapped value
    n.addEventListener('input', function () { stage.startDaysAfter = n.value.trim(); });
    n.addEventListener('change', function () { stage.startDaysAfter = String(revStageDaysAfter(state, idx)); render(); }); // snap on blur/enter
    row.appendChild(n); row.appendChild(document.createTextNode('days'));
    w.appendChild(row);
  }
  return w;
}

function autoIssuanceRow(stage, ai, idx, tk, render) {
  var row = el('div', 'create-split-row');
  var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Issue' : '… and'; row.appendChild(lead);
  // Amount box with a "$TOKEN" suffix inside, mirroring the issuance field.
  var amtWrap = el('div', 'create-amt-suffix');
  var cnt = el('input', ''); cnt.type = 'number'; cnt.min = '0'; cnt.step = 'any';
  cnt.value = ai.count || ''; cnt.addEventListener('input', function () { ai.count = cnt.value.trim(); });
  amtWrap.appendChild(cnt);
  var suf = el('span', 'create-amt-suffix-label'); suf.textContent = '$' + tk; amtWrap.appendChild(suf);
  row.appendChild(amtWrap);
  row.appendChild((function () { var t = el('span', 'create-split-to'); t.textContent = 'to'; return t; })());
  var recip = el('input', 'field create-split-recip'); recip.type = 'text'; recip.placeholder = '0x…';
  recip.value = ai.address || '';
  var ensHint = attachEns(recip, function (name, addr) { ai.resolvedFor = addr ? name : null; ai.resolvedAddress = addr || null; });
  recip.addEventListener('input', function () { ai.address = recip.value.trim(); });
  row.appendChild(recipBoxWith(recip, ensHint));
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = stage.autoIssuances.indexOf(ai); if (i >= 0) stage.autoIssuances.splice(i, 1); render(); });
  row.appendChild(rm);
  return row;
}

function recipLabel(rec) {
  if (rec.type === 'project' && rec.projectId) return 'project #' + rec.projectId;
  if (rec.address) return shortAddr(rec.address);
  return 'owner';
}

// Capitalized bullet strings for a stage (no leading "• "). stageSummary joins them for the card head.
function stageSummaryParts(stage, idx, state) {
  return stageSummaryRaw(stage, idx, state).map(function (p) { return p ? p.charAt(0).toUpperCase() + p.slice(1) : p; });
}
function stageSummary(stage, idx, state) {
  return stageSummaryParts(stage, idx, state).map(function (p) { return '• ' + p; }).join('\n');
}

function stageSummaryRaw(stage, idx, state) {
  var parts = [];
  parts.push(idx === 0 ? ((stage.scheduleOn && stage.schedule) ? 'Starts at a set time' : 'Starts at launch') : 'Starts after Ruleset #' + idx);
  parts.push(!stage.durationSeconds ? 'lasts until changed by owner'
    : (stage.durationSeconds === FOREVER_SECONDS ? 'lasts forever' : 'lasts ' + secondsLabel(stage.durationSeconds)));

  // Issuance — weight, reserved split, issuance cut.
  if (stage.tokenMode === 'custom') {
    parts.push('issues ' + (stage.weight || '0') + ' tokens / ' + (stage.baseCurrency === 2 ? 'USD' : 'ETH'));
    var reservedPct = (stage.reservedRecipients || []).reduce(function (s, x) { return s + (Number(x.percent) || 0); }, 0);
    if (reservedPct > 0) {
      var rLine = round2(reservedPct) + '% reserved';
      var rNamed = (stage.reservedRecipients || []).filter(function (x) { return Number(x.percent) > 0; });
      if (rNamed.length) rLine += ' (' + rNamed.map(function (x) { return round2(Number(x.percent)) + '% → ' + recipLabel(x); }).join(', ') + ')';
      parts.push(rLine);
    }
    if (stage.issuanceCutOn && Number(stage.weightCutPercent) > 0) parts.push('issuance cuts ' + round2(Number(stage.weightCutPercent)) + '% each cycle');
  } else parts.push('no issuance');

  // Cash outs.
  if (stage.cashOutEnabled && stage.payoutMode !== 'unlimited') parts.push('cash outs on, ' + round2(Number(stage.cashOutTaxRate)) + '% tax');

  // Payouts — list each recipient's share.
  if (stage.payoutMode === 'unlimited') {
    var uRecips = (stage.payoutRecipients || []).filter(function (r) { return Number(r.percent) > 0; });
    if (!uRecips.length) {
      // No splits → everything goes to the owner; say so directly instead of "all funds" + "remainder → owner".
      parts.push('pays out all funds to owner');
    } else {
      parts.push('pays out all funds');
      uRecips.forEach(function (r) { parts.push(round2(Number(r.percent)) + '% → ' + recipLabel(r)); });
      parts.push('remainder → owner');
    }
  } else if (stage.payoutMode === 'limited') {
    var pc = stage.payoutCurrency === 2 ? 'USD' : 'ETH';
    var named = (stage.payoutRecipients || []).filter(function (r) { return Number(r.amountEth) > 0; });
    if (named.length) named.forEach(function (r) { parts.push('pays ' + r.amountEth + ' ' + pc + ' → ' + recipLabel(r)); });
    else parts.push('payouts set, no recipients yet');
  }

  // Surplus allowance.
  if (stage.surplusAllowanceOn && stage.payoutMode !== 'unlimited') {
    if (stage.surplusAllowanceUnlimited) parts.push('owner can withdraw all surplus');
    else if (Number(stage.surplusAllowanceAmount) > 0) parts.push('owner can withdraw ' + stage.surplusAllowanceAmount + ' ' + (stage.surplusAllowanceCurrency === 2 ? 'USD' : 'ETH') + ' of surplus');
    else parts.push('surplus allowance on');
  }

  // Noteworthy flags.
  if (stage.allowOwnerMinting) parts.push('owner can mint tokens');
  if (stage.pauseTransfers) parts.push('token credit transfers paused');
  if (stage.pausePay) parts.push('payments paused');
  if (stage.holdFees) parts.push('fees held');
  if (stage.allowTerminalMigration) parts.push('terminal migration allowed');
  // Edit deadline is shown in its own "Edit deadline" section below the card — not a ruleset bullet.

  return parts;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function renderStageEditor(stage, idx, state, render) {
  var c = el('div', 'create-stage-body');
  c.appendChild(stageTiming(stage, idx, idx === state.stages.length - 1, render));
  c.appendChild(tokenSection(stage, render));
  c.appendChild(payoutsSection(stage, render)); // Schedule payouts + Surplus allowance — top-level, no disclosure
  c.appendChild(collapse(stage, 'otherOpen', 'Other rules', true, render, function () { return otherRulesSection(stage, render); }));
  return c;
}

function stageTiming(stage, idx, isLast, render) {
  var w = el('div', '');
  // Duration (None + presets)
  var f = el('div', 'create-field');
  var lab = el('label', 'create-label'); lab.textContent = 'Duration'; f.appendChild(lab);
  var sel = el('select', 'field create-input');
  var flex = el('option', ''); flex.value = '0'; flex.textContent = 'Flexible';
  if (!stage.durationCustom && !stage.durationSeconds) flex.selected = true; sel.appendChild(flex);
  DURATION_PRESETS.forEach(function (p) {
    var opt = el('option', ''); opt.value = String(p.seconds); opt.textContent = p.label;
    if (!stage.durationCustom && stage.durationSeconds === p.seconds) opt.selected = true; sel.appendChild(opt);
  });
  var foreverOpt = el('option', ''); foreverOpt.value = String(FOREVER_SECONDS); foreverOpt.textContent = 'Forever';
  if (!stage.durationCustom && stage.durationSeconds === FOREVER_SECONDS) foreverOpt.selected = true; sel.appendChild(foreverOpt);
  var customOpt = el('option', ''); customOpt.value = 'custom'; customOpt.textContent = 'Custom…';
  if (stage.durationCustom) customOpt.selected = true; sel.appendChild(customOpt);
  sel.addEventListener('change', function () {
    if (sel.value === 'custom') { stage.durationCustom = true; recomputeCustomDuration(stage); }
    else { stage.durationCustom = false; stage.durationSeconds = Number(sel.value); }
    render();
  });
  f.appendChild(sel);
  if (stage.durationCustom) {
    var crow = el('div', 'create-amount-row'); crow.style.marginTop = '8px';
    var num = el('input', 'field create-amount-input'); num.type = 'number'; num.min = '1'; num.step = '1'; num.placeholder = '1'; num.value = stage.customDurVal;
    num.addEventListener('input', function () { stage.customDurVal = num.value.trim(); recomputeCustomDuration(stage); render(); });
    var unit = el('select', 'create-amount-cur');
    ['hours', 'days', 'weeks', 'years'].forEach(function (u) { var op = el('option', ''); op.value = u; op.textContent = u; if (stage.customDurUnit === u) op.selected = true; unit.appendChild(op); });
    unit.addEventListener('change', function () { stage.customDurUnit = unit.value; recomputeCustomDuration(stage); render(); });
    crow.appendChild(num); crow.appendChild(unit);
    f.appendChild(crow);
  }
  w.appendChild(f);

  if (idx === 0) {
    w.appendChild(toggleRow('Launch right away', '', !stage.scheduleOn, function (v) {
      stage.scheduleOn = !v;
      if (v) stage.schedule = ''; // launching now clears any scheduled time
      render();
    }));
    if (stage.scheduleOn) {
      var ww = el('div', '');
      var sub = el('div', 'create-hint'); sub.textContent = 'Your project will start at this date.'; ww.appendChild(sub);
      var i = el('input', 'field create-input'); i.type = 'datetime-local'; i.style.marginTop = '4px';
      if (stage.schedule) i.value = tsToLocal(stage.schedule);
      i.addEventListener('input', function () {
        if (!i.value) { stage.schedule = ''; return; }
        var dt = new Date(i.value); stage.schedule = isNaN(dt.getTime()) ? '' : Math.floor(dt.getTime() / 1000);
      });
      ww.appendChild(i);
      var tz = el('div', 'create-hint'); tz.textContent = localTimezoneLabel(); ww.appendChild(tz);
      w.appendChild(fieldBlock(null, false, ww));
    }
  } else {
    w.appendChild(infoNote('Stage ' + (idx + 1) + ' begins automatically when Stage ' + idx + ' ends.'));
  }
  // Accept payments — first thing after timing. Pausing payments idles token issuance (see tokenSection).
  w.appendChild(toggleRow('Accept payments', dz('The project can receive payments.', 'The project can’t receive payments.'), !stage.pausePay, function (v) { stage.pausePay = !v; render(); }));
  // A non-final stage with no duration would never advance — the next stage would start at the same
  // instant and immediately clobber it. Require a duration on every non-final stage.
  if (!isLast && !stage.durationSeconds) {
    w.appendChild(warnNote('⚠ This stage isn’t the last, so it needs a duration. With “no expiry”, the next stage would start at the same moment and override this one. Set a duration so Stage ' + (idx + 2) + ' begins when this stage’s cycle ends.'));
  }
  return w;
}

function choiceCardsInline(opts, current, onPick) {
  var row = el('div', 'create-pills');
  opts.forEach(function (o) {
    var p = el('button', 'create-pill' + (current === o.key ? ' selected' : ''));
    p.textContent = o.label;
    p.addEventListener('click', function () { onPick(o.key); });
    row.appendChild(p);
  });
  return row;
}

// ETH/USD currency <select> (JBCurrencyIds 1/2). `onChange` receives the numeric id; `cls` overrides the
// default compact inline style. Consolidates the identical option-loop used across the wizard.
export function currencySelect(current, onChange, cls) {
  var sel = el('select', cls || 'create-amount-cur');
  [['ETH', 1], ['USD', 2]].forEach(function (o) {
    var op = el('option'); op.value = String(o[1]); op.textContent = o[0];
    if ((current || 1) === o[1]) op.selected = true;
    sel.appendChild(op);
  });
  sel.addEventListener('change', function () { onChange(Number(sel.value)); });
  return sel;
}


// Payouts section for a stage (folded into the stage editor).
function payoutRow(stage, rec, idx, mode, render) {
  var wrap = el('div', 'create-split-wrap');
  if (idx > 0) wrap.style.marginTop = '18px'; // separate each recipient block
  var recip = el('input', 'field create-split-recip'); recip.type = 'text'; recip.placeholder = '0x… or project ID';
  recip.value = rec.type === 'project' ? String(rec.projectId || '') : (rec.address || '');
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = stage.payoutRecipients.indexOf(rec); if (i >= 0) stage.payoutRecipients.splice(i, 1); render(); });
  // A specific (limited) payout needs at least one entry — don't let the user remove the last one.
  var lockLast = mode === 'amount' && stage.payoutRecipients.length <= 1;
  // Resolve an ENS recipient (wallet path only — project IDs are numeric); the address shows under the field.
  var ensHint = attachEns(recip, function (name, addr) { rec.resolvedFor = addr ? name : null; rec.resolvedAddress = addr || null; });

  if (mode === 'percent') {
    var row = el('div', 'create-split-row');
    var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Split' : '… and'; row.appendChild(lead);
    var pct = el('input', 'field create-split-pct'); pct.type = 'number'; pct.min = '0'; pct.max = '100'; pct.step = 'any'; pct.placeholder = '10';
    pct.value = rec.percent || ''; pct.addEventListener('input', function () { rec.percent = parseFloat(pct.value) || 0; }); row.appendChild(pct);
    var sign = el('span', 'create-split-sign'); sign.textContent = '%'; row.appendChild(sign);
    var to = el('span', 'create-split-to'); to.textContent = 'to'; row.appendChild(to);
    row.appendChild(recipBoxWith(recip, ensHint)); row.appendChild(rm);
    wrap.appendChild(row);
  } else {
    // Two lines: "Payout [amount] [ETH/USD] to" then the recipient field, left-aligned under the amount
    // (line 2's lead is an invisible copy of line 1's so the inputs line up in the monospace grid).
    var leadText = idx === 0 ? 'Payout' : '… and';
    var l1 = el('div', 'create-split-row');
    var lead1 = el('span', 'create-split-lead'); lead1.textContent = leadText; l1.appendChild(lead1);
    var amt = el('input', 'field create-inline-num'); amt.type = 'number'; amt.min = '0'; amt.step = 'any'; amt.placeholder = '0.0';
    amt.value = rec.amountEth || ''; amt.addEventListener('input', function () { rec.amountEth = amt.value.trim(); }); l1.appendChild(amt);
    l1.appendChild(currencySelect(stage.payoutCurrency, function (v) { stage.payoutCurrency = v; render(); }));
    var toEnd = el('span', 'create-split-to'); toEnd.textContent = 'to'; l1.appendChild(toEnd);
    wrap.appendChild(l1);
    var l2 = el('div', 'create-split-row payout-line2');
    var lead2 = el('span', 'create-split-lead'); lead2.textContent = leadText; lead2.style.visibility = 'hidden'; l2.appendChild(lead2);
    l2.appendChild(recipBoxWith(recip, ensHint)); if (!lockLast) l2.appendChild(rm);
    wrap.appendChild(l2);
  }

  var benefRow = el('div', 'create-split-benef'); benefRow.style.display = 'none';
  var benefLead = el('span', 'create-split-to'); benefLead.textContent = 'with beneficiary'; benefRow.appendChild(benefLead);
  var benef = el('input', 'field'); benef.type = 'text'; benef.placeholder = '0x… or name.eth';
  benef.value = rec.type === 'project' ? (rec.address || '') : '';
  benef.addEventListener('input', function () { rec.address = benef.value.trim(); });
  var benefHint = attachEns(benef, function () {}); // resolves on Ethereum mainnet; populates the global ENS cache resolvedStr reads
  benefRow.appendChild(recipBoxWith(benef, benefHint)); wrap.appendChild(benefRow);
  function refresh() {
    var v = (recip.value || '').trim();
    if (/^[0-9]+$/.test(v) && Number(v) > 0) { rec.type = 'project'; rec.projectId = Number(v); benefRow.style.display = ''; }
    else { rec.type = 'wallet'; rec.projectId = 0; rec.address = v; benefRow.style.display = 'none'; }
  }
  recip.addEventListener('input', refresh); refresh();
  return wrap;
}

function payoutsSection(stage, render) {
  var wrap = el('div', '');
  wrap.appendChild(toggleRow('Payout funds', dz('Routing some of the project’s funds to other accounts or projects.', 'All funds stay in the project for cash outs / later stages.'), stage.payoutMode !== 'none', function (v) { stage.payoutMode = v ? 'unlimited' : 'none'; render(); }));

  if (stage.payoutMode !== 'none') {
    var card = el('div', 'create-subcard');
    card.appendChild(toggleRow('Payout all received funds', dz('Paying out everything received; recipients get a percentage and the rest goes to the owner.', 'Paying out fixed amounts; anything else stays in the project.'), stage.payoutMode === 'unlimited', function (v) {
      stage.payoutMode = v ? 'unlimited' : 'limited';
      // A specific (limited) payout needs at least one entry to fill in.
      if (!v && !stage.payoutRecipients.length) stage.payoutRecipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0, amountEth: '' });
      render();
    }));
    var mode = stage.payoutMode === 'unlimited' ? 'percent' : 'amount';
    stage.payoutRecipients.forEach(function (rec, i) { card.appendChild(payoutRow(stage, rec, i, mode, render)); });
    var add = el('a', 'operator-cta create-add-link'); add.href = '#'; add.textContent = '+ Add payout';
    add.style.marginTop = stage.payoutRecipients.length ? '14px' : '4px'; // only need the gap when there are rows above
    add.addEventListener('click', function (e) { e.preventDefault(); stage.payoutRecipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0, amountEth: '' }); render(); });
    card.appendChild(add);
    // Make the default-to-owner behavior explicit (unlimited only).
    if (stage.payoutMode === 'unlimited') {
      var ownerNote = el('div', 'create-hint'); ownerNote.style.marginTop = '10px';
      ownerNote.textContent = 'Any payouts not allocated above go to the project owner.';
      card.appendChild(ownerNote);
    }
    wrap.appendChild(card);
  }

  // Surplus access — owner (allowance) and token holders (cash outs) both draw from surplus (funds beyond
  // payouts). When paying out everything there's no surplus, so both are shown idle/disabled.
  if (stage.payoutMode === 'unlimited') {
    wrap.appendChild(idleToggle('Give owner access to surplus funds', 'All funds are allocated to unlimited payouts, no surplus available.'));
    wrap.appendChild(idleToggle('Give tokens cash out access to surplus funds', 'All funds are allocated to unlimited payouts, no surplus to cash out.'));
  } else {
    wrap.appendChild(toggleRow('Give owner access to surplus funds', dz('The owner can withdraw from the project’s surplus (funds beyond payouts).', 'The owner can’t withdraw from the project’s surplus.'), stage.surplusAllowanceOn, function (v) { stage.surplusAllowanceOn = v; render(); }));
    if (stage.surplusAllowanceOn) {
      var saCard = el('div', 'create-subcard');
      saCard.appendChild(toggleRow('Unlimited', dz('No cap — the owner can withdraw the entire surplus.', 'Capped at the amount set below.'), stage.surplusAllowanceUnlimited, function (v) { stage.surplusAllowanceUnlimited = v; render(); }));
      if (!stage.surplusAllowanceUnlimited) {
        var saRow = el('div', 'create-inline-row');
        var saAmt = el('input', 'field create-inline-num'); saAmt.type = 'text'; saAmt.placeholder = '0.0'; saAmt.value = stage.surplusAllowanceAmount;
        saAmt.addEventListener('input', function () { stage.surplusAllowanceAmount = saAmt.value.trim(); });
        saRow.appendChild(saAmt);
        saRow.appendChild(currencySelect(stage.surplusAllowanceCurrency, function (v) { stage.surplusAllowanceCurrency = v; }));
        saRow.appendChild(document.createTextNode(' allowed.'));
        saCard.appendChild(saRow);
      }
      wrap.appendChild(saCard);
    }
    // Token-holder cash outs live right after the owner's surplus allowance (both draw from surplus).
    wrap.appendChild(cashOutSection(stage, render));
  }
  return wrap;
}

// Inline reserved-token split row: "Split [%] to [0x / project ID]". A project ID reveals a
// "token beneficiary" field (who receives that project's tokens). Edits `rec` in place.
function reservedSplitRow(t, rec, idx, render, onTotal) {
  var wrap = el('div', 'create-split-wrap');
  var row = el('div', 'create-split-row');
  var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Split' : '… and'; row.appendChild(lead);
  var pct = el('input', 'field create-split-pct'); pct.type = 'number'; pct.min = '0'; pct.max = '100'; pct.step = 'any'; pct.placeholder = '10';
  pct.value = rec.percent || ''; pct.addEventListener('input', function () { rec.percent = parseFloat(pct.value) || 0; if (onTotal) onTotal(); }); row.appendChild(pct);
  var sign = el('span', 'create-split-sign'); sign.textContent = '%'; row.appendChild(sign);
  var to = el('span', 'create-split-to'); to.textContent = 'to'; row.appendChild(to);
  var hookAddr = getAddress('BannyLPSplitHook', 1);
  var isLp = rec.type === 'lphook';
  var recip = el('input', 'field create-split-recip'); recip.type = 'text'; recip.placeholder = '0x… or project ID';
  // When this split funds the market, the recipient IS the shared LP split hook — show it (read-only).
  recip.value = isLp ? (hookAddr || '') : (rec.type === 'project' ? String(rec.projectId || '') : (rec.address || ''));
  if (isLp) recip.readOnly = true;
  var ensHint = attachEns(recip, function (name, addr) { rec.resolvedFor = addr ? name : null; rec.resolvedAddress = addr || null; });
  var recipBox = recipBoxWith(recip, ensHint);
  row.appendChild(recipBox);
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = t.reservedRecipients.indexOf(rec); if (i >= 0) t.reservedRecipients.splice(i, 1); render(); });
  row.appendChild(rm);
  wrap.appendChild(row);
  // Project-ID beneficiary line — "with beneficiary [0x…]" (who receives that project's tokens).
  var benefRow = el('div', 'create-split-benef'); benefRow.style.display = 'none';
  var benefLead = el('span', 'create-split-to'); benefLead.textContent = 'with beneficiary'; benefRow.appendChild(benefLead);
  var benef = el('input', 'field'); benef.type = 'text'; benef.placeholder = '0x… or name.eth';
  benef.value = rec.type === 'project' ? (rec.address || '') : '';
  benef.addEventListener('input', function () { rec.address = benef.value.trim(); });
  var benefHint = attachEns(benef, function () {}); // resolves on Ethereum mainnet; populates the global ENS cache resolvedStr reads
  benefRow.appendChild(recipBoxWith(benef, benefHint)); wrap.appendChild(benefRow);
  // "fund market" chip — routes this split to the shared zero-fee BannyLPSplitHook. Offered only when this
  // row is already the market-funder OR no other row is (one buyback market per project). Sits under the
  // field (inside recipBox) so it left-aligns with it.
  var otherLp = t.reservedRecipients.some(function (r) { return r !== rec && r.type === 'lphook'; });
  var lpChip = null;
  if (hookAddr && (isLp || !otherLp)) {
    lpChip = el('button', 'create-split-chip'); lpChip.type = 'button'; lpChip.textContent = 'fund market';
    if (isLp) lpChip.classList.add('active');
    lpChip.title = 'Pool reserved tokens into a Uniswap V4 buyback position for your token';
    lpChip.addEventListener('click', function () {
      if (rec.type === 'lphook') { rec.type = 'wallet'; rec.address = ''; rec.projectId = 0; }
      else { rec.type = 'lphook'; }
      render();
    });
    recipBox.appendChild(lpChip);
    if (isLp) {
      var lpHint = el('div', 'create-split-lphint');
      lpHint.textContent = 'Pools splits tokens into a Uniswap V4 position. Trading fees route back to your project.';
      wrap.appendChild(lpHint);
    }
  }
  // The chip only makes sense on an empty row — once a real recipient is typed, hide it (and drop the
  // top-align so the row centers normally). When this row IS the market-funder it stays shown + active.
  function updateChip() {
    if (!lpChip) return;
    var show = isLp || !(recip.value || '').trim();
    lpChip.style.display = show ? '' : 'none';
    row.classList.toggle('has-chip', show);
  }
  function refresh() {
    if (rec.type === 'lphook') return; // handled by the chip
    var v = (recip.value || '').trim();
    if (/^[0-9]+$/.test(v) && Number(v) > 0) { rec.type = 'project'; rec.projectId = Number(v); benefRow.style.display = ''; }
    else { rec.type = 'wallet'; rec.projectId = 0; rec.address = v; benefRow.style.display = 'none'; }
    updateChip();
  }
  recip.addEventListener('input', refresh);
  if (isLp) row.classList.add('has-chip');
  else refresh();
  return wrap;
}

// Token issuance section for a stage (folded into the stage editor).
// Bonding-curve preview: token cash-out value vs % of tokens cashed out, at tax rate r (0..1). The
// orange curve f(x)=x·((1−r)+r·x) bows below the straight no-tax line, meeting it at the ends.
function cashOutCurveSvg(r) {
  var W = 320, H = 170, padL = 30, padR = 10, padT = 10, padB = 26;
  var x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
  function X(t) { return x0 + (x1 - x0) * t; }
  function Y(v) { return y0 + (y1 - y0) * v; }
  var pts = [];
  for (var i = 0; i <= 40; i++) { var t = i / 40; var f = t * ((1 - r) + r * t); pts.push(X(t).toFixed(1) + ',' + Y(f).toFixed(1)); }
  var midY = (y0 + y1) / 2;
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" class="cashout-curve" aria-hidden="true">'
    + '<line x1="' + x0 + '" y1="' + y1 + '" x2="' + x0 + '" y2="' + y0 + '" stroke="#7d6858" stroke-width="1"/>'
    + '<line x1="' + x0 + '" y1="' + y0 + '" x2="' + x1 + '" y2="' + y0 + '" stroke="#7d6858" stroke-width="1"/>'
    + '<line x1="' + X(0) + '" y1="' + Y(0) + '" x2="' + X(1) + '" y2="' + Y(1) + '" stroke="rgba(0,0,0,0.22)" stroke-width="1.2"/>'
    + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#b8602e" stroke-width="2"/>'
    + '<text x="' + ((x0 + x1) / 2) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="9" fill="#7d5a4e">% tokens cashed out</text>'
    + '<text x="11" y="' + midY + '" text-anchor="middle" font-size="9" fill="#7d5a4e" transform="rotate(-90 11 ' + midY + ')">cash out value</text>'
    + '</svg>';
}

// Hover the bonding-curve graph: show a dot + tooltip with "X% cashed out → Y% of treasury" at the cursor.
// `holder` is the element whose innerHTML carries the SVG (redrawn on input); dot/tip are siblings in `wrap`.
function attachCurveHover(wrap, holder, getR) {
  wrap.style.position = 'relative';
  var dot = el('div', 'cashout-dot'); dot.style.display = 'none';
  var tip = el('div', 'cashout-tip'); tip.style.display = 'none';
  wrap.appendChild(dot); wrap.appendChild(tip);
  var W = 320, H = 170, padL = 30, padR = 10, padT = 10, padB = 26;
  wrap.addEventListener('mousemove', function (e) {
    var svg = holder.querySelector('svg'); if (!svg) return;
    var rect = svg.getBoundingClientRect();
    var plotL = rect.left + (padL / W) * rect.width, plotR = rect.left + ((W - padR) / W) * rect.width;
    var plotT = rect.top + (padT / H) * rect.height, plotB = rect.top + ((H - padB) / H) * rect.height;
    var x = (e.clientX - plotL) / (plotR - plotL); x = Math.max(0, Math.min(1, x));
    var r = getR(); var f = x * ((1 - r) + r * x);
    var cx = plotL + x * (plotR - plotL), cy = plotB - f * (plotB - plotT);
    var wr = wrap.getBoundingClientRect();
    dot.style.display = ''; dot.style.left = (cx - wr.left) + 'px'; dot.style.top = (cy - wr.top) + 'px';
    tip.style.display = ''; tip.textContent = Math.round(x * 100) + '% cashed out → ' + (Math.round(f * 1000) / 10) + '% of treasury';
    tip.style.left = Math.max(28, Math.min(cx - wr.left, wr.width - 28)) + 'px';
    tip.style.top = (cy - wr.top - 24) + 'px';
  });
  wrap.addEventListener('mouseleave', function () { dot.style.display = 'none'; tip.style.display = 'none'; });
}

// A disabled, greyed toggle that always reads unchecked — used when an option is contextually moot.
function idleToggle(label, subtext) {
  var t = toggleRow(label, subtext, false, function () {});
  var cb = t.querySelector('input'); if (cb) cb.disabled = true;
  t.classList.add('create-toggle-disabled');
  return t;
}

// Cash-out access for token holders — they reclaim a share of the project's surplus by burning tokens.
// Lives next to the owner's surplus allowance (both draw from surplus). Tax rate shapes the bonding curve.
export function cashOutSection(stage, render) {
  var t = stage;
  var wrap = el('div', '');
  var acctSym = t.baseCurrency === 2 ? 'USDC' : 'ETH';
  wrap.appendChild(toggleRow('Give tokens cash out access to surplus funds', dz('Token holders can cash out their tokens for a share of the project’s surplus ' + acctSym + '.', 'Token holders can’t cash out their tokens.'), t.cashOutEnabled, function (v) { t.cashOutEnabled = v; render(); }));
  if (t.cashOutEnabled) wrap.appendChild(cashOutTaxCard(t, render, acctSym));
  return wrap;
}

// The cash-out tax chips + bonding-curve preview, shared by the custom flow's cashOutSection and the revnet
// stage editor. Stores `stage.cashOutTaxRate` as a percent (0–100). `reclaimVerb` lets the revnet copy differ.
function cashOutTaxCard(t, render, acctSym, reclaimVerb, bare) {
  var coCard = el('div', bare ? '' : 'create-subcard');
  // Named tax levels with the 0–1 value beneath; unnamed entries are the half-steps between them.
  // A tax of 1 (100%) returns nothing — identical to disabling cash outs — so it's not offered.
  var levels = [
    { n: 'No tax', v: 0 }, { n: '', v: 0.1 }, { n: '', v: 0.2 }, { n: 'Light', v: 0.3 }, { n: '', v: 0.4 },
    { n: 'Medium', v: 0.5 }, { n: '', v: 0.6 }, { n: 'Heavy', v: 0.7 }, { n: '', v: 0.8 }, { n: 'Extreme', v: 0.9 },
  ];
  var presetPcts = levels.map(function (l) { return l.v * 100; });
  var isCustom = presetPcts.indexOf(Number(t.cashOutTaxRate)) === -1;
  var chips = el('div', 'create-chip-row');
  levels.forEach(function (l) {
    var pct = l.v * 100;
    var chip = el('button', 'create-chip create-chip-stack' + (!isCustom && Number(t.cashOutTaxRate) === pct ? ' active' : '')); chip.type = 'button';
    var top = el('span', 'create-chip-top'); top.textContent = String(l.v);
    var bot = el('span', 'create-chip-sub'); bot.textContent = l.n || '';
    chip.appendChild(top); chip.appendChild(bot);
    chip.addEventListener('click', function () { t.cashOutTaxRate = pct; render(); });
    chips.appendChild(chip);
  });
  var customChip = el('button', 'create-chip create-chip-stack' + (isCustom ? ' active' : '')); customChip.type = 'button';
  var ct = el('span', 'create-chip-top'); ct.textContent = 'Custom'; customChip.appendChild(ct);
  customChip.appendChild(el('span', 'create-chip-sub'));
  customChip.addEventListener('click', function () { if (!isCustom) { t.cashOutTaxRate = 5; render(); } });
  chips.appendChild(customChip);
  coCard.appendChild(chips);

  var sub = el('div', 'create-hint');
  var graphWrap = el('div', 'cashout-curve-wrap');
  var svgHolder = el('div'); graphWrap.appendChild(svgHolder); // hover overlay (dot/tip) lives beside this, not wiped on redraw
  var cashViz = function () {
    var r = Math.max(0, Math.min(100, Number(t.cashOutTaxRate) || 0)) / 100;
    var pct10 = 0.1 * ((1 - r) + r * 0.1) * 100; // % of treasury for cashing out 10% of supply
    sub.textContent = reclaimVerb
      ? ('Cashing out 10% of $' + reclaimVerb + ' gets ' + (Math.round(pct10 * 10) / 10) + '% of the revnet’s ' + acctSym + '.')
      : ('Cashing out 10% of your tokens returns ' + (Math.round(pct10 * 10) / 10) + '% of the project’s surplus ' + acctSym + '.');
    svgHolder.innerHTML = cashOutCurveSvg(r);
  };
  if (isCustom) {
    var crow = el('div', 'create-inline-row');
    var cin = el('input', 'field create-inline-num'); cin.type = 'number'; cin.min = '0'; cin.max = '1'; cin.step = '0.01'; cin.value = String(Math.round(t.cashOutTaxRate) / 100);
    cin.addEventListener('input', function () { t.cashOutTaxRate = Math.max(0, Math.min(1, Number(cin.value) || 0)) * 100; cashViz(); });
    crow.appendChild(document.createTextNode('Cash out tax ')); crow.appendChild(cin); crow.appendChild(document.createTextNode(' (0–1)'));
    coCard.appendChild(crow);
  }
  cashViz();
  coCard.appendChild(sub);
  coCard.appendChild(graphWrap);
  attachCurveHover(graphWrap, svgHolder, function () { return Math.max(0, Math.min(100, Number(t.cashOutTaxRate) || 0)) / 100; });
  return coCard;
}

function tokenSection(stage, render) {
  var t = stage;
  var wrap = el('div', '');
  // Paused payments → no one can pay → no issuance possible; show the issuance toggle idle.
  if (t.pausePay) {
    wrap.appendChild(idleToggle('Issue tokens when paid', 'No tokens are issued while payments are paused.'));
  } else {
    wrap.appendChild(toggleRow('Issue tokens when paid', dz('Payers receive newly minted project tokens.', 'No tokens are issued when the project is paid.'), t.tokenMode === 'custom', function (v) { t.tokenMode = v ? 'custom' : 'none'; render(); }));
  }

  if (t.tokenMode === 'custom' && !t.pausePay) {
    var card = el('div', 'create-subcard');

    // Issues [x] tokens per [ETH/USD]
    card.appendChild((function () {
      var row = el('div', 'create-inline-row');
      row.appendChild(document.createTextNode('Issues '));
      var n = el('input', 'field create-inline-num'); n.type = 'text'; n.placeholder = '0'; n.value = t.weight;
      n.addEventListener('input', function () { t.weight = n.value.trim(); });
      row.appendChild(n);
      row.appendChild(document.createTextNode(' tokens per '));
      row.appendChild(currencySelect(t.baseCurrency, function (v) { t.baseCurrency = v; render(); }));
      return row;
    })());

    // Reserved splits — each "Split [%] to [recipient]" reserves that share of issuance; the payer gets
    // the rest. The percentages sum to the project's reserved rate (shown in the summary below).
    var sumNote = el('div', 'create-hint'); sumNote.style.marginTop = '12px';
    function updateReservedSummary() {
      var tot = Math.round(t.reservedRecipients.reduce(function (s, x) { return s + (Number(x.percent) || 0); }, 0) * 100) / 100;
      var payer = Math.round((100 - tot) * 100) / 100;
      sumNote.textContent = tot > 0
        ? 'Total splits of ' + tot + '%, payer receives ' + payer + '% of issuance.'
        : 'Payer receives 100% of issuance.';
      sumNote.className = 'create-hint' + (tot > 100 ? ' warn' : '');
    }
    t.reservedRecipients.forEach(function (rec, i) { card.appendChild(reservedSplitRow(t, rec, i, render, updateReservedSummary)); });
    var addSplit = el('a', 'operator-cta create-add-link'); addSplit.href = '#'; addSplit.textContent = '+ Add split'; addSplit.style.marginTop = '14px';
    addSplit.addEventListener('click', function (e) { e.preventDefault(); t.reservedRecipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0 }); render(); });
    card.appendChild(addSplit);
    updateReservedSummary(); card.appendChild(sumNote);

    wrap.appendChild(card);
  }

  // Token options apply whether or not THIS stage issues tokens (tokens can exist from prior stages or
  // owner mints) — always shown, each in its own container like the issuance section.
  wrap.appendChild(toggleRow('Give owner privileged access to tokens', dz('The project owner can mint any amount of project tokens without paying.', 'The project owner can’t mint tokens without paying.'), t.allowOwnerMinting, function (v) { t.allowOwnerMinting = v; }));
  wrap.appendChild(toggleRow('Pause token credit transfers', dz('Project credits can’t be transferred (ERC-20s, once issued, are always transferable).', 'Project credits can be transferred freely.'), t.pauseTransfers, function (v) { t.pauseTransfers = v; }));
  return wrap;
}

// ---------------------------------------------------------------------------
// Step 4: NFTs
// ---------------------------------------------------------------------------

// Collection name/symbol default to the project name set in Details (empty if none); the project owner
// can change them on-chain later. Once the user edits a field, their value sticks.
function collectionNameOf(state) {
  var c = state.collection || {};
  if (c.nameTouched) return c.name;
  return state.details.name || '';
}
function collectionSymbolOf(state) {
  var c = state.collection || {};
  if (c.symbolTouched) return c.symbol;
  // Default the NFT collection symbol to the project's token symbol (the Details ticker), not its name.
  return state.details.ticker || '';
}

// Everything that applies to the whole collection (not a single item) — collection name/symbol, the Pinata
// JWT, and the top-level JB721TiersHookFlags. Lives in the "Extras" dropdown under "add item +".
function collectionExtrasSection(state, render) {
  var c = state.collection;
  var f = el('div', '');
  var ownerNote = el('div', 'create-hint'); ownerNote.textContent = 'The project owner can set or change these anytime after launch.'; ownerNote.style.marginTop = '0'; f.appendChild(ownerNote);
  var nameField = fieldBlock('Collection name', false, textInput(collectionNameOf(state), state.details.name || 'Collection name', function (v) { c.name = v; c.nameTouched = true; }));
  f.appendChild(nameField);
  f.appendChild(fieldBlock('Collection symbol', false, textInput(collectionSymbolOf(state), state.details.ticker || 'Symbol', function (v) { c.symbol = v; c.symbolTouched = true; })));

  // Pinata JWT — needed to pin item media + metadata to IPFS. Only shown when one isn't set yet.
  if (!hasPinata()) {
    var jwtField = el('div', 'create-field');
    var jl = el('label', 'create-label'); jl.textContent = 'Pinata JWT'; jwtField.appendChild(jl);
    var jh = el('div', 'create-hint'); jh.innerHTML = 'To pin item media + metadata to IPFS. <a href="https://app.pinata.cloud/developers/api-keys" target="_blank" rel="noopener">Get one</a>; stored only in this browser.'; jwtField.appendChild(jh);
    var jwt = el('input', 'field create-input'); jwt.type = 'password'; jwt.placeholder = 'pinata JWT'; jwt.autocomplete = 'off'; jwt.spellcheck = false;
    jwt.addEventListener('change', function () { if (jwt.value.trim()) { setPinataJwt(jwt.value.trim()); render(); } });
    jwtField.appendChild(jwt); f.appendChild(jwtField);
  }

  f.appendChild(toggleRow('Require exact payment', dz('Payers must pay an item’s exact price — anything extra is turned away.', 'Payers can overpay; the extra is kept as spendable credit.'), c.preventOverspending, function (v) { c.preventOverspending = v; }));
  f.appendChild(toggleRow('Lock reserved items after launch', dz('New items added after launch can’t set aside reserved inventory.', 'New items added after launch can set aside reserved inventory.'), c.noNewTiersWithReserves, function (v) { c.noNewTiersWithReserves = v; }));
  f.appendChild(toggleRow('Lock voting items after launch', dz('New items added after launch can’t carry custom voting power.', 'New items added after launch can carry custom voting power.'), c.noNewTiersWithVotes, function (v) { c.noNewTiersWithVotes = v; }));
  f.appendChild(toggleRow('Lock owner minting after launch', dz('New items added after launch can’t let the owner mint for free.', 'New items added after launch can let the owner mint for free.'), c.noNewTiersWithOwnerMinting, function (v) { c.noNewTiersWithOwnerMinting = v; }));
  f.appendChild(toggleRow('Give split recipients project tokens', dz('Sale-split recipients also receive project tokens for their share.', 'Sale-split recipients receive funds only, no project tokens.'), c.issueTokensForSplits, function (v) { c.issueTokensForSplits = v; }));

  // Revnet operator 721 permissions — REVDeployer grants the operator all four by default; these let the
  // user revoke individual ones at deploy time (encoded as the REVDeploy721TiersHookConfig preventOperator* flags).
  if (state.projectType === 'revnet') {
    var opHead = el('div', 'create-label'); opHead.style.marginTop = '16px'; opHead.textContent = 'Operator store permissions'; f.appendChild(opHead);
    var opNote = el('div', 'create-hint'); opNote.textContent = 'What the revnet operator can do to the store after launch.'; f.appendChild(opNote);
    f.appendChild(toggleRow('Operator can add & remove items', dz('The operator can adjust the store’s item tiers.', 'The operator can’t change the store’s item tiers.'), c.opCanAdjustTiers, function (v) { c.opCanAdjustTiers = v; }));
    f.appendChild(toggleRow('Operator can update item metadata', dz('The operator can update the store’s metadata.', 'The operator can’t update the store’s metadata.'), c.opCanUpdateMetadata, function (v) { c.opCanUpdateMetadata = v; }));
    f.appendChild(toggleRow('Operator privileged access', dz('The operator can take from inventory for free.', 'The operator pays like everyone else.'), c.opCanMint, function (v) { c.opCanMint = v; }));
    f.appendChild(toggleRow('Operator can increase discounts', dz('The operator can raise an item’s discount.', 'The operator can’t raise item discounts.'), c.opCanIncreaseDiscount, function (v) { c.opCanIncreaseDiscount = v; }));
  }
  return f;
}

// Store-item price currency (independent of the ruleset base currency).
function storeCur(state) { return state.storePricingCurrency || 1; }
function storeUnit(state) { return storeCur(state) === 2 ? 'USDC' : 'ETH'; }
function storeDecimals(state) { return storeCur(state) === 2 ? 6 : 18; }

function renderNfts(state, render) {
  var wrap = el('div', '');
  var head = stepHead('Shop', 'Sell items to customers and supporters.');
  wrap.appendChild(head);

  // Store pricing currency — what every item's price is denominated in.
  wrap.appendChild(fieldBlock('Store pricing currency', false, (function () {
    var sel = currencySelect(storeCur(state), function (v) { state.storePricingCurrency = v; render(); }, 'field create-input');
    sel.style.width = 'auto'; sel.style.minWidth = '0';
    return sel;
  })()));

  // Opt-in: the Shop is off by default. Ticking it on reveals the first item to fill out.
  wrap.appendChild(toggleRow('Launch with store items in stock', dz('Your project launches with items already for sale.', 'You can add items to sell anytime after launch.'), state.shopEnabled, function (v) {
    state.shopEnabled = v;
    if (v && !state.nfts.length) state.nfts.push(itemDraft());
    render();
  }));

  if (state.shopEnabled) {
    state.nfts.forEach(function (nft, idx) { wrap.appendChild(itemCard(state, nft, idx, render)); });

    var add = el('a', 'operator-cta create-add-link'); add.href = '#'; add.textContent = '+ Add item';
    add.style.marginTop = state.nfts.length ? '14px' : '4px';
    add.addEventListener('click', function (e) {
      e.preventDefault();
      state.nfts.forEach(function (n) { n.expanded = false; });
      state.nfts.push(itemDraft()); render();
    });
    wrap.appendChild(add);
  }

  // Store Config (collection name/symbol, Pinata JWT, store-wide flags) is always available — the owner
  // can configure the store even when launching with no items in stock.
  var extras = collapse(state.collection, 'extrasOpen', 'Store Config', false, render, function () { return collectionExtrasSection(state, render); });
  extras.style.marginTop = '16px';
  wrap.appendChild(extras);
  return wrap;
}

// One item as an expandable inline card — same head/caret/remove pattern as a ruleset card.
function itemCard(state, nft, idx, render) {
  var card = el('div', 'create-stage-card');
  var head = el('div', 'create-stage-head');
  head.addEventListener('click', function (e) { if (e.target.closest('.create-stage-remove')) return; nft.expanded = !nft.expanded; render(); });
  var left = el('div', 'create-stage-headtext');
  var title = el('div', 'create-stage-title'); title.textContent = nft.name || ('Item #' + (idx + 1)); left.appendChild(title);
  var sum = el('div', 'create-stage-sum'); sum.textContent = itemSummary(state, nft); left.appendChild(sum);
  head.appendChild(left);
  var rm = el('button', 'create-stage-remove'); rm.textContent = '✕';
  rm.addEventListener('click', function () { state.nfts.splice(idx, 1); if (!state.nfts.length) state.shopEnabled = false; render(); });
  head.appendChild(rm);
  var caret = el('span', 'create-stage-caret'); caret.textContent = nft.expanded ? '▴' : '▾'; head.appendChild(caret);
  card.appendChild(head);
  if (nft.expanded) card.appendChild(itemEditor(state, nft, idx, render));
  return card;
}

function itemSummary(state, nft) {
  var unit = storeUnit(state);
  var parts = [];
  parts.push((nft.priceEth ? nft.priceEth : '0') + ' ' + unit);
  parts.push(nft.limited ? ((nft.supply || '0') + ' for sale') : 'unlimited');
  if (Number(nft.category) > 0) {
    var c = (state.storeCategories || []).find(function (x) { return x.id === Number(nft.category); });
    parts.push('category ' + (c ? c.name : ('#' + nft.category)));
  }
  if (nft.splitOn) parts.push('split sales');
  if (nft.discountOn && Number(nft.discountPct) > 0) parts.push(round2(Number(nft.discountPct)) + '% off');
  if (nft.reserveOn) parts.push('reserved');
  return parts.join(' | ');
}

// Inline media picker — pins the chosen file immediately (any type) and stores imageUri + mediaType.
function itemMediaPicker(state, nft, render) {
  var w = el('div', 'operator-edit-logo');
  if (nft.imageUri && (nft.mediaType || '').indexOf('image') === 0) { var prev = el('img', 'operator-edit-logo-prev'); prev.src = ipfsHttp(nft.imageUri); w.appendChild(prev); }
  else if (nft.imageUri) { var hint = el('span', 'operator-edit-hint'); hint.textContent = (nft.mediaType || 'file') + ' | pinned'; w.appendChild(hint); }
  var file = el('input', 'operator-edit-logo-file'); file.type = 'file';
  file.accept = 'image/*,video/*,audio/*,application/pdf,text/*,.md,.markdown';
  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (!f) return;
    if (!hasPinata()) { alert('Add a Pinata JWT in the Collection section to upload media.'); return; }
    if (f.size > ITEM_MAX_MEDIA_BYTES) { alert('That file is ' + itemFileSize(f.size) + ' — over the ' + ITEM_MAX_MEDIA_MB + ' MB max.'); return; }
    nft._mediaBusy = true; render();
    pinFile(f, nft.name || f.name).then(function (uri) { nft.imageUri = uri; nft.mediaType = (f.type || '').toLowerCase(); nft._mediaBusy = false; render(); })
      .catch(function (e) { nft._mediaBusy = false; render(); alert('Upload failed: ' + (e && e.message || e)); });
  });
  w.appendChild(file);
  if (nft._mediaBusy) { var b = el('span', 'operator-edit-hint'); b.textContent = 'Pinning…'; w.appendChild(b); }
  if (nft.imageUri) { var clr = el('a', 'operator-edit-logo-clear'); clr.href = '#'; clr.textContent = '✕'; clr.title = 'Remove'; clr.addEventListener('click', function (e) { e.preventDefault(); nft.imageUri = ''; nft.mediaType = ''; render(); }); w.appendChild(clr); }
  return w;
}

// Inline editor for one item — same fields as the project-page store modal, rendered inline (no popover).
function itemEditor(state, nft, idx, render) {
  var c = el('div', 'create-stage-body');
  var priceUnit = storeUnit(state);

  c.appendChild(fieldBlock('Name', false, textInput(nft.name, 'My juicy thing', function (v) { nft.name = v; })));
  c.appendChild(fieldBlock('Media', false, itemMediaPicker(state, nft, render)));
  var mediaHint = el('div', 'create-hint'); mediaHint.textContent = 'Image, gif, video, audio, PDF, text… up to ' + ITEM_MAX_MEDIA_MB + ' MB.'; c.appendChild(mediaHint);
  c.appendChild(fieldBlock('Description', true, textArea(nft.description, '', function (v) { nft.description = v; })));

  // Price — re-render on change (blur/enter) so split/discount gating updates without losing focus mid-type.
  var priceInput = textInput(nft.priceEth, '0.0', function (v) { nft.priceEth = v.trim(); });
  priceInput.addEventListener('change', function () { render(); });
  c.appendChild(fieldBlock('Price (' + priceUnit + ')', false, priceInput));

  // Split sales + Initial discount only make sense once there's a price — always shown, idle when free.
  var hasPrice = parseFloat(nft.priceEth) > 0;
  if (!hasPrice) {
    c.appendChild(idleToggle('Split sales', 'Set a price above to split each sale.'));
    c.appendChild(idleToggle('Initial discount', 'Set a price above to start the item at a discount.'));
  } else {
    c.appendChild(toggleRow('Split sales', dz('Send part of each sale to other addresses or projects; the rest goes to this project.', 'The whole sale goes to this project.'), nft.splitOn, function (v) { nft.splitOn = v; if (v && !nft.splitRecipients.length) nft.splitRecipients.push({ pct: '', recip: '', benef: '' }); render(); }));
    if (nft.splitOn) {
      var sc = el('div', 'create-subcard');
      nft.splitRecipients.forEach(function (rec, i) { sc.appendChild(itemSplitRow(nft, rec, i, render)); });
      var addS = el('a', 'operator-cta create-add-link'); addS.href = '#'; addS.textContent = '+ Add recipient'; addS.style.marginTop = '12px';
      addS.addEventListener('click', function (e) { e.preventDefault(); nft.splitRecipients.push({ pct: '', recip: '', benef: '' }); render(); });
      sc.appendChild(addS);
      c.appendChild(sc);
    }
    c.appendChild(toggleRow('Initial discount', dz('The item starts at a percent off its price.', 'The item sells at full price.'), nft.discountOn, function (v) { nft.discountOn = v; if (!v) nft.discountPct = ''; render(); }));
    if (nft.discountOn) {
      var dRow = el('div', 'create-inline-row');
      var dInp = el('input', 'field create-split-pct'); dInp.type = 'number'; dInp.min = '0'; dInp.max = '100'; dInp.step = 'any'; dInp.placeholder = '10'; dInp.value = nft.discountPct || '';
      dInp.addEventListener('input', function () { nft.discountPct = dInp.value.trim(); });
      dRow.appendChild(dInp); dRow.appendChild(document.createTextNode(' % off the price'));
      c.appendChild(dRow);
    }
  }

  c.appendChild(toggleRow('Unlimited inventory', dz('Any number can be sold.', 'Only a set quantity can be sold.'), !nft.limited, function (v) { nft.limited = !v; render(); }));
  if (nft.limited) c.appendChild(fieldBlock('Quantity', false, textInput(nft.supply, '100', function (v) { nft.supply = v.trim(); })));

  // Category
  var catField = el('div', 'create-field');
  var catLbl = el('label', 'create-label'); catLbl.textContent = 'Category'; catField.appendChild(catLbl);
  var catHint = el('div', 'create-hint'); catHint.textContent = 'Items being sold can be organized by category.'; catField.appendChild(catHint);
  if (nft._catAdding) {
    var caRow = el('div', 'create-inline-row');
    var caInp = el('input', 'field create-input'); caInp.type = 'text'; caInp.placeholder = 'category name'; caInp.value = nft._catName || '';
    caInp.addEventListener('input', function () { nft._catName = caInp.value; });
    var caSave = el('a', 'operator-cta'); caSave.href = '#'; caSave.textContent = 'Save'; caSave.style.marginLeft = '8px';
    caSave.addEventListener('click', function (e) {
      e.preventDefault(); var nm = (nft._catName || '').trim(); if (!nm) { caInp.focus(); return; }
      var nextId = (state.storeCategories || []).reduce(function (m, x) { return x.id > m ? x.id : m; }, 0) + 1;
      state.storeCategories.push({ id: nextId, name: nm }); nft.category = nextId; nft._catAdding = false; nft._catName = ''; render();
    });
    caRow.appendChild(caInp); caRow.appendChild(caSave); catField.appendChild(caRow);
  } else {
    var catSel = el('select', 'field create-input');
    var o0 = el('option'); o0.value = '0'; o0.textContent = 'Default'; catSel.appendChild(o0);
    (state.storeCategories || []).forEach(function (x) { var o = el('option'); o.value = String(x.id); o.textContent = x.name + ' (#' + x.id + ')'; catSel.appendChild(o); });
    var oA = el('option'); oA.value = '__add__'; oA.textContent = '+ Add category…'; catSel.appendChild(oA);
    catSel.value = String(nft.category || 0);
    catSel.addEventListener('change', function () { if (catSel.value === '__add__') { nft._catAdding = true; render(); } else { nft.category = Number(catSel.value) || 0; } });
    catField.appendChild(catSel);
  }
  c.appendChild(catField);

  // Extra options
  c.appendChild(collapse(nft, 'advOpen', 'Extra options', true, render, function () {
    var a = el('div', '');
    a.appendChild(toggleRow('Reserve inventory', dz('Set aside 1 of every N sold for a chosen address.', 'No inventory is reserved.'), nft.reserveOn, function (v) { nft.reserveOn = v; render(); }));
    if (nft.reserveOn) {
      var rRow = el('div', 'create-inline-row');
      rRow.appendChild(document.createTextNode('1 of '));
      var fInp = el('input', 'field create-split-pct'); fInp.type = 'number'; fInp.min = '1'; fInp.step = '1'; fInp.placeholder = '10'; fInp.value = nft.reserveFrequency || '';
      fInp.addEventListener('input', function () { nft.reserveFrequency = fInp.value.trim(); });
      rRow.appendChild(fInp); rRow.appendChild(document.createTextNode(' sold to '));
      var bInp = el('input', 'field'); bInp.type = 'text'; bInp.placeholder = '0x… or name.eth'; bInp.value = nft.reserveBeneficiary || ''; bInp.style.flex = '1';
      bInp.addEventListener('input', function () { nft.reserveBeneficiary = bInp.value.trim(); });
      var bHint = attachEns(bInp, function () { render(); }); // resolves on mainnet; populates the global ENS cache resolvedStr reads
      rRow.appendChild(recipBoxWith(bInp, bHint)); a.appendChild(rRow);
      // Reserving requires a beneficiary, or the deploy reverts (JB721TiersHookStore_MissingReserveBeneficiary).
      if (Number(nft.reserveFrequency) > 0 && !/^0x[0-9a-fA-F]{40}$/.test(resolvedStr(nft.reserveBeneficiary))) {
        a.appendChild(warnNote('Add the address that receives the reserved set-aside, or this item will fail to deploy.'));
      }
    }
    var minter = state.projectType === 'revnet' ? 'operator' : 'owner';
    a.appendChild(toggleRow(minter.charAt(0).toUpperCase() + minter.slice(1) + ' privileged access', dz('The ' + minter + ' can take from inventory for free.', 'The ' + minter + ' pays like everyone else.'), nft.flags.allowOwnerMint, function (v) { nft.flags.allowOwnerMint = v; }));
    a.appendChild(toggleRow('Transfers pausable per ruleset', dz('This item’s transfers can be paused during a ruleset.', 'This item’s transfers can’t be paused.'), nft.flags.transfersPausable, function (v) { nft.flags.transfersPausable = v; }));
    a.appendChild(toggleRow('Permanent', dz('This item can never be removed from the store.', 'This item can be removed later.'), nft.flags.cantBeRemoved, function (v) { nft.flags.cantBeRemoved = v; }));
    a.appendChild(toggleRow('Allow credit purchases', dz('Payments that don’t buy an item become credit usable on items that allow it.', 'Payments that don’t buy this item don’t earn credit toward it.'), nft.flags.allowCredits, function (v) { nft.flags.allowCredits = v; }));
    a.appendChild(toggleRow('Owner can edit discounts', dz('The owner can change this item’s discount later.', 'This item’s discount is locked.'), nft.flags.ownerCanEditDiscount, function (v) { nft.flags.ownerCanEditDiscount = v; }));
    a.appendChild(toggleRow('Custom voting units', dz('Give this item a specific governance weight.', 'Governance weight follows the item price.'), nft.votingOn, function (v) { nft.votingOn = v; if (!v) nft.votingUnits = ''; render(); }));
    if (nft.votingOn) a.appendChild(fieldBlock('Voting units', false, textInput(nft.votingUnits, '0', function (v) { nft.votingUnits = v.trim(); })));
    return a;
  }));
  return c;
}

function itemSplitRow(nft, rec, idx, render) {
  var wrap = el('div', 'create-split-wrap');
  if (idx > 0) wrap.style.marginTop = '12px';
  var row = el('div', 'create-split-row');
  var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Send' : '… and'; row.appendChild(lead);
  var pct = el('input', 'field create-split-pct'); pct.type = 'number'; pct.min = '0'; pct.step = 'any'; pct.placeholder = '10'; pct.value = rec.pct || '';
  pct.addEventListener('input', function () { rec.pct = pct.value.trim(); }); row.appendChild(pct);
  var sign = el('span', 'create-split-sign'); sign.textContent = '%'; row.appendChild(sign);
  var to = el('span', 'create-split-to'); to.textContent = 'to'; row.appendChild(to);
  var recip = el('input', 'field create-split-recip'); recip.type = 'text'; recip.placeholder = '0x… or project ID'; recip.value = rec.recip || '';
  var ensHint = attachEns(recip, function (name, addr) { rec.resolvedFor = addr ? name : null; rec.resolvedAddress = addr || null; });
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = nft.splitRecipients.indexOf(rec); if (i >= 0) nft.splitRecipients.splice(i, 1); render(); });
  row.appendChild(recipBoxWith(recip, ensHint)); row.appendChild(rm); wrap.appendChild(row);
  var benefRow = el('div', 'create-split-benef'); benefRow.style.display = 'none';
  var benefLead = el('span', 'create-split-to'); benefLead.textContent = 'with beneficiary'; benefRow.appendChild(benefLead);
  var benef = el('input', 'field'); benef.type = 'text'; benef.placeholder = '0x… or name.eth'; benef.value = rec.benef || '';
  benef.addEventListener('input', function () { rec.benef = benef.value.trim(); });
  var benefHint = attachEns(benef, function () {}); // resolves on Ethereum mainnet; populates the global ENS cache
  benefRow.appendChild(recipBoxWith(benef, benefHint)); wrap.appendChild(benefRow);
  function refresh() { var v = (recip.value || '').trim(); rec.recip = v; benefRow.style.display = (/^[0-9]+$/.test(v) && Number(v) > 0) ? '' : 'none'; }
  recip.addEventListener('input', refresh); refresh();
  return wrap;
}

// Deadline + other-rules section for a stage (folded into the stage editor).
function otherRulesSection(stage, render) {
  var c = el('div', '');
  c.appendChild(toggleRow('Hold fees', dz('Fees are held in the project instead of processed automatically, and refunded to the project’s balance if the funds are returned. Useful for managing whole token holder refunds. After 28 days without seeing the withdrawn funds, held fees are automatically processed.', 'Fees are processed automatically.'), stage.holdFees, function (v) { stage.holdFees = v; }));

  // Owner-power toggles — each grants the owner mid-flight control that supporters must trust. Grouped
  // in a pink warning zone so the abuse-vector risk is unmistakable.
  var warn = el('div', 'create-warn-zone');
  var wh = el('div', 'create-warn-zone-head'); wh.textContent = 'Superpowers';
  warn.appendChild(wh);
  warn.appendChild(toggleRow('Allow setting payment terminals', dz('The owner can add/remove payment terminals at any time. This lets the project upgrade, but also lets the owner reroute where funds flow at will.', 'Payment terminals are fixed for this ruleset.'), stage.allowSetTerminals, function (v) { stage.allowSetTerminals = v; }));
  warn.appendChild(toggleRow('Allow setting controller', dz('The owner can change the project’s controller at any time. This lets the project upgrade, but can also be used by the owner to change all the rules at will.', 'The controller is fixed for this ruleset.'), stage.allowSetController, function (v) { stage.allowSetController = v; }));
  warn.appendChild(toggleRow('Allow terminal migration', dz('The owner can migrate the project’s terminals to a new version. This lets the project upgrade, but can also be used by the owner to move all funds to a terminal of their choosing.', 'Terminal migration is disabled.'), stage.allowTerminalMigration, function (v) { stage.allowTerminalMigration = v; }));
  warn.appendChild(toggleRow('Allow setting a custom token', dz('The owner can replace the project’s token with a custom ERC-20 of their choosing.', 'The project token can’t be swapped for a custom one.'), stage.allowSetCustomToken, function (v) { stage.allowSetCustomToken = v; }));
  warn.appendChild(toggleRow('Allow adding accounting tokens', dz('The owner can add new accounting tokens the project holds at any time.', 'The set of accounting tokens is fixed for this ruleset.'), stage.allowAddAccountingContext, function (v) { stage.allowAddAccountingContext = v; }));
  warn.appendChild(toggleRow('Allow adding price feeds', dz('The owner can add price feeds the project uses to convert currencies.', 'Price feeds can’t be added during this ruleset.'), stage.allowAddPriceFeed, function (v) { stage.allowAddPriceFeed = v; }));
  c.appendChild(warn);
  return c;
}

// ---------------------------------------------------------------------------
// Step 6: Deploy
// ---------------------------------------------------------------------------

// Settlement — how/where the project settles: accounting token, chains, and per-chain refinements.
function renderSettlement(state, render) {
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Settlement', 'Decide where you can receive payments and how money settles.'));

  // Accounting token — what the project HOLDS in its treasury. The router terminal (any-token
  // auto-convert) is always part of the tx and toggled via an inline enable/disable in the description.
  // Revnets are ETH-only (fixed native accounting context), so the accounting card is hidden for them.
  wrap.appendChild(fieldBlock('Accounting', false, (function () {
    var w = el('div', '');
    w.appendChild(choiceCardsInline([{ key: 'eth', label: 'ETH' }, { key: 'usdc', label: 'USDC' }], state.accepts[0] || 'eth', function (k) {
      state.accepts = [k]; render();
    }));
    var note = el('div', 'create-hint');
    note.textContent = state.projectType === 'revnet'
      ? ('Pick which reserve asset will back the value of $' + tickerLabel(state) + '.')
      : 'The token that makes up your project’s balance.';
    w.appendChild(note);
    // The router terminal (any-token auto-swap) is a custom-flow feature; revnets use only the canonical terminal.
    if (state.projectType !== 'revnet') {
      var line2 = el('div', 'create-hint');
      line2.appendChild(document.createTextNode(state.swapRouter
        ? 'Other payment tokens auto-swap to your chosen accounting token as they’re paid in. '
        : 'Payers can only pay in your accounting token. '));
      var toggle = el('a', 'create-inline-toggle'); toggle.href = '#';
      toggle.textContent = state.swapRouter ? 'Disable giving payers this option' : 'Enable giving payers this option';
      toggle.addEventListener('click', function (e) { e.preventDefault(); state.swapRouter = !state.swapRouter; render(); });
      line2.appendChild(toggle);
      w.appendChild(line2);
    }
    return w;
  })()));

  // Chain + bridge selection (shared with the revnet Deploy step).
  wrap.appendChild(chainBridgeBlock(state, render));

  // Per-chain overrides (multichain only) — confirm/adapt amounts, items, and addresses per chain.
  if (state.chainIds.length > 1) wrap.appendChild(perChainSection(state, render));
  return wrap;
}

// Chain multi-select (canonical names) + the bridge selector shown when >1 chain is chosen. Shared by the
// custom Settlement step and the revnet Deploy step.
function chainBridgeBlock(state, render) {
  var wrap = el('div', '');
  var label = el('div', 'create-label'); label.style.marginTop = '18px'; label.textContent = 'Select chains:'; wrap.appendChild(label);
  var chainRow = el('div', 'create-chain-row');
  CHAIN_PAIRS.forEach(function (p) {
    var actual = actualChainId(p.canon, state.network);
    var on = state.chainIds.indexOf(actual) !== -1;
    var pill = el('button', 'create-chain-pill' + (on ? ' selected' : ''));
    pill.textContent = p.name;
    pill.addEventListener('click', function () {
      var ids = state.chainIds.slice();
      if (on) ids = ids.filter(function (x) { return x !== actual; });
      else ids.push(actual);
      state.chainIds = ids.length ? ids : [actual];
      render();
    });
    chainRow.appendChild(pill);
  });
  wrap.appendChild(chainRow);
  wrap.appendChild(infoNote(state.chainIds.length > 1
    ? 'Deploys on ' + state.chainIds.length + ' chains, linked so your token and balances can move between them. You sign once per chain and pay gas once (via Relayr).'
    : 'Deploys on a single chain. You can add more chains here before launching.'));

  if (state.chainIds.length > 1) {
    var bField = el('div', 'create-field'); bField.style.marginTop = '16px';
    var bl = el('label', 'create-label'); bl.textContent = 'Connect chains via'; bField.appendChild(bl);
    var bsel = el('select', 'field create-input'); bsel.style.width = 'auto'; bsel.style.minWidth = '0';
    [['native', 'Native bridges'], ['ccip', 'CCIP'], ['both', 'Both']].forEach(function (o) {
      var op = el('option'); op.value = o[0]; op.textContent = o[1]; if ((state.suckerType || 'native') === o[0]) op.selected = true; bsel.appendChild(op);
    });
    bsel.addEventListener('change', function () { state.suckerType = bsel.value; render(); });
    bField.appendChild(bsel);
    var bh = el('div', 'create-hint'); bh.textContent = 'Native bridges connect Ethereum with L2s (strongest guarantees). CCIP (Chainlink) connects any chains.'; bField.appendChild(bh);
    wrap.appendChild(bField);
    var unc = uncoveredPairs(state);
    if (unc.length) wrap.appendChild(warnNote('⚠ ' + unc.length + ' chain pair' + (unc.length > 1 ? 's' : '') + ' can’t connect with native bridges (they only link Ethereum↔L2). Choose CCIP or Both to link L2↔L2 pairs.'));
  }
  return wrap;
}

// Selected-chain pairs that won't link under the chosen sucker type (e.g. L2↔L2 under native bridges).
function uncoveredPairs(state) {
  var ids = state.chainIds, out = [];
  for (var i = 0; i < ids.length; i++) for (var j = i + 1; j < ids.length; j++) {
    var ok = bridgesForType(state.suckerType).some(function (br) { return suckerDeployerForBridge(ids[i], ids[j], br); });
    if (!ok) out.push([ids[i], ids[j]]);
  }
  return out;
}

function renderDeploy(state, render) {
  var isRev = state.projectType === 'revnet';
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Review & Deploy', isRev ? 'Review, then deploy your revnet.' : 'Review your project, then launch.'));

  // Review summary
  wrap.appendChild(reviewSummary(state));

  // The exact transaction for each chain is shown in a confirmation screen (with a copy-able LLM audit
  // prompt) right before you sign it — no need to re-review raw calldata here.
  if (state.chainIds.length > 1) {
    wrap.appendChild(pinkNote('Your wallet will switch networks and prompt for a signature once per chain (' + state.chainIds.length + ' chains) — each request is bound to its own chain, so the wallet must be on that network to sign it. After signing all ' + state.chainIds.length + ', you pay gas once and Relayr deploys to every chain.'));
    wrap.appendChild(infoNote('Each chain’s exact transaction is shown for review before you sign it.'));
  } else {
    wrap.appendChild(infoNote('The exact transaction data is shown for review before you sign it.'));
  }

  // ToS + launch
  var tos = el('label', 'create-tos');
  var cb = el('input', ''); cb.type = 'checkbox'; cb.checked = state.tos;
  cb.addEventListener('change', function () { state.tos = cb.checked; updateLaunch(); });
  tos.appendChild(cb);
  tos.appendChild(document.createTextNode(' I understand this is a brand-new protocol and accept the risks of deploying.'));
  wrap.appendChild(tos);

  if (!hasPinata()) wrap.appendChild(infoNote('No Pinata JWT set — add one in DATA → settings to pin your logo & metadata. Otherwise they’re skipped at launch and you can add them by editing the project later.'));

  // Success panel — replaces the form once deployed: a clear confirmation + a "Go to project" CTA.
  if (state.done) {
    var panel = el('div', 'create-success');
    var st = el('div', 'create-success-title'); st.textContent = (state.details.name || 'Your project') + ' is live'; panel.appendChild(st);
    var sub = el('div', 'create-success-sub');
    sub.textContent = (isRev ? 'Revnet' : 'Project') + ' deployed on ' + state.chainIds.map(chainName).join(', ') + '.';
    panel.appendChild(sub);
    if (state.deployed && state.deployed.txHash) {
      var txp = el('div', 'create-success-sub'); txp.textContent = 'Transaction: ' + truncAddr(state.deployed.txHash);
      panel.appendChild(txp);
    }
    if (state.deployed && state.deployed.route) {
      var go = el('button', 'create-btn primary big'); go.style.marginTop = '14px'; go.textContent = 'Go to project →';
      go.addEventListener('click', function () { window.location.hash = state.deployed.route; if (state._close) state._close(); });
      panel.appendChild(go);
    } else {
      var noteFinding = el('div', 'create-success-sub'); noteFinding.textContent = 'Find it in Discover in a moment.'; panel.appendChild(noteFinding);
    }
    wrap.appendChild(panel);
    return wrap;
  }

  // While deploying, show only the current step (single live line) — not a growing log.
  var last = state.statusLines.length ? state.statusLines[state.statusLines.length - 1] : null;
  if (last) {
    var statusRow = el('div', 'create-status' + (last.err ? ' err' : ''));
    if (state.deploying && !last.err && !state.quoteChoice) statusRow.appendChild(el('span', 'create-spinner'));
    var stx = el('span'); stx.textContent = last.text; statusRow.appendChild(stx);
    wrap.appendChild(statusRow);
  }

  // Multichain deploy: a friendly per-chain checklist (chain name + Deploying…/Deployed/Failed).
  if (state.deployProgress && state.deployProgress.length) {
    var prog = el('div', 'create-deploy-progress');
    state.deployProgress.forEach(function (p) {
      var row = el('div', 'create-deploy-row');
      if (p.status.kind === 'pending') {
        row.appendChild(el('span', 'create-spinner'));
      } else {
        var ic = el('span', 'create-deploy-ic create-deploy-' + p.status.kind);
        ic.textContent = p.status.kind === 'ok' ? '✓' : '✕';
        row.appendChild(ic);
      }
      var nm = el('span', 'create-deploy-name'); nm.textContent = chainName(p.chainId); row.appendChild(nm);
      var st = el('span', 'create-deploy-state create-deploy-' + p.status.kind); st.textContent = p.status.label; row.appendChild(st);
      prog.appendChild(row);
    });
    wrap.appendChild(prog);
  }

  // Relayr quote returned (multichain) → let the user pick which chain to pay gas on, then pay. Shown in
  // place of the Launch button while a choice is pending.
  if (state.quoteChoice) {
    var qc = el('div', 'create-quote-choice');
    var qh = el('div', 'create-label'); qh.textContent = 'Pay gas once to deploy on every chain'; qc.appendChild(qh);
    var qSel = el('select', 'field create-input'); qSel.style.width = 'auto'; qSel.style.minWidth = '0';
    state.quoteChoice.options.forEach(function (o, i) {
      var op = el('option'); op.value = String(i); op.textContent = o.chain + ' — ~' + o.eth + ' ETH'; qSel.appendChild(op);
    });
    qc.appendChild(qSel);
    var qFoot = el('div', 'create-modal-foot'); qFoot.style.marginTop = '10px';
    var qPay = el('button', 'create-btn primary'); qPay.textContent = 'Pay & deploy';
    qPay.addEventListener('click', function () { var i = Number(qSel.value) || 0; var o = state.quoteChoice && state.quoteChoice.options[i]; if (o && state.quoteChoice) state.quoteChoice.resolve(o.opt); });
    var qCancel = el('button', 'create-btn ghost'); qCancel.textContent = 'Cancel';
    qCancel.addEventListener('click', function () { state.quoteChoice && state.quoteChoice.resolve(null); });
    qFoot.appendChild(qCancel); qFoot.appendChild(qPay);
    qc.appendChild(qFoot);
    wrap.appendChild(qc);
    return wrap;
  }

  var bad = isRev ? -1 : badStageIndex(state); // revnets have no per-stage durations to validate

  // Mainnet/testnet — chosen here, just before launching. Remaps the selected chains to that network.
  var netField = el('div', 'create-field'); netField.style.marginTop = '14px';
  var netLbl = el('label', 'create-label'); netLbl.textContent = 'Deploy to'; netField.appendChild(netLbl);
  var netSel = el('select', 'field create-input'); netSel.style.width = 'auto'; netSel.style.minWidth = '0';
  [['mainnet', 'Mainnet'], ['testnet', 'Testnet']].forEach(function (o) { var op = el('option'); op.value = o[0]; op.textContent = o[1]; if (state.network === o[0]) op.selected = true; netSel.appendChild(op); });
  netSel.addEventListener('change', function () {
    state.network = netSel.value;
    state.chainIds = state.chainIds.map(function (id) { return actualChainId(canonChainId(id), state.network); });
    render();
  });
  netField.appendChild(netSel);
  wrap.appendChild(netField);

  var needTicker = isRev && !state.details.ticker;
  var ownerRaw = pickResolved(state.details.owner, { resolvedAddress: state.details.ownerResolved, resolvedFor: state.details.ownerResolvedFor });
  var opRaw = pickResolved(state.revOperator, { resolvedAddress: state.revOperatorResolved, resolvedFor: state.revOperatorResolvedFor });
  var needOwner = !isRev && !/^0x[0-9a-fA-F]{40}$/.test(ownerRaw);
  var needOperator = isRev && !/^0x[0-9a-fA-F]{40}$/.test(opRaw);
  var launch = el('button', 'create-btn primary big');
  function updateLaunch() {
    launch.disabled = state.deploying || !state.tos || !state.chainIds.length || !state.details.name || needTicker || needOwner || needOperator || bad !== -1;
  }
  launch.textContent = state.deploying ? (isRev ? 'Deploying…' : 'Launching…') : (isRev ? 'Deploy revnet' : 'Launch project');
  launch.addEventListener('click', function () { deploy(state, render); });
  updateLaunch();
  wrap.appendChild(launch);
  if (!state.details.name) wrap.appendChild(infoNote('Add a project name on the Details step to ' + (isRev ? 'deploy.' : 'launch.')));
  if (needTicker) wrap.appendChild(infoNote('Add a token symbol on the Details step to deploy your revnet.'));
  if (needOwner) wrap.appendChild(infoNote('Set a project owner on the Flavor step to launch.'));
  if (needOperator) wrap.appendChild(infoNote('Set an operator on the Flavor step to deploy your revnet.'));
  if (bad !== -1) wrap.appendChild(warnNote('Stage ' + (bad + 1) + ' has no duration but isn’t the last stage. Give it a duration on the Stages step so Stage ' + (bad + 2) + ' starts when its cycle ends.'));

  return wrap;
}

// ---- Per-chain overrides (multichain): limited payout amounts + store-item inclusion/quantity ----

// Per-chain overrides are keyed by canonical chain id (1/10/42161/8453) so they survive a mainnet↔testnet switch.
function perChainOf(state, chainId) {
  var k = canonChainId(chainId);
  if (!state.perChain[k]) state.perChain[k] = { payouts: {}, items: {}, addr: {} };
  var pc = state.perChain[k];
  if (!pc.payouts) pc.payouts = {}; if (!pc.items) pc.items = {}; if (!pc.addr) pc.addr = {};
  return pc;
}
function perChainPeek(state, chainId) { return state.perChain[canonChainId(chainId)]; }
// Per-chain address override store, keyed by a stable field key (e.g. 'p:0:1' = payout stage0 recipient1).
function pcAddrGet(state, chainId, key, def) {
  var pc = perChainPeek(state, chainId);
  var ov = pc && pc.addr && pc.addr[key];
  return (ov != null && ov !== '') ? ov : def;
}
function pcAddrSet(state, chainId, key, val) { var pc = perChainOf(state, chainId); pc.addr[key] = val; }
// The resolved 0x address for a field on a chain (per-chain override → default), ENS-resolved.
function chainAddr(state, chainId, key, defStr) { return resolvedStr(pcAddrGet(state, chainId, key, defStr)); }
// Per-chain payout amount for one recipient (override → default).
function chainPayoutAmount(state, chainId, stageIdx, recipIdx) {
  var pc = perChainPeek(state, chainId);
  var ov = pc && pc.payouts && pc.payouts[stageIdx] && pc.payouts[stageIdx][recipIdx];
  if (ov != null && ov !== '') return ov;
  return state.stages[stageIdx].payoutRecipients[recipIdx].amountEth;
}
function chainItemIncluded(state, chainId, itemIdx) {
  var pc = perChainPeek(state, chainId);
  var ov = pc && pc.items && pc.items[itemIdx];
  return ov ? ov.include !== false : true;
}
// Per-chain "unlimited inventory" toggle for an item (override → item default).
function chainItemUnlimited(state, chainId, itemIdx) {
  var pc = perChainPeek(state, chainId);
  var ov = pc && pc.items && pc.items[itemIdx];
  if (ov && ov.unlimited != null) return ov.unlimited;
  return !state.nfts[itemIdx].limited;
}
// Per-chain supply string for an item ('' = unlimited).
function chainItemSupply(state, chainId, itemIdx) {
  if (chainItemUnlimited(state, chainId, itemIdx)) return '';
  var pc = perChainPeek(state, chainId);
  var ov = pc && pc.items && pc.items[itemIdx];
  if (ov && ov.supply != null && ov.supply !== '') return ov.supply;
  var nft = state.nfts[itemIdx];
  return nft.limited ? nft.supply : '';
}

// An address input prefilled with the per-chain override (or default), with ENS resolution shown below.
function pcAddrField(state, chainId, key, defStr) {
  var input = el('input', 'field'); input.type = 'text'; input.placeholder = '0x… or name.eth';
  input.value = pcAddrGet(state, chainId, key, defStr || '');
  input.addEventListener('input', function () { pcAddrSet(state, chainId, key, input.value.trim()); });
  return recipBoxWith(input, attachEns(input, function () {}));
}
function isWalletRecip(rec) { return rec && rec.type !== 'project' && (rec.address || '').trim(); }
function pcLabelRow(card, text) { var d = el('div', 'create-hint'); d.style.marginTop = '8px'; d.textContent = text; card.appendChild(d); }

function perChainSection(state, render) {
  var hasItems = state.shopEnabled && state.nfts.length > 0;
  var anyPayouts = state.stages.some(function (s) { return s.payoutMode !== 'none' && (s.payoutRecipients || []).length; });
  var anyReserved = state.stages.some(function (s) { return s.tokenMode === 'custom' && (s.reservedRecipients || []).some(function (r) { return Number(r.percent) > 0; }); });
  if (!anyPayouts && !anyReserved && !hasItems) return el('div', '');
  var wrap = el('div', '');
  var lbl = el('div', 'create-label'); lbl.style.marginTop = '18px'; lbl.textContent = 'Per-chain settings'; wrap.appendChild(lbl);
  wrap.appendChild(infoNote('Amounts, store items, and addresses default to the same on every chain. Adjust any chain below — addresses can differ since an account may not exist on all chains.'));

  state.chainIds.forEach(function (cid) {
    var card = el('div', 'create-subcard');
    var h = el('div', 'create-stage-title'); h.textContent = chainName(cid); card.appendChild(h);
    var multiStage = state.stages.length > 1;

    // Payouts — per recipient: amount (limited) and address (wallet recipients).
    state.stages.forEach(function (stage, si) {
      if (stage.payoutMode === 'none' || !(stage.payoutRecipients || []).length) return;
      var cur = stage.payoutCurrency === 2 ? 'USD' : 'ETH';
      var limited = stage.payoutMode === 'limited';
      if (multiStage) pcLabelRow(card, 'Ruleset #' + (si + 1) + ' payouts');
      stage.payoutRecipients.forEach(function (rec, ri) {
        if (limited) {
          var row = el('div', 'create-inline-row');
          row.appendChild(document.createTextNode('Pay '));
          var amt = el('input', 'field create-inline-num'); amt.type = 'text'; amt.placeholder = '0.0'; amt.value = chainPayoutAmount(state, cid, si, ri);
          amt.addEventListener('input', function () { var pc = perChainOf(state, cid); pc.payouts[si] = pc.payouts[si] || {}; pc.payouts[si][ri] = amt.value.trim(); });
          row.appendChild(amt); row.appendChild(document.createTextNode(' ' + cur + ' to'));
          card.appendChild(row);
        } else {
          pcLabelRow(card, round2(Number(rec.percent) || 0) + '% to');
        }
        if (isWalletRecip(rec)) card.appendChild(pcAddrField(state, cid, 'p:' + si + ':' + ri, rec.address));
        else { var pl = el('div', 'create-hint'); pl.textContent = recipLabel(rec); card.appendChild(pl); }
      });
    });

    // Reserved-token splits — per wallet recipient, an address override.
    state.stages.forEach(function (stage, si) {
      if (stage.tokenMode !== 'custom') return;
      var wallets = (stage.reservedRecipients || []).map(function (r, i) { return { r: r, i: i }; }).filter(function (e) { return Number(e.r.percent) > 0 && isWalletRecip(e.r); });
      if (!wallets.length) return;
      pcLabelRow(card, (multiStage ? 'Ruleset #' + (si + 1) + ' reserved' : 'Reserved tokens'));
      wallets.forEach(function (e) {
        pcLabelRow(card, round2(Number(e.r.percent) || 0) + '% to');
        card.appendChild(pcAddrField(state, cid, 'r:' + si + ':' + e.i, e.r.address));
      });
    });

    // Store items — include + quantity, plus reserve beneficiary and sale-split addresses.
    if (hasItems) {
      state.nfts.forEach(function (nft, ii) {
        var name = nft.name || ('Item #' + (ii + 1));
        var inc = chainItemIncluded(state, cid, ii);
        card.appendChild(toggleRow('Sell “' + name + '” here', dz('Sold on ' + chainName(cid) + '.', 'Not sold on ' + chainName(cid) + '.'), inc, function (v) {
          var pc = perChainOf(state, cid); pc.items[ii] = pc.items[ii] || {}; pc.items[ii].include = v; render();
        }));
        if (!inc) return;
        var unlimited = chainItemUnlimited(state, cid, ii);
        card.appendChild(toggleRow('Unlimited inventory', dz('Any number can be sold on ' + chainName(cid) + '.', 'Only a set quantity is sold on ' + chainName(cid) + '.'), unlimited, function (v) {
          var pc = perChainOf(state, cid); pc.items[ii] = pc.items[ii] || {}; pc.items[ii].unlimited = v; render();
        }));
        if (!unlimited) {
          var qrow = el('div', 'create-inline-row');
          qrow.appendChild(document.createTextNode('Quantity '));
          var q = el('input', 'field create-inline-num'); q.type = 'text'; q.placeholder = '100'; q.value = chainItemSupply(state, cid, ii);
          q.addEventListener('input', function () { var pc = perChainOf(state, cid); pc.items[ii] = pc.items[ii] || {}; pc.items[ii].supply = q.value.trim(); });
          qrow.appendChild(q);
          card.appendChild(qrow);
        }
        if (nft.reserveOn && Number(nft.reserveFrequency) > 0) {
          pcLabelRow(card, 'Reserve set-aside to');
          card.appendChild(pcAddrField(state, cid, 'rb:' + ii, nft.reserveBeneficiary));
        }
        if (nft.splitOn) {
          (nft.splitRecipients || []).forEach(function (r, sj) {
            var v = (r.recip || '').trim();
            if (!v || (/^[0-9]+$/.test(v) && Number(v) > 0)) return; // skip empty + project-ID recipients
            pcLabelRow(card, round2(Number(r.pct) || 0) + '% of “' + name + '” sales to');
            card.appendChild(pcAddrField(state, cid, 'is:' + ii + ':' + sj, v));
          });
        }
      });
    }
    wrap.appendChild(card);
  });
  return wrap;
}

function reviewSummary(state) {
  var c = el('div', 'create-review');
  function row(k, v) {
    var r = el('div', 'create-review-row');
    var kk = el('span', 'create-review-k'); kk.textContent = k;
    var vv = el('span', 'create-review-v'); vv.textContent = v;
    r.appendChild(kk); r.appendChild(vv); return r;
  }
  function rowBullets(k, items) {
    var r = el('div', 'create-review-row col');
    var kk = el('span', 'create-review-k'); kk.textContent = k; r.appendChild(kk);
    var list = el('div', 'create-review-bullets');
    items.forEach(function (it) { var d = el('div', 'create-review-bullet'); d.textContent = '• ' + it; list.appendChild(d); });
    r.appendChild(list); return r;
  }
  if (state.projectType === 'revnet') {
    c.appendChild(row('Flavor', 'Revnet'));
    c.appendChild(row('Name', state.details.name || '—'));
    c.appendChild(row('Token', '$' + tickerLabel(state)));
    c.appendChild(row('Accounting token', (state.accepts[0] || 'eth') === 'usdc' ? 'USDC' : 'ETH'));
    var opRaw = pickResolved(state.revOperator, { resolvedAddress: state.revOperatorResolved, resolvedFor: state.revOperatorResolvedFor });
    c.appendChild(row('Operator', /^0x/.test(opRaw) ? shortAddr(opRaw) : 'Project owner'));
    c.appendChild(row('Stages', String(state.stages.length)));
    state.stages.forEach(function (s, i) { c.appendChild(row('Stage #' + (i + 1), revStageSummary(s, i, state))); });
    c.appendChild(row('Chains', state.chainIds.map(chainName).join(', ')));
    return c;
  }
  c.appendChild(row('Name', state.details.name || '—'));
  c.appendChild(row('Accounting token', state.accepts.map(function (a) { return a.toUpperCase(); }).join(' + ') + (state.swapRouter ? ' (+ any via router)' : '')));
  c.appendChild(row('Launch', state.stages[0] && state.stages[0].schedule
    ? new Date(Number(state.stages[0].schedule) * 1000).toLocaleString() : 'Immediately'));
  c.appendChild(row('Rulesets', String(state.stages.length)));
  state.stages.forEach(function (s, i) { c.appendChild(rowBullets('Ruleset #' + (i + 1), stageSummaryParts(s, i, state))); });
  if (afterApplies(state)) {
    c.appendChild(row('Afterwards', { wait: 'idle (standby)', terminal: 'continue on the same terms forever', cycle: 'repeat the cycle forever' }[state.afterMode] || state.afterMode));
  }
  c.appendChild(row('Shop', (state.shopEnabled && state.nfts.length) ? (state.nfts.length + ' item(s)') : 'None'));
  c.appendChild(row('Chains', state.chainIds.map(chainName).join(', ')));
  return c;
}


// ---------------------------------------------------------------------------
// NFT modal
// ---------------------------------------------------------------------------

var ITEM_MAX_MEDIA_MB = 25;
var ITEM_MAX_MEDIA_BYTES = ITEM_MAX_MEDIA_MB * 1024 * 1024;

function itemDraft() {
  return {
    expanded: true, advOpen: false, _mediaBusy: false, _catAdding: false,
    name: '', description: '',
    imageUri: '', mediaType: '', metaUri: '', encodedIpfsUri: '',
    priceEth: '', limited: false, supply: '',
    splitOn: false, splitRecipients: [],   // {pct, recip, benef}
    discountOn: false, discountPct: '',
    category: 0,
    reserveOn: false, reserveFrequency: '', reserveBeneficiary: '',
    votingOn: false, votingUnits: '',
    flags: { allowOwnerMint: false, transfersPausable: false, cantBeRemoved: false, allowCredits: true, ownerCanEditDiscount: true },
  };
}

function itemFileSize(bytes) {
  if (bytes >= 1024 * 1024) return (Math.round(bytes / 1024 / 1024 * 10) / 10) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}


// Convert an item draft's split recipients into per-chain JB721 splits. Project recipients use the entered
// project ID as-is on every chain (pre-deploy, the same project deploys at the same ID across chains).
function itemSplits(d, state, chainId, itemIdx) {
  if (!d.splitOn) return { splitPercent: 0, splits: [] };
  var rsList = d.splitRecipients.map(function (r, i) { return { r: r, i: i }; }).filter(function (e) { return Number(e.r.pct) > 0 && (e.r.recip || '').trim(); });
  var tot = rsList.reduce(function (s, e) { return s + Number(e.r.pct); }, 0);
  if (!tot) return { splitPercent: 0, splits: [] };
  var splits = rsList.map(function (e) {
    var r = e.r;
    var v = (r.recip || '').trim();
    var isProj = /^[0-9]+$/.test(v) && Number(v) > 0;
    // Per-chain wallet beneficiary override → default (ENS-resolved).
    var benef = state ? chainAddr(state, chainId, 'is:' + itemIdx + ':' + e.i, pickResolved(v, r)) : pickResolved(v, r);
    return {
      percent: Math.round(Number(r.pct) / tot * 1e9),
      projectId: isProj ? BigInt(v) : 0n,
      beneficiary: isProj ? ((resolvedStr(r.benef) && /^0x[0-9a-fA-F]{40}$/.test(resolvedStr(r.benef))) ? resolvedStr(r.benef) : ZERO) : ((benef && /^0x[0-9a-fA-F]{40}$/.test(benef)) ? benef : ZERO),
      preferAddToBalance: false, lockedUntil: 0, hook: ZERO,
    };
  });
  return { splitPercent: Math.round(tot / 100 * 1e9), splits: splits };
}

// ---------------------------------------------------------------------------
// Deploy orchestration
// ---------------------------------------------------------------------------

// Known JB/REV revert selectors → friendly, actionable guidance pointing at the step the user can fix.
var DEPLOY_ERROR_GUIDE = [
  { sel: '0x584f1c49', name: 'jbcontroller_invalidcreationfee', msg: 'The project creation fee didn’t match what the contract expects. Refresh and try again — the fee may have just changed.' },
  { sel: '0x2e373fa3', name: 'jbprojects_invalidcreationfee', msg: 'The project creation fee didn’t match what the contract expects. Refresh and try again — the fee may have just changed.' },
  { sel: '0x50dcc307', name: 'jbprojects_zerocreationfeereceiver', msg: 'The protocol’s creation-fee receiver isn’t configured on this chain, so deploys aren’t available here right now. Try a different chain.' },
  { sel: '0xba2fe6f3', name: 'revdeployer_stagetimesmustincrease', msg: 'Each stage must start after the previous one. On the Stages step, give a later stage a larger “days after”.' },
  { sel: '0x8249b409', name: 'revdeployer_musthavesplits', msg: 'A stage has a split percentage but no recipients. On the Stages step, add a split recipient or remove the split.' },
  { sel: '0x8c4564bd', name: 'revdeployer_cashoutscantbeturnedoffcompletely', msg: 'A stage’s cash-out tax is 100%, which fully blocks cash outs (not allowed for a revnet). Lower the cash-out tax on the Stages step.' },
  { sel: '0x141d4794', name: 'revdeployer_stagesrequired', msg: 'A revnet needs at least one stage. Add a stage on the Stages step.' },
  { sel: '0x87971d24', name: 'jbrulesets_invalidweightcutpercent', msg: 'An issuance-cut percentage is out of range. Set it between 0 and 100% on the Rulesets/Stages step.' },
  { sel: '0xbad92c41', name: 'jb721tiershookstore_invalidquantity', msg: 'A store item’s quantity is too high (max 999,999,999). Lower it on the Shop step.' },
  { sel: '0x800e9368', name: 'jb721tiershookstore_missingreservebeneficiary', msg: 'A store item reserves inventory but has no beneficiary address. Add one on the Shop step (the item’s “Reserve inventory” row).' },
  { sel: '0xb99e376a', name: 'jb721tiershookstore_invalidcategorysortorder', msg: 'Store items are out of category order. On the Shop step, order items so their categories ascend.' },
];

// Turn a raw sim/contract/wallet error into a friendly, fixable message. Walks the cause chain so a custom
// error's 4-byte selector (or decoded name) is matched even when it's nested in viem's error data.
function friendlyDeployError(err) {
  var raw = (err && (err.shortMessage || err.message)) || 'The transaction reverted.';
  var parts = [], e = err;
  for (var i = 0; e && i < 8; i++) {
    parts.push(e.shortMessage || '', e.message || '', e.details || '');
    if (e.data) parts.push(typeof e.data === 'string' ? e.data : (e.data.data || ''));
    e = e.cause;
  }
  var blob = parts.join(' ').toLowerCase();
  if (/user rejected|user denied|rejected the request|request rejected|denied transaction/.test(blob)) return 'You rejected the transaction in your wallet.';
  if (/insufficient funds|exceeds the balance|gas required exceeds|insufficient balance/.test(blob)) return 'Not enough ETH to cover the creation fee plus gas. Top up the wallet and try again.';
  for (var k = 0; k < DEPLOY_ERROR_GUIDE.length; k++) {
    var g = DEPLOY_ERROR_GUIDE[k];
    if (blob.indexOf(g.sel) !== -1 || blob.indexOf(g.name) !== -1) return g.msg;
  }
  return raw;
}

// Friendly label + icon kind for a relayr per-chain execution state (raw states: Quoted, PaymentReceived,
// Mempool, Pending, Submitted, Success/Completed, Failed).
function relayrChainStatus(t) {
  var s = (t && t.status && t.status.state) || '';
  if (s === 'Success' || s === 'Completed') return { label: 'Deployed', kind: 'ok' };
  if (s === 'Failed') return { label: 'Failed', kind: 'err' };
  return { label: 'Deploying…', kind: 'pending' };
}

function deploy(state, render) {
  state.statusLines = [];
  state.done = false;
  state._render = render; // so async deploy progress (relayr poll) can re-render outside the push() log
  // A connected wallet is always required — it signs/sends (and pays once, for multichain via Relayr).
  var signer = getAccount && getAccount();
  if (!signer) {
    connect().then(function () { state.statusLines.push({ text: 'Wallet connected — click Launch again.' }); render(); })
      .catch(function (e) { state.statusLines.push({ text: 'Connect failed: ' + (e && e.message || e), err: true }); render(); });
    return;
  }
  // The project owner / revnet operator is an explicit, required launch argument (ENS-resolved).
  var ownerRaw = pickResolved(state.details.owner, { resolvedAddress: state.details.ownerResolved, resolvedFor: state.details.ownerResolvedFor });
  var owner = /^0x[0-9a-fA-F]{40}$/.test(ownerRaw) ? ownerRaw : signer;
  state.deploying = true; render();
  // Set the status pusher BEFORE runDeploy — with no Pinata JWT, runDeploy calls push() synchronously
  // (the "launching without metadata" line) before its first await, so the assignment must precede the call.
  state._push = function pushStatus(text, kind) { state.statusLines.push({ text: text, ok: kind === 'ok', err: kind === 'err' }); render(); };
  runDeploy(state, owner).then(function (res) {
    state.deploying = false;
    if (res === false) { render(); return; } // user cancelled at the raw-data review — not a success
    state.done = true;
    state.statusLines.push({ text: 'All done.', ok: true });
    render();
  }).catch(function (e) {
    state.deploying = false;
    state.statusLines.push({ text: friendlyDeployError(e), err: true });
    render();
  });
}

async function runDeploy(state, owner) {
  var push = state._push;
  // 1) Pin metadata (best-effort).
  var projectUri = '';
  if (hasPinata()) {
    push('Pinning project metadata…');
    try {
      projectUri = await pinJson(buildMetadata(state.details), state.details.name || 'project');
      push('Metadata pinned: ' + projectUri, 'ok');
    } catch (e) { push('Metadata pin failed (' + (e && e.message || e) + ') — launching without it.', 'err'); }
  } else {
    push('No Pinata JWT — launching without metadata; you can edit the project later.');
  }

  // Pin each store item's metadata JSON (name + media) so its tier resolves to {name, image/animation_url}.
  if (state.nfts.length && hasPinata()) {
    for (var n = 0; n < state.nfts.length; n++) {
      var it = state.nfts[n];
      push('Pinning item “' + (it.name || ('#' + (n + 1))) + '” metadata…');
      var meta = { name: it.name || ('Item #' + (n + 1)) };
      if (it.description) meta.description = it.description;
      if (it.imageUri) { if ((it.mediaType || '').indexOf('image') === 0) meta.image = it.imageUri; else meta.animation_url = it.imageUri; meta.mediaType = it.mediaType; }
      try {
        it.metaUri = await pinJson(meta, (it.name || 'item') + '-item');
        it.encodedIpfsUri = encodeIpfsUriToBytes32(it.metaUri);
      } catch (e) { push('Item metadata pin failed (' + (e && e.message || e) + ').', 'err'); }
    }
  }

  var salt = deploySalt(state, owner);
  var signer = getAccount();
  if (!signer) throw new Error('Connect a wallet to deploy.');
  // One shared start timestamp for ALL chains, ~10 min ahead. Computed ONCE here — and recomputed every
  // attempt because runDeploy re-runs on each Launch click (a rejected tx → a fresh, later start). Revnets
  // bake it into stage starts (matching the cross-chain config hash → deterministic sucker/project
  // addresses); custom multichain uses it for the first ruleset's mustStartAtOrAfter so every chain's
  // project begins at the SAME moment rather than at each chain's own block-confirmation time.
  var deployStart = Math.floor(Date.now() / 1000) + 600;

  // Build every chain's launch call, then simulate each (eth_call) so any encoding/logic revert surfaces
  // BEFORE the user signs or pays anything.
  var plans = [];
  for (var i = 0; i < state.chainIds.length; i++) {
    var cid = state.chainIds[i];
    var plan = state.projectType === 'revnet'
      ? buildRevnetArgs(state, cid, owner, projectUri, salt, deployStart)
      : buildLaunchArgs(state, cid, owner, projectUri, salt, deployStart);
    if (!plan.address) throw new Error('No deployer address on ' + chainName(cid));
    if (plan.missingSuckers) push('Note: some chain pairs have no sucker deployer on ' + chainName(cid) + '; those links will be skipped.', 'err');
    plan.chainId = cid;
    plan.value = await creationFeeOf(cid); // the deploy charges msg.value == JBProjects.creationFee()
    plans.push(plan);
  }
  // Review the EXACT raw data FIRST — before anything is simulated, signed, or sent. For multichain this
  // is the per-chain calldata that gets wrapped into ERC-2771 forward requests and posted to Relayr for a
  // quote; for single chain it's the wallet transaction. Simulation runs only AFTER the user confirms.
  var multichain = plans.length > 1;
  var reviewPayload = {
    action: (state.projectType === 'revnet' ? 'Deploy revnet' : 'Launch project') + ' on ' + plans.map(function (p) { return chainName(p.chainId); }).join(', '),
    transactions: plans.map(function (p) {
      var fn = p.functionName || 'launchProjectFor';
      return {
        chain: chainName(p.chainId),
        address: p.address,
        'function': fn,
        value: p.value.toString() + ' wei (' + formatEther(p.value) + ' ETH creation fee)',
        args: p.args,
        calldata: encodeFunctionData({ abi: p.abi, functionName: fn, args: p.args }),
      };
    }),
  };
  var reviewOk = await confirmTransactionModal(reviewPayload, {
    title: multichain ? 'Review the raw data sent to Relayr' : 'Review the transaction',
    confirmText: 'Confirm & simulate',
    note: multichain
      ? 'This is the exact per-chain calldata that will be wrapped into ERC-2771 forward requests and sent to Relayr for a quote. Nothing is signed or sent until you confirm — simulation runs next, then you pay once.'
      : 'This is the exact transaction. Nothing is sent until you confirm — it’s simulated next, then sent to your wallet to sign.',
  });
  if (!reviewOk) { push('Launch cancelled — nothing was simulated or sent.'); return false; }

  // Single chain → simulate locally (eth_call), then one direct wallet transaction (creation fee as
  // msg.value). Already reviewed above, so skip executeTransaction's own confirm (the wallet still shows
  // its native signing prompt).
  if (plans.length === 1) {
    var p0 = plans[0];
    push('Simulating the ' + (state.projectType === 'revnet' ? 'revnet deploy' : 'launch') + ' on ' + chainName(p0.chainId) + '…');
    try {
      await simulateTransaction({ chainId: p0.chainId, address: p0.address, abi: p0.abi, functionName: p0.functionName || 'launchProjectFor', args: p0.args, value: p0.value, account: signer });
      push('Simulation passed on ' + chainName(p0.chainId), 'ok');
    } catch (e) {
      throw new Error('Couldn’t simulate on ' + chainName(p0.chainId) + ' — ' + friendlyDeployError(e));
    }
    push('Confirm in your wallet for ' + chainName(p0.chainId) + ' (incl. ' + formatEther(p0.value) + ' ETH creation fee)…');
    var hash0 = await execTx({ chainId: p0.chainId, address: p0.address, abi: p0.abi, functionName: p0.functionName || 'launchProjectFor', args: p0.args, value: p0.value, skipConfirm: true, onStatus: function (m) { push(m); } });
    push('Reading the new project…');
    await captureDeployed(state, p0.chainId, hash0);
    return;
  }

  // Multichain → Relayr (two-step, like revnet-app). We DON'T eth_call-simulate locally — Relayr simulates
  // each chain server-side and only returns a quote if every leg would succeed. Sign one request per chain,
  // post the bundle for a quote, let the user CHOOSE which chain to pay gas on, then pay once.
  push('Sign one request per chain — gas is paid once at the end.');
  var txs = [];
  for (var k = 0; k < plans.length; k++) {
    var pk = plans[k];
    push('Estimating + signing for ' + chainName(pk.chainId) + '…');
    var gas = await estimateLaunchGas(pk, signer);
    var data = encodeFunctionData({ abi: pk.abi, functionName: pk.functionName || 'launchProjectFor', args: pk.args });
    txs.push(await buildForwardedTx(pk.chainId, signer, pk.address, data, gas, pk.value));
  }
  push('Sending to Relayr to simulate + quote…');
  var quote = await relayrPostBundle(txs);
  var options = (quote.payment_info || []).slice().sort(function (a, b) { return BigInt(a.amount) < BigInt(b.amount) ? -1 : 1; });
  if (!options.length) throw new Error('Relayr returned no payment options.');
  // Step 2: let the user pick a pay option from the quote (cheapest first), then pay it.
  var pay = await new Promise(function (resolve) {
    state.quoteChoice = {
      options: options.map(function (o) { return { opt: o, chain: chainName(o.chain), eth: (+formatEther(BigInt(o.amount))).toFixed(5) }; }),
      resolve: function (o) { state.quoteChoice = null; resolve(o); },
    };
    push('Relayr quoted ' + options.length + ' pay option' + (options.length > 1 ? 's' : '') + ' — choose where to pay gas once to fund all chains.');
  });
  if (!pay) { push('Cancelled — nothing was paid (the signed requests expire unused).'); return false; }
  var wallet = getWalletClient();
  var cur = await wallet.getChainId();
  if (cur !== pay.chain) { push('Switching wallet to ' + chainName(pay.chain) + '…'); await switchChain(pay.chain); }
  push('Pay once on ' + chainName(pay.chain) + ' (~' + formatEther(BigInt(pay.amount)) + ' ETH) to fund all chains — confirm in wallet…');
  var payHash = await relayrPay(pay);
  push('Payment sent | ' + truncAddr(payHash) + ' — relayers are deploying on each chain…');
  // Relayr's per-tx records don't carry a chain field, but they come back in submission order — map by
  // index to the chains we deployed, and render a friendly per-chain checklist (see renderDeploy).
  state.deployChains = plans.map(function (p) { return p.chainId; });
  await relayrPoll(quote.bundle_uuid, function (txList) {
    state.deployProgress = (txList || []).map(function (t, i) {
      return { chainId: state.deployChains[i], status: relayrChainStatus(t) };
    });
    if (state._render) state._render();
  });
  state.deployProgress = null;
  push('Reading the new project…');
  await captureDeployed(state, plans[0].chainId, null);
}

// Gas for the inner launch call (the forwarder forwards this much). Estimate the direct call + buffer;
// fall back generously if estimation throws. Includes the creation fee as value so the estimate runs
// (a 0-value estimate would hit the InvalidCreationFee revert).
function estimateLaunchGas(plan, account) {
  var pub = createPublicClientForChain(plan.chainId);
  return pub.estimateContractGas({ account: account, address: plan.address, abi: plan.abi, functionName: plan.functionName || 'launchProjectFor', args: plan.args, value: plan.value || 0n })
    .then(function (g) { return (g * 13n) / 10n + 300000n; })
    .catch(function () { return 8000000n; });
}

// JBProjects.creationFee() — the exact msg.value launchProjectFor requires (per chain).
function creationFeeOf(chainId) {
  var projects = getAddress('JBProjects', chainId);
  if (!projects) return Promise.resolve(0n);
  var pub = createPublicClientForChain(chainId);
  return pub.readContract({
    address: projects,
    abi: [{ type: 'function', name: 'creationFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'creationFee',
  }).catch(function () { return 0n; });
}

function execTx(opts) {
  return new Promise(function (resolve, reject) {
    executeTransaction(Object.assign({}, opts, {
      onSuccess: function (m, meta) { resolve((meta && meta.hash) || null); },
      onError: function (m) { reject(new Error(m)); },
    }));
  });
}

// After a successful deploy, capture the new project's id (JBProjects.count) + route + tx hash for the
// success panel's "Go to project" link. Best-effort — the panel still shows a generic success if it fails.
function captureDeployed(state, chainId, txHash) {
  return projectCountOf(chainId).then(function (pid) {
    state.deployed = { chainId: chainId, projectId: pid, txHash: txHash || null, route: projectRouteFor(chainId, pid) };
  }).catch(function () { state.deployed = { chainId: chainId, txHash: txHash || null }; });
}

// Chain-id → discover route slug (must match discover.js CHAIN_SLUGS exactly) for the "Go to project" link.
var CREATE_CHAIN_SLUGS = { 1: 'eth', 11155111: 'sep', 42161: 'arb', 421614: 'arbsep', 8453: 'base', 84532: 'basesep', 10: 'op', 11155420: 'opsep' };
function projectRouteFor(chainId, projectId) { var s = CREATE_CHAIN_SLUGS[chainId]; return (s && projectId) ? ('#' + s + ':' + projectId) : null; }
// JBProjects.count() = the id of the most recently created project (ids increment) — the one we just deployed.
function projectCountOf(chainId) {
  var projects = getAddress('JBProjects', chainId);
  if (!projects) return Promise.resolve(null);
  return createPublicClientForChain(chainId).readContract({
    address: projects, abi: [{ type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'count',
  }).then(function (n) { return Number(n); }).catch(function () { return null; });
}

// Deterministic salt — same on every chain (so omnichain sucker addresses match). No Math.random.
function deploySalt(state, owner) {
  return keccak256(stringToHex((state.details.name || 'project') + ':' + String(owner).toLowerCase()));
}

// Build the launchProjectFor call for one chain. Returns { contract, address, abi, args, missingSuckers }.
// Used BOTH for the on-chain send (runDeploy) and the JSON payload preview, so what the user reviews is
// byte-for-byte what they sign.
function buildLaunchArgs(state, chainId, owner, projectUri, salt, deployStart) {
  var multi = state.chainIds.length > 1;
  // Multichain "start immediately" → pin every chain's first ruleset to the one shared deploy-time start
  // (~10 min ahead) so they all begin at the same moment. Single chain starts at its own deploy block (0).
  var immediateStart = multi ? deployStart : 0;
  // Items can be included/excluded per chain — a chain with no included items uses the non-721 path.
  var hasNfts = state.shopEnabled && state.nfts.some(function (_, idx) { return chainItemIncluded(state, chainId, idx); });
  var terminalConfigs = buildTerminalConfigs(chainId, state.accepts, state.swapRouter);
  var effectiveStages = resolveStages(state);
  var deadlineOn = deadlineApplies(state);
  var stageRulesets = function (payHook) {
    return buildRulesetConfigs(
      effectiveStages.map(function (s, i) {
        // The appended standby/terminal stage (index ≥ user-stage count) inherits the last user stage's overrides.
        var userIdx = Math.min(i, state.stages.length - 1);
        return assembleRuleset(state, s, userIdx, chainId, i === 0, deadlineOn, immediateStart);
      }),
      payHook ? { payDataHookVariant: true } : undefined);
  };

  if (!multi && !hasNfts) {
    return {
      contract: 'JBController', address: getAddress('JBController', chainId), abi: launchProjectAbi,
      args: [owner, projectUri, stageRulesets(false), terminalConfigs, ''],
    };
  }
  if (!multi && hasNfts) {
    return {
      contract: 'JB721TiersHookProjectDeployer', address: getAddress('JB721TiersHookProjectDeployer', chainId), abi: deployer721Abi,
      args: [owner, build721Config(state, projectUri, chainId),
        { projectUri: projectUri, rulesetConfigurations: stageRulesets(true), terminalConfigurations: terminalConfigs, memo: '' },
        getAddress('JBController', chainId), salt],
    };
  }
  var others = state.chainIds.filter(function (x) { return x !== chainId; });
  var sucker = suckerConfigFor(chainId, others, salt, state.suckerType, state.accepts);
  var rulesetsFull = stageRulesets(false);
  var addr = getAddress('JBOmnichainDeployer', chainId);
  var missing = sucker.missing.length > 0;
  if (hasNfts) {
    var deploy721 = { deployTiersHookConfig: build721Config(state, projectUri, chainId), useDataHookForCashOut: false, salt: salt };
    return { contract: 'JBOmnichainDeployer', address: addr, abi: omnichain721Abi, missingSuckers: missing,
      args: [owner, projectUri, deploy721, rulesetsFull, terminalConfigs, '', sucker] };
  }
  return { contract: 'JBOmnichainDeployer', address: addr, abi: omnichainAbi, missingSuckers: missing,
    args: [owner, projectUri, rulesetsFull, terminalConfigs, '', sucker] };
}

// ---- Revnet (REVDeployer.deployFor) call assembly ----

// Build the REVDeployer.deployFor call for one chain. revnetId 0 = deploy a new revnet (msg.value ==
// creationFee). Stage start times are computed cumulatively from a single deployStart so every chain
// encodes the identical config (matching cross-chain addresses).
function buildRevnetArgs(state, chainId, owner, projectUri, salt, deployStart) {
  var opRaw = pickResolved(state.revOperator, { resolvedAddress: state.revOperatorResolved, resolvedFor: state.revOperatorResolvedFor });
  var operator = /^0x[0-9a-fA-F]{40}$/.test(opRaw) ? opRaw : owner;

  var stages = [];
  var prevStart = deployStart;
  state.stages.forEach(function (stage, i) {
    var start;
    if (i === 0) {
      start = (stage.scheduleOn && stage.schedule) ? Number(stage.schedule) : deployStart;
    } else {
      // The previous stage's autocut makes its ruleset CYCLE every `cutFreqDays` (REVDeployer sets
      // duration = issuanceCutFrequency). A queued next stage only takes effect on a cycle boundary, so
      // its start must be a positive multiple of the cut interval — snap it so the encoded start matches
      // what the controller will actually do.
      start = prevStart + revStageDaysAfter(state, i) * 86400;
    }
    prevStart = start;
    stages.push(buildRevStage(state, stage, i, chainId, start));
  });

  var configuration = {
    description: { name: state.details.name || '', ticker: state.details.ticker || '', uri: projectUri || '', salt: salt },
    baseCurrency: state.revBaseCurrency === 2 ? 2 : 1, // standard JBCurrencyIds (ETH=1 / USD=2); JBPrices bridges to the accounting context
    operator: operator,
    scopeCashOutsToLocalBalances: false,
    stageConfigurations: stages,
  };
  var accept = revnetAccept(state, chainId);
  var others = state.chainIds.filter(function (x) { return x !== chainId; });
  var sucker = others.length ? suckerConfigFor(chainId, others, salt, state.suckerType, state.accepts) : { deployerConfigurations: [], salt: salt, missing: [] };
  var suckerArg = { deployerConfigurations: sucker.deployerConfigurations, salt: sucker.salt };
  var addr = getAddress('REVDeployer', chainId);
  var missing = sucker.missing && sucker.missing.length > 0;

  // With store items, use the 6-arg overload (tiered ERC-721 hook). Otherwise the 4-arg builds an empty hook.
  var hasItems = state.shopEnabled && state.nfts.some(function (_, idx) { return chainItemIncluded(state, chainId, idx); });
  if (hasItems) {
    return {
      contract: 'REVDeployer', address: addr, abi: revDeploy721Abi, functionName: 'deployFor', missingSuckers: missing,
      args: [0n, configuration, accept, suckerArg, buildRevnet721Config(state, projectUri, chainId, salt), []],
    };
  }
  return {
    contract: 'REVDeployer', address: addr, abi: revDeployAbi, functionName: 'deployFor', missingSuckers: missing,
    args: [0n, configuration, accept, suckerArg],
  };
}

// REVDeploy721TiersHookConfig from the Shop step. Reuses build721Config (tiers priced in standard
// JBCurrencyIds — ETH=1 / USD=2, bridged to the accounting context by JBPrices), then strips
// issueTokensForSplits (revnets force it false).
function buildRevnet721Config(state, projectUri, chainId, salt) {
  var base = build721Config(state, projectUri, chainId);
  var baseline = {
    name: base.name, symbol: base.symbol, baseUri: base.baseUri, tokenUriResolver: base.tokenUriResolver,
    contractUri: base.contractUri, tiersConfig: base.tiersConfig,
    flags: {
      noNewTiersWithReserves: !!base.flags.noNewTiersWithReserves,
      noNewTiersWithVotes: !!base.flags.noNewTiersWithVotes,
      noNewTiersWithOwnerMinting: !!base.flags.noNewTiersWithOwnerMinting,
      preventOverspending: !!base.flags.preventOverspending,
    },
  };
  var col = state.collection || {};
  return {
    baseline721HookConfiguration: baseline, salt: salt,
    // The toggles grant ability (default on); the contract flags REVOKE, so prevent = !can.
    preventOperatorAdjustingTiers: col.opCanAdjustTiers === false,
    preventOperatorUpdatingMetadata: col.opCanUpdateMetadata === false,
    preventOperatorMinting: col.opCanMint === false,
    preventOperatorIncreasingDiscountPercent: col.opCanIncreaseDiscount === false,
  };
}

// The accounting token the project HOLDS — its address + token-keyed currency (uint32(uint160(token))).
// Payout splits (group id), fund-access-limit token, and unlimited-limit currency must all use THIS token,
// not native, or a USDC project's payouts are denominated in the wrong token.
function acctTokenFor(state, chainId) {
  if ((state.accepts[0] || 'eth') === 'usdc') {
    var usdc = USDC_BY_CHAIN[chainId];
    if (usdc) return { token: usdc, decimals: 6, currency: Number(BigInt(usdc) % (1n << 32n)) };
  }
  return { token: NATIVE_TOKEN, decimals: 18, currency: NATIVE_CURRENCY };
}

// The revnet's accounting context — ETH (native) or USDC, per the Settlement accounting choice.
// JBAccountingContext.currency = uint32(uint160(token)).
function revnetAccept(state, chainId) {
  return [acctTokenFor(state, chainId)];
}

// One REVStageConfig from a revnet stage object.
function buildRevStage(state, stage, idx, chainId, start) {
  var totalPct = revSplitTotalPct(stage); // 0..100 across split rows
  var splitPercent = Math.round(Math.min(100, totalPct) * 100); // → out of MAX_RESERVED_PERCENT (10000)
  var splits = [];
  if (totalPct > 0) {
    var rows = (stage.reservedRecipients || [])
      .map(function (x, origIdx) { return { x: x, origIdx: origIdx }; })
      .filter(function (e) { return (Number(e.x.percent) || 0) > 0; });
    // Each split's share of the reserved bucket is its row% ÷ total%. fillSplits keeps the group summing to
    // exactly SPLITS_TOTAL (1e9) so rounding drift can't exceed it and revert.
    var shares = fillSplits(rows.map(function (e) { return Math.round((Number(e.x.percent) || 0) / totalPct * SPLITS_TOTAL); }));
    splits = rows.map(function (e, k) {
      var benef = e.x.type === 'project' ? resolvedStr(e.x.address) : pickResolved(e.x.address, e.x);
      return splitState(e.x, shares[k], benef);
    });
  }
  // initialIssuance: tokens per base unit × 1e18 (18-dec fixed point). 0 on later stages = inherit (with cut).
  // parseEther (not Number×1e18) keeps precision on large/decimal weights and never throws on Infinity.
  var issuance = (idx === 0 || stage.weight) ? tokenAmount18(stage.weight, UINT112_MAX) : 0n;
  var cutFreq = stage.issuanceCutOn ? Math.max(0, Math.round((Number(stage.cutFreqDays) || 0) * 86400)) : 0;
  var cutPercent = stage.issuanceCutOn
    ? Math.round(Math.max(0, Math.min(100, Number(stage.weightCutPercent) || 0)) / 100 * JBCONSTANTS.MAX_WEIGHT_CUT_PERCENT)
    : 0;
  var taxRate = Math.round(Math.max(0, Math.min(100, Number(stage.cashOutTaxRate) || 0)) * 100); // percent → out of 10000
  var autos = (stage.autoIssuances || [])
    .map(function (a) { return { count: tokenAmount18(a.count, UINT104_MAX), addr: pickResolved(a.address, a) }; })
    .filter(function (a) { return a.count > 0n && /^0x[0-9a-fA-F]{40}$/.test(a.addr); })
    .map(function (a) { return { chainId: chainId, count: a.count, beneficiary: a.addr }; });
  return {
    startsAtOrAfter: start,
    autoIssuances: autos,
    splitPercent: splitPercent,
    splits: splits,
    initialIssuance: issuance,
    issuanceCutFrequency: cutFreq,
    issuanceCutPercent: cutPercent,
    cashOutTaxRate: taxRate,
    extraMetadata: 0,
  };
}

// Assemble a single ruleset state object (createDefaultRuleset shape) from the wizard steps.
// Build one JBRulesetConfig from a stage. isFirst => stage 1 (honors scheduled launch); later stages
// queue with mustStartAtOrAfter 0 so the controller chains them after the previous stage's duration.
// Encode a queue's rulesets for one chain — the same stage→JBRulesetConfig[] mapping the launcher uses
// (resolveStages applies the "Afterwards" choice; assembleRuleset encodes each), minus the NFT/terminal
// scaffolding. `immediateStart` aligns the first ruleset across chains for an omnichain queue (0 = next
// cycle on a single chain). Returns the JBRulesetConfig[] for JBController/JBOmnichainDeployer.queueRulesetsOf.
export function buildQueueRulesetConfigs(state, chainId, immediateStart) {
  var effectiveStages = resolveStages(state);
  var deadlineOn = deadlineApplies(state);
  return buildRulesetConfigs(effectiveStages.map(function (s, i) {
    var userIdx = Math.min(i, state.stages.length - 1);
    return assembleRuleset(state, s, userIdx, chainId, i === 0, deadlineOn, immediateStart || 0);
  }));
}

function assembleRuleset(state, stage, userStageIdx, chainId, isFirst, deadlineOn, immediateStart) {
  // Per-chain overrides (amount + beneficiary), keyed by user-stage + recipient index; fall back to defaults.
  var amtAt = function (x, idx) { return chainPayoutAmount(state, chainId, userStageIdx, idx); };
  // For project recipients, the token beneficiary is held in x.address and resolved via the global ENS cache.
  var payoutBenef = function (x, idx) { return x.type === 'project' ? resolvedStr(x.address) : chainAddr(state, chainId, 'p:' + userStageIdx + ':' + idx, pickResolved(x.address, x)); };
  var reservedBenef = function (x, idx) { return x.type === 'project' ? resolvedStr(x.address) : chainAddr(state, chainId, 'r:' + userStageIdx + ':' + idx, pickResolved(x.address, x)); };
  var rs = createDefaultRuleset();
  rs.baseCurrency = stage.baseCurrency || 1;
  // First ruleset start: scheduled time if set; else 0 ("start at the deploy block") for single chain. For
  // MULTICHAIN "immediately", use the shared `immediateStart` (one deploy-time timestamp, identical on every
  // chain) so each chain's first ruleset starts at the SAME moment instead of its own block-confirmation time.
  rs.mustStartAtOrAfter = isFirst ? (stage.schedule ? Number(stage.schedule) : (immediateStart || 0)) : 0;
  rs.durationPreset = -1; rs.durationCustom = String(stage.durationSeconds || 0); // exact seconds via custom path

  var custom = stage.tokenMode === 'custom';
  // Reserved rate = sum of the split-row percentages (each is a % of issuance reserved for that recipient).
  var reservedTotalPct = (stage.reservedRecipients || []).reduce(function (s, x) { return s + (Number(x.percent) || 0); }, 0);
  rs.weight = custom ? (stage.weight || '0') : '0';
  rs.reservedPercent = custom ? Math.max(0, Math.min(100, reservedTotalPct)) : 0;
  rs.weightCutPercent = custom ? Math.max(0, Math.min(100, Number(stage.weightCutPercent) || 0)) : 0;
  // Cash outs / owner minting / pausing apply to the project's tokens regardless of whether THIS stage
  // issues new tokens (tokens can exist from prior stages or owner mints). Clamp 0–100 so a stray value
  // can't overflow MAX_CASH_OUT_TAX_RATE and revert at deploy.
  rs.cashOutTaxRate = (stage.cashOutEnabled && stage.payoutMode !== 'unlimited')
    ? Math.max(0, Math.min(100, Number(stage.cashOutTaxRate) || 0)) : 100; // 100% = cash outs off (no surplus under unlimited payouts)
  rs.allowOwnerMinting = !!stage.allowOwnerMinting;
  rs.pauseCreditTransfers = !!stage.pauseTransfers;

  var dl = DEADLINE_OPTIONS.find(function (d) { return d.key === stage.deadline; });
  rs.approvalHook = (deadlineOn !== false && dl && dl.contract && getAddress(dl.contract, chainId)) || ZERO;

  rs.pausePay = stage.pausePay; rs.holdFees = stage.holdFees;
  rs.allowSetTerminals = stage.allowSetTerminals; rs.allowSetController = stage.allowSetController;
  rs.allowTerminalMigration = stage.allowTerminalMigration;
  rs.allowSetCustomToken = !!stage.allowSetCustomToken;
  rs.allowAddAccountingContext = !!stage.allowAddAccountingContext;
  rs.allowAddPriceFeed = !!stage.allowAddPriceFeed;

  // Splits
  rs.splitGroups = [];
  if (stage.payoutMode !== 'none' && stage.payoutRecipients.length) {
    var payoutSplits;
    if (stage.payoutMode === 'unlimited') {
      // % of payouts each recipient gets; any unallocated remainder goes to the project owner. Clamp the
      // running total to SPLITS_TOTAL so over-100% (or rounding drift) can't revert the group.
      var pacc = 0;
      payoutSplits = stage.payoutRecipients.map(function (x, idx) {
        var raw = Math.round((Number(x.percent) || 0) / 100 * SPLITS_TOTAL);
        if (pacc + raw > SPLITS_TOTAL) raw = Math.max(0, SPLITS_TOTAL - pacc);
        pacc += raw;
        return splitState(x, raw, payoutBenef(x, idx));
      });
    } else {
      // Limited: the payout limit is the sum of the amounts; each recipient's split is its share of that sum.
      var total = stage.payoutRecipients.reduce(function (s, x, idx) { return s + (Number(amtAt(x, idx)) || 0); }, 0) || 1;
      var lshares = fillSplits(stage.payoutRecipients.map(function (x, idx) { return Math.round(((Number(amtAt(x, idx)) || 0) / total) * SPLITS_TOTAL); }));
      payoutSplits = stage.payoutRecipients.map(function (x, idx) { return splitState(x, lshares[idx], payoutBenef(x, idx)); });
    }
    // Payout split group is keyed by the accounting token (uint256(uint160(token))) — USDC, not native.
    rs.splitGroups.push({ groupId: uint256FromAddress(acctTokenFor(state, chainId).token), splits: payoutSplits });
  }
  if (custom && reservedTotalPct > 0) {
    // Each recipient's share of the reserved group = its row % ÷ the total reserved %. fillSplits keeps the
    // group summing to exactly SPLITS_TOTAL so rounding drift can't exceed it and revert.
    var rrows = stage.reservedRecipients.map(function (x, origIdx) { return { x: x, origIdx: origIdx }; })
      .filter(function (e) { return (Number(e.x.percent) || 0) > 0; });
    var rshares = fillSplits(rrows.map(function (e) { return Math.round((Number(e.x.percent) || 0) / reservedTotalPct * SPLITS_TOTAL); }));
    rs.splitGroups.push({
      groupId: '1',
      splits: rrows.map(function (e, k) { return splitState(e.x, rshares[k], reservedBenef(e.x, e.origIdx), chainId); }),
    });
  }

  // Fund access (payout limits + surplus allowance) — on the ACCOUNTING token's terminal (USDC, not native).
  // An "unlimited" (uint224 max) limit must be denominated in the accounting token's own currency so the
  // terminal doesn't try to JBPrices-convert MAX from ETH/USD (which would overflow); a finite/limited
  // amount keeps the user's chosen ETH/USD denomination (JBPrices converts it to the token at payout).
  var acct = acctTokenFor(state, chainId);
  rs.fundAccessLimitGroups = [];
  var payoutLimits = [];
  if (stage.payoutMode !== 'none') {
    if (stage.payoutMode === 'unlimited') payoutLimits.push({ amount: UINT224_MAX, currency: acct.currency });
    else payoutLimits.push({ amount: stage.payoutRecipients.reduce(function (s, x, idx) { return s + safeParseEther(amtAt(x, idx)); }, 0n), currency: stage.payoutCurrency || 1 });
  }
  var surplusAllowances = [];
  if (stage.surplusAllowanceOn && stage.payoutMode !== 'unlimited') {
    if (stage.surplusAllowanceUnlimited) surplusAllowances.push({ amount: UINT224_MAX, currency: acct.currency });
    else { var saAmt = safeParseEther(stage.surplusAllowanceAmount); if (saAmt > 0n) surplusAllowances.push({ amount: saAmt, currency: stage.surplusAllowanceCurrency || 1 }); }
  }
  if (payoutLimits.length || surplusAllowances.length) {
    rs.fundAccessLimitGroups.push({
      terminal: getAddress('JBMultiTerminal', chainId), token: acct.token,
      payoutLimits: payoutLimits, surplusAllowances: surplusAllowances,
    });
  }
  return rs;
}

// Adjust a list of integer split shares so they sum to EXACTLY SPLITS_TOTAL (1e9). Per-row rounding can
// drift a few atoms above/below; JBSplits reverts if a group EXCEEDS SPLITS_TOTAL. We correct the drift on
// the largest share (always non-zero, can't go negative for tiny deltas). Use for groups meant to
// distribute 100% (reserved tokens, limited payouts). Returns the same array, mutated.
function fillSplits(rawShares) {
  if (!rawShares.length) return rawShares;
  var sum = rawShares.reduce(function (s, v) { return s + v; }, 0);
  var delta = SPLITS_TOTAL - sum;
  if (delta !== 0) {
    var maxI = 0;
    for (var i = 1; i < rawShares.length; i++) if (rawShares[i] > rawShares[maxI]) maxI = i;
    rawShares[maxI] = Math.max(0, rawShares[maxI] + delta);
  }
  return rawShares;
}

function splitState(rec, rawPercent, beneficiaryOverride, chainId) {
  // "Buyback liquidity" reserved split → routes to the shared BannyLPSplitHook (same address on every
  // chain). The hook keys off the distributing project, so projectId/beneficiary are pass-through.
  if (rec.type === 'lphook' && chainId != null) {
    var hookAddr = getAddress('BannyLPSplitHook', chainId);
    if (hookAddr) {
      var b = getAccount && getAccount();
      return { preferAddToBalance: false, percent: rawPercent, projectId: 0,
        beneficiary: (b && /^0x[0-9a-fA-F]{40}$/.test(b)) ? b : ZERO, lockedUntil: 0, hook: hookAddr };
    }
  }
  var addr = (beneficiaryOverride != null) ? beneficiaryOverride : pickResolved(rec.address, rec); // resolve ENS → 0x
  return {
    preferAddToBalance: false,
    percent: rawPercent,
    projectId: rec.type === 'project' ? (Number(rec.projectId) || 0) : 0,
    beneficiary: (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) ? addr : ZERO,
    lockedUntil: rec.lockedUntil ? Number(rec.lockedUntil) : 0,
    hook: ZERO,
  };
}

function build721Config(state, projectUri, chainId) {
  var name = collectionNameOf(state);
  var symbol = collectionSymbolOf(state);
  var col = state.collection || {};
  var priceDecimals = storeDecimals(state);
  var tiers = state.nfts
    .map(function (nft, idx) { return { nft: nft, idx: idx }; })
    .filter(function (e) { return chainId == null || chainItemIncluded(state, chainId, e.idx); })
    .map(function (e) {
    var nft = e.nft;
    // Per-chain quantity override ('' = unlimited).
    var chainSupply = chainId == null ? (nft.limited ? nft.supply : '') : chainItemSupply(state, chainId, e.idx);
    var limited = chainSupply !== '' && chainSupply != null;
    var flags = nft.flags || {};
    var freq = nft.reserveOn ? (Number(nft.reserveFrequency) || 0) : 0;
    var rb = freq > 0 ? chainAddr(state, chainId, 'rb:' + e.idx, resolvedStr(nft.reserveBeneficiary)) : '';
    var reserveBenef = (rb && /^0x[0-9a-fA-F]{40}$/.test(rb)) ? rb : ZERO;
    var votes = nft.votingOn ? (Number(nft.votingUnits) || 0) : 0;
    var discountPercent = nft.discountOn ? Math.min(200, Math.round((parseFloat(nft.discountPct) || 0) / 100 * 200)) : 0;
    var sp = itemSplits(nft, state, chainId, e.idx);
    return {
      price: priceUnits(nft.priceEth, priceDecimals),
      // Clamp to [0, 999999999] — the store caps initialSupply at _ONE_BILLION-1; a larger value reverts (uint32 overflow / InvalidQuantity).
      initialSupply: limited ? Math.max(0, Math.min(999999999, Math.floor(Number(chainSupply) || 0))) : 999999999,
      votingUnits: votes,
      reserveFrequency: freq,
      reserveBeneficiary: reserveBenef,
      encodedIpfsUri: nft.encodedIpfsUri || (nft.metaUri ? encodeIpfsUriToBytes32(nft.metaUri) : '0x' + '0'.repeat(64)),
      category: Number(nft.category) || 0,
      discountPercent: discountPercent,
      flags: {
        allowOwnerMint: !!flags.allowOwnerMint,
        useReserveBeneficiaryAsDefault: freq > 0 && reserveBenef !== ZERO,
        transfersPausable: !!flags.transfersPausable,
        useVotingUnits: votes > 0,
        cantBeRemoved: !!flags.cantBeRemoved,
        cantIncreaseDiscountPercent: !(flags.ownerCanEditDiscount !== false),
        cantBuyWithCredits: !(flags.allowCredits !== false),
      },
      splitPercent: sp.splitPercent,
      splits: sp.splits,
    };
  });
  return {
    name: name, symbol: symbol, baseUri: 'ipfs://', tokenUriResolver: ZERO, contractUri: projectUri || '',
    tiersConfig: { tiers: tiers, currency: storeCur(state), decimals: priceDecimals },
    flags: {
      noNewTiersWithReserves: !!col.noNewTiersWithReserves, noNewTiersWithVotes: !!col.noNewTiersWithVotes,
      noNewTiersWithOwnerMinting: !!col.noNewTiersWithOwnerMinting, preventOverspending: !!col.preventOverspending,
      issueTokensForSplits: !!col.issueTokensForSplits,
    },
  };
}

// Terminal configs: the project's accounting terminal (which token[s] it HOLDS, currency =
// uint32(uint160(token))) plus, optionally, the router terminal (empty contexts — it swaps any incoming
// token into the accounting token[s], like REVDeployer does).
function buildTerminalConfigs(chainId, accepts, swapRouter) {
  var terminal = getAddress('JBMultiTerminal', chainId);
  if (!terminal) return [];
  var contexts = [];
  if (accepts.indexOf('eth') !== -1) {
    contexts.push({ token: NATIVE_TOKEN, decimals: 18, currency: Number(uint32FromAddress(NATIVE_TOKEN)) });
  }
  if (accepts.indexOf('usdc') !== -1 && USDC_BY_CHAIN[chainId]) {
    var usdc = USDC_BY_CHAIN[chainId];
    contexts.push({ token: usdc, decimals: 6, currency: Number(uint32FromAddress(usdc)) });
  }
  if (!contexts.length) contexts.push({ token: NATIVE_TOKEN, decimals: 18, currency: Number(uint32FromAddress(NATIVE_TOKEN)) });
  var configs = [{ terminal: terminal, accountingContextsToAccept: contexts }];
  if (swapRouter) {
    var router = getAddress('JBRouterTerminalRegistry', chainId);
    if (router) configs.push({ terminal: router, accountingContextsToAccept: [] });
  }
  return configs;
}

function buildMetadata(d) {
  var m = { version: 1, name: d.name || '', projectTagline: d.tagline || '', description: d.description || '' };
  // Custom projects don't deploy an ERC-20 at launch (tokens are credits), so the symbol can't live
  // on-chain yet — stash it in the project URI metadata so the UI can show "$SYMBOL" until/unless an
  // ERC-20 is deployed later. Revnets pass the ticker to REVDeployer instead (real ERC-20), but it's
  // harmless to also record it here.
  if (d.ticker) m.symbol = d.ticker;
  if (d.logoUri) m.logoUri = d.logoUri;
  if (d.coverImageUri) m.coverImageUri = d.coverImageUri;
  if (d.website) m.infoUri = d.website;
  if (d.twitter) m.twitter = d.twitter.replace(/^@/, '');
  if (d.discord) m.discord = d.discord;
  if (d.telegram) m.telegram = d.telegram;
  if (d.payDisclosure) m.payDisclosure = d.payDisclosure;
  if (d.tags && d.tags.length) m.tags = d.tags;
  return m;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function chainName(id) { var c = CHAIN_OPTIONS.find(function (x) { return x.id === id; }); return c ? c.name : ('chain ' + id); }
function shortAddr(a) { return a && a.length > 10 ? (a.slice(0, 6) + '…' + a.slice(-4)) : (a || '—'); }
function secondsLabel(s) {
  var p = DURATION_PRESETS.find(function (x) { return x.seconds === s; });
  if (p) return p.label;
  var U = [['year', 31536000], ['week', 604800], ['day', 86400], ['hour', 3600]];
  for (var i = 0; i < U.length; i++) { if (s % U[i][1] === 0) { var n = s / U[i][1]; return n + ' ' + U[i][0] + (n === 1 ? '' : 's'); } }
  return s + 's';
}
var DURATION_UNIT_SECONDS = { hours: 3600, days: 86400, weeks: 604800, years: 31536000 };
export var FOREVER_SECONDS = 4294967295; // uint32 max (~136 years) — the "Forever" option's max duration
function recomputeCustomDuration(stage) {
  var v = parseFloat(stage.customDurVal);
  stage.durationSeconds = (v > 0) ? Math.round(v * (DURATION_UNIT_SECONDS[stage.customDurUnit] || 86400)) : 0;
}
function uint256FromAddress(addr) { return BigInt(addr).toString(); }
function uint32FromAddress(addr) { return (BigInt(addr) & 0xFFFFFFFFn).toString(); }
// --- ENS resolution for address fields (resolves on mainnet, regardless of the deploy chain) ---
// The app's default mainnet RPC is CORS-blocked in the browser, so use a dedicated CORS-enabled endpoint.
var _ensCache = {};
var _ensClient = null;
function ensClient() {
  if (!_ensClient) _ensClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
  return _ensClient;
}
function isEnsName(v) { v = (v || '').trim(); return /\.[a-z]{2,}$/i.test(v) && !/^0x/i.test(v); }
function resolveEns(name) {
  name = (name || '').trim().toLowerCase();
  if (_ensCache[name] !== undefined) return Promise.resolve(_ensCache[name]);
  var norm; try { norm = ensNormalize(name); } catch (_) { return Promise.resolve(null); }
  return ensClient().getEnsAddress({ name: norm }).then(function (addr) { _ensCache[name] = addr || null; return addr || null; })
    .catch(function () { return null; });
}
// Reverse ENS: a 0x address → its primary ENS name (or null). Cached.
var _ensRevCache = {};
function reverseEns(address) {
  var a = (address || '').toLowerCase();
  if (_ensRevCache[a] !== undefined) return Promise.resolve(_ensRevCache[a]);
  return ensClient().getEnsName({ address: address }).then(function (name) { _ensRevCache[a] = name || null; return name || null; })
    .catch(function () { return null; });
}
// The usable 0x address for a recipient: the resolved ENS address if it still matches the typed name, else
// the raw value (a 0x address or unresolved name).
function pickResolved(name, rec) {
  name = (name || '').trim();
  return (rec && rec.resolvedAddress && rec.resolvedFor === name) ? rec.resolvedAddress : name;
}
// Synchronously resolve an address string to 0x: raw 0x passes through; an ENS name uses the global cache
// (populated when the field resolved in the UI); unresolved → '' so it encodes as ZERO rather than garbage.
function resolvedStr(str) {
  str = (str || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(str)) return str;
  if (isEnsName(str)) { var c = _ensCache[str.toLowerCase()]; return c || ''; }
  return str;
}
// Attach ENS resolution to an address input: returns a small hint element that shows the resolved address
// (or a "resolving…/not found" state) under the field, and stores the result on `rec` via store(name,addr).
function attachEns(input, store) {
  var hint = el('div', 'create-resolve-hint'); hint.style.display = 'none';
  var token = 0, timer = null;
  function go() {
    var v = (input.value || '').trim();
    if (!isEnsName(v)) {
      store(v, null);
      if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
        // Valid address → reverse-resolve and show its ENS name underneath (only if one exists).
        hint.style.display = ''; hint.className = 'create-resolve-hint'; hint.textContent = 'Looking up ENS…';
        var myR = ++token;
        reverseEns(v).then(function (name) {
          if (myR !== token) return;
          if (name) { hint.style.display = ''; hint.className = 'create-resolve-hint ok'; hint.textContent = name; }
          else hint.style.display = 'none';
        });
      } else if (/^0x/i.test(v)) {
        // Malformed 0x (valid = 40 hex chars). Half-typed ENS without a dot stays silent (no mid-typing nag).
        hint.style.display = ''; hint.className = 'create-resolve-hint warn';
        hint.textContent = 'Not a valid address — needs 0x followed by 40 hex characters.';
      } else { hint.style.display = 'none'; }
      return;
    }
    hint.style.display = ''; hint.className = 'create-resolve-hint'; hint.textContent = 'Resolving ' + v + '…';
    var my = ++token;
    resolveEns(v).then(function (addr) {
      if (my !== token) return;
      if (addr) { hint.textContent = addr; hint.className = 'create-resolve-hint ok'; store(v, addr); }
      else { hint.textContent = 'No address found for ' + v; hint.className = 'create-resolve-hint warn'; store(v, null); }
    });
  }
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(go, 350); });
  go();
  return hint;
}
// Column wrapper so an ENS resolve-hint sits directly under (left-aligned with) its recipient field.
function recipBoxWith(recip, hint) {
  recip.style.flex = '';
  var b = el('div', 'create-recip-box');
  b.appendChild(recip); b.appendChild(hint);
  return b;
}

function safeParseEther(v) { try { return v ? parseEther(String(v)) : 0n; } catch (_) { return 0n; } }
function priceUnits(v, decimals) { try { return v ? parseUnits(String(v), decimals) : 0n; } catch (_) { return 0n; } }
function ipfsHttp(uri) {
  if (!uri) return '';
  if (uri.indexOf('ipfs://') === 0) return 'https://ipfs.io/ipfs/' + uri.slice(7);
  return uri;
}
function tsToLocal(ts) {
  var d = new Date(Number(ts) * 1000); if (isNaN(d.getTime())) return '';
  var p = function (x) { return x < 10 ? '0' + x : '' + x; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// e.g. "America/New_York" — the browser's local zone, for the scheduled-launch helper text.
function localTimezoneLabel() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch (e) { return 'local time'; }
}
