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

import { keccak256, stringToHex, parseEther, parseUnits, encodeFunctionData, formatEther, createPublicClient, decodeEventLog, http } from 'viem';
import { mainnet } from 'viem/chains';
import { isSafeConnected } from './wallet.js';
import { ipfsHttpUrl } from './chain.js';
import { normalize as ensNormalize } from 'viem/ens';
import {
  el, executeTransaction, simulateTransaction, confirmTransactionModal, getAddress, getAccount, connect, NATIVE_TOKEN,
  createPublicClientForChain, getWalletClient, switchChain, truncAddr, ZERO_ADDRESS as ZERO, errMessage, isAddr, addrOrZero, promptFoot,
  resolveContractName, getChainTokens, txExplorerUrl,
} from './component-base.js';
import {
  launchProjectAbi, buildRulesetConfigs, createDefaultRuleset,
} from './launch-component.js';
import { pinFile, pinJson, hasPinata, setPinataJwt, encodeIpfsUriToBytes32 } from './ipfs-pin.js';
import { getAuditPrompt } from './prompts.js';
import { buildForwardedTx, relayrDestinationHash, relayrPostBundle, relayrPay, relayrPoll, relayrProgress, relayrStateIsSuccess, relayrStateIsFailed, saveRelayrPendingSession, loadRelayrPendingSession, clearRelayrPendingSession } from './relayr.js';
import { renderRelayrReceiptInto } from './relayr-ui.js';
import { DEADLINE_OPTIONS } from './deadline-options.js';
import { build721TierConfig, build721TierMetadata, mediaTypeForFile, sortTierEntriesByCategory, tierDiscountPercentFromPct } from './nft721-build.js';
import { build721RulesetMetadata } from './nft721-ruleset.js';
import { attachProjectIdResolver } from './project-id-resolver.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Keep this contract flag's builder-facing language identical across the
// create flow and project shop config (and aligned with the sibling clients).
export var SPLIT_SALES_TOKEN_CREDIT_TITLE = 'Full token credit on split sales';
export var SPLIT_SALES_TOKEN_CREDIT_ON = 'Buyers get project tokens for their entire payment, even the portion an item routes to splits.';
export var SPLIT_SALES_TOKEN_CREDIT_OFF = 'Tokens are only issued for what stays in the project.';

// Steps depend on the chosen project type (defaults to Custom). Type is always the first step.
// Revnet is a reduced flow (no Shop/Settlement — ETH-only, single canonical terminal, suckers on Deploy).
function stepsFor(state) {
  if (state.projectType === 'revnet') return ['Flavor', 'Basics', 'Stages', 'Shop', 'Deploy'];
  return ['Flavor', 'Basics', 'Rulesets', 'Shop', 'Deploy'];
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
// Flip the wizard between mainnets/testnets: remap every selected chain to its pair twin and force a
// re-verify of a custom accounting token (its existence is per-network).
function setWizardNetwork(state, mode) {
  mode = mode === 'testnet' ? 'testnet' : 'mainnet';
  if (state.network === mode) return;
  state.network = mode;
  state.chainIds = (state.chainIds || []).map(function (cid) {
    var pair = CHAIN_PAIRS.find(function (p) { return p.canon === cid || p.testnet === cid; });
    return pair ? (mode === 'mainnet' ? pair.canon : pair.testnet) : cid;
  });
  if (!state.chainIds.length) state.chainIds = CHAIN_PAIRS.map(function (p) { return mode === 'mainnet' ? p.canon : p.testnet; });
  if (state.customToken && isAddr((state.customToken.address || '').trim())) { state.customToken.status = 'idle'; state.customToken.chains = null; }
}
function canonChainId(id) { var p = CHAIN_PAIRS.find(function (x) { return x.canon === id || x.testnet === id; }); return p ? p.canon : id; }

var CHAIN_OPTIONS = [
  { id: 1, name: 'Ethereum', testnet: false }, { id: 10, name: 'Optimism', testnet: false },
  { id: 42161, name: 'Arbitrum', testnet: false }, { id: 8453, name: 'Base', testnet: false },
  { id: 11155111, name: 'Sepolia', testnet: true }, { id: 11155420, name: 'OP Sepolia', testnet: true },
  { id: 84532, name: 'Base Sepolia', testnet: true }, { id: 421614, name: 'Arb Sepolia', testnet: true },
];

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

// Field order MUST match the onchain JBSplit struct exactly (the selector hashes the tuple types in
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
  { name: 'scopeCashOutsToLocalBalances', type: 'bool' }, { name: 'useDataHookForPay', type: 'bool' },
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
// JBPayDataHookRulesetConfig is the reduced ruleset shape accepted by the single-chain 721 project deployer.
// Export the canonical tuple components so queue builders cannot accidentally substitute a full
// JBRulesetConfig[] (which has a different selector even though most fields look identical).
export var PAY_DATA_HOOK_RULESET_COMPONENTS = rulesetConfigComponents(METADATA_PAYHOOK);
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
export var DEPLOY_721_COMPONENTS = [
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
// `REVDeployer.deploySuckersFor` reads bit 2 of the CURRENT stage's app metadata and
// reverts without it (REVDeployer.sol:646-650). Stages are immutable, so a stage that
// ships without this bit can never be extended to another chain — launch-time suckers
// are exempt, which is why the gap only surfaces later.
var REV_METADATA_ALLOW_SUCKER_DEPLOYMENT = 1 << 2;

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
      { name: 'rulesetConfigurations', type: 'tuple[]', components: PAY_DATA_HOOK_RULESET_COMPONENTS },
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

// The token mapping for one (local→remote) sucker over one bridge, or null when that bridge can't
// safely carry the accounting token. Canonical USDC over an OP-stack/Arbitrum NATIVE bridge locks funds
// in bridge escrow (USDC is not a mintable-pair token; JBOptimismSucker passes the mapping straight into
// bridgeERC20To, and the Arbitrum gateway delivers USDC.e while leaves reference canonical USDC) — so
// only CCIP suckers may carry the USDC mapping. Native suckers bridge native ETH only.
function tokenMappingFor(localId, remoteId, accepts, bridge) {
  if ((accepts && accepts[0]) === 'usdc') {
    if (bridge !== 'ccip') return null;
    var local = USDC_BY_CHAIN[localId], remote = USDC_BY_CHAIN[remoteId];
    if (local && remote) return { localToken: local, minGas: 200000, remoteToken: addrToBytes32(remote) };
    return null;
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
      var mapping = tokenMappingFor(localId, remoteId, accepts, bridge);
      if (!mapping) return; // this bridge can't safely carry the accounting token (USDC over a native bridge)
      covered[remoteId] = true;
      deployerConfigurations.push({
        deployer: deployer,
        peer: '0x0000000000000000000000000000000000000000000000000000000000000000',
        mappings: [mapping],
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
  // Match the Discover network toggle, and default to deploying on ALL of that network's chains.
  var network = 'mainnet';
  try { if (localStorage.getItem('jb-network') === 'testnet') network = 'testnet'; } catch (_) {}
  var allChains = CHAIN_PAIRS.map(function (p) { return network === 'mainnet' ? p.canon : p.testnet; });
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
    accepts: ['eth'],                // accounting token(s) the project HOLDS / issues against: 'eth', 'usdc', or ['custom']
    customToken: { address: '', name: '', symbol: '', decimals: null, status: 'idle', error: '' }, // 'custom' accounting token (one ERC-20, same address on all chains; its own currency id, no price feed)
    swapRouter: true,                // include the router terminal (any token auto-converts) — on by default
    approvalAddress: '',             // custom ruleset-approval-hook address (when the approval condition is 'custom'); per-chain overrides live under key 'approval'
    stages: [createStage()],         // ordered rulesets queued at launch (revnet-style stages)
    afterMode: 'wait',               // what happens after a single timed ruleset: wait | terminal | cycle (custom adds a 2nd stage)
    shopEnabled: false, // off by default — the Shop step starts as a single opt-in checkbox
    storePricingCurrency: 1, // store-item price denomination (1=ETH / 2=USD) — JB721 tiersConfig.currency
    network: network, // mainnet | testnet — follows the Discover toggle; maps the selected canonical chains to actual ids
    suckerType: 'both', // bridge between chains: native (Ethereum↔L2 only) | ccip (any pair) | both — default Both (broadest coverage)
    nfts: [], // item drafts — see itemDraft() for shape
    perChain: {}, // multichain overrides: { [chainId]: { addr: { [key]: str } } } — keys: 'p:/r:/pk:' addresses, 'ppid:/rpid:/pkpid:' project ids, 'pamt:/pkamt:' payout amounts, 'isup:' item supplies
    storeCategories: [], // {id, name} named categories the user adds locally in the Shop step
    collection: { // top-level JB721 hook config (name/symbol auto-derive from the project until edited)
      name: '', symbol: '', nameTouched: false, symbolTouched: false, extrasOpen: false,
      preventOverspending: false, noNewTiersWithReserves: false, noNewTiersWithVotes: false,
      noNewTiersWithOwnerMinting: false, issueTokensForSplits: false, useForRedemptions: false,
      // revnet-only: extra 721 permissions the operator gets (default on — REVDeployer grants all four).
      opCanAdjustTiers: true, opCanUpdateMetadata: true, opCanMint: true, opCanIncreaseDiscount: true,
    },
    chainIds: allChains,
    tos: false,
    deploying: false, statusLines: [], done: false, quoteChoice: null,
  };
}

// Public constructor for integrations which need to produce a create-flow draft (for example the
// existing-project ".jb" export action). Callers fill verified values over these defaults, then pass the
// result through createDraftObject; imported values still cross the normal whitelist/normalization path.
export function newCreateDraftState() { return initState(); }

// ---------------------------------------------------------------------------
// Draft persistence + .jb import/export
// ---------------------------------------------------------------------------

var DRAFT_KEY = 'jb-create-draft';

// A JSON-safe snapshot of the form state: drop functions (`_close`), transient deploy flags, and the
// in-flight logo-upload flag so a refresh/import never restores a half-deploy or "uploading…" state.
function sanitizeState(state) {
  var c = {};
  // Skip transient UI flags (any `_`-prefixed key: _bridgeOpen, _pcOpen, _close, …) and functions — they
  // must not persist in the draft, so panels like the bridge selector always start collapsed on reopen.
  Object.keys(state).forEach(function (k) { if (k.charAt(0) === '_' || typeof state[k] === 'function') return; c[k] = state[k]; });
  // Deep clone + strip functions AND nested `_`-prefixed transients (item _mediaBusy/_catAdding etc.),
  // so the exported .jb carries only durable config.
  c = JSON.parse(JSON.stringify(c, function (key, val) { return key.charAt(0) === '_' ? undefined : val; }));
  c.deploying = false; c.statusLines = []; c.done = false; delete c.deployed; c.quoteChoice = null;
  if (c.details) c.details.logoUploading = false;
  return c;
}

function cloneDraftValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function mergeKnownDraftFields(defaults, input) {
  var out = Object.assign({}, defaults);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  Object.keys(defaults).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = cloneDraftValue(input[key]);
  });
  return out;
}

function normalizeImportedStage(value, chainIds) {
  var stage = mergeKnownDraftFields(createStage(), value);
  ['reservedRecipients', 'autoIssuances', 'payoutRecipients'].forEach(function (key) {
    if (!Array.isArray(stage[key])) stage[key] = [];
    else stage[key] = stage[key].slice(0, 100);
  });
  // An auto-issuance row's mint chain only survives import while it's still a selected chain (canonical
  // match, mirroring the per-chain override store); anything else becomes null, which encodes as the
  // first selected chain (aiMintChain).
  var canonSelected = (chainIds || []).map(canonChainId);
  stage.autoIssuances = stage.autoIssuances
    .filter(function (ai) { return ai && typeof ai === 'object' && !Array.isArray(ai); })
    .map(function (ai) {
      var cid = Number(ai.chainId);
      ai.chainId = canonSelected.indexOf(canonChainId(cid)) !== -1 ? cid : null;
      return ai;
    });
  if (!stage.payoutByKind || typeof stage.payoutByKind !== 'object' || Array.isArray(stage.payoutByKind)) stage.payoutByKind = {};
  else Object.keys(stage.payoutByKind).forEach(function (key) {
    var pk = stage.payoutByKind[key];
    if (!pk || typeof pk !== 'object' || Array.isArray(pk)) { delete stage.payoutByKind[key]; return; }
    pk.mode = ['none', 'unlimited', 'limited'].indexOf(pk.mode) !== -1 ? pk.mode : 'none';
    pk.recipients = Array.isArray(pk.recipients) ? pk.recipients.slice(0, 100) : [];
  });
  return stage;
}

function normalizeImportedItem(value) {
  var item = mergeKnownDraftFields(itemDraft(), value);
  item.flags = mergeKnownDraftFields(itemDraft().flags, value && value.flags);
  Object.keys(item).forEach(function (k) { if (k.charAt(0) === '_') delete item[k]; }); // exports strip transients; mirror on import
  item.splitRecipients = Array.isArray(item.splitRecipients) ? item.splitRecipients.slice(0, 100) : [];
  return item;
}

// Merge a loaded/imported draft over current defaults. Only known fields cross the boundary; arrays and chain
// selections are bounded/normalized before they can reach a transaction builder.
function mergeDraft(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  var defaults = initState();
  var s = mergeKnownDraftFields(defaults, obj);
  s.projectType = obj.projectType === 'revnet' ? 'revnet' : 'custom';
  s.network = obj.network === 'testnet' ? 'testnet' : 'mainnet';
  s.details = mergeKnownDraftFields(defaults.details, obj.details);
  s.details.tags = Array.isArray(s.details.tags) ? s.details.tags.slice(0, 50).map(String) : [];
  s.collection = mergeKnownDraftFields(defaults.collection, obj.collection);
  s.customToken = mergeKnownDraftFields(defaults.customToken, obj.customToken);
  if (s.customToken.status === 'loading') s.customToken.status = 'idle'; // never import a stuck in-flight lookup (re-verified on import)
  var allowedChains = CHAIN_PAIRS.map(function (pair) { return s.network === 'testnet' ? pair.testnet : pair.canon; });
  var seenChains = {};
  s.chainIds = (Array.isArray(obj.chainIds) ? obj.chainIds : []).map(Number).filter(function (chainId) {
    if (allowedChains.indexOf(chainId) === -1 || seenChains[chainId]) return false;
    seenChains[chainId] = true; return true;
  });
  if (!s.chainIds.length) s.chainIds = allowedChains;
  // Bounded like every other imported collection here: a corrupt or hostile .jb with thousands
  // of stages otherwise hangs the wizard's render and encode.
  s.stages = (Array.isArray(obj.stages) && obj.stages.length ? obj.stages : defaults.stages)
    .slice(0, 20)
    .map(function (st) { return normalizeImportedStage(st, s.chainIds); });
  s.nfts = (Array.isArray(obj.nfts) ? obj.nfts : []).slice(0, 100).map(normalizeImportedItem);
  s.storeCategories = (Array.isArray(obj.storeCategories) ? obj.storeCategories : []).slice(0, 255).map(function (entry) {
    return { id: Number(entry && entry.id), name: String(entry && entry.name || '').trim() };
  }).filter(function (entry) { return Number.isSafeInteger(entry.id) && entry.id > 0 && entry.name; });
  var seenAccepts = {};
  s.accepts = (Array.isArray(obj.accepts) ? obj.accepts : defaults.accepts).filter(function (token) {
    if (['eth', 'usdc', 'custom'].indexOf(token) === -1 || seenAccepts[token]) return false;
    seenAccepts[token] = true; return true;
  });
  if (!s.accepts.length || (s.accepts.indexOf('custom') !== -1 && s.accepts.length !== 1)) s.accepts = ['eth'];
  if (['native', 'ccip', 'both'].indexOf(s.suckerType) === -1) s.suckerType = 'both';
  if (['wait', 'terminal', 'cycle'].indexOf(s.afterMode) === -1) s.afterMode = 'wait';
  if (!s.perChain || typeof s.perChain !== 'object' || Array.isArray(s.perChain)) s.perChain = {};
  Object.keys(s).forEach(function (k) { if (k.charAt(0) === '_') delete s[k]; });
  // Re-derive the issuance denomination when the imported accounting selection contradicts the accepts
  // set, mirroring what applyAccountingDefaults enforces: e.g. accepts ['usdc'] with baseCurrency ETH(1)
  // deploys a config where every payment reverts PriceFeedNotFound (there is no USDC→ETH default feed).
  // ETH-only drafts keep a user-chosen USD base — ETH→USD has a default feed.
  var expectedCur = null;
  if (s.accepts[0] === 'custom') expectedCur = customCurrencyId(s) || null; // null until the token resolves — re-checked at deploy
  else if (s.accepts.indexOf('usdc') !== -1) expectedCur = 2;
  if (expectedCur != null) {
    var inconsistent = Number(s.storePricingCurrency) !== expectedCur || (s.projectType === 'revnet'
      ? Number(s.revBaseCurrency) !== expectedCur
      : (s.stages || []).some(function (st) {
          return Number(st.baseCurrency) !== expectedCur || Number(st.payoutCurrency) !== expectedCur
            || Number(st.surplusAllowanceCurrency) !== expectedCur;
        }));
    if (inconsistent) {
      applyAccountingDefaults(s);
      s._importNotice = 'Adjusted the issuance denomination to match the accepted asset — the imported draft priced issuance in a currency the accepted token can’t convert to.';
    }
  }
  s.deploying = false; s.statusLines = []; s.done = false; delete s.deployed; s.quoteChoice = null;
  if (s.details) s.details.logoUploading = false;
  s.step = Math.max(0, Math.min(Number(s.step) || 0, stepsFor(s).length - 1));
  return s;
}

// The existing .jb file is the canonical interchange format: a plain, sanitized create-flow state object.
// Keep this public so an existing project can be reconstructed from verified reads and exported identically.
export function createDraftObject(state) { return sanitizeState(state); }

function looksLikeCreateDraft(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value)
    && (value.projectType === 'custom' || value.projectType === 'revnet')
    && value.details && typeof value.details === 'object'
    && Array.isArray(value.stages) && Array.isArray(value.chainIds));
}

function unwrapCreateDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (looksLikeCreateDraft(value)) return value;
  return null;
}

// Accept the JSON contents of a .jb file, either directly or in a fenced JSON block. Returns a safe editable
// state through the same whitelist used by file import; transaction calldata or unrelated JSON is rejected.
export function parseCreateDraftJson(input) {
  var candidates = [];
  if (input && typeof input === 'object') candidates.push(input);
  else {
    var text = String(input || '').trim();
    if (!text) throw new Error('Paste .jb JSON first.');
    if (text.length > 2000000) throw new Error('The .jb JSON is too large.');
    try { candidates.push(JSON.parse(text)); } catch (_) {}
    var blocks = /```(?:json)?\s*([\s\S]*?)```/gi, match;
    while ((match = blocks.exec(text))) { try { candidates.push(JSON.parse(match[1])); } catch (_) {} }
  }
  for (var i = 0; i < candidates.length; i++) {
    var draft = unwrapCreateDraft(candidates[i]);
    if (!draft) continue;
    var merged = mergeDraft(draft);
    if (!merged) continue;
    merged.step = 0;
    merged.tos = false; // every new deployment must re-acknowledge the risk confirmation
    return merged;
  }
  throw new Error('No Juicebox V6 .jb draft was found. Paste the JSON contents of an exported .jb file.');
}

function saveDraft(state) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(sanitizeState(state))); } catch (_) {} }
function loadDraft() { try { var r = localStorage.getItem(DRAFT_KEY); return r ? mergeDraft(JSON.parse(r)) : null; } catch (_) { return null; } }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (_) {} }

// Download the current draft as a `.jb` file (plain JSON) to save or share for review.
export function exportDraftFile(state) {
  var nm = ((state.details && state.details.name) || 'project').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project';
  var blob = new Blob([JSON.stringify(createDraftObject(state), null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = nm + '.jb';
  // Safari can discard a synthetic download when its anchor is removed in the
  // same task as click(). Keep the node and object URL alive long enough for
  // the browser to begin the download. This matters on the success screen,
  // where Export is often the last action before closing the wizard.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

// ---------------------------------------------------------------------------
// Entry / overlay
// ---------------------------------------------------------------------------

export function openCreateFlow() {
  // Restore a saved draft if one exists (survives refresh); otherwise start fresh.
  var state = loadDraft() || initState();
  // The Discover toggle is the source of truth when the wizard opens. A draft saved in the other mode
  // silently pins its old chain ids behind identical-looking pills ("Base" reads the same in both modes),
  // so a testnet token kept failing lookup after the user toggled to Testnets and refreshed.
  try { setWizardNetwork(state, localStorage.getItem('jb-network') === 'testnet' ? 'testnet' : 'mainnet'); } catch (_) {}
  var pre = getAccount && getAccount();
  // Owner/operator are required and explicit — prefill the connected wallet only where still blank.
  if (pre) { if (!state.details.owner) state.details.owner = pre; if (!state.revOperator) state.revOperator = pre; }

  // The wizard is a native <dialog> for the same reason every modal is: it joins the browser's top
  // layer, so a confirm modal opened from inside it stacks above and takes Escape for itself — the
  // wizard's old document keydown handler tore the whole wizard down on that same keypress.
  var overlay = el('dialog', 'create-overlay');
  var sheet = el('div', 'create-sheet');
  overlay.appendChild(sheet);

  var closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (overlay.open) overlay.close();
    overlay.remove();
  }
  state._close = close; // so the success panel's "Go to project" can dismiss the overlay
  overlay.addEventListener('cancel', function (e) { e.preventDefault(); if (!state.deploying) close(); });
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !state.deploying) close(); });

  // Replace the live state object's contents in place (render/handlers close over `state`), then re-render.
  function installImported(merged) {
    Object.keys(state).forEach(function (k) { if (k !== '_close') delete state[k]; });
    Object.assign(state, merged);
    render();
    // Re-verify a custom accounting token against the imported chain set (its onchain state isn't in the file).
    if (customAccounting(state) && isAddr((state.customToken || {}).address)) lookupCustomToken(state, render);
    reresolveApproval(state, render); // re-resolve a custom approval-hook ENS name (cache isn't in the file)
  }
  function applyImportedText(text) {
    var merged = parseCreateDraftJson(text);
    installImported(merged);
  }
  function onImport(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try { applyImportedText(String(reader.result)); }
      catch (e) { alert((e && e.message) || 'Could not read that .jb file.'); }
    };
    reader.onerror = function () { alert('Could not read that file.'); };
    reader.readAsText(file);
  }
  function onExport() { exportDraftFile(state); }

  function render() {
    sheet.innerHTML = '';
    sheet.appendChild(renderHeader(state, close, onImport, onExport));
    sheet.appendChild(renderStepper(state, render));
    var body = el('div', 'create-step');
    // Import-time corrections (e.g. re-derived issuance denomination) stay visible for the session.
    if (state._importNotice) body.appendChild(pinkNote(state._importNotice));
    body.appendChild(renderStep(state, render));
    sheet.appendChild(body);
    sheet.appendChild(renderFooter(state, render, close));
    sheet.appendChild(promptFoot('Launch a project', 'launch')); // [copy build prompt] for the whole create flow
    // Persist the draft after every render so a refresh restores the work. Clear it once deployed.
    if (state.done) clearDraft(); else saveDraft(state);
  }
  render();
  reresolveApproval(state, render); // a restored draft's approval ENS isn't in the cache yet — re-resolve it
  // A network remap above reset the custom token to idle — re-verify it against the remapped chain set.
  if (customAccounting(state) && state.customToken.status === 'idle' && isAddr((state.customToken.address || '').trim())) lookupCustomToken(state, render);

  document.body.appendChild(overlay);
  overlay.showModal();
  return { close: close };
}

function renderHeader(state, close, onImport, onExport) {
  var head = el('div', 'create-head');
  var title = el('div', 'create-title');
  title.textContent = 'Create a project';
  head.appendChild(title);

  // .jb import/export — save the in-progress draft to a file, or load one (e.g. to share for review).
  var actions = el('div', 'create-head-actions');
  var imp = el('button', 'create-io-btn'); imp.type = 'button'; imp.textContent = 'Import';
  imp.title = 'Load a saved or shared project draft (.jb)';
  imp.disabled = !!state.deploying;
  var fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = '.jb,application/json'; fileIn.style.display = 'none';
  fileIn.addEventListener('change', function () { var f = fileIn.files && fileIn.files[0]; if (f && onImport) onImport(f); fileIn.value = ''; });
  imp.addEventListener('click', function () { if (!state.deploying) fileIn.click(); });
  var exp = el('button', 'create-io-btn'); exp.type = 'button'; exp.textContent = 'Export';
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
    case 'Basics': return renderDetails(state, render);
    case 'Rulesets': return renderStages(state, render);
    case 'Stages': return renderRevnetStages(state, render);
    case 'Shop': return renderNfts(state, render);
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
  [['custom', 'Custom project'], ['revnet', 'Revnet']].forEach(function (o) {
    var op = el('option'); op.value = o[0]; op.textContent = o[1]; if (state.projectType === o[0]) op.selected = true; sel.appendChild(op);
  });
  sel.addEventListener('change', function () {
    state.projectType = sel.value;
    // Revnets hold a single reserve asset — collapse a custom ETH+USDC selection to one.
    if (sel.value === 'revnet' && state.accepts.length > 1) state.accepts = [state.accepts[0] || 'eth'];
    state.step = Math.min(state.step, stepsFor(state).length - 1); // clamp if the new flow has fewer steps
    render();
  });
  // Keep the description inside the field block (tight under the select), like the other sections' subtexts.
  var flavorContent = el('div', '');
  flavorContent.appendChild(sel);
  var desc = el('div', 'create-hint'); // 8px subtext gap via the standardized base .create-hint
  desc.textContent = isRev
    ? 'Fixed rules that run forever, guaranteed. Tokens are always backed by revenues and funds raised, allowing for increasing price floors, loans, and predictability.'
    : 'Full control and customizability.';
  flavorContent.appendChild(desc);
  wrap.appendChild(fieldBlock('Flavor', false, flavorContent));

  // Settlement basics (chains + accounting token) are collected up front, so every downstream address and
  // currency field knows the chain set and accounting token(s). Chains first, then accounting.
  wrap.appendChild(chainBridgeBlock(state, render));
  wrap.appendChild(accountingBlock(state, render));

  // Owner (custom) or operator (revnet) is collected here.
  wrap.appendChild(isRev ? operatorSection(state, render) : ownerSection(state, render));
  return wrap;
}

// Accounting token(s) the project holds. Revnets pick exactly one (single reserve asset); custom projects
// can hold ETH and/or USDC at the same time. Also carries the router-terminal (any-token auto-swap) toggle.
// When the accounting token resolves to a single currency, point the ETH/USD dropdowns at it (USDC → USD).
// --- Custom accounting token (one ERC-20, same address on every chain; its own currency id = uint32(uint160),
// so every ruleset/shop currency equals it and no JBPrices feed is needed). ---
function customAccounting(state) { return ((state.accepts || [])[0] === 'custom'); }
function customCurrencyId(state) { var a = state.customToken && state.customToken.address; return isAddr(a) ? Number(BigInt(a) % (1n << 32n)) : 0; }
function customAcctSym(state) { return customAccounting(state) ? ((state.customToken && state.customToken.symbol) || 'TOKEN') : null; }
function customAcctDecimals(state) { var d = state.customToken && state.customToken.decimals; return (d != null && !isNaN(Number(d))) ? Number(d) : 18; }
function customReady(state) { return customAccounting(state) && isAddr(state.customToken && state.customToken.address) && state.customToken.status === 'ok'; }

// Every JBFundAccessLimits amount uses the associated accounting token context's decimals. `currency` changes
// the denomination and may trigger a price conversion, but it never changes the fixed-point scale. Thus both
// token-keyed and USD limits on a USDC context are 6-decimal values.
export function fundAccessAmountDecimals(currency, acct) {
  if (!acct || acct.decimals == null || acct.decimals === '') throw new Error('A verified accounting-token decimal value (0–36) is required.');
  var decimals = Number(acct && acct.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('A verified accounting-token decimal value (0–36) is required.');
  return decimals;
}

function fundAccessUnits(value, currency, acct) {
  return priceUnits(value, fundAccessAmountDecimals(currency, acct));
}

function fundAccessCurrencyLabel(currency, state) {
  var cur; try { cur = Number(currency || 1); } catch (_) { cur = 1; }
  if (cur === 1) return 'ETH';
  if (cur === 2) return 'USD';
  var chainId = (state && state.chainIds && state.chainIds[0]) || 1;
  var acct = state ? acctTokenFor(state, chainId) : null;
  if (acct && cur === Number(acct.currency || 0)) {
    if (state && customAcctSym(state)) return customAcctSym(state);
    if (acct.token && acct.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return 'ETH';
    if ((state.accepts || [])[0] === 'usdc') return 'USDC';
    return 'TOKEN';
  }
  return 'currency ' + cur;
}

// Point every ruleset/shop currency at the right base id. A custom ERC-20 → its own currency id. Otherwise,
// USD(2) whenever USDC is accepted (alone OR alongside ETH) so BOTH ETH and USDC resolve via the default
// ETH/USD + USDC/USD feeds — a base of ETH(1) has no USDC→ETH feed and every USDC payment would revert.
// Pure ETH stays ETH(1) (the user may still switch it to USD via the dropdown; ETH→USD has a feed).
function applyAccountingDefaults(state) {
  var accepts = state.accepts || [];
  if (!accepts.length) return;
  var cur;
  if (accepts[0] === 'custom') { cur = customCurrencyId(state); if (!cur) return; } // token not resolved yet
  else cur = accepts.indexOf('usdc') !== -1 ? 2 : 1;
  state.storePricingCurrency = cur;
  if (state.projectType === 'revnet') state.revBaseCurrency = cur;
  else (state.stages || []).forEach(function (s) {
    s.baseCurrency = cur; s.payoutCurrency = cur; s.surplusAllowanceCurrency = cur;
    // A custom token has no default price feed, so keep the owner's escape hatch open: pricing in ETH/USD
    // later requires adding a feed, which the ruleset must allow.
    if (accepts[0] === 'custom') s.allowAddPriceFeed = true;
  });
}
// True when the base currency is forced (USDC accepted → USD, or a custom token) and the user must not pick ETH.
function usdcAccounting(state) { return !customAccounting(state) && (state.accepts || []).indexOf('usdc') !== -1; }
function lockedCurrencySym(state) { return customAcctSym(state) || (usdcAccounting(state) ? 'USD' : null); }

// Verify the custom ERC-20 exists at the SAME address on EVERY selected chain, with matching symbol +
// decimals (a per-chain decimals/contract mismatch breaks the accounting math). status: loading → ok|error.
function lookupCustomToken(state, render) {
  var ct = state.customToken; var addr = (ct.address || '').trim();
  if (!isAddr(addr)) { ct.status = addr ? 'error' : 'idle'; ct.error = addr ? 'Not a valid address.' : ''; ct.name = ct.symbol = ''; ct.decimals = null; ct.chains = null; return; }
  var chainIds = (state.chainIds || []).slice(); if (!chainIds.length) return;
  ct.status = 'loading'; ct.error = ''; ct.chains = null;
  var ERC20 = [
    { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  ];
  var stale = function () { return (state.customToken.address || '').trim().toLowerCase() !== addr.toLowerCase(); };
  Promise.all(chainIds.map(function (cid) {
    var pub = createPublicClientForChain(cid);
    return Promise.all([
      pub.readContract({ address: addr, abi: ERC20, functionName: 'name' }).catch(function () { return null; }),
      pub.readContract({ address: addr, abi: ERC20, functionName: 'symbol' }),
      pub.readContract({ address: addr, abi: ERC20, functionName: 'decimals' }),
    ]).then(function (r) { return { cid: cid, ok: true, name: r[0], symbol: r[1], decimals: Number(r[2]) }; })
      // A transport failure must not read as "token doesn't exist" — classify it so the error can say retry.
      .catch(function (e) { return { cid: cid, ok: false, rpcFail: /HttpRequestError|timeout|fetch|network/i.test(String((e && e.name) || '') + ' ' + String((e && e.message) || '')) }; });
  })).then(function (results) {
    if (stale()) return;
    var first = results.filter(function (r) { return r.ok; })[0];
    if (!first) {
      ct.status = 'error';
      // Name the exact chains checked — "Base" selected in mainnet mode checks Base, not Base Sepolia,
      // and a token deployed only on a testnet fails here without this being obvious.
      ct.error = results.every(function (r) { return r.rpcFail; })
        ? 'Could not look up the token (RPC error). Try again.'
        : 'No ERC-20 found at this address on ' + chainIds.map(chainName).join(', ') + '.'
          + (state.network === 'mainnet' ? ' Looking for a testnet token? Switch Discover to Testnets first, then create the project.' : '');
      ct.symbol = ''; ct.decimals = null; ct.chains = null; render(); return;
    }
    ct.name = first.name || ''; ct.symbol = first.symbol || ''; ct.decimals = Number(first.decimals); ct.chains = results;
    if (!Number.isInteger(ct.decimals) || ct.decimals < 0 || ct.decimals > 36) {
      ct.status = 'error'; ct.error = 'This token reports ' + ct.decimals + ' decimals; Juicebox accounting contexts support 0–36.'; render(); return;
    }
    // Every selected chain must have the same token (same symbol + decimals) at this address.
    var bad = results.filter(function (r) { return !r.ok || r.symbol !== first.symbol || Number(r.decimals) !== Number(first.decimals); });
    if (bad.length) {
      ct.status = 'error';
      ct.error = 'Not the same token on ' + bad.map(function (r) { return chainName(r.cid) + (r.ok ? ' (' + r.symbol + ', ' + r.decimals + ' dec)' : ' — not found'); }).join('; ') + '. Deploy ' + ct.symbol + ' at this exact address on every selected chain, or deselect those chains.';
    } else { ct.status = 'ok'; ct.error = ''; }
    applyAccountingDefaults(state); render();
  }).catch(function () {
    if (stale()) return;
    ct.status = 'error'; ct.error = 'Could not look up the token (RPC error). Try again.'; render();
  });
}

function accountingBlock(state, render) {
  var isRev = state.projectType === 'revnet';
  var isCustom = customAccounting(state);
  return fieldBlock('Accounting', false, (function () {
    var w = el('div', '');
    var opts = [{ key: 'eth', label: 'ETH' }, { key: 'usdc', label: 'USDC' }, { key: 'custom', label: 'Custom token' }];
    // Both custom projects and revnets can hold ETH and/or USDC (multi-select); a custom ERC-20 is exclusive.
    var row = el('div', 'create-pills');
    opts.forEach(function (o) {
      var on = state.accepts.indexOf(o.key) !== -1;
      var p = el('button', 'create-pill' + (on ? ' selected' : ''));
      p.textContent = o.label;
      p.addEventListener('click', function () {
        if (o.key === 'custom') { if (!isCustom) { state.accepts = ['custom']; applyAccountingDefaults(state); render(); } return; }
        // ETH/USDC are multi-select among themselves but mutually exclusive with a custom token.
        var a = isCustom ? [] : state.accepts.slice();
        if (a.indexOf(o.key) !== -1) { a = a.filter(function (x) { return x !== o.key; }); if (!a.length) a = [o.key === 'eth' ? 'usdc' : 'eth']; }
        else a.push(o.key);
        state.accepts = ['eth', 'usdc'].filter(function (k) { return a.indexOf(k) !== -1; }); // canonical order
        applyAccountingDefaults(state);
        render();
      });
      row.appendChild(p);
    });
    w.appendChild(row);
    if (isCustom) { w.appendChild(customTokenBlock(state, render)); return w; }
    var note = el('div', 'create-hint');
    note.textContent = isRev
      ? ('The reserve asset(s) that back the value of $' + tickerLabel(state) + '.')
      : 'The token(s) that make up your project’s balance.';
    w.appendChild(note);
    // Multi-asset revnet: the backing is fixed by the proportion of payments received and can't be rebalanced.
    if (isRev && state.accepts.length > 1) {
      var revWarn = pinkNote('Your revnet’s token will be backed by both ETH and USDC paid in by users. Holders can cash out for either, and the backing mix is set entirely by the proportion of payments received in each — you can’t rebalance between them later.');
      revWarn.style.marginTop = '10px'; // gap between the accounting note and the warning box
      w.appendChild(revWarn);
    }
    // Router-terminal (any-token auto-swap) note stays grouped right under the main note (custom only).
    if (!isRev) {
      var line2 = el('div', 'create-hint');
      line2.appendChild(document.createTextNode(state.swapRouter
        ? 'Other payment tokens auto-swap to your chosen accounting token(s) as they’re paid in. '
        : 'Payers can only pay in your accounting token(s). '));
      var toggle = el('button', 'create-inline-toggle');
      toggle.textContent = state.swapRouter ? 'Make payers pay in your accounting token' : 'Allow payers to pay in any token';
      toggle.addEventListener('click', function (e) { e.preventDefault(); state.swapRouter = !state.swapRouter; render(); });
      line2.appendChild(toggle);
      w.appendChild(line2);
    }
    var immut = el('div', 'create-hint');
    immut.textContent = isRev ? 'Accounting contexts cannot be added or removed later.' : 'Accounting tokens cannot be removed later.';
    w.appendChild(immut);
    return w;
  })());
}

// Custom accounting token: address input + onchain ERC-20 lookup (name/symbol/decimals), shown below the
// pills. Updates a status line in place (no full re-render) so the address field keeps focus while typing.
function customTokenBlock(state, render) {
  var ct = state.customToken;
  var wrap = el('div', ''); wrap.style.marginTop = '10px';
  var input = el('input', 'field create-input'); input.type = 'text'; input.placeholder = '0x… (ERC-20 token address)'; input.value = ct.address || '';
  var status = el('div', 'create-hint');
  function renderStatus() {
    status.className = 'create-hint';
    if (ct.status === 'loading') { status.textContent = 'Looking up token…'; status.style.color = ''; }
    else if (ct.status === 'ok') {
      var n = (state.chainIds || []).length;
      status.textContent = (ct.name ? ct.name + ' — ' : '') + ct.symbol + ' | ' + ct.decimals + ' decimals' + (n > 1 ? ' | verified on all ' + n + ' chains' : '');
      status.style.color = 'var(--c-teal)';
    }
    else if (ct.status === 'error') { status.textContent = ct.error; status.className = 'create-hint warn'; status.style.color = ''; }
    else { status.textContent = ''; status.style.color = ''; }
  }
  var deb;
  input.addEventListener('input', function () {
    ct.address = input.value.trim(); ct.status = 'idle';
    saveDraft(state); // persist the address immediately so export captures it even before the lookup resolves
    clearTimeout(deb);
    deb = setTimeout(function () {
      // Full render on resolve → saves the draft (symbol/decimals/status) and refreshes the locked currency
      // dropdowns on the Rulesets/Shop steps. By now the user has finished typing, so losing focus is fine.
      lookupCustomToken(state, render);
      renderStatus(); // reflect the synchronous 'loading' / 'error' state set by lookupCustomToken
    }, 400);
    renderStatus();
  });
  wrap.appendChild(input);
  wrap.appendChild(status);
  var note = el('div', 'create-hint');
  note.textContent = 'Must be deployed at the SAME address on every selected chain. Every ruleset, payout, and shop price is denominated in ' + (ct.symbol || 'this token') + ' itself, so issuing tokens and paying need no price feed. Pricing in ETH or USD instead requires the project owner to add a ' + (ct.symbol || 'token') + ' price feed after deploy (Owner tab → Add price feed) — the “Allow adding price feeds” rule is on by default for custom-token projects.';
  wrap.appendChild(note);
  renderStatus();
  return wrap;
}

// Project-owner field (custom flow) — required. We confirm it exists on each chain at the Settlement step.
function ownerSection(state, render) {
  var d = state.details;
  var box = el('div', '');
  if (!perChainOpen(state, 'owner')) {
    var ownerInput = textInput(d.owner, '0x… or name.eth', function (v) { d.owner = v.trim(); });
    var ownerHint = attachEns(ownerInput, function (name, addr) { d.ownerResolvedFor = addr ? name : null; d.ownerResolved = addr || null; }, { chainId: (state.chainIds || [])[0] });
    box.appendChild(recipBoxWith(ownerInput, ownerHint));
  }
  box.appendChild(perChainAddrControl(state, render, 'owner', d.ownerResolved || d.owner || ''));
  box.appendChild(infoNote('The address that can make changes around the configured rulesets.'));
  box.appendChild(infoNote('Currently set to ' + (perChainOpen(state, 'owner') ? 'the per-chain addresses above' : (d.owner || 'no project owner yet')) + '.'));
  var wrap = el('div', '');
  wrap.appendChild(fieldBlock('Project owner', false, box));
  return wrap;
}

// Revnet operator field — required. We confirm it exists on each chain at the Settlement step.
function operatorSection(state, render) {
  var wrap = el('div', '');
  var box = el('div', '');
  if (!perChainOpen(state, 'op')) {
    var opInput = textInput(state.revOperator, '0x… or name.eth', function (v) { state.revOperator = v.trim(); });
    var opHint = attachEns(opInput, function (name, addr) { state.revOperatorResolvedFor = addr ? name : null; state.revOperatorResolved = addr || null; }, { chainId: (state.chainIds || [])[0] });
    box.appendChild(recipBoxWith(opInput, opHint));
  }
  box.appendChild(perChainAddrControl(state, render, 'op', state.revOperatorResolved || state.revOperator || ''));
  box.appendChild(infoNote('The address that operates the few controls available in revnets.'));
  box.appendChild(infoNote('Currently set to ' + (perChainOpen(state, 'op') ? 'the per-chain addresses above' : (state.revOperator || 'no revnet operator yet')) + '.'));
  wrap.appendChild(fieldBlock('Revnet operator', false, box));
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
function dz(on, off) { return function (checked) { return checked ? 'On: ' + on : 'Off: ' + off; }; }
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
  var n = el('div', 'create-banner'); // soft pink band (palette), not the harsh red note
  n.textContent = text;
  return n;
}

// Size a <select> tight to its CURRENTLY selected option's text. Native `width:auto` sizes to the widest
// option (leaving slack when a shorter one is picked); this measures the selection after layout (rAF, once
// attached) and sets an explicit width. No-op where measurement is unavailable (e.g. jsdom → width 0).
function fitSelect(sel) {
  if (typeof requestAnimationFrame !== 'function') return sel;
  requestAnimationFrame(function () {
    if (!sel.isConnected) return;
    var opt = sel.options[sel.selectedIndex]; if (!opt) return;
    var cs = getComputedStyle(sel);
    var span = el('span', '');
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
    span.style.font = cs.font || (cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily);
    span.style.letterSpacing = cs.letterSpacing;
    span.textContent = opt.textContent;
    document.body.appendChild(span);
    var w = span.getBoundingClientRect().width;
    document.body.removeChild(span);
    if (w > 0) sel.style.width = Math.ceil(w + parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0)
      + parseFloat(cs.borderLeftWidth || 0) + parseFloat(cs.borderRightWidth || 0) + 1) + 'px';
  });
  return sel;
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
// Standby: zero issuance, no payouts/surplus, payments paused, no expiry; cash outs preserved so holders can exit.
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
  caret.textContent = state[key] ? '▾' : '▸';
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
  wrap.appendChild(stepHead('Project details', 'The ' + (state.projectType === 'revnet' ? 'revnet operator' : 'project owner') + ' can edit these after launch.'));

  wrap.appendChild(fieldBlock('Name', false, textInput(d.name, 'My project', function (v) { d.name = v; })));
  // Token ticker — revnets only (it names the ERC-20 REVDeployer deploys). A custom project's ERC-20 is
  // deployed later from the Owner tab, which asks for the symbol then.
  if (state.projectType === 'revnet') {
    wrap.appendChild(fieldBlock('Token symbol', false, (function () {
      var n = textInput(d.ticker, 'TOKEN', function (v) { d.ticker = v.trim().toUpperCase().slice(0, 11); });
      n.classList.add('create-symbol-field'); // a symbol is short — 1/4 width
      n.addEventListener('input', function () { n.value = n.value.toUpperCase(); });
      return n;
    })()));
  }
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
    g.appendChild(fieldBlock('Instagram', true, textInput(d.instagram, 'https://instagram.com/…', function (v) { d.instagram = v; })));
    g.appendChild(fieldBlock('WhatsApp', true, textInput(d.whatsapp, 'https://wa.me/…', function (v) { d.whatsapp = v; })));
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
    if (!hasPinata()) { alert('IPFS pinning isn’t available right now — you can add a logo later by editing the project.'); return; }
    onChange(uri, true);
    pinFile(f, f.name).then(function (ipfs) { onChange(ipfs, false); })
      .catch(function (e) { alert('Could not upload: ' + (e && e.message || e)); onChange(uri, false); });
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
    cashOutEnabled: false, cashOutTaxRate: 0, allowOwnerMinting: false, pauseTransfers: false, pause721Transfers: false,
    // Queue-prefill-only fields which have no concise control but must survive an edit unchanged.
    useTotalSurplusForCashOuts: true, ownerMustSendPayouts: false, metadataExtra: 0,
    reservedRecipients: [], tokenAdvancedOpen: false,
    // revnet-only stage fields (ignored by the custom flow)
    cutFreqDays: '30', autoIssuances: [], startDaysAfter: '30',
    // payouts (single-token). Multi-accounting-context queues use payoutByKind instead (keyed by token kind).
    payoutMode: 'none', payoutRecipients: [], payoutByKind: {},
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
      wait: 'The project idles safely — no issuance, payments paused, cash outs preserved — until the project owner changes it.',
      terminal: (state.queueEditor ? 'The new ruleset’s' : 'Ruleset #1’s') + ' terms continue on forever, without cycling again.',
      cycle: (state.queueEditor ? 'The new ruleset' : 'Ruleset #1') + ' repeats its cycle until the project owner changes it. Changes can only take effect once a cycled ruleset ends.',
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

  // Ruleset approval condition — project-wide, at the bottom of the tab. The approval hook decides whether a
  // queued edit can take effect; presets are time deadlines, "Custom address" points at any approval-hook
  // contract (per-chain). Only shown when a future ruleset edit can actually happen (see deadlineApplies).
  if (deadlineApplies(state)) {
    var cur = (state.stages[0] && state.stages[0].deadline) || '3days';
    var dField = el('div', 'create-field'); dField.style.marginTop = '22px';
    var dLab = el('label', 'create-label'); dLab.textContent = 'Ruleset approval condition'; dField.appendChild(dLab);
    dField.appendChild(infoNote('The condition a queued edit must satisfy before it takes effect, giving token holders time to review changes.'));
    // Dropdown sits tight to its text; when Custom is picked the address field sits inline beside it.
    var dRow = el('div', 'create-approval-row');
    var dSel = el('select', 'field create-input create-input-auto');
    DEADLINE_OPTIONS.forEach(function (o) {
      var op = el('option', ''); op.value = o.key; op.textContent = o.label;
      if (cur === o.key) op.selected = true; dSel.appendChild(op);
    });
    var custOpt = el('option', ''); custOpt.value = 'custom'; custOpt.textContent = 'Custom address';
    if (cur === 'custom') custOpt.selected = true; dSel.appendChild(custOpt);
    dSel.addEventListener('change', function () { state.stages.forEach(function (s) { s.deadline = dSel.value; }); render(); });
    fitSelect(dSel); dRow.appendChild(dSel);
    // Inline address — only when custom and not in per-chain mode (per-chain rows render full-width below).
    if (cur === 'custom' && !perChainOpen(state, 'approval')) {
      var ai = textInput(state.approvalAddress || '', '0x… or name.eth', function (v) { state.approvalAddress = v.trim(); });
      var ah = attachEns(ai, function (name, addr) { state.approvalAddressResolved = addr || null; state.approvalAddressResolvedFor = addr ? name : null; }, { chainId: (state.chainIds || [])[0] });
      var ab = recipBoxWith(ai, ah); ab.classList.add('create-approval-addr'); dRow.appendChild(ab);
    }
    dField.appendChild(dRow);
    if (cur === 'custom') {
      dField.appendChild(perChainAddrControl(state, render, 'approval', state.approvalAddressResolved || state.approvalAddress || ''));
      dField.appendChild(infoNote('A JBRulesetApprovalHook contract that approves or rejects queued edits. Must be deployed on every selected chain.'));
    } else if (cur === 'none') {
      dField.appendChild(warnNote('No condition lets the owner make last-second edits before a ruleset takes effect, which supporters may see as risky.'));
    }
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
  var title = el('div', 'create-stage-title');
  title.textContent = state.queueEditor
    ? (idx === 0 ? (state.queueAction === 'replace' ? 'Replacement ruleset' : 'New ruleset') : 'Following ruleset ' + (idx + 1))
    : 'Ruleset #' + (idx + 1);
  left.appendChild(title);
  var sum = el('div', 'create-stage-sum'); setBulletSummary(sum, stageSummaryParts(stage, idx, state)); left.appendChild(sum);
  head.appendChild(left);
  if (idx > 0) {
    var rm = el('button', 'create-stage-remove'); rm.textContent = '✕';
    rm.addEventListener('click', function () { state.stages.splice(idx, 1); render(); });
    head.appendChild(rm);
  }
  var caret = el('span', 'create-stage-caret'); caret.textContent = stage.expanded ? '▾' : '▸'; head.appendChild(caret);
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
  var caret = el('span', 'create-stage-caret'); caret.textContent = stage.expanded ? '▾' : '▸'; head.appendChild(caret);
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
  parts.push(round2(Number(stage.cashOutTaxRate)) + '% cash out tax');
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
  issRow.appendChild(currencySelect(state.revBaseCurrency, function (v) { state.revBaseCurrency = v; render(); }, null, lockedCurrencySym(state)));
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
  (stage.reservedRecipients || []).forEach(function (rec, i) { s1.appendChild(reservedSplitRow(stage, rec, i, render, setSplitHead, state, idx)); });
  var addSplit = el('button', 'create-add-btn'); addSplit.textContent = '+ Add split';
  addSplit.addEventListener('click', function (e) { e.preventDefault(); stage.reservedRecipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0 }); render(); });
  s1.appendChild(addSplit);
  s1.appendChild(splitHead);

  // Auto-issuance — inline rows (no box).
  var aiHint = el('div', 'create-hint'); aiHint.textContent = 'Optionally, auto-issue $' + tk + ' when the stage starts.'; aiHint.style.marginTop = '22px'; s1.appendChild(aiHint);
  (stage.autoIssuances || []).forEach(function (ai, i) { s1.appendChild(autoIssuanceRow(stage, ai, i, tk, render, state, idx)); });
  var addAi = el('button', 'create-add-btn'); addAi.textContent = '+ Add auto issuance';
  addAi.addEventListener('click', function (e) { e.preventDefault(); stage.autoIssuances.push({ count: '', address: '', chainId: null }); render(); });
  s1.appendChild(addAi);
  var aiTotal = (stage.autoIssuances || []).reduce(function (s, a) { return s + (Number(a.count) || 0); }, 0);
  if (aiTotal > 0) {
    var aiSum = el('div', 'create-hint');
    var aiText = 'Total auto issuance of ' + round2(aiTotal) + ' $' + tk;
    if ((state.chainIds || []).length > 1) {
      // Break the total down by mint chain — each row only mints on its chosen chain.
      var byChain = {};
      (stage.autoIssuances || []).forEach(function (a) {
        var n = Number(a.count) || 0;
        if (n > 0) { var c = aiMintChain(state, a); byChain[c] = (byChain[c] || 0) + n; }
      });
      aiText += ' — ' + state.chainIds.filter(function (cid) { return byChain[cid]; })
        .map(function (cid) { return round2(byChain[cid]) + ' on ' + chainName(cid); }).join(', ');
    }
    aiSum.textContent = aiText + '.';
    s1.appendChild(aiSum);
  }
  w.appendChild(s1);

  // 2. Cash outs (always on for a revnet — the only exit besides loans)
  var acctSym = surplusTokenLabel(state);
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

function autoIssuanceRow(stage, ai, idx, tk, render, state, stageIdx) {
  var wrap = el('div', 'create-split-wrap');
  var row = el('div', 'create-split-row');
  var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Issue' : '… and'; row.appendChild(lead);
  // Amount box with a "$TOKEN" suffix inside, mirroring the issuance field.
  var amtWrap = el('div', 'create-amt-suffix');
  var cnt = el('input', ''); cnt.type = 'number'; cnt.min = '0'; cnt.step = 'any';
  cnt.value = ai.count || ''; cnt.addEventListener('input', function () { ai.count = cnt.value.trim(); });
  amtWrap.appendChild(cnt);
  var suf = el('span', 'create-amt-suffix-label'); suf.textContent = '$' + tk; amtWrap.appendChild(suf);
  row.appendChild(amtWrap);
  var to = el('span', 'create-split-to'); to.textContent = 'to';
  var toField = el('div', 'create-split-tofield'); toField.appendChild(to);
  var key = 'ai:' + stageIdx + ':' + idx;
  if (!(state && perChainOpen(state, key, [aiMintChain(state, ai)]))) {
    var recip = el('input', 'field create-split-recip'); recip.type = 'text'; recip.placeholder = '0x… or name.eth';
    recip.value = ai.address || '';
    var ensHint = attachEns(recip, function (name, addr) { ai.resolvedFor = addr ? name : null; ai.resolvedAddress = addr || null; }, { chainId: (state.chainIds || [])[0] });
    recip.addEventListener('input', function () { ai.address = recip.value.trim(); });
    toField.appendChild(recipBoxWith(recip, ensHint));
  }
  row.appendChild(toField);
  // Multichain: each row picks the ONE chain it mints on (every chain's config carries the full row
  // list; REVDeployer only mints rows matching the local chain). Single chain needs no choice.
  if (state && (state.chainIds || []).length > 1) {
    var on = el('span', 'create-split-to'); on.textContent = 'on'; row.appendChild(on);
    var chSel = el('select', 'field create-input create-split-subsel create-ai-chain');
    chSel.title = 'The chain this issuance mints on';
    state.chainIds.forEach(function (cid) {
      var op = el('option', ''); op.value = String(cid); op.textContent = chainName(cid); chSel.appendChild(op);
    });
    chSel.value = String(aiMintChain(state, ai));
    chSel.addEventListener('change', function () { ai.chainId = Number(chSel.value); render(); });
    row.appendChild(chSel);
  }
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = stage.autoIssuances.indexOf(ai); if (i >= 0) stage.autoIssuances.splice(i, 1); render(); });
  row.appendChild(rm);
  wrap.appendChild(row);
  // A row whose stored mint chain was deselected falls back to the first selected chain — say so
  // inline instead of silently reassigning (the chain select above already shows the fallback).
  if (state && ai.chainId != null) {
    var selIds = state.chainIds || [];
    var stillSelected = selIds.some(function (cid) { return canonChainId(cid) === canonChainId(Number(ai.chainId)); });
    if (!stillSelected && selIds.length) {
      var chainWarn = el('div', 'create-hint create-ai-chain-warn');
      chainWarn.textContent = 'Was set to mint on ' + chainName(ai.chainId) + ', which is no longer selected — now minting on '
        + chainName(aiMintChain(state, ai)) + '.';
      wrap.appendChild(chainWarn);
    }
  }
  // The per-chain override only matters on the ONE chain this row mints on — fields for other
  // chains would be dead inputs the encoder never reads.
  if (state) wrap.appendChild(perChainAddrControl(state, render, key, pickResolved(ai.address, ai), [aiMintChain(state, ai)]));
  return wrap;
}

function recipLabel(rec) {
  if (rec.type === 'project' && rec.projectId) return 'project #' + rec.projectId;
  if (rec.address) return shortAddr(rec.address);
  return 'owner';
}

// Capitalized bullet strings for a stage (no leading "• ").
function stageSummaryParts(stage, idx, state) {
  return stageSummaryRaw(stage, idx, state).map(function (p) { return p ? p.charAt(0).toUpperCase() + p.slice(1) : p; });
}
// Render bullets as per-line divs with a hanging indent, so a wrapped line aligns under the text
// (after the "• "), not under the bullet.
function setBulletSummary(elx, parts) {
  parts.forEach(function (p) { var d = el('div', 'create-sum-li'); d.textContent = '• ' + p; elx.appendChild(d); });
}

function stageSummaryRaw(stage, idx, state) {
  var parts = [];
  if (state.queueEditor) {
    parts.push(idx === 0
      ? (state.queueStartSummary || 'Starts when the queued change becomes eligible')
      : 'Starts after the preceding queued ruleset');
  } else {
    parts.push(idx === 0 ? ((stage.scheduleOn && stage.schedule) ? 'Starts at a set time' : 'Starts at launch') : 'Starts after Ruleset #' + idx);
  }
  parts.push(!stage.durationSeconds ? 'lasts until changed by owner'
    : (stage.durationSeconds === FOREVER_SECONDS ? 'lasts forever' : 'lasts ' + secondsLabel(stage.durationSeconds)));

  // Issuance — weight, reserved split, issuance cut.
  if (stage.tokenMode === 'custom') {
    parts.push('issues ' + (stage.weight || '0') + ' tokens / ' + fundAccessCurrencyLabel(stage.baseCurrency, state));
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
      parts.push('pays out all funds to the project owner');
    } else {
      parts.push('pays out all funds');
      uRecips.forEach(function (r) { parts.push(round2(Number(r.percent)) + '% → ' + recipLabel(r)); });
      parts.push('remainder → project owner');
    }
  } else if (stage.payoutMode === 'limited') {
    var pc = fundAccessCurrencyLabel(stage.payoutCurrency, state);
    var named = (stage.payoutRecipients || []).filter(function (r) { return Number(r.amountEth) > 0; });
    if (named.length) named.forEach(function (r) { parts.push('pays ' + r.amountEth + ' ' + pc + ' → ' + recipLabel(r)); });
    else parts.push('payouts set, no recipients yet');
  }

  // Surplus allowance.
  if (stage.surplusAllowanceOn && stage.payoutMode !== 'unlimited') {
    if (stage.surplusAllowanceUnlimited) parts.push('project owner can withdraw all surplus');
    else if (Number(stage.surplusAllowanceAmount) > 0) parts.push('project owner can withdraw ' + stage.surplusAllowanceAmount + ' ' + fundAccessCurrencyLabel(stage.surplusAllowanceCurrency, state) + ' of surplus');
    else parts.push('surplus allowance on');
  }

  // Noteworthy flags.
  if (stage.allowOwnerMinting) parts.push('project owner can mint tokens');
  if (stage.pauseTransfers) parts.push('token credit transfers paused');
  if (stage.pause721Transfers) parts.push('eligible shop item transfers paused');
  if (stage.pausePay) parts.push('payments paused');
  if (stage.holdFees) parts.push('fees held');
  if (stage.allowTerminalMigration) parts.push('terminal migration allowed');
  // Edit deadline is shown in its own "Edit deadline" section below the card — not a ruleset bullet.

  return parts;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function renderStageEditor(stage, idx, state, render) {
  var c = el('div', 'create-stage-body');
  c.appendChild(stageTiming(stage, idx, idx === state.stages.length - 1, render, state));
  c.appendChild(tokenSection(stage, render, state, idx));
  c.appendChild(payoutsSection(stage, render, state)); // Schedule payouts + Surplus allowance — top-level, no disclosure
  c.appendChild(collapse(stage, 'otherOpen', 'Other rules', true, render, function () { return otherRulesSection(stage, render); }));
  return c;
}

function stageTiming(stage, idx, isLast, render, state) {
  var w = el('div', '');
  // Duration (None + presets)
  var f = el('div', 'create-field');
  var lab = el('label', 'create-label'); lab.textContent = 'Duration'; f.appendChild(lab);
  var sel = el('select', 'field create-input create-input-auto');
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
  fitSelect(sel); f.appendChild(sel);
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
    if (state.queueEditor) {
      w.appendChild(infoNote(state.queueTimingExplanation || 'The current ruleset’s cycle schedule and approval hook determine when this queued configuration can take effect.'));
    } else {
      w.appendChild(toggleRow('Launch right away', '', !stage.scheduleOn, function (v) {
        stage.scheduleOn = !v;
        if (v) stage.schedule = ''; // launching now clears any scheduled time
        render();
      }));
    }
    if (!state.queueEditor && stage.scheduleOn) {
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
    w.appendChild(infoNote(state.queueEditor
      ? 'This following ruleset begins automatically when the preceding queued ruleset ends.'
      : 'Stage ' + (idx + 1) + ' begins automatically when Stage ' + idx + ' ends.'));
  }
  // Accept payments — first thing after timing. Pausing payments idles token issuance (see tokenSection).
  w.appendChild(toggleRow('Accept payments', dz('The project can receive payments.', 'The project can’t receive payments.'), !stage.pausePay, function (v) { stage.pausePay = !v; render(); }));
  // A non-final stage with no duration would never advance — the next stage would start at the same
  // instant and immediately clobber it. Require a duration on every non-final stage.
  if (!isLast && !stage.durationSeconds) {
    w.appendChild(warnNote('This stage isn’t the last, so it needs a duration. With “no expiry”, the next stage would start at the same moment and override this one. Set a duration so Stage ' + (idx + 2) + ' begins when this stage’s cycle ends.'));
  }
  return w;
}

// ETH/USD currency <select> (JBCurrencyIds 1/2). `onChange` receives the numeric id; `cls` overrides the
// default compact inline style. Consolidates the identical option-loop used across the wizard.
function currencySelect(current, onChange, cls, lockedSym) {
  var sel = el('select', cls || 'create-amount-cur');
  // A custom accounting token forces every currency to itself (no ETH/USD choice, no price feed) — show it
  // as a single locked option.
  if (lockedSym) {
    var lop = el('option'); lop.value = String(current || ''); lop.textContent = lockedSym; lop.selected = true; sel.appendChild(lop);
    sel.disabled = true;
    return sel;
  }
  [['ETH', 1], ['USD', 2]].forEach(function (o) {
    var op = el('option'); op.value = String(o[1]); op.textContent = o[0];
    if ((current || 1) === o[1]) op.selected = true;
    sel.appendChild(op);
  });
  sel.addEventListener('change', function () { onChange(Number(sel.value)); });
  return sel;
}


// Split lock (JBSplit.lockedUntil). A checked "Locked" + date stores a unix timestamp; the split then can't
// be edited or removed by the owner until that date. Only offered when the ruleset has a fixed duration —
// a "Flexible" (no-duration) ruleset has no bounded window for the lock to govern, so the control is hidden.
function splitLockAllowed(stage) { return !!stage && (Number(stage.durationSeconds) || 0) > 0; }
function tsToDateInput(ts) { try { return new Date(Number(ts) * 1000).toISOString().slice(0, 10); } catch (_) { return ''; } }
function splitLockRow(stage, rec, render) {
  if (!splitLockAllowed(stage)) { if (rec.lockedUntil) rec.lockedUntil = 0; return null; } // flexible → no lock; clear any stale value
  var wrap = el('div', 'create-split-lock');
  var lbl = el('label', 'create-split-lockcheck');
  var cb = el('input', ''); cb.type = 'checkbox'; cb.checked = !!rec.lockedUntil;
  cb.addEventListener('change', function () {
    // Default to the end of this ruleset, capped at ~10y so a "Forever" duration doesn't seed a year-4159 date.
    var span = Math.min(Number(stage.durationSeconds) || 2592000, 315360000);
    rec.lockedUntil = cb.checked ? (rec.lockedUntil || (Math.floor(Date.now() / 1000) + span)) : 0;
    render();
  });
  lbl.appendChild(cb); var t = el('span', 'create-split-locklabel'); t.textContent = 'Locked'; lbl.appendChild(t);
  wrap.appendChild(lbl);
  if (rec.lockedUntil) {
    var d = el('input', 'field create-split-lockdate'); d.type = 'date'; d.value = tsToDateInput(rec.lockedUntil);
    d.min = tsToDateInput(Math.floor(Date.now() / 1000)); // no past dates (a lock in the past is meaningless)
    // Clamp ≥ 0 — a negative timestamp would overflow JBSplit.lockedUntil (uint48) and abort the whole deploy build.
    d.addEventListener('change', function () { rec.lockedUntil = d.value ? Math.max(0, Math.floor(Date.parse(d.value + 'T00:00:00Z') / 1000)) : 0; render(); });
    wrap.appendChild(d);
    wrap.appendChild(infoNote("Locked until this date — the split can’t be edited or removed for the rest of this ruleset."));
  }
  return wrap;
}

// Payouts section for a stage (folded into the stage editor).
function payoutRow(stage, rec, idx, mode, render, state) {
  var wrap = el('div', 'create-split-wrap'); if (idx > 0) wrap.style.marginTop = '18px';
  var lockLast = mode === 'amount' && stage.payoutRecipients.length <= 1;
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = stage.payoutRecipients.indexOf(rec); if (i >= 0) stage.payoutRecipients.splice(i, 1); render(); });
  var to = el('span', 'create-split-to'); to.textContent = 'to';
  var toField = el('div', 'create-split-tofield'); toField.appendChild(to);
  var row = el('div', 'create-split-row');
  if (mode === 'percent') {
    var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Split' : '… and'; row.appendChild(lead);
    var pct = el('input', 'field create-split-pct'); pct.type = 'number'; pct.min = '0'; pct.max = '100'; pct.step = 'any'; pct.placeholder = '10';
    pct.value = rec.percent || ''; pct.addEventListener('input', function () { rec.percent = parseFloat(pct.value) || 0; }); row.appendChild(pct);
    var sign = el('span', 'create-split-sign'); sign.textContent = '%'; row.appendChild(sign);
    row.appendChild(toField); row.appendChild(rm);
  } else {
    var lead2 = el('span', 'create-split-lead'); lead2.textContent = idx === 0 ? 'Pay' : '… and'; row.appendChild(lead2);
    var amt = el('input', 'field create-inline-num create-payout-amt'); amt.type = 'number'; amt.min = '0'; amt.step = 'any'; amt.placeholder = '0.0';
    amt.value = rec.amountEth || ''; amt.addEventListener('input', function () { rec.amountEth = amt.value.trim(); }); row.appendChild(amt);
    row.appendChild(currencySelect(stage.payoutCurrency, function (v) { stage.payoutCurrency = v; render(); }, null, lockedCurrencySym(state)));
    row.appendChild(toField); if (!lockLast) row.appendChild(rm);
  }
  wrap.appendChild(row);
  var stageIdx = state ? state.stages.indexOf(stage) : 0;
  if (mode !== 'percent' && state) {
    // Fixed amounts can differ per chain — one combined control covers amount + recipient per chain.
    appendRecipientPicker(toField, rec, render, { state: state, isPayout: true });
    wrap.appendChild(perChainPayoutRowControl(state, render, rec,
      { amt: 'pamt:' + stageIdx + ':' + idx, addr: 'p:' + stageIdx + ':' + idx, pid: 'ppid:' + stageIdx + ':' + idx },
      { amt: rec.amountEth || '', addr: pickResolved(rec.address, rec), pid: rec.projectId || '' }));
  } else {
    appendRecipientPicker(toField, rec, render, { state: state, perChainKey: 'p:' + stageIdx + ':' + idx, pidKey: 'ppid:' + stageIdx + ':' + idx, isPayout: true });
  }
  var plk = splitLockRow(stage, rec, render); if (plk) wrap.appendChild(plk);
  return wrap;
}

// Per-accounting-context payout state (multi-token queues): { mode:'none'|'unlimited'|'limited', recipients[] }.
function pkState(stage, key) {
  if (!stage.payoutByKind) stage.payoutByKind = {};
  if (!stage.payoutByKind[key]) stage.payoutByKind[key] = { mode: 'none', recipients: [] };
  return stage.payoutByKind[key];
}
// One recipient row for a per-token payout block. `kind` provides the token symbol for limited amounts.
function payoutKindRow(pk, kind, rec, idx, render, state, stage) {
  var mode = pk.mode === 'unlimited' ? 'percent' : 'amount';
  var wrap = el('div', 'create-split-wrap'); if (idx > 0) wrap.style.marginTop = '18px';
  var lockLast = pk.recipients.length <= 1;
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = pk.recipients.indexOf(rec); if (i >= 0) pk.recipients.splice(i, 1); render(); });
  var to = el('span', 'create-split-to'); to.textContent = 'to';
  var toField = el('div', 'create-split-tofield'); toField.appendChild(to);
  var row = el('div', 'create-split-row');
  if (mode === 'percent') {
    var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Split' : '… and'; row.appendChild(lead);
    var pct = el('input', 'field create-split-pct'); pct.type = 'number'; pct.min = '0'; pct.max = '100'; pct.step = 'any'; pct.placeholder = '10';
    pct.value = rec.percent || ''; pct.addEventListener('input', function () { rec.percent = parseFloat(pct.value) || 0; }); row.appendChild(pct);
    var sign = el('span', 'create-split-sign'); sign.textContent = '%'; row.appendChild(sign);
    row.appendChild(toField); row.appendChild(rm);
  } else {
    var lead2 = el('span', 'create-split-lead'); lead2.textContent = idx === 0 ? 'Pay' : '… and'; row.appendChild(lead2);
    var amt = el('input', 'field create-inline-num create-payout-amt'); amt.type = 'number'; amt.min = '0'; amt.step = 'any'; amt.placeholder = '0.0';
    amt.value = rec.amountEth || ''; amt.addEventListener('input', function () { rec.amountEth = amt.value.trim(); }); row.appendChild(amt);
    var u = el('span', 'create-suffix'); u.textContent = ' ' + kind.symbol + ' '; row.appendChild(u);
    row.appendChild(toField); if (!lockLast) row.appendChild(rm);
  }
  wrap.appendChild(row);
  if (mode !== 'percent' && state) {
    // Fixed amounts can differ per chain — one combined control covers amount + recipient per chain.
    appendRecipientPicker(toField, rec, render, { state: state, isPayout: true });
    wrap.appendChild(perChainPayoutRowControl(state, render, rec,
      { amt: 'pkamt:' + kind.key + ':' + idx, addr: 'pk:' + kind.key + ':' + idx, pid: 'pkpid:' + kind.key + ':' + idx },
      { amt: rec.amountEth || '', addr: pickResolved(rec.address, rec), pid: rec.projectId || '' }));
  } else {
    appendRecipientPicker(toField, rec, render, { state: state, perChainKey: 'pk:' + kind.key + ':' + idx, pidKey: 'pkpid:' + kind.key + ':' + idx, isPayout: true });
  }
  var klk = splitLockRow(stage, rec, render); if (klk) wrap.appendChild(klk);
  return wrap;
}
// A "Payout <SYM> funds" block for one accounting context.
function payoutKindBlock(stage, kind, render, state) {
  var pk = pkState(stage, kind.key);
  var wrap = el('div', '');
  wrap.appendChild(toggleRow('Payout ' + kind.symbol + ' funds', dz('Routing some of the project’s ' + kind.symbol + ' to other accounts or projects.', 'All ' + kind.symbol + ' stays in the project for cash outs / later cycles.'), pk.mode !== 'none', function (v) { pk.mode = v ? 'unlimited' : 'none'; render(); }));
  if (pk.mode !== 'none') {
    var card = el('div', 'create-subcard');
    card.appendChild(toggleRow('Payout all received ' + kind.symbol, dz('Paying out everything received; recipients get a percentage and the rest goes to the project owner.', 'Paying out fixed amounts; anything else stays in the project.'), pk.mode === 'unlimited', function (v) { pk.mode = v ? 'unlimited' : 'limited'; if (!v && !pk.recipients.length) pk.recipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0, amountEth: '' }); render(); }));
    pk.recipients.forEach(function (rec, i) { card.appendChild(payoutKindRow(pk, kind, rec, i, render, state, stage)); });
    var add = el('button', 'operator-cta create-add-link'); add.textContent = '+ Add payout'; add.style.marginTop = pk.recipients.length ? '14px' : '4px';
    add.addEventListener('click', function (e) { e.preventDefault(); pk.recipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0, amountEth: '' }); render(); });
    card.appendChild(add);
    if (pk.mode === 'unlimited') { var on = el('div', 'create-hint'); on.style.marginTop = '10px'; on.textContent = 'Any ' + kind.symbol + ' not allocated above goes to the project owner.'; card.appendChild(on); }
    wrap.appendChild(card);
  }
  return wrap;
}

// Token "kind" objects (key/symbol/decimals/addrForChain) for the create flow's accepted tokens.
function createPayoutKinds(state) {
  return (state.accepts || []).map(function (k) {
    if (k === 'custom') {
      var ct = state.customToken || {};
      return { key: 'custom', symbol: ct.symbol || 'TOKEN', decimals: customAcctDecimals(state), addrForChain: function () { return ct.address; } };
    }
    return k === 'usdc'
      ? { key: 'usdc', symbol: 'USDC', decimals: 6, addrForChain: function (cid) { return USDC_BY_CHAIN[cid] || null; } }
      : { key: 'eth', symbol: 'ETH', decimals: 18, addrForChain: function () { return NATIVE_TOKEN; } };
  });
}
// Single source of truth for whether payouts/surplus are configured per-token. The queue form sets
// `state.payoutKinds` from the project's contexts; the create flow derives it from `accepts` — multi-token
// only when a CUSTOM project holds more than one accounting token. Both the UI and the deploy build read this.
function currentPayoutKinds(state) {
  if (state.payoutKinds && state.payoutKinds.length) return state.payoutKinds; // queue form
  if (state.projectType !== 'revnet' && (state.accepts || []).length > 1) return createPayoutKinds(state); // custom-both
  // A custom ERC-20 routes through the per-token path too (token-keyed currency + token decimals, no feed).
  if (state.projectType !== 'revnet' && customAccounting(state) && isAddr(state.customToken.address)) return createPayoutKinds(state);
  return null;
}

function payoutsSection(stage, render, state) {
  var wrap = el('div', '');
  // Multi-accounting-context (custom-both / queue): one "Payout <SYM> funds" block per token; surplus is cumulative.
  var kinds = state && currentPayoutKinds(state);
  if (kinds) {
    kinds.forEach(function (kind) { wrap.appendChild(payoutKindBlock(stage, kind, render, state)); });
    var allUnlimited = kinds.every(function (k) { return pkState(stage, k.key).mode === 'unlimited'; });
    if (allUnlimited) {
      wrap.appendChild(idleToggle('Give project owner access to surplus funds', 'All funds are allocated to unlimited payouts, no surplus available.'));
      wrap.appendChild(idleToggle('Give tokens cash out access to surplus funds', 'All funds are allocated to unlimited payouts, no surplus to cash out.'));
    } else {
      // Surplus is the project's TOTAL across all accepted tokens (cash out reclaim prices against the
      // cumulative surplus). Owner access is unlimited-across-tokens here to avoid per-token cap ambiguity.
      wrap.appendChild(toggleRow('Give project owner access to surplus funds', dz('The project owner can withdraw the project’s surplus (funds beyond payouts) — an unlimited allowance per accepted token (ETH, USDC, …), each in its own currency.', 'The project owner can’t withdraw from the project’s surplus.'), stage.surplusAllowanceOn, function (v) { stage.surplusAllowanceOn = v; stage.surplusAllowanceUnlimited = true; render(); }));
      wrap.appendChild(cashOutSection(state, stage, render));
    }
    return wrap;
  }
  wrap.appendChild(toggleRow('Payout funds', dz('Routing some of the project’s funds to other accounts or projects.', 'All funds stay in the project for cash outs / later stages.'), stage.payoutMode !== 'none', function (v) { stage.payoutMode = v ? 'unlimited' : 'none'; render(); }));

  if (stage.payoutMode !== 'none') {
    var card = el('div', 'create-subcard');
    card.appendChild(toggleRow('Payout all received funds', dz('Paying out everything received; recipients get a percentage and the rest goes to the project owner.', 'Paying out fixed amounts; anything else stays in the project.'), stage.payoutMode === 'unlimited', function (v) {
      stage.payoutMode = v ? 'unlimited' : 'limited';
      // A specific (limited) payout needs at least one entry to fill in.
      if (!v && !stage.payoutRecipients.length) stage.payoutRecipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0, amountEth: '' });
      render();
    }));
    var mode = stage.payoutMode === 'unlimited' ? 'percent' : 'amount';
    stage.payoutRecipients.forEach(function (rec, i) { card.appendChild(payoutRow(stage, rec, i, mode, render, state)); });
    var add = el('button', 'operator-cta create-add-link'); add.textContent = '+ Add payout';
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
    wrap.appendChild(idleToggle('Give project owner access to surplus funds', 'All funds are allocated to unlimited payouts, no surplus available.'));
    wrap.appendChild(idleToggle('Give tokens cash out access to surplus funds', 'All funds are allocated to unlimited payouts, no surplus to cash out.'));
  } else {
    wrap.appendChild(toggleRow('Give project owner access to surplus funds', dz('The project owner can withdraw from the project’s surplus (funds beyond payouts).', 'The project owner can’t withdraw from the project’s surplus.'), stage.surplusAllowanceOn, function (v) { stage.surplusAllowanceOn = v; render(); }));
    if (stage.surplusAllowanceOn) {
      var saCard = el('div', 'create-subcard');
      saCard.appendChild(toggleRow('Unlimited', dz('No cap — the project owner can withdraw the entire surplus.', 'Capped at the amount set below.'), stage.surplusAllowanceUnlimited, function (v) { stage.surplusAllowanceUnlimited = v; render(); }));
      if (!stage.surplusAllowanceUnlimited) {
        var saRow = el('div', 'create-inline-row');
        var saAmt = el('input', 'field create-inline-num'); saAmt.type = 'text'; saAmt.placeholder = '0.0'; saAmt.value = stage.surplusAllowanceAmount;
        saAmt.addEventListener('input', function () { stage.surplusAllowanceAmount = saAmt.value.trim(); });
        saRow.appendChild(saAmt);
        saRow.appendChild(currencySelect(stage.surplusAllowanceCurrency, function (v) { stage.surplusAllowanceCurrency = v; }, null, lockedCurrencySym(state)));
        saRow.appendChild(document.createTextNode(' allowed.'));
        saCard.appendChild(saRow);
      }
      wrap.appendChild(saCard);
    }
    // Token-holder cash outs live right after the owner's surplus allowance (both draw from surplus).
    wrap.appendChild(cashOutSection(state, stage, render));
  }
  return wrap;
}

// Inline reserved-token split row: "Split [%] to [0x / project ID]". A project ID reveals a
// "token beneficiary" field (who receives that project's tokens). Edits `rec` in place.
// Recipient type picker (Address / Project ID / Hook) + the dependent fields beneath it. Shared by the
// reserved-token and payout split rows. The type <select> is appended to `toFieldNode` (the inline
// "to […]"); the dependent inputs (address / project-id + beneficiary / hook selector + custom hook
// address) are appended to `wrap` below the row. Edits `rec` in place; `rec.type` is one of
// wallet | project | lphook (fund-market hook) | customhook.
function appendRecipientPicker(toFieldNode, rec, render, opts) {
  opts = opts || {};
  // Build a column placed after the "to" label: the type dropdown on top, dependent fields beneath it —
  // so the address / beneficiary / hook selector all left-align with the dropdown.
  var col = el('div', 'create-split-picker');
  var head = el('div', 'create-split-pickerhead');
  var typeSel = el('select', 'field create-input create-split-typesel');
  var curType = rec.type === 'project' ? 'project' : (rec.type === 'lphook' || rec.type === 'customhook') ? 'hook' : 'address';
  [['address', 'Address'], ['project', 'Project'], ['hook', 'Hook']].forEach(function (o) {
    var op = el('option'); op.value = o[0]; op.textContent = o[1]; if (curType === o[0]) op.selected = true; typeSel.appendChild(op);
  });
  // Switching recipient type must drop any per-chain overrides for this slot — they're keyed per slot and
  // would otherwise leak a wallet address into a project beneficiary slot (or vice-versa) at deploy time.
  function clearPerChain() {
    if (!opts.state) return;
    (opts.state.chainIds || []).forEach(function (cid) {
      var pc = perChainPeek(opts.state, cid);
      if (pc && pc.addr) { if (opts.perChainKey) delete pc.addr[opts.perChainKey]; if (opts.pidKey) delete pc.addr[opts.pidKey]; }
    });
  }
  // Fund market (the shared LP hook) pools project TOKENS — only meaningful for reserved-token splits, not
  // payout (funds) splits. When it's off, "Hook" means a custom hook directly.
  var hookDefault = opts.allowFundMarket ? 'lphook' : 'customhook';
  typeSel.addEventListener('change', function () {
    clearPerChain();
    rec.type = typeSel.value === 'address' ? 'wallet' : typeSel.value === 'project' ? 'project' : hookDefault;
    render();
  });
  head.appendChild(typeSel);

  function sub(node) { var d = el('div', 'create-split-sub'); d.appendChild(node); col.appendChild(d); return d; }

  // Project-ID input (small) + its per-chain override; project IDs differ per chain for the same project.
  function projectIdField() {
    var idInput = el('input', 'field create-split-idnum'); idInput.type = 'number'; idInput.min = '1'; idInput.placeholder = 'ID'; idInput.value = rec.projectId || '';
    idInput.addEventListener('input', function () { rec.projectId = Number(idInput.value) || 0; });
    return idInput;
  }
  // Column holding the inline ID field + its per-chain control, so the per-chain chain icons line up with
  // the ID field's left edge. When per-chain is expanded the single field is replaced by the per-chain rows.
  function projectIdCol() {
    var c = el('div', 'create-split-idcol');
    var pcOpen = opts.state && opts.pidKey && perChainOpen(opts.state, opts.pidKey);
    if (!pcOpen) {
      var projectInput = projectIdField();
      c.appendChild(recipBoxWith(projectInput, attachProjectIdResolver(projectInput, opts.state && opts.state.chainIds || [])));
    }
    if (opts.state && opts.pidKey) c.appendChild(perChainNumControl(opts.state, render, opts.pidKey, rec.projectId || ''));
    return c;
  }
  // Token beneficiary input + its per-chain override. When per-chain is expanded the single field is replaced.
  function beneficiaryField() {
    var pcOpen = opts.state && opts.perChainKey && perChainOpen(opts.state, opts.perChainKey);
    if (!pcOpen) {
      var benef = el('input', 'field create-split-recip'); benef.type = 'text'; benef.placeholder = '0x… or name.eth'; benef.value = rec.address || '';
      benef.addEventListener('input', function () { rec.address = benef.value.trim(); });
      sub(recipBoxWith(benef, attachEns(benef, function () {}, { chainId: opts.state && (opts.state.chainIds || [])[0] })));
    }
    if (opts.state && opts.perChainKey) col.appendChild(perChainAddrControl(opts.state, render, opts.perChainKey, pickResolved(rec.address, rec)));
  }

  if (rec.type === 'project') {
    head.appendChild(projectIdCol()); col.appendChild(head); // ID + its per-chain control sit right of the dropdown
    if (opts.isPayout) {
      var routeLabel = el('div', 'create-split-sublabel'); routeLabel.textContent = 'route as'; col.appendChild(routeLabel);
      var routeWrap = el('div', 'field create-input create-split-subsel create-wrap-select');
      var routeText = el('span', 'create-wrap-select-label');
      var routeCaret = el('span', 'create-wrap-select-caret'); routeCaret.setAttribute('aria-hidden', 'true');
      var route = el('select', 'create-wrap-select-native');
      [['pay', 'Pay project | mint its tokens'], ['balance', 'Add to project balance | mint none']].forEach(function (o) {
        var op = el('option'); op.value = o[0]; op.textContent = o[1];
        if ((rec.preferAddToBalance ? 'balance' : 'pay') === o[0]) op.selected = true;
        route.appendChild(op);
      });
      route.setAttribute('aria-label', 'Project payout route');
      routeText.setAttribute('aria-hidden', 'true'); routeText.textContent = route.options[route.selectedIndex].textContent;
      route.addEventListener('change', function () { rec.preferAddToBalance = route.value === 'balance'; render(); });
      routeWrap.appendChild(routeText); routeWrap.appendChild(routeCaret); routeWrap.appendChild(route);
      sub(routeWrap);
    }
    if (!opts.isPayout || !rec.preferAddToBalance) {
      var benefLabel = el('div', 'create-split-sublabel');
      benefLabel.textContent = opts.isPayout ? 'destination-token beneficiary' : 'fallback token beneficiary';
      col.appendChild(benefLabel);
      beneficiaryField();
    }
    if (opts.isReserved) {
      var projectRouteHint = el('div', 'create-split-lphint');
      projectRouteHint.textContent = 'Reserved tokens pay this project only when the source token is an ERC-20 and the destination has a terminal for it; credits or an unavailable/reverting route go to the fallback beneficiary.';
      col.appendChild(projectRouteHint);
    }
  } else if (rec.type === 'lphook' || rec.type === 'customhook') {
    // A custom split hook (address) that can also carry a project id + beneficiary, all per-chain settable.
    var customHookFields = function () {
      var hookInput = el('input', 'field create-split-recip'); hookInput.type = 'text'; hookInput.placeholder = '0x… (split hook address)'; hookInput.value = rec.hookAddress || '';
      hookInput.addEventListener('input', function () { rec.hookAddress = hookInput.value.trim(); }); sub(hookInput);
      var projRow = el('div', 'create-split-pickerhead');
      var projLbl = el('span', 'create-split-sublabel'); projLbl.textContent = 'with project'; projRow.appendChild(projLbl);
      projRow.appendChild(projectIdCol()); col.appendChild(projRow);
      var benLbl = el('div', 'create-split-sublabel'); benLbl.textContent = 'and beneficiary'; col.appendChild(benLbl);
      beneficiaryField();
    };
    if (opts.allowFundMarket) {
      var hookSel = el('select', 'field create-input create-split-subsel');
      [['fundmarket', 'Fund market'], ['custom', 'Custom']].forEach(function (o) {
        var op = el('option'); op.value = o[0]; op.textContent = o[1]; if ((rec.type === 'customhook' ? 'custom' : 'fundmarket') === o[0]) op.selected = true; hookSel.appendChild(op);
      });
      hookSel.addEventListener('change', function () { clearPerChain(); rec.type = hookSel.value === 'custom' ? 'customhook' : 'lphook'; render(); });
      head.appendChild(hookSel); col.appendChild(head); // Fund market / Custom sits inline to the right of "Hook"
      if (rec.type === 'customhook') customHookFields();
      else { var lpHint = el('div', 'create-split-lphint'); lpHint.textContent = 'Pools split tokens into a Uniswap V4 buyback position. Trading fees route back to your project.'; col.appendChild(lpHint); }
    } else {
      // Payout splits: custom hook only (no Fund market). No sub-selector — the dropdown is just "Hook".
      if (rec.type === 'lphook') rec.type = 'customhook';
      col.appendChild(head);
      customHookFields();
    }
  } else { // wallet (address)
    col.appendChild(head);
    if (!(opts.state && opts.perChainKey && perChainOpen(opts.state, opts.perChainKey))) {
      var addrInput = el('input', 'field create-split-recip'); addrInput.type = 'text'; addrInput.placeholder = '0x… or name.eth'; addrInput.value = rec.address || '';
      addrInput.addEventListener('input', function () { rec.address = addrInput.value.trim(); });
      sub(recipBoxWith(addrInput, attachEns(addrInput, function (name, addr) { rec.resolvedFor = addr ? name : null; rec.resolvedAddress = addr || null; }, { chainId: opts.state && (opts.state.chainIds || [])[0] })));
    }
    if (opts.state && opts.perChainKey) col.appendChild(perChainAddrControl(opts.state, render, opts.perChainKey, pickResolved(rec.address, rec)));
  }
  toFieldNode.appendChild(col);
}
// Whether the per-chain control for `key` is expanded (explicitly opened, or has any stored override).
function perChainOpen(state, key, chains) {
  if ((state.chainIds || []).length < 2) return false;
  if (state._pcOpen && state._pcOpen[key]) return true;
  var ids = (chains && chains.length ? chains : state.chainIds) || [];
  return ids.some(function (cid) { var pc = perChainPeek(state, cid); return pc && pc.addr && pc.addr[key]; });
}

function reservedSplitRow(t, rec, idx, render, onTotal, state, stageIdx) {
  var wrap = el('div', 'create-split-wrap');
  var row = el('div', 'create-split-row');
  var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Split' : '… and'; row.appendChild(lead);
  var pct = el('input', 'field create-split-pct'); pct.type = 'number'; pct.min = '0'; pct.max = '100'; pct.step = 'any'; pct.placeholder = '10';
  pct.value = rec.percent || ''; pct.addEventListener('input', function () { rec.percent = parseFloat(pct.value) || 0; if (onTotal) onTotal(); }); row.appendChild(pct);
  var sign = el('span', 'create-split-sign'); sign.textContent = '%'; row.appendChild(sign);
  var to = el('span', 'create-split-to'); to.textContent = 'to';
  var toField = el('div', 'create-split-tofield'); toField.appendChild(to); row.appendChild(toField);
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = t.reservedRecipients.indexOf(rec); if (i >= 0) t.reservedRecipients.splice(i, 1); render(); });
  row.appendChild(rm);
  wrap.appendChild(row);
  appendRecipientPicker(toField, rec, render, { state: state, perChainKey: 'r:' + stageIdx + ':' + idx, pidKey: 'rpid:' + stageIdx + ':' + idx, allowFundMarket: true, isReserved: true });
  var rlk = splitLockRow(t, rec, render); if (rlk) wrap.appendChild(rlk);
  return wrap;
}

// Token issuance section for a stage (folded into the stage editor).
// Bonding-curve preview: token cash out value vs % of tokens cashed out, at tax rate r (0..1). The
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

// Hover the bonding-curve graph: show a dot + tooltip with "X% cashed out → Y% of funds" at the cursor.
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
    tip.style.display = ''; tip.textContent = (x * 100).toFixed(1) + '% cashed out → ' + (f * 100).toFixed(1) + '% of funds';
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

// The accounting token(s) the project's surplus is held in (for cash out copy). Custom → its symbol; ETH/USDC
// (either or both) → "ETH", "USDC", or "ETH and USDC" — honors a project that accepts more than one token.
function surplusTokenLabel(state) {
  if (customAccounting(state)) return customAcctSym(state) || 'TOKEN';
  var a = state.accepts || [];
  var syms = [];
  if (a.indexOf('eth') !== -1) syms.push('ETH');
  if (a.indexOf('usdc') !== -1) syms.push('USDC');
  return syms.length ? syms.join(' and ') : 'ETH';
}
// Token cash out (rulesets) and item cash out (the 721 store) are MUTUALLY EXCLUSIVE onchain: with the 721
// hook as the cash out data hook, JB721Hook.beforeCashOutRecordedWith reverts on any project-token cash out
// (JB721Hook.sol:107). So enabling one idles the other in the UI.
function itemCashOutOn(state) { return !!(state.shopEnabled && state.collection && state.collection.useForRedemptions); }
function anyTokenCashOut(state) { return (state.stages || []).some(function (s) { return s.cashOutEnabled; }); }

// Cash out access for token holders — they reclaim a share of the project's surplus by burning tokens.
// Lives next to the owner's surplus allowance (both draw from surplus). Tax rate shapes the bonding curve.
function cashOutSection(state, stage, render) {
  var t = stage;
  var wrap = el('div', '');
  var label = surplusTokenLabel(state);
  // Item cash out (Shop) overrides token cash out — they can't both be on. Idle the token toggle, but keep the
  // tax card: the same ruleset cashOutTaxRate governs item redemption (JB721Hook forwards it).
  if (itemCashOutOn(state) && !t.cashOutEnabled) {
    wrap.appendChild(idleToggle('Give tokens cash out access to surplus funds', 'Items cash out for surplus instead (enabled in the Shop) — tokens and items can’t both be cashed out.'));
    wrap.appendChild(cashOutTaxCard(t, render, label));
    wrap.appendChild(infoNote('This cash out tax applies to item redemptions.'));
    return wrap;
  }
  wrap.appendChild(toggleRow('Give tokens cash out access to surplus funds', dz('Token holders can cash out their tokens for a share of the project’s surplus ' + label + '.', 'Token holders can’t cash out their tokens.'), t.cashOutEnabled, function (v) { t.cashOutEnabled = v; render(); }));
  if (t.cashOutEnabled) wrap.appendChild(cashOutTaxCard(t, render, label));
  return wrap;
}

// The cash out tax chips + bonding-curve preview, shared by the custom flow's cashOutSection and the revnet
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
    var pct10 = 0.1 * ((1 - r) + r * 0.1) * 100; // % of funds for cashing out 10% of supply
    sub.textContent = reclaimVerb
      ? ('Cashing out 10% of $' + reclaimVerb + ' gets ' + (Math.round(pct10 * 10) / 10) + '% of the revnet’s ' + acctSym + '.')
      : ('Cashing out 10% of your tokens returns ' + (Math.round(pct10 * 10) / 10) + '% of the project’s surplus ' + acctSym + '.');
    svgHolder.innerHTML = cashOutCurveSvg(r);
  };
  if (isCustom) {
    var crow = el('div', 'create-inline-row');
    // Contract requires cashOutTaxRate STRICTLY < MAX (100%); 1.0 reverts. Cap at 0.99 (step is 0.01).
    var cin = el('input', 'field create-inline-num'); cin.type = 'number'; cin.min = '0'; cin.max = '0.99'; cin.step = '0.01'; cin.value = String(Math.round(t.cashOutTaxRate) / 100);
    cin.addEventListener('input', function () { t.cashOutTaxRate = Math.max(0, Math.min(0.99, Number(cin.value) || 0)) * 100; cashViz(); });
    crow.appendChild(document.createTextNode('Cash out tax ')); crow.appendChild(cin); crow.appendChild(document.createTextNode(' (0–1)'));
    coCard.appendChild(crow);
  }
  cashViz();
  coCard.appendChild(sub);
  coCard.appendChild(graphWrap);
  attachCurveHover(graphWrap, svgHolder, function () { return Math.max(0, Math.min(100, Number(t.cashOutTaxRate) || 0)) / 100; });
  return coCard;
}

function tokenSection(stage, render, state, stageIdx) {
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
      row.appendChild(document.createTextNode(' tokens '));
      // Keep "per" attached to the currency selector so they wrap together as "per [ETH]".
      var perUnit = el('span', 'create-inline-unit');
      perUnit.appendChild(document.createTextNode('per '));
      perUnit.appendChild(currencySelect(t.baseCurrency, function (v) { t.baseCurrency = v; render(); }, null, lockedCurrencySym(state)));
      row.appendChild(perUnit);
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
    t.reservedRecipients.forEach(function (rec, i) { card.appendChild(reservedSplitRow(t, rec, i, render, updateReservedSummary, state, stageIdx)); });
    var addSplit = el('button', 'operator-cta create-add-link'); addSplit.textContent = '+ Add split'; addSplit.style.marginTop = '14px';
    addSplit.addEventListener('click', function (e) { e.preventDefault(); t.reservedRecipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0 }); render(); });
    card.appendChild(addSplit);
    updateReservedSummary(); card.appendChild(sumNote);

    wrap.appendChild(card);
  }

  // Token options apply whether or not THIS stage issues tokens (tokens can exist from prior stages or
  // owner mints) — always shown, each in its own container like the issuance section.
  wrap.appendChild(toggleRow('Give project owner privileged access to tokens', dz('The project owner can mint any amount of project tokens without paying.', 'The project owner can’t mint tokens without paying.'), t.allowOwnerMinting, function (v) { t.allowOwnerMinting = v; }));
  var transferCopy = t.tokenMode === 'custom'
    ? 'Internal project credits can be transferred until they are claimed as ERC-20 tokens.'
    : 'This stage issues no credits. Existing credits from earlier stages can still be transferred.';
  wrap.appendChild(toggleRow('Pause internal credit transfers', dz('Existing internal credits can’t be transferred. Claimed ERC-20 tokens remain transferable.', transferCopy), t.pauseTransfers, function (v) { t.pauseTransfers = v; }));
  var itemTransferOff = state.projectType === 'revnet'
    ? 'Eligible items remain transferable during this precommitted stage.'
    : 'Eligible items remain transferable during this ruleset.';
  wrap.appendChild(toggleRow('Pause eligible shop item transfers', dz(
    'Items created with “Transfers pausable” can’t move between wallets. Minting and burning still work.',
    itemTransferOff,
  ), t.pause721Transfers, function (v) { t.pause721Transfers = v; }));
  return wrap;
}

// ---------------------------------------------------------------------------
// Step 4: NFTs
// ---------------------------------------------------------------------------

// Collection name/symbol default to the project name set in Details (empty if none); the project owner
// can change them onchain later. Once the user edits a field, their value sticks.
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
  f.appendChild(fieldBlock('Collection symbol', false, (function () {
    var s = textInput(collectionSymbolOf(state), state.details.ticker || 'Symbol', function (v) { c.symbol = v; c.symbolTouched = true; });
    s.classList.add('create-symbol-field'); // a symbol is short — 1/4 width
    return s;
  })()));

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
  f.appendChild(toggleRow('Lock project owner minting after launch', dz('New items added after launch can’t let the project owner mint for free.', 'New items added after launch can let the project owner mint for free.'), c.noNewTiersWithOwnerMinting, function (v) { c.noNewTiersWithOwnerMinting = v; }));
  f.appendChild(toggleRow(SPLIT_SALES_TOKEN_CREDIT_TITLE, dz(SPLIT_SALES_TOKEN_CREDIT_ON, SPLIT_SALES_TOKEN_CREDIT_OFF), c.issueTokensForSplits, function (v) { c.issueTokensForSplits = v; }));
  // useDataHookForCashOut — item holders redeem items against project surplus. Revnets force this on at the
  // deployer (so it's custom-only). Mutually exclusive with TOKEN cash out (set in rulesets): the 721 hook
  // reverts on any token cash out, so if token cash outs are on we idle this instead of letting both be set.
  if (state.projectType !== 'revnet') {
    if (anyTokenCashOut(state) && !c.useForRedemptions) {
      f.appendChild(idleToggle('Give items cash out access to surplus funds', 'Token cash outs are enabled in your rulesets — tokens and items can’t both be cashed out. Turn off token cash outs to let items redeem.'));
    } else {
      f.appendChild(toggleRow('Give items cash out access to surplus funds', dz('Item holders can cash out their items for a share of the project’s surplus ' + surplusTokenLabel(state) + '.', 'Items can’t be cashed out — they grant no claim on surplus.'), c.useForRedemptions, function (v) { c.useForRedemptions = v; render(); }));
      if (c.useForRedemptions) f.appendChild(infoNote('Items redeem at the cash out tax you set in your rulesets.'));
    }
  }

  // Revnet operator 721 permissions — REVDeployer grants the operator all four by default; these let the
  // user revoke individual ones at deploy time (encoded as the REVDeploy721TiersHookConfig preventOperator* flags).
  if (state.projectType === 'revnet') {
    var opHead = el('div', 'create-label'); opHead.style.marginTop = '16px'; opHead.textContent = 'Revnet operator store permissions'; f.appendChild(opHead);
    var opNote = el('div', 'create-hint'); opNote.textContent = 'What the revnet’s revnet operator can do to the store after launch.'; f.appendChild(opNote);
    f.appendChild(toggleRow('Revnet operator can add & remove items', dz('The revnet operator can adjust the store’s items.', 'The revnet operator can’t change the store’s items.'), c.opCanAdjustTiers, function (v) { c.opCanAdjustTiers = v; }));
    f.appendChild(toggleRow('Revnet operator can update item metadata', dz('The revnet operator can update the store’s metadata.', 'The revnet operator can’t update the store’s metadata.'), c.opCanUpdateMetadata, function (v) { c.opCanUpdateMetadata = v; }));
    f.appendChild(toggleRow('Revnet operator can mint items for free', dz('The revnet operator can mint shop items from inventory without paying.', 'The revnet operator pays like everyone else.'), c.opCanMint, function (v) { c.opCanMint = v; }));
    f.appendChild(toggleRow('Revnet operator can increase discounts', dz('The revnet operator can raise an item’s discount.', 'The revnet operator can’t raise item discounts.'), c.opCanIncreaseDiscount, function (v) { c.opCanIncreaseDiscount = v; }));
  }
  return f;
}

// Store-item price currency (independent of the ruleset base currency).
function storeCur(state) { return state.storePricingCurrency || 1; }
function storeUnit(state) { return customAccounting(state) ? customAcctSym(state) : (storeCur(state) === 2 ? 'USD' : 'ETH'); }
function storeDecimals(state) { return customAccounting(state) ? customAcctDecimals(state) : (storeCur(state) === 2 ? 6 : 18); }

export function renderNfts(state, render) {
  var wrap = el('div', '');
  var head = stepHead('Shop', 'Sell items to customers and supporters.');
  wrap.appendChild(head);

  // Store pricing currency — what every item's price is denominated in.
  wrap.appendChild(fieldBlock('Store pricing currency', false, (function () {
    var sel = currencySelect(storeCur(state), function (v) { state.storePricingCurrency = v; render(); }, 'field create-input', lockedCurrencySym(state));
    sel.style.width = 'auto'; sel.style.minWidth = '0';
    return sel;
  })()));

  // Opt-in: the Shop is off by default. Ticking it on reveals the first item to fill out.
  wrap.appendChild(toggleRow('Launch with items in stock', dz('The project launches with items already for sale.', 'The ' + (state.projectType === 'revnet' ? 'revnet operator' : 'project owner') + ' can add items after launch.'), state.shopEnabled, function (v) {
    state.shopEnabled = v;
    if (v && !state.nfts.length) state.nfts.push(itemDraft());
    render();
  }));

  if (state.shopEnabled) {
    state.nfts.forEach(function (nft, idx) { wrap.appendChild(itemCard(state, nft, idx, render)); });

    var add = el('button', 'operator-cta create-add-link'); add.textContent = '+ Add item';
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
  var extras = collapse(state.collection, 'extrasOpen', 'Store config', false, render, function () { return collectionExtrasSection(state, render); });
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
  var caret = el('span', 'create-stage-caret'); caret.textContent = nft.expanded ? '▾' : '▸'; head.appendChild(caret);
  card.appendChild(head);
  if (nft.expanded) card.appendChild(itemEditor(state, nft, idx, render));
  return card;
}

function itemSummary(state, nft) {
  var unit = storeUnit(state);
  var parts = [];
  parts.push((nft.price ? nft.price : '0') + ' ' + unit);
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
  else if (nft.imageUri && (nft.mediaType || '').indexOf('audio') === 0) {
    var audioPrev = el('span', 'operator-edit-logo-prev operator-edit-audio-prev'); audioPrev.setAttribute('role', 'img'); audioPrev.setAttribute('aria-label', 'Audio preview'); audioPrev.textContent = '♪'; w.appendChild(audioPrev);
  }
  else if (nft.imageUri) { var hint = el('span', 'operator-edit-hint'); hint.textContent = (nft.mediaType || 'file') + ' | pinned'; w.appendChild(hint); }
  var file = el('input', 'operator-edit-logo-file'); file.type = 'file';
  file.accept = 'image/*,video/*,audio/*,application/pdf,text/*,.md,.markdown';
  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (!f) return;
    function fail(msg) { nft._mediaBusy = false; nft._mediaError = msg; render(); alert(msg); }
    if (!hasPinata()) { fail('Add a Pinata JWT in the Store config section to upload media.'); return; }
    if (f.size > ITEM_MAX_MEDIA_BYTES) { fail('That file is ' + itemFileSize(f.size) + ' — over the ' + ITEM_MAX_MEDIA_MB + ' MB max.'); return; }
    nft._mediaBusy = true; nft._mediaError = ''; render();
    pinFile(f, nft.name || f.name).then(function (uri) {
      nft.imageUri = uri; nft.mediaType = mediaTypeForFile(f); nft._mediaBusy = false; nft._mediaError = ''; render();
    }).catch(function (e) {
      fail('Could not upload: ' + (e && e.message || e));
    });
  });
  w.appendChild(file);
  if (nft._mediaBusy) { var b = el('span', 'operator-edit-hint'); b.textContent = 'Pinning…'; w.appendChild(b); }
  if (nft._mediaError) { var er = el('span', 'operator-edit-hint warn'); er.textContent = nft._mediaError; w.appendChild(er); }
  if (nft.imageUri) { var clr = el('button', 'operator-edit-logo-clear'); clr.textContent = '✕'; clr.title = 'Remove'; clr.addEventListener('click', function (e) { e.preventDefault(); nft.imageUri = ''; nft.mediaType = ''; nft._mediaError = ''; render(); }); w.appendChild(clr); }
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

  // Split/discount gating only changes when price crosses zero. Re-rendering after every positive-to-positive
  // edit can remove the DOM target during blur, causing the checkbox click that follows to hit a stale node.
  var priceInput = textInput(nft.price, '0.0', function (v) { nft.price = v.trim(); });
  var hadPrice = parseFloat(nft.price) > 0;
  priceInput.addEventListener('change', function () {
    if ((parseFloat(nft.price) > 0) !== hadPrice) render();
  });
  c.appendChild(fieldBlock('Price (' + priceUnit + ')', false, priceInput));

  // Split sales + Initial discount only make sense once there's a price — always shown, idle when free.
  var hasPrice = parseFloat(nft.price) > 0;
  if (!hasPrice) {
    c.appendChild(idleToggle('Split sales', 'Set a price above to split each sale.'));
    c.appendChild(idleToggle('Initial discount', 'Set a price above to start the item at a discount.'));
  } else {
    c.appendChild(toggleRow('Split sales', dz('Send part of each sale to other addresses or projects; the rest goes to this project.', 'The whole sale goes to this project.'), nft.splitOn, function (v) { nft.splitOn = v; if (v && !nft.splitRecipients.length) nft.splitRecipients.push({ pct: '', recip: '', benef: '' }); render(); }));
    if (nft.splitOn) {
      var sc = el('div', 'create-subcard');
      nft.splitRecipients.forEach(function (rec, i) { sc.appendChild(itemSplitRow(state, nft, rec, i, render)); });
      var addS = el('button', 'operator-cta create-add-link'); addS.textContent = '+ Add recipient'; addS.style.marginTop = '12px';
      addS.addEventListener('click', function (e) { e.preventDefault(); nft.splitRecipients.push({ pct: '', recip: '', benef: '' }); render(); });
      sc.appendChild(addS);
      if (nft.flags.allowCredits) sc.appendChild(warnNote('Buying with shop credit bypasses this split — the split only divides new payment, and a credit purchase brings in little or none. To make every sale honor the split, turn off “Allow credit purchases” under Extra options.'));
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
  if (nft.limited) {
    c.appendChild(fieldBlock('Quantity', false, textInput(nft.supply, '100', function (v) { nft.supply = v.trim(); })));
    // Each chain's shop carries its own inventory — the quantity can differ per chain.
    c.appendChild(perChainSupplyControl(state, render, 'isup:' + idx, nft.supply || ''));
  }

  // Category
  var catField = el('div', 'create-field');
  var catLbl = el('label', 'create-label'); catLbl.textContent = 'Category'; catField.appendChild(catLbl);
  var catHint = el('div', 'create-hint'); catHint.textContent = 'Items being sold can be organized by category.'; catField.appendChild(catHint);
  if (nft._catAdding) {
    var caRow = el('div', 'create-inline-row');
    var caInp = el('input', 'field create-input'); caInp.type = 'text'; caInp.placeholder = 'category name'; caInp.value = nft._catName || '';
    caInp.addEventListener('input', function () { nft._catName = caInp.value; });
    var caSave = el('button', 'operator-cta'); caSave.textContent = 'Save'; caSave.style.marginLeft = '8px';
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
      // attachEns fires store() synchronously at attach time; an unconditional render() here recurses
      // (render → attachEns → store → render) until the stack blows and the wizard body vanishes.
      // Only re-render when an ENS resolution lands (async, addr set) while the missing-beneficiary warn is up.
      var warnShown = Number(nft.reserveFrequency) > 0 && !isAddr(resolvedStr(nft.reserveBeneficiary));
      var bHint = attachEns(bInp, function (name, addr) { if (addr && warnShown) render(); }, { chainId: (state.chainIds || [])[0] }); // resolves on mainnet; populates the global ENS cache resolvedStr reads
      rRow.appendChild(recipBoxWith(bInp, bHint)); a.appendChild(rRow);
      // Reserving requires a beneficiary, or the deploy reverts (JB721TiersHookStore_MissingReserveBeneficiary).
      if (Number(nft.reserveFrequency) > 0 && !isAddr(resolvedStr(nft.reserveBeneficiary))) {
        a.appendChild(warnNote('Add the address that receives the reserved set-aside, or this item will fail to deploy.'));
      }
    }
    var minter = state.projectType === 'revnet' ? 'revnet operator' : 'project owner';
    a.appendChild(toggleRow(minter.charAt(0).toUpperCase() + minter.slice(1) + ' can mint for free', dz('The ' + minter + ' can mint this item from inventory without paying.', 'The ' + minter + ' pays like everyone else.'), nft.flags.allowOwnerMint, function (v) { nft.flags.allowOwnerMint = v; }));
    a.appendChild(toggleRow('Transfers pausable per ruleset', dz('This item’s transfers can be paused during a ruleset.', 'This item’s transfers can’t be paused.'), nft.flags.transfersPausable, function (v) { nft.flags.transfersPausable = v; }));
    a.appendChild(toggleRow('Permanent', dz('This item can never be removed from the store.', 'This item can be removed later.'), nft.flags.cantBeRemoved, function (v) { nft.flags.cantBeRemoved = v; }));
    a.appendChild(toggleRow('Allow credit purchases', dz('Payments that don’t buy an item become credit usable on items that allow it.', 'Payments that don’t buy this item don’t earn credit toward it.'), nft.flags.allowCredits, function (v) { nft.flags.allowCredits = v; }));
    a.appendChild(toggleRow(minter.charAt(0).toUpperCase() + minter.slice(1) + ' can edit discounts', dz('The ' + minter + ' can change this item’s discount later.', 'This item’s discount is locked.'), nft.flags.ownerCanEditDiscount, function (v) { nft.flags.ownerCanEditDiscount = v; }));
    a.appendChild(toggleRow('Custom voting units', dz('Give this item a specific governance weight.', 'Governance weight follows the item price.'), nft.votingOn, function (v) { nft.votingOn = v; if (!v) nft.votingUnits = ''; render(); }));
    if (nft.votingOn) a.appendChild(fieldBlock('Voting units', false, textInput(nft.votingUnits, '0', function (v) { nft.votingUnits = v.trim(); })));
    return a;
  }));
  return c;
}

function itemSplitRow(state, nft, rec, idx, render) {
  var wrap = el('div', 'create-split-wrap');
  if (idx > 0) wrap.style.marginTop = '12px';
  var row = el('div', 'create-split-row');
  var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Send' : '… and'; row.appendChild(lead);
  var pct = el('input', 'field create-split-pct'); pct.type = 'number'; pct.min = '0'; pct.step = 'any'; pct.placeholder = '10'; pct.value = rec.pct || '';
  pct.addEventListener('input', function () { rec.pct = pct.value.trim(); }); row.appendChild(pct);
  var sign = el('span', 'create-split-sign'); sign.textContent = '%'; row.appendChild(sign);
  var to = el('span', 'create-split-to'); to.textContent = 'to'; row.appendChild(to);
  var recip = el('input', 'field create-split-recip'); recip.type = 'text'; recip.placeholder = '0x…, name.eth, or project ID'; recip.value = rec.recip || '';
  var ensHint = attachEns(recip, function (name, addr) { rec.resolvedFor = addr ? name : null; rec.resolvedAddress = addr || null; });
  var projectHint = attachProjectIdResolver(recip, state && state.chainIds || [], { silentUnlessNumeric: true });
  var rm = el('button', 'create-split-rm'); rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = nft.splitRecipients.indexOf(rec); if (i >= 0) nft.splitRecipients.splice(i, 1); render(); });
  var recipientBox = recipBoxWith(recip, ensHint); recipientBox.appendChild(projectHint);
  row.appendChild(recipientBox); row.appendChild(rm); wrap.appendChild(row);
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
  warn.appendChild(toggleRow('Allow setting payment terminals', dz('The project owner can add/remove payment terminals at any time. This lets the project upgrade, but also lets the project owner reroute where funds flow at will.', 'Payment terminals are fixed for this ruleset.'), stage.allowSetTerminals, function (v) { stage.allowSetTerminals = v; }));
  warn.appendChild(toggleRow('Allow setting controller', dz('The project owner can change the project’s controller at any time. This lets the project upgrade, but can also be used by the project owner to change all the rules at will.', 'The controller is fixed for this ruleset.'), stage.allowSetController, function (v) { stage.allowSetController = v; }));
  warn.appendChild(toggleRow('Allow terminal migration', dz('The project owner can migrate the project’s terminals to a new version. This lets the project upgrade, but can also be used by the project owner to move all funds to a terminal of their choosing.', 'Terminal migration is disabled.'), stage.allowTerminalMigration, function (v) { stage.allowTerminalMigration = v; }));
  warn.appendChild(toggleRow('Allow setting a custom token', dz('The project owner can replace the project’s token with a custom ERC-20 of their choosing.', 'The project token can’t be swapped for a custom one.'), stage.allowSetCustomToken, function (v) { stage.allowSetCustomToken = v; }));
  warn.appendChild(toggleRow('Allow adding accounting tokens', dz('The project owner can add new accounting tokens the project holds at any time.', 'The set of accounting tokens is fixed for this ruleset.'), stage.allowAddAccountingContext, function (v) { stage.allowAddAccountingContext = v; }));
  warn.appendChild(toggleRow('Allow adding price feeds', dz('The project owner can add price feeds the project uses to convert currencies.', 'Price feeds can’t be added during this ruleset.'), stage.allowAddPriceFeed, function (v) { stage.allowAddPriceFeed = v; }));
  c.appendChild(warn);
  return c;
}

// ---------------------------------------------------------------------------
// Step 6: Deploy
// ---------------------------------------------------------------------------

// Settlement — how/where the project settles: accounting token, chains, and per-chain refinements.
// Chain multi-select (canonical names) + the bridge selector shown when >1 chain is chosen. Shared by the
// custom Settlement step and the revnet Deploy step.
function chainBridgeBlock(state, render) {
  var wrap = el('div', ''); wrap.style.marginBottom = '18px'; // breathing room before the owner/operator field
  // "On [Mainnets ▾]" — the network is part of the sentence, like the pay box's "[Pay ▾] on <chain>".
  // Without it, the chain pills read "Base" in BOTH modes and a wrong-network draft is invisible.
  var labelRow = el('div', 'create-net-row');
  var label = el('div', 'create-label'); label.textContent = 'On'; labelRow.appendChild(label);
  var netSel = el('select', 'paybox-select paybox-mode');
  [['mainnet', 'Mainnets'], ['testnet', 'Testnets']].forEach(function (o) {
    var op = el('option'); op.value = o[0]; op.textContent = o[1]; if (state.network === o[0]) op.selected = true; netSel.appendChild(op);
  });
  netSel.addEventListener('change', function () {
    setWizardNetwork(state, netSel.value);
    try { localStorage.setItem('jb-network', state.network); } catch (_) {} // keep the site-level toggle in step
    if (customAccounting(state) && isAddr((state.customToken || {}).address)) lookupCustomToken(state, render);
    render();
  });
  labelRow.appendChild(netSel);
  wrap.appendChild(labelRow);
  var chainRow = el('div', 'create-chain-row');
  CHAIN_PAIRS.forEach(function (p) {
    var actual = actualChainId(p.canon, state.network);
    var on = state.chainIds.indexOf(actual) !== -1;
    var pill = el('button', 'create-chain-pill' + (on ? ' selected' : ''));
    pill.textContent = chainName(actual); // "Base" in mainnet mode, "Base Sepolia" in testnet mode
    pill.addEventListener('click', function () {
      var ids = state.chainIds.slice();
      if (on) ids = ids.filter(function (x) { return x !== actual; });
      else ids.push(actual);
      state.chainIds = ids.length ? ids : [actual];
      if (customAccounting(state) && isAddr(state.customToken.address)) lookupCustomToken(state, render); // re-verify the token on the new chain set
      render();
    });
    chainRow.appendChild(pill);
  });
  wrap.appendChild(chainRow);

  if (state.chainIds.length > 1) {
    // Single line, with "linked" as the toggle that opens the bridge selector.
    var note = el('div', 'create-hint');
    note.appendChild(document.createTextNode('Your project will exist on ' + state.chainIds.length + ' chains, '));
    var linked = el('button', 'create-inline-toggle'); linked.textContent = 'linked'; linked.title = 'Choose how the chains are connected';
    linked.addEventListener('click', function (e) { e.preventDefault(); state._bridgeOpen = !state._bridgeOpen; render(); });
    note.appendChild(linked);
    note.appendChild(document.createTextNode(' so your token and balances can move between them.'));
    wrap.appendChild(note);

    if (state._bridgeOpen) {
      // Compact inline bridge selector: "Connect chains via [select]" + the always-shown explanation.
      var bRow = el('div', 'create-inline-row'); bRow.style.marginTop = '12px';
      bRow.appendChild(document.createTextNode('Connect chains via '));
      var bsel = el('select', 'field create-input'); bsel.style.width = 'auto'; bsel.style.minWidth = '0';
      [['native', 'Native bridges'], ['ccip', 'CCIP'], ['both', 'Native and CCIP']].forEach(function (o) {
        var op = el('option'); op.value = o[0]; op.textContent = o[1]; if ((state.suckerType || 'both') === o[0]) op.selected = true; bsel.appendChild(op);
      });
      bsel.addEventListener('change', function () { state.suckerType = bsel.value; render(); });
      bRow.appendChild(bsel);
      wrap.appendChild(bRow);
      var bh = el('div', 'create-hint'); bh.textContent = 'Native bridges connect Ethereum with L2s (strongest guarantees). CCIP (Chainlink) connects any chains. Native and CCIP gives the broadest coverage.'; wrap.appendChild(bh);
    }
    var usdcAcct = (state.accepts || [])[0] === 'usdc';
    if (usdcAcct && state.suckerType !== 'ccip') {
      wrap.appendChild(state.suckerType === 'native'
        ? warnNote('USDC moves between chains over CCIP only — native bridges can’t carry canonical USDC. Choose CCIP (or Native and CCIP) to link these chains.')
        : infoNote('USDC moves between chains over CCIP only, so this project links its chains with CCIP suckers.'));
    }
    var unc = uncoveredPairs(state);
    if (unc.length && !(usdcAcct && state.suckerType === 'native')) wrap.appendChild(warnNote('' + unc.length + ' chain pair' + (unc.length > 1 ? 's' : '') + ' can’t connect with native bridges (they only link Ethereum↔L2). Choose CCIP or Native and CCIP to link L2↔L2 pairs.'));
  } else {
    wrap.appendChild(infoNote('Deploys on a single chain. ' + (state.projectType === 'revnet'
      ? 'The revnet operator can add more chains later if they exactly match the configuration deployed now.'
      : 'The project owner can add more chains later.')));
  }
  return wrap;
}


// Selected-chain pairs that won't link under the chosen sucker type — no deployer for the pair (e.g.
// L2↔L2 under native bridges), or no bridge that can safely carry the accounting token (USDC needs CCIP).
function uncoveredPairs(state) {
  var ids = state.chainIds, out = [];
  for (var i = 0; i < ids.length; i++) for (var j = i + 1; j < ids.length; j++) {
    var a = ids[i], b = ids[j];
    var ok = bridgesForType(state.suckerType).some(function (br) {
      return suckerDeployerForBridge(a, b, br) && tokenMappingFor(a, b, state.accepts, br);
    });
    if (!ok) out.push([a, b]);
  }
  return out;
}

function renderDeploy(state, render) {
  var isRev = state.projectType === 'revnet';
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Review & deploy', isRev ? 'Review, then deploy your revnet.' : 'Review your project, then launch.'));

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

  // The first stage's start is frozen at build time (+10 min) because every chain must encode
  // the SAME value — the cross-chain configuration hash, and the deterministic addresses
  // derived from it, depend on it. A Safe collecting signatures for days therefore executes a
  // launch whose stage 1 already began, with issuance-cut cycles elapsed against what was
  // reviewed. Nothing can be re-derived at execution time without breaking the hash, so say so.
  if (isSafeConnected()) {
    wrap.appendChild(infoNote('This launch pins its start time now (about 10 minutes out) so every chain encodes the same value — that shared value is what links your chains together. If your multisig executes days later, stage 1 will already have begun and some of its scheduled issuance cuts may have passed. Execute promptly, or re-create the launch when you are ready to sign.'));
  }

  // ToS + launch
  var tos = el('label', 'create-tos');
  var cb = el('input', ''); cb.type = 'checkbox'; cb.checked = state.tos;
  cb.addEventListener('change', function () { state.tos = cb.checked; updateLaunch(); });
  tos.appendChild(cb);
  var tosContent = el('span', '');
  tosContent.appendChild(document.createTextNode(' I understand this is a public protocol that can’t be changed and accept the risks of deploying. '));
  var auditLink = el('button', 'create-audit-link'); auditLink.textContent = '[copy system audit prompt]';
  // preventDefault stops the surrounding label from toggling the checkbox when the link is clicked.
  auditLink.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var p = getAuditPrompt();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(p).then(function () {
        auditLink.textContent = '[copied to clipboard]';
        setTimeout(function () { auditLink.textContent = '[copy system audit prompt]'; }, 2000);
      }).catch(function () {});
    }
  });
  tosContent.appendChild(auditLink);
  tos.appendChild(tosContent);
  wrap.appendChild(tos);

  if (!hasPinata()) wrap.appendChild(infoNote('IPFS pinning isn’t configured, so your logo & metadata will be skipped at launch — you can add them later by editing the project.'));

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
        ic.textContent = p.status.kind === 'ok' ? 'done' : 'failed';
        row.appendChild(ic);
      }
      var nm = el('span', 'create-deploy-name'); nm.textContent = chainName(p.chainId); row.appendChild(nm);
      var st = el('span', 'create-deploy-state create-deploy-' + p.status.kind); st.textContent = p.status.label; row.appendChild(st);
      prog.appendChild(row);
    });
    wrap.appendChild(prog);
  }

  // A Relayr payment may outlive this polling window or even the page. Restore its receipt before showing
  // Launch again, and make the only available action re-check that SAME bundle. Only hit localStorage when
  // there is no live session — during active polling this renders every tick.
  if (!state._relayrPending) state._relayrPending = loadRelayrPendingSession(CREATE_RELAYR_SCOPE);
  if (state._relayrPending) {
    wrap.appendChild(createRelayrReceiptNode(state._relayrPending, state.deploying, function () { deploy(state, render); }, function () {
      state._relayrPending = null; state.deployProgress = null;
      state.statusLines.push({ text: 'Saved Relayr receipt cleared. Review every chain before launching missing work.', err: true });
      render();
    }));
    return wrap;
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

  // Network is chosen on the Flavor step's "On [Mainnets ▾]" toggle — no separate picker here.
  var needTicker = isRev && !state.details.ticker;
  var ownerRaw = pickResolved(state.details.owner, { resolvedAddress: state.details.ownerResolved, resolvedFor: state.details.ownerResolvedFor });
  var opRaw = pickResolved(state.revOperator, { resolvedAddress: state.revOperatorResolved, resolvedFor: state.revOperatorResolvedFor });
  var needOwner = !isRev && !isAddr(ownerRaw);
  var needOperator = isRev && !isAddr(opRaw);
  var needCustomToken = customAccounting(state) && !customReady(state); // custom accounting token not resolved yet
  var recipBad = recipientIssue(state); // a split/payout/auto-issuance with a value but no valid recipient
  var totalBad = splitTotalIssue(state); // a stage whose reserved/payout percentages sum over 100%
  var approvalBad = approvalIssue(state); // custom approval condition with no valid hook address on some chain
  var deadlineBad = deadlinePresetIssue(state); // preset approval hook (JBDeadline) unmanifested on a selected chain
  var lpBad = lpHookIssue(state); // Fund market split with the LP fee hook unmanifested on a selected chain
  var mediaBad = shopMediaUploadIssue(state); // never launch while an item attachment is pending/failed
  var exportRow = el('div', 'create-predeploy-export-row');
  var exportBeforeDeploy = el('button', 'create-io-btn create-predeploy-export');
  exportBeforeDeploy.type = 'button'; exportBeforeDeploy.textContent = 'Export your configuration';
  exportBeforeDeploy.title = 'Save this exact editable project draft before deploying';
  exportBeforeDeploy.disabled = !!state.deploying;
  exportBeforeDeploy.addEventListener('click', function () { exportDraftFile(state); });
  exportRow.appendChild(exportBeforeDeploy);
  wrap.appendChild(exportRow);
  var launch = el('button', 'create-btn primary big');
  function updateLaunch() {
    launch.disabled = state.deploying || !state.tos || !state.chainIds.length || !state.details.name || needTicker || needOwner || needOperator || needCustomToken || !!recipBad || !!totalBad || !!approvalBad || !!deadlineBad || !!lpBad || !!mediaBad || bad !== -1;
  }
  launch.textContent = state.deploying ? (isRev ? 'Deploying…' : 'Launching…') : (isRev ? 'Deploy revnet' : 'Launch project');
  launch.addEventListener('click', function () { deploy(state, render); });
  updateLaunch();
  wrap.appendChild(launch);
  // Spell out every reason the launch button is disabled, so the user knows exactly what to fix.
  if (!state.details.name) wrap.appendChild(infoNote('Add a project name on the Details step to ' + (isRev ? 'deploy.' : 'launch.')));
  if (needTicker) wrap.appendChild(infoNote('Add a token symbol on the Details step to deploy your revnet.'));
  if (needOwner) wrap.appendChild(infoNote('Set a project owner on the Flavor step to launch.'));
  if (needOperator) wrap.appendChild(infoNote('Set a revnet operator on the Flavor step to deploy your revnet.'));
  if (needCustomToken) wrap.appendChild(warnNote('Your custom accounting token isn’t verified on every selected chain yet — fix it on the Flavor step (same address, symbol, and decimals on each chain).'));
  if (recipBad) wrap.appendChild(warnNote(capitalize(recipBad) + ' Fix or remove it before deploying — otherwise those funds/tokens go to the zero address.'));
  if (totalBad) wrap.appendChild(warnNote(capitalize(totalBad) + ' Reduce a share on the ' + (isRev ? 'Stages' : 'Rulesets') + ' step (anything not allocated already goes to the project owner).'));
  if (approvalBad) wrap.appendChild(warnNote(approvalBad + ' Without it the approval condition silently becomes “none” (no review window for edits).'));
  if (deadlineBad) wrap.appendChild(warnNote(deadlineBad));
  if (lpBad) wrap.appendChild(warnNote(lpBad));
  if (mediaBad) wrap.appendChild(warnNote(mediaBad));
  if (!state.chainIds.length) wrap.appendChild(warnNote('Select at least one chain on the Flavor step before deploying.'));
  if (bad !== -1) wrap.appendChild(warnNote('Stage ' + (bad + 1) + ' has no duration but isn’t the last stage. Give it a duration on the Stages step so Stage ' + (bad + 2) + ' starts when its cycle ends.'));
  if (!state.tos) wrap.appendChild(infoNote('Check the box above to confirm you accept the risks before ' + (isRev ? 'deploying.' : 'launching.')));

  return wrap;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// When the approval condition is "Custom address", every selected chain must resolve to a real contract.
// A blank / mistyped / unresolved-ENS value would silently encode approvalHook = address(0) — no review
// window for owner edits — with nothing else to catch it, so it's a hard deploy gate.
function approvalIssue(state) {
  if (!(state.stages || []).some(function (s) { return s.deadline === 'custom'; })) return null;
  var def = pickResolved(state.approvalAddress, { resolvedAddress: state.approvalAddressResolved, resolvedFor: state.approvalAddressResolvedFor });
  var bad = (state.chainIds || []).filter(function (cid) { return !isAddr(chainAddr(state, cid, 'approval', def)); });
  if (!bad.length) return null;
  return 'The custom ruleset approval condition needs a valid contract address on ' + bad.map(function (c) { return chainName(c); }).join(', ') + '.';
}

// The Fund market ("Buyback liquidity") split routes reserved tokens through the shared
// JBP6FeeLPSplitHook. On a chain where that hook has no deployment the encoder cannot build the split,
// and a silent fallback would pay the LP share to a wallet on an immutable deploy — so it's a hard
// deploy gate naming the offending chains.
function lpHookIssue(state) {
  function hasLp(recips) {
    return (recips || []).some(function (r) { return r && r.type === 'lphook' && ((Number(r.percent) || 0) > 0 || (Number(r.amountEth) || 0) > 0); });
  }
  var uses = (state.stages || []).some(function (st) {
    if (hasLp(st.reservedRecipients) || hasLp(st.payoutRecipients)) return true;
    var byKind = st.payoutByKind || {};
    return Object.keys(byKind).some(function (k) { return byKind[k] && hasLp(byKind[k].recipients); });
  });
  if (!uses) return null;
  var bad = (state.chainIds || []).filter(function (cid) { return !getAddress('JBP6FeeLPSplitHook', cid); });
  if (!bad.length) return null;
  return 'The Fund market (LP fee) hook isn’t deployed on ' + bad.map(chainName).join(', ')
    + ' — remove the buyback-liquidity split or deselect the chain.';
}

// A preset approval condition ("1-day deadline" etc.) encodes a shared JBDeadline contract address.
// Where that deployment is missing the encoder would silently fall back to approvalHook = address(0) —
// no review window for owner edits — so, like a bad custom address (approvalIssue), it's a hard gate.
// Revnets configure no approval hook, and "none"/"custom" are covered elsewhere.
function deadlinePresetIssue(state) {
  if (state.projectType === 'revnet' || !deadlineApplies(state)) return null;
  for (var si = 0; si < (state.stages || []).length; si++) {
    var dl = DEADLINE_OPTIONS.find(function (d) { return d.key === state.stages[si].deadline; });
    if (!dl || !dl.contract) continue; // 'none' has no contract; 'custom' isn't a preset
    var bad = (state.chainIds || []).filter(function (cid) { return !getAddress(dl.contract, cid); });
    if (bad.length) {
      return 'The ' + dl.label + ' approval hook isn’t deployed on ' + bad.map(chainName).join(', ')
        + ' — pick a different approval condition or deselect the chain.';
    }
  }
  return null;
}

// Repopulate the volatile _ensCache for a custom approval-hook ENS name after a reload/import, so the
// Deploy-step gate (approvalIssue) sees the resolved address instead of treating a valid name as missing.
function reresolveApproval(state, render) {
  if (!(state.stages || []).some(function (s) { return s.deadline === 'custom'; })) return;
  if (!isEnsName(state.approvalAddress || '')) return;
  resolveEns(state.approvalAddress).then(function (addr) {
    if (addr) { state.approvalAddressResolved = addr; state.approvalAddressResolvedFor = (state.approvalAddress || '').trim(); if (render) render(); }
  });
}

// First stage whose reserved-token or percent-mode payout splits sum over 100% (silently clamped at build).
function splitTotalIssue(state) {
  var stages = state.stages || [];
  function over(recips) { return (recips || []).reduce(function (s, r) { return s + (Number(r.percent) || 0); }, 0); }
  for (var si = 0; si < stages.length; si++) {
    var st = stages[si]; var pre = stages.length > 1 ? ('stage ' + (si + 1) + ' ') : '';
    var rTot = over(st.reservedRecipients);
    if (rTot > 100.0001) return pre + 'reserved-token splits total ' + round2(rTot) + '%, over 100%.';
    var kinds = currentPayoutKinds(state);
    if (kinds && st.payoutByKind) {
      for (var ki = 0; ki < kinds.length; ki++) {
        var pk = st.payoutByKind[kinds[ki].key];
        if (pk && pk.mode === 'unlimited' && over(pk.recipients) > 100.0001) return pre + kinds[ki].symbol + ' payout splits total ' + round2(over(pk.recipients)) + '%, over 100%.';
      }
    } else if (st.payoutMode === 'unlimited' && over(st.payoutRecipients) > 100.0001) {
      return pre + 'payout splits total ' + round2(over(st.payoutRecipients)) + '%, over 100%.';
    }
  }
  return null;
}

// Walk every split / payout / auto-issuance recipient with a non-zero value; return a one-line description
// of the first that has no valid destination (so funds/tokens would be sent to 0x0), or null if all are fine.
function recipientIssue(state) {
  var stages = state.stages || [];
  function badSplit(recips, kindLabel, isPayout) {
    for (var i = 0; i < (recips || []).length; i++) {
      var r = recips[i];
      if (!((Number(r.percent) || 0) > 0 || (Number(r.amountEth) || 0) > 0)) continue; // empty row — ignore
      if (r.type === 'project') {
        if (!(Number(r.projectId) > 0)) return 'a ' + kindLabel + ' to a project is missing its project ID.';
        // A pay-to-project split mints the destination project's tokens. Leaving beneficiary empty hands those
        // tokens to whichever account eventually triggers distribution. Add-to-balance intentionally mints none.
        if ((!isPayout || !r.preferAddToBalance) && !isAddr(resolvedStr(pickResolved(r.address, r)))) {
          return 'a ' + kindLabel + ' to a project is missing the address that receives destination/fallback tokens.';
        }
      }
      else if (r.type === 'lphook') { /* fund-market hook needs no address */ }
      else if (r.type === 'customhook') { if (!isAddr(r.hookAddress)) return 'a ' + kindLabel + ' uses a custom hook with no valid hook address.'; }
      else if (!isAddr(resolvedStr(pickResolved(r.address, r)))) return 'a ' + kindLabel + ' has no valid recipient address.';
    }
    return null;
  }
  for (var si = 0; si < stages.length; si++) {
    var st = stages[si];
    var pre = stages.length > 1 ? ('on stage ' + (si + 1) + ', ') : '';
    var kinds = currentPayoutKinds(state);
    var checks = [badSplit(st.reservedRecipients, 'reserved-token split', false)];
    if (kinds && st.payoutByKind) kinds.forEach(function (k) { var pk = st.payoutByKind[k.key]; checks.push(pk && badSplit(pk.recipients, 'payout split', true)); });
    else checks.push(badSplit(st.payoutRecipients, 'payout split', true));
    for (var c = 0; c < checks.length; c++) if (checks[c]) return pre + checks[c];
    for (var a = 0; a < (st.autoIssuances || []).length; a++) {
      var ai = st.autoIssuances[a];
      if (!((Number(ai.count) || 0) > 0)) continue;
      // Validate the address the ENCODER will resolve: the per-chain override for the row's mint
      // chain (where the tokens land) when set, else the default. Checking only the default let a
      // bad override slip through validation and get silently dropped at encode time.
      var mintChain = aiMintChain(state, ai);
      var aiAddr = mintChain != null
        ? chainAddr(state, mintChain, 'ai:' + si + ':' + a, pickResolved(ai.address, ai))
        : resolvedStr(pickResolved(ai.address, ai));
      if (!isAddr(aiAddr)) {
        return pre + 'auto-issuance #' + (a + 1) + ' has no valid recipient address'
          + (mintChain != null && (state.chainIds || []).length > 1 ? ' on ' + chainName(mintChain) + ' (its mint chain)' : '') + '.';
      }
    }
  }
  return null;
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
// The ONE chain an auto-issuance row mints on: the row's stored choice while it's still a selected chain
// (canonical match, so a mainnet↔testnet switch keeps the pick, like the per-chain override store), else
// the first selected chain. Must be config-chain independent — every chain encodes the SAME row list and
// REVDeployer mints only rows whose chainId matches the local chain.
function aiMintChain(state, ai) {
  var ids = (state && state.chainIds) || [];
  var want = canonChainId(Number(ai && ai.chainId));
  for (var i = 0; i < ids.length; i++) if (canonChainId(ids[i]) === want) return ids[i];
  return ids[0];
}
// Per-chain payout amount for one stage recipient (override → default). Stored in the shared per-chain
// override store under 'pamt:<stage>:<recip>' so the "Set per chain" control machinery applies untouched.
function chainPayoutAmount(state, chainId, stageIdx, recipIdx) {
  return pcAddrGet(state, chainId, 'pamt:' + stageIdx + ':' + recipIdx, state.stages[stageIdx].payoutRecipients[recipIdx].amountEth);
}
// Per-chain payout amount for a per-token (kind) recipient — multi-token custom projects.
function chainKindPayoutAmount(state, chainId, kindKey, recipIdx, def) {
  return pcAddrGet(state, chainId, 'pkamt:' + kindKey + ':' + recipIdx, def);
}
function chainItemIncluded(state, chainId, itemIdx) {
  var pc = perChainPeek(state, chainId);
  var ov = pc && pc.items && pc.items[itemIdx];
  return ov ? ov.include !== false : true;
}
// Per-chain supply string for an item ('' = unlimited). Unlimited items have no per-chain supply.
function chainItemSupply(state, chainId, itemIdx) {
  var nft = state.nfts[itemIdx];
  if (!nft.limited) return '';
  return pcAddrGet(state, chainId, 'isup:' + itemIdx, nft.supply);
}

// An address input prefilled with the per-chain override (or default), with ENS resolution shown below.
function pcAddrField(state, chainId, key, defStr) {
  var input = el('input', 'field'); input.type = 'text'; input.placeholder = '0x… or name.eth';
  input.value = pcAddrGet(state, chainId, key, defStr || '');
  input.addEventListener('input', function () { pcAddrSet(state, chainId, key, input.value.trim()); });
  return recipBoxWith(input, attachEns(input, function () {}, { chainId: chainId }));
}
// Per-chain numeric field (project ID) — stored in the same `addr[key]` store as a raw string, no ENS.
function pcNumField(state, chainId, key, defStr) {
  var input = el('input', 'field create-split-recip'); input.type = 'number'; input.min = '1'; input.placeholder = 'ID';
  input.value = pcAddrGet(state, chainId, key, defStr || '');
  input.addEventListener('input', function () { pcAddrSet(state, chainId, key, input.value.trim()); });
  return recipBoxWith(input, attachProjectIdResolver(input, [chainId]));
}
// Per-chain amount field (payout amounts) — blank means "use the default", shown as the placeholder.
function pcAmountField(state, chainId, key, defStr) {
  var input = el('input', 'field create-inline-num create-payout-amt'); input.type = 'number'; input.min = '0'; input.step = 'any';
  input.placeholder = defStr || '0.0';
  input.value = pcAddrGet(state, chainId, key, '');
  input.addEventListener('input', function () { pcAddrSet(state, chainId, key, input.value.trim()); });
  return input;
}
// Per-chain whole-number field (store item supply) — blank means "use the default".
function pcSupplyField(state, chainId, key, defStr) {
  var input = el('input', 'field create-inline-num'); input.type = 'number'; input.min = '1'; input.step = '1';
  input.placeholder = defStr || '100';
  input.value = pcAddrGet(state, chainId, key, '');
  input.addEventListener('input', function () { pcAddrSet(state, chainId, key, input.value.trim()); });
  return input;
}

// Inline "same on all chains" control shown under an address field (only when >1 chain is selected). The
// address defaults to the same on every chain; clicking the indicator reveals a per-chain input for each
// chain (since an account may not exist at the same address on all chains). Overrides are stored under
// `key` in state.perChain[cid].addr and consumed by the deploy build via chainAddr(state, cid, key, def).
function perChainAddrControl(state, render, key, defStr, chains) {
  return perChainControl(state, render, key, defStr, pcAddrField, null, chains);
}
// Same control, numeric per-chain field — for project IDs (which differ per chain for the same project).
function perChainNumControl(state, render, key, defStr) {
  return perChainControl(state, render, key, defStr, pcNumField);
}
function perChainSupplyControl(state, render, key, defStr) {
  return perChainControl(state, render, key, defStr, pcSupplyField, 'Set quantity per chain');
}
// ONE "Set per chain" for a fixed-amount payout row: each chain's row carries the amount AND the
// recipient's chain-specific fields (wallet address, or project id + token beneficiary) together —
// two side-by-side per-field links read as clutter. Writes the same override keys the deploy build
// already consumes (pamt/pkamt, p/pk, ppid/pkpid).
function perChainPayoutRowControl(state, render, rec, keys, defaults) {
  var wrap = el('div', 'create-pcaddr');
  if ((state.chainIds || []).length < 2) return wrap;
  if (!state._pcOpen) state._pcOpen = {};
  var allKeys = [keys.amt, keys.addr, keys.pid].filter(Boolean);
  var hasOverrides = state.chainIds.some(function (cid) {
    var pc = perChainPeek(state, cid);
    return pc && pc.addr && allKeys.some(function (k) { return pc.addr[k]; });
  });
  var open = !!state._pcOpen[keys.amt] || hasOverrides;
  if (!open) {
    wrap.classList.add('create-pcaddr-collapsed');
    var link = el('button', 'create-pcaddr-toggle'); link.textContent = 'Set per chain';
    link.title = 'Set a different amount and recipient on each chain';
    link.addEventListener('click', function (e) { e.preventDefault(); state._pcOpen[keys.amt] = true; render(); });
    wrap.appendChild(link);
    return wrap;
  }
  var wantsPid = rec.type === 'project' || rec.type === 'customhook';
  var wantsAddr = rec.type === 'wallet' || !(rec.preferAddToBalance && rec.type === 'project');
  state.chainIds.forEach(function (cid) {
    var rowc = el('div', 'create-pcaddr-row');
    var nm = el('span', 'create-pcaddr-chain'); nm.appendChild(chainIcon(cid, chainName(cid))); rowc.appendChild(nm);
    rowc.appendChild(pcAmountField(state, cid, keys.amt, defaults.amt));
    if (wantsPid && keys.pid) rowc.appendChild(pcNumField(state, cid, keys.pid, defaults.pid));
    if (wantsAddr && keys.addr) rowc.appendChild(pcAddrField(state, cid, keys.addr, defaults.addr));
    wrap.appendChild(rowc);
  });
  var foot = el('div', 'create-pcaddr-foot');
  var collapse = el('button', 'create-pcaddr-toggle'); collapse.textContent = 'Use same on all chains';
  collapse.addEventListener('click', function (e) {
    e.preventDefault();
    state.chainIds.forEach(function (cid) {
      var pc = perChainPeek(state, cid);
      if (pc && pc.addr) allKeys.forEach(function (k) { delete pc.addr[k]; });
    });
    state._pcOpen[keys.amt] = false; render();
  });
  foot.appendChild(collapse); wrap.appendChild(foot);
  return wrap;
}
// `chains` (optional) scopes the control to a subset of the selected chains — e.g. an auto-issuance
// row's ONE mint chain, where fields for the other chains would be dead inputs the encoder ignores.
function perChainControl(state, render, key, defStr, fieldFn, linkLabel, chains) {
  var wrap = el('div', 'create-pcaddr');
  if ((state.chainIds || []).length < 2) return wrap; // single chain — nothing to differ
  var ids = (chains && chains.length ? chains : state.chainIds) || [];
  if (!state._pcOpen) state._pcOpen = {};
  var hasOverrides = ids.some(function (cid) { var pc = perChainPeek(state, cid); return pc && pc.addr && pc.addr[key]; });
  var open = !!state._pcOpen[key] || hasOverrides;
  if (!open) {
    wrap.classList.add('create-pcaddr-collapsed'); // right-align the link under the field
    var link = el('button', 'create-pcaddr-toggle');
    link.textContent = linkLabel || (ids.length === 1 ? 'Set address on ' + chainName(ids[0]) : 'Set per chain');
    link.title = ids.length === 1 ? 'Set a different value on ' + chainName(ids[0]) : 'Set a different value on each chain';
    link.addEventListener('click', function (e) { e.preventDefault(); state._pcOpen[key] = true; render(); });
    wrap.appendChild(link);
    return wrap;
  }
  // Per-chain rows first, so the top row lines up with the field/dropdown row it replaces…
  ids.forEach(function (cid) {
    var rowc = el('div', 'create-pcaddr-row');
    var nm = el('span', 'create-pcaddr-chain'); nm.appendChild(chainIcon(cid, chainName(cid))); rowc.appendChild(nm);
    rowc.appendChild(fieldFn(state, cid, key, defStr));
    wrap.appendChild(rowc);
  });
  // …then the "use same on all chains" collapse link beneath them (right-aligned, like "Set per chain").
  var foot = el('div', 'create-pcaddr-foot');
  var collapse = el('button', 'create-pcaddr-toggle');
  collapse.textContent = ids.length === 1 ? 'Use the default address' : 'Use same on all chains';
  collapse.addEventListener('click', function (e) {
    e.preventDefault();
    ids.forEach(function (cid) { var pc = perChainPeek(state, cid); if (pc && pc.addr) delete pc.addr[key]; });
    state._pcOpen[key] = false; render();
  });
  foot.appendChild(collapse);
  wrap.appendChild(foot);
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
    c.appendChild(row('Accounting token', surplusTokenLabel(state)));
    var opRaw = pickResolved(state.revOperator, { resolvedAddress: state.revOperatorResolved, resolvedFor: state.revOperatorResolvedFor });
    c.appendChild(row('Revnet operator', /^0x/.test(opRaw) ? shortAddr(opRaw) : (opRaw || '—')));
    c.appendChild(row('Stages', String(state.stages.length)));
    state.stages.forEach(function (s, i) { c.appendChild(row('Stage #' + (i + 1), revStageSummary(s, i, state))); });
    c.appendChild(row('Chains', state.chainIds.map(chainName).join(', ')));
    return c;
  }
  c.appendChild(row('Name', state.details.name || '—'));
  c.appendChild(row('Accounting token', surplusTokenLabel(state) + (state.swapRouter ? ' (+ any via router)' : '')));
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
    expanded: true, advOpen: false, _mediaBusy: false, _mediaError: '', _catAdding: false,
    name: '', description: '',
    imageUri: '', mediaType: '', metaUri: '', encodedIpfsUri: '',
    price: '', limited: false, supply: '',
    splitOn: false, splitRecipients: [],   // {pct, recip, benef}
    discountOn: false, discountPct: '',
    category: 0,
    reserveOn: false, reserveFrequency: '', reserveBeneficiary: '',
    votingOn: false, votingUnits: '',
    flags: { allowOwnerMint: false, transfersPausable: false, cantBeRemoved: false, allowCredits: true, ownerCanEditDiscount: true },
  };
}

// A pending/failed async media upload must never silently become a name-only onchain tier. The transient
// flags are intentionally excluded from .jb drafts; after a reload, an unpinned file must be selected again.
export function shopMediaUploadIssue(state) {
  if (!state || state.shopEnabled === false) return '';
  var items = (state && state.nfts) || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i]._mediaBusy) return 'Item ' + (i + 1) + ' media is still uploading.';
    if (items[i]._mediaError) return 'Item ' + (i + 1) + ' media upload failed. Choose the file again before continuing.';
  }
  return '';
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
  // Per-row rounding can drift the group a few atoms above 1e9, which reverts the deploy AFTER the IPFS
  // pin — correct through fillSplits like every other split builder.
  var shares = fillSplits(rsList.map(function (e) { return Math.round(Number(e.r.pct) / tot * SPLITS_TOTAL); }));
  var splits = rsList.map(function (e, k) {
    var r = e.r;
    var v = (r.recip || '').trim();
    var isProj = /^[0-9]+$/.test(v) && Number(v) > 0;
    // Per-chain wallet beneficiary override → default (ENS-resolved).
    var benef = state ? chainAddr(state, chainId, 'is:' + itemIdx + ':' + e.i, pickResolved(v, r)) : pickResolved(v, r);
    return {
      percent: shares[k],
      projectId: isProj ? BigInt(v) : 0n,
      beneficiary: isProj ? ((resolvedStr(r.benef) && isAddr(resolvedStr(r.benef))) ? resolvedStr(r.benef) : ZERO) : (addrOrZero(benef)),
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
  { sel: '0x8c4564bd', name: 'revdeployer_cashoutscantbeturnedoffcompletely', msg: 'A stage’s cash out tax is 100%, which fully blocks cash outs (not allowed for a revnet). Lower the cash out tax on the Stages step.' },
  { sel: '0x141d4794', name: 'revdeployer_stagesrequired', msg: 'A revnet needs at least one stage. Add a stage on the Stages step.' },
  { sel: '0x87971d24', name: 'jbrulesets_invalidweightcutpercent', msg: 'An issuance-cut percentage is out of range. Set it between 0 and 100% on the Rulesets/Stages step.' },
  { sel: '0xbad92c41', name: 'jb721tiershookstore_invalidquantity', msg: 'A store item’s quantity is too high (max 999,999,999). Lower it on the Shop step.' },
  { sel: '0x800e9368', name: 'jb721tiershookstore_missingreservebeneficiary', msg: 'A store item reserves inventory but has no beneficiary address. Add one on the Shop step (the item’s “Reserve inventory” row).' },
  { sel: '0xb99e376a', name: 'jb721tiershookstore_invalidcategorysortorder', msg: 'Store items are out of category order. On the Shop step, order items so their categories ascend.' },
];

// Turn a raw sim/contract/wallet error into a friendly, fixable message. Walks the cause chain so a custom
// error's 4-byte selector (or decoded name) is matched even when it's nested in viem's error data.
function friendlyDeployError(err) {
  var raw = errMessage(err, 'The transaction reverted.');
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
  if (relayrStateIsSuccess(s)) return { label: 'Deployed', kind: 'ok' };
  if (relayrStateIsFailed(s)) return { label: 'Failed', kind: 'err' };
  return { label: 'Deploying…', kind: 'pending' };
}

var CREATE_RELAYR_SCOPE = 'create-project';

async function monitorCreateRelayr(state, session, resumed) {
  var expected = Math.max(1, Number(session.expectedCount) || (session.chains && session.chains.length) || (state.chainIds || []).length || 1);
  session.expectedCount = expected;
  function persist(records) {
    if (records) session.records = records;
    state._relayrPending = saveRelayrPendingSession(CREATE_RELAYR_SCOPE, session) || session;
    session.persisted = state._relayrPending.persisted;
    state.deployChains = (session.chains || []).map(function (chain) { return Number(chain.id); });
  }
  persist(session.records || []);
  try {
    var records = await relayrPoll(session.bundleUuid, function (txList) {
      persist(txList);
      state.deployProgress = (txList || []).map(function (t, i) {
        return { chainId: state.deployChains[i], status: relayrChainStatus(t) };
      });
      var progress = relayrProgress(txList, expected);
      if (state.statusLines.length) state.statusLines[state.statusLines.length - 1] = { text: 'Relayr is deploying… ' + progress.confirmed + '/' + progress.total + ' chains confirmed. ' + (session.persisted === false ? 'Keep this window open; the receipt could not be saved.' : 'The paid receipt is saved.') };
      if (state._render) state._render();
    }, 2500, resumed ? 60 * 1000 : undefined);
    clearRelayrPendingSession(CREATE_RELAYR_SCOPE);
    state._relayrPending = null;
    state.deployProgress = null;
    return records;
  } catch (error) {
    if (error && error.code === 'RELAYR_PAYMENT_EXPIRED') session.paymentState = 'expired';
    if (error && error.records) persist(error.records);
    if (relayrProgress(session.records, expected).allFailed) {
      clearRelayrPendingSession(CREATE_RELAYR_SCOPE);
      state._relayrPending = null;
      state.deployProgress = null;
      error.message += ' No chains confirmed, so you can review and launch a new request.';
    } else {
      error.message += ' Use “Check Relayr status” to inspect this same paid bundle; do not launch again.';
    }
    throw error;
  }
}

function createRelayrReceiptNode(session, checking, onCheck, onClear) {
  var panel = el('div', 'relayr-pending-panel create-relayr-receipt');
  var progress = relayrProgress(session.records, session.expectedCount);
  var paymentExpired = session.paymentState === 'expired';
  renderRelayrReceiptInto(panel, session, {
    stateLabel: function (record) { var s = relayrChainStatus(record); return { text: s.label, kind: s.kind }; },
    chainNameOf: chainName,
    noteText: paymentExpired
      ? 'The payment transaction was confirmed, but Relayr did not recognize it before the quote expired. Nothing deployed. Keep the payment hash and bundle ID for support; clear this receipt only when you are ready to create a new quote.'
      : progress.failed
      ? 'Some chain outcomes may differ. Nothing was resubmitted—review the project state before clearing this receipt or retrying missing work.'
      : (session.persisted === false
        ? 'The payment transaction confirmed, but this browser could not save the receipt. Keep this window open or copy the bundle ID. Checking status never signs or pays again.'
        : 'The payment transaction confirmed. It is safe to close this window; checking status never signs, pays, or creates another bundle.'),
  });
  var action = el('button', 'create-btn ghost'); action.type = 'button'; action.style.marginTop = '10px';
  if (paymentExpired || progress.failed) {
    action.textContent = 'Clear saved receipt';
    action.addEventListener('click', function () {
      if (!window.confirm('Clear this saved Relayr receipt? This does not undo chains that already deployed. Review every chain before launching any missing work.')) return;
      clearRelayrPendingSession(CREATE_RELAYR_SCOPE);
      if (onClear) onClear();
    });
  } else {
    action.disabled = !!checking; action.textContent = checking ? 'Checking Relayr…' : 'Check Relayr status';
    action.addEventListener('click', onCheck);
  }
  panel.appendChild(action);
  return panel;
}

function deploy(state, render) {
  state.statusLines = [];
  state.done = false;
  state._render = render; // so async deploy progress (relayr poll) can re-render outside the push() log
  // Status recovery is read-only and must remain available after refresh even though imported/restored drafts
  // intentionally reset ToS and even when no wallet is connected. It always checks the same paid bundle.
  var pendingRelayr = state._relayrPending || loadRelayrPendingSession(CREATE_RELAYR_SCOPE);
  if (pendingRelayr) {
    state._relayrPending = pendingRelayr;
    beginDeployRun(state, render, null);
    return;
  }
  // A connected wallet is always required — it signs/sends (and pays once, for multichain via Relayr).
  var signer = getAccount && getAccount();
  if (!signer) {
    connect().then(function () { state.statusLines.push({ text: 'Wallet connected — click Launch again.' }); render(); })
      .catch(function (e) { state.statusLines.push({ text: 'Could not connect: ' + (e && e.message || e), err: true }); render(); });
    return;
  }
  var accepts = state.accepts || [];
  var validAccounting = accepts.length > 0 && accepts.every(function (token, index) {
    return ['eth', 'usdc', 'custom'].indexOf(token) !== -1 && accepts.indexOf(token) === index;
  }) && !(accepts.indexOf('custom') !== -1 && accepts.length !== 1);
  if (!validAccounting || (customAccounting(state) && !customReady(state))) {
    state.statusLines.push({ text: 'Choose and verify the accounting token(s) before deploying.', err: true }); render(); return;
  }
  if (accepts.indexOf('usdc') !== -1 && (state.chainIds || []).some(function (cid) { return !USDC_BY_CHAIN[cid]; })) {
    state.statusLines.push({ text: 'USDC is not configured on every selected chain.', err: true }); render(); return;
  }
  if (!state.tos || !(state.chainIds || []).length || !state.details.name) {
    state.statusLines.push({ text: 'Complete the required deploy fields and risk confirmation before launching.', err: true }); render(); return;
  }
  var mediaIssue = shopMediaUploadIssue(state);
  if (mediaIssue) { state.statusLines.push({ text: mediaIssue, err: true }); render(); return; }
  // The project owner / revnet operator is an explicit, required launch argument (ENS-resolved).
  var ownerRaw = pickResolved(state.details.owner, { resolvedAddress: state.details.ownerResolved, resolvedFor: state.details.ownerResolvedFor });
  var operatorRaw = pickResolved(state.revOperator, { resolvedAddress: state.revOperatorResolved, resolvedFor: state.revOperatorResolvedFor });
  if (state.projectType === 'revnet' ? !isAddr(operatorRaw) : !isAddr(ownerRaw)) {
    state.statusLines.push({ text: state.projectType === 'revnet' ? 'Set a valid revnet operator before deploying.' : 'Set a valid project owner before launching.', err: true }); render(); return;
  }
  var owner = isAddr(ownerRaw) ? ownerRaw : signer;
  beginDeployRun(state, render, owner);
}

function beginDeployRun(state, render, owner) {
  state.deploying = true; render();
  // Set the status pusher BEFORE runDeploy — with no Pinata JWT, runDeploy calls push() synchronously
  // (the "launching without metadata" line) before its first await, so the assignment must precede the call.
  state._push = function pushStatus(text, kind) { state.statusLines.push({ text: text, ok: kind === 'ok', err: kind === 'err' }); render(); };
  runDeploy(state, owner).then(function (res) {
    state.deploying = false;
    if (res === false) { render(); return; } // user cancelled at the raw-data review — not a success
    state.done = true;
    state.statusLines.push({ text: 'All done.', ok: true });
    // Discover owns its own onchain/indexer caches. Tell it a project was created so it can switch to the
    // deployed network, drop the old project count, and enumerate the new project immediately.
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('jb:project-created', { detail: state.deployed || { chainId: state.chainIds && state.chainIds[0] } }));
    render();
  }).catch(function (e) {
    state.deploying = false;
    state.statusLines.push({ text: friendlyDeployError(e), err: true });
    render();
  });
}

async function runDeploy(state, owner) {
  var push = state._push;
  // deploy() has already resolved any persisted session into state._relayrPending before reaching here.
  var restoredRelayr = state._relayrPending;
  if (restoredRelayr) {
    push('Checking the saved paid Relayr bundle — no new transaction will be created.');
    var restoredTxs = await monitorCreateRelayr(state, restoredRelayr, true);
    var restoredChain = Number(restoredRelayr.chains && restoredRelayr.chains[0] && restoredRelayr.chains[0].id) || state.chainIds[0];
    push('Reading the deployed project…');
    await captureDeployed(state, restoredChain, relayrDestinationHash(restoredTxs[0]));
    return;
  }
  // 1) Pin metadata (best-effort).
  var projectUri = '';
  if (hasPinata()) {
    push('Pinning project metadata…');
    try {
      projectUri = await pinJson(buildMetadata(state.details, state.storeCategories), state.details.name || 'project');
      push('Metadata pinned: ' + projectUri, 'ok');
    } catch (e) {
      push('Could not pin metadata (' + (e && e.message || e) + ') — nothing was sent.', 'err');
      throw e;
    }
  } else {
    push('No Pinata JWT — launching without metadata; you can edit the project later.');
  }

  // Pin each store item's metadata JSON (name + media) so its tier resolves to {name, image/animation_url}.
  if (state.nfts.length && hasPinata()) {
    for (var n = 0; n < state.nfts.length; n++) {
      var it = state.nfts[n];
      push('Pinning item “' + (it.name || ('#' + (n + 1))) + '” metadata…');
      var categoryName = storeCategoryName(state, it.category);
      var meta = build721TierMetadata({
        name: it.name || ('Item #' + (n + 1)), description: it.description,
        categoryName: categoryName, mediaUri: it.imageUri, mediaType: it.mediaType,
      });
      try {
        it.metaUri = await pinJson(meta, (it.name || 'item') + '-item');
        it.encodedIpfsUri = encodeIpfsUriToBytes32(it.metaUri);
      } catch (e) {
        push('Could not pin item metadata (' + (e && e.message || e) + ') — nothing was sent.', 'err');
        throw e;
      }
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
  // FROZEN deliberately: every chain must encode the SAME start or the cross-chain
  // configuration hash (and the deterministic addresses derived from it) diverge. The
  // consequence is that a launch EXECUTED much later — a Safe collecting signatures over
  // days — begins with stage 1 already in the past and some issuance-cut cycles elapsed
  // versus what was reviewed. That is inherent to the hash requirement, not a bug to fix
  // here; the review screen warns Safe users (see confirmDeployStartNote).
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
        chainId: p.chainId,
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
      throw new Error('Could not simulate on ' + chainName(p0.chainId) + ' — ' + friendlyDeployError(e));
    }
    if (!getAccount() || getAccount().toLowerCase() !== signer.toLowerCase()) throw new Error('Connected account changed. Review the launch transaction again.');
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
  var payHash = await relayrPay(pay, signer);
  push('Payment sent | ' + truncAddr(payHash) + ' — relayers are deploying on each chain…');
  // Relayr's per-tx records don't carry a chain field, but they come back in submission order — map by
  // index to the chains we deployed, and render a friendly per-chain checklist (see renderDeploy).
  state.deployChains = plans.map(function (p) { return p.chainId; });
  var finalRelayrTxs = await monitorCreateRelayr(state, {
    bundleUuid: quote.bundle_uuid,
    paymentHash: payHash,
    paymentChainId: Number(pay.chain),
    expectedCount: plans.length,
    chains: plans.map(function (p) { return { id: p.chainId, name: chainName(p.chainId) }; }),
    records: [],
  }, false);
  push('Reading the new project…');
  await captureDeployed(state, plans[0].chainId, relayrDestinationHash(finalRelayrTxs[0]));
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
  if (!projects) return Promise.reject(new Error('No JBProjects deployment on ' + chainName(chainId) + '.'));
  var pub = createPublicClientForChain(chainId);
  return pub.readContract({
    address: projects,
    abi: [{ type: 'function', name: 'creationFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'creationFee',
  });
}

function execTx(opts) {
  return new Promise(function (resolve, reject) {
    executeTransaction(Object.assign({}, opts, {
      onSuccess: function (m, meta) { resolve((meta && meta.hash) || null); },
      onError: function (m) { reject(new Error(m)); },
    }));
  });
}

// After a successful deploy, decode this transaction's JBProjects.Create event for the exact project id.
// Reading the global count here is race-prone: another project could be created before the receipt is processed.
function captureDeployed(state, chainId, txHash) {
  if (!txHash) { state.deployed = { chainId: chainId, txHash: null }; return Promise.resolve(); }
  var projects = getAddress('JBProjects', chainId);
  var createEvent = [{ type: 'event', name: 'Create', inputs: [
    { name: 'projectId', type: 'uint256', indexed: true }, { name: 'owner', type: 'address', indexed: true }, { name: 'caller', type: 'address', indexed: false },
  ] }];
  return createPublicClientForChain(chainId).getTransactionReceipt({ hash: txHash }).then(function (receipt) {
    var pid = null;
    (receipt.logs || []).some(function (log) {
      if (projects && log.address.toLowerCase() !== projects.toLowerCase()) return false;
      try {
        var decoded = decodeEventLog({ abi: createEvent, data: log.data, topics: log.topics });
        if (decoded.eventName === 'Create') { pid = decoded.args.projectId; return true; }
      } catch (_) {}
      return false;
    });
    if (pid == null) throw new Error('Create event not found');
    state.deployed = { chainId: chainId, projectId: pid, txHash: txHash, route: projectRouteFor(chainId, pid) };
  }).catch(function () { state.deployed = { chainId: chainId, txHash: txHash }; });
}

// Chain-id → discover route slug (must match discover.js CHAIN_SLUGS exactly) for the "Go to project" link.
var CREATE_CHAIN_SLUGS = { 1: 'eth', 11155111: 'sep', 42161: 'arb', 421614: 'arbsep', 8453: 'base', 84532: 'basesep', 10: 'op', 11155420: 'opsep' };
function projectRouteFor(chainId, projectId) { var s = CREATE_CHAIN_SLUGS[chainId]; return (s && projectId) ? ('#' + s + ':' + projectId) : null; }
// Deterministic salt — same on every chain (so omnichain sucker addresses match). No Math.random.
export function deploySalt(state, owner) {
  return keccak256(stringToHex((state.details.name || 'project') + ':' + String(owner).toLowerCase()));
}

// Build the launchProjectFor call for one chain. Returns { contract, address, abi, args, missingSuckers }.
// Used BOTH for the onchain send (runDeploy) and the JSON payload preview, so what the user reviews is
// byte-for-byte what they sign.
function buildLaunchArgs(state, chainId, owner, projectUri, salt, deployStart) {
  var multi = state.chainIds.length > 1;
  // Per-chain owner override (the "same on all chains" control may set a different address per chain). The
  // CREATE2 `salt` stays derived from the default owner (passed in) so omnichain addresses still match.
  var chainOwner = chainAddr(state, chainId, 'owner', owner);
  if (isAddr(chainOwner)) owner = chainOwner;
  // Multichain "start immediately" → pin every chain's first ruleset to the one shared deploy-time start
  // (~10 min ahead) so they all begin at the same moment. Single chain starts at its own deploy block (0).
  var immediateStart = multi ? deployStart : 0;
  // Always deploy a 721 shop hook (empty if no items) so any project can sell NFTs later without re-deploying —
  // matches revnets, which always ship a default empty 721 hook. build721Config still filters items per chain;
  // _deploy721Hook is unconditional at launch (the tiers.length gate is queue-only, so 0 tiers won't revert).
  var hasNfts = true; // ponytail: always-on shop
  var terminalConfigs = buildTerminalConfigs(chainId, state, state.swapRouter);
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
    var deploy721 = { deployTiersHookConfig: build721Config(state, projectUri, chainId), useDataHookForCashOut: !!(state.collection && state.collection.useForRedemptions), salt: salt };
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
  // Per-chain operator override ("same on all chains" control); salt stays on the default for matching addresses.
  var opChain = chainAddr(state, chainId, 'op', opRaw);
  var operator = isAddr(opChain) ? opChain : (isAddr(opRaw) ? opRaw : owner);

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
    baseCurrency: customAccounting(state) ? customCurrencyId(state) : ((state.accepts || []).indexOf('usdc') !== -1 ? 2 : (state.revBaseCurrency === 2 ? 2 : 1)), // custom id, USD(2) if USDC accepted, else ETH(1)
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
  if (customAccounting(state) && isAddr(state.customToken.address)) {
    return { token: state.customToken.address, decimals: customAcctDecimals(state), currency: customCurrencyId(state) };
  }
  if ((state.accepts[0] || 'eth') === 'usdc') {
    var usdc = USDC_BY_CHAIN[chainId];
    if (usdc) return { token: usdc, decimals: 6, currency: Number(BigInt(usdc) % (1n << 32n)) };
  }
  return { token: NATIVE_TOKEN, decimals: 18, currency: NATIVE_CURRENCY };
}

// The revnet's accounting context — ETH (native) or USDC, per the Settlement accounting choice.
// JBAccountingContext.currency = uint32(uint160(token)).
function revnetAccept(state, chainId) {
  // A revnet can accept multiple reserve assets (ETH and/or USDC), or one custom ERC-20 — REVDeployer.deployFor
  // takes accountingContextsToAccept as a tuple[]. Mirror the custom-project terminal contexts.
  if (customAccounting(state) && isAddr(state.customToken.address)) {
    return [{ token: state.customToken.address, decimals: customAcctDecimals(state), currency: customCurrencyId(state) }];
  }
  var ctx = [];
  var accepts = state.accepts || [];
  if (accepts.indexOf('eth') !== -1) ctx.push({ token: NATIVE_TOKEN, decimals: 18, currency: NATIVE_CURRENCY });
  if (accepts.indexOf('usdc') !== -1 && USDC_BY_CHAIN[chainId]) ctx.push({ token: USDC_BY_CHAIN[chainId], decimals: 6, currency: Number(BigInt(USDC_BY_CHAIN[chainId]) % (1n << 32n)) });
  return ctx.length ? ctx : [{ token: NATIVE_TOKEN, decimals: 18, currency: NATIVE_CURRENCY }];
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
      var benef = chainAddr(state, chainId, 'r:' + idx + ':' + e.origIdx, pickResolved(e.x.address, e.x)); // per-chain beneficiary/address
      var pid = (e.x.type === 'project' || e.x.type === 'customhook') ? (Number(pcAddrGet(state, chainId, 'rpid:' + idx + ':' + e.origIdx, e.x.projectId || 0)) || 0) : 0;
      return splitState(e.x, shares[k], benef, chainId, pid, false);
    });
  }
  // initialIssuance: tokens per base unit × 1e18 (18-dec fixed point). Blank on a later stage = keep the
  // previous stage's (cut) issuance, which JBRulesets encodes as the RAW sentinel weight 1 — a weight of
  // 0 would turn issuance off permanently. Blank on stage 1 stays an explicit 0 (there is no previous
  // stage to inherit; the stage summary displays "0" for it).
  // parseEther (not Number×1e18) keeps precision on large/decimal weights and never throws on Infinity.
  var issuance = (idx === 0 || stage.weight) ? tokenAmount18(stage.weight, UINT112_MAX) : 1n;
  var cutFreq = stage.issuanceCutOn ? Math.max(0, Math.round((Number(stage.cutFreqDays) || 0) * 86400)) : 0;
  var cutPercent = stage.issuanceCutOn
    ? Math.round(Math.max(0, Math.min(100, Number(stage.weightCutPercent) || 0)) / 100 * JBCONSTANTS.MAX_WEIGHT_CUT_PERCENT)
    : 0;
  var taxRate = Math.round(Math.max(0, Math.min(100, Number(stage.cashOutTaxRate) || 0)) * 100); // percent → out of 10000
  // Every chain's config carries the SAME full auto-issuance row list — REVDeployer folds all rows into
  // encodedConfiguration (which must be byte-identical across chains) and mints only rows whose chainId
  // matches the local chain. Each row's beneficiary resolves against the ROW's mint chain (where the
  // tokens land), keeping the encoding independent of the config chain.
  var autos = (stage.autoIssuances || [])
    .map(function (a, aiIdx) {
      var mintChain = aiMintChain(state, a) || chainId;
      return { chainId: mintChain, count: tokenAmount18(a.count, UINT104_MAX), addr: chainAddr(state, mintChain, 'ai:' + idx + ':' + aiIdx, pickResolved(a.address, a)) };
    })
    .filter(function (a) { return a.count > 0n && isAddr(a.addr); })
    .map(function (a) { return { chainId: a.chainId, count: a.count, beneficiary: a.addr }; });
  return {
    startsAtOrAfter: start,
    autoIssuances: autos,
    splitPercent: splitPercent,
    splits: splits,
    initialIssuance: issuance,
    issuanceCutFrequency: cutFreq,
    issuanceCutPercent: cutPercent,
    cashOutTaxRate: taxRate,
    extraMetadata: build721RulesetMetadata({
      metadata: Number(stage.metadataExtra) || 0,
      pauseTransfers: !!stage.pause721Transfers,
    }) | REV_METADATA_ALLOW_SUCKER_DEPLOYMENT,
  };
}

// Assemble a single ruleset state object (createDefaultRuleset shape) from the wizard steps.
// Build one JBRulesetConfig from a stage. isFirst => stage 1 (honors scheduled launch); later stages
// queue with mustStartAtOrAfter 0 so the controller chains them after the previous stage's duration.
// Encode a queue's rulesets for one chain — the same stage→JBRulesetConfig[] mapping the launcher uses
// (resolveStages applies the "Afterwards" choice; assembleRuleset encodes each), minus the NFT/terminal
// scaffolding. `immediateStart` aligns the first ruleset across chains for an omnichain queue (0 = next
// cycle on a single chain). Returns the JBRulesetConfig[] for JBController/JBOmnichainDeployer.queueRulesetsOf.
export function buildQueueRulesetConfigs(state, chainId, immediateStart, opts) {
  var effectiveStages = resolveStages(state);
  var deadlineOn = deadlineApplies(state);
  return buildRulesetConfigs(effectiveStages.map(function (s, i) {
    var userIdx = Math.min(i, state.stages.length - 1);
    return assembleRuleset(state, s, userIdx, chainId, i === 0, deadlineOn, immediateStart || 0);
  }), opts);
}

function assembleRuleset(state, stage, userStageIdx, chainId, isFirst, deadlineOn, immediateStart) {
  var lockOk = splitLockAllowed(stage); // split locks only encode for a fixed-duration ruleset (not Flexible)
  // Per-chain overrides (amount + beneficiary), keyed by user-stage + recipient index; fall back to defaults.
  var amtAt = function (x, idx) { return chainPayoutAmount(state, chainId, userStageIdx, idx); };
  // For project recipients, the token beneficiary is held in x.address and resolved via the global ENS cache.
  var payoutBenef = function (x, idx) { return chainAddr(state, chainId, 'p:' + userStageIdx + ':' + idx, pickResolved(x.address, x)); };
  var reservedBenef = function (x, idx) { return chainAddr(state, chainId, 'r:' + userStageIdx + ':' + idx, pickResolved(x.address, x)); };
  // Per-chain project id for project / custom-hook splits (override → default); 0 for wallet / lphook.
  var projAt = function (x, key) { return (x.type === 'project' || x.type === 'customhook') ? (Number(pcAddrGet(state, chainId, key, x.projectId || 0)) || 0) : 0; };
  var payoutPid = function (x, idx) { return projAt(x, 'ppid:' + userStageIdx + ':' + idx); };
  var reservedPid = function (x, idx) { return projAt(x, 'rpid:' + userStageIdx + ':' + idx); };
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
  // Multi-accounting-context (queue): payouts are per token (stage.payoutByKind). There's surplus to cash
  // out / withdraw unless EVERY accepted token pays out everything (all unlimited).
  var pkAll = currentPayoutKinds(state);
  var allKindsUnlimited = pkAll ? pkAll.every(function (k) { return ((stage.payoutByKind || {})[k.key] || {}).mode === 'unlimited'; }) : false;
  var noSurplus = pkAll ? allKindsUnlimited : (stage.payoutMode === 'unlimited');
  rs.weight = custom ? (stage.weight || '0') : '0';
  rs.reservedPercent = custom ? Math.max(0, Math.min(100, reservedTotalPct)) : 0;
  rs.weightCutPercent = custom ? Math.max(0, Math.min(100, Number(stage.weightCutPercent) || 0)) : 0;
  // Cash outs / owner minting / pausing apply to the project's tokens regardless of whether THIS stage
  // issues new tokens (tokens can exist from prior stages or owner mints). Clamp 0–100 so a stray value
  // can't overflow MAX_CASH_OUT_TAX_RATE and revert at deploy.
  // Item redemptions route cash out through the 721 hook (item holders redeem for surplus). Only when a store
  // is actually on this chain AND the project opted in. Mutually exclusive with token cash out by contract.
  var storeRedeem = state.shopEnabled && !!(state.collection && state.collection.useForRedemptions)
    && (state.nfts || []).some(function (_, i) { return chainItemIncluded(state, chainId, i); });
  // The cash out tax governs whoever can cash out — token holders OR (mutually exclusively) item holders — so
  // it applies when either is on. 100% = cash outs off (also forced when payouts leave no surplus).
  rs.cashOutTaxRate = ((stage.cashOutEnabled || storeRedeem) && !noSurplus)
    ? Math.max(0, Math.min(100, Number(stage.cashOutTaxRate) || 0)) : 100;
  rs.allowOwnerMinting = !!stage.allowOwnerMinting;
  rs.pauseCreditTransfers = !!stage.pauseTransfers;
  rs.useTotalSurplusForCashOuts = !!stage.useTotalSurplusForCashOuts;
  rs.ownerMustSendPayouts = !!stage.ownerMustSendPayouts;
  rs.metadataExtra = build721RulesetMetadata({
    metadata: Number(stage.metadataExtra) || 0,
    pauseTransfers: !!stage.pause721Transfers,
  });
  rs.useDataHookForCashOut = storeRedeem;

  // Queue-only 721-shop choice. The discover Rulesets tab sets state.shopChoice; the LAUNCH path leaves it
  // undefined so this whole block no-ops (launch stays exactly as-is). On the SINGLE-CHAIN queue path the 721
  // hook IS metadata.dataHook, and the default encodes dataHook=0 — which silently DETACHES a live shop. So
  // "continue" must re-pass the current hook to keep it, while "reactivate" puts a verified historical hook back.
  // On the OMNICHAIN path the shop rides the deploy721 empty-tiers carry-forward (metadata.dataHook is the
  // extra/buyback slot), so we leave the metadata alone.
  if (state.shopChoice && !state.isOmnichain) {
    if (state.shopChoice === 'reactivate') {
      rs.dataHook = (state.reactivatedShopHookByChain && state.reactivatedShopHookByChain[chainId]) || state.reactivatedShopHook || '';
      rs.useDataHookForPay = true;
      // Reactivation is explicit, so preserve whether the archived collection previously gave items cash out access.
      rs.useDataHookForCashOut = !!state.reactivatedShopUseDataHookForCashOut;
    } else if (state.shopChoice === 'continue') {
      rs.dataHook = (state.currentDataHookByChain && state.currentDataHookByChain[chainId]) || state.currentDataHook || '';
      rs.useDataHookForPay = state.currentUseDataHookForPayByChain && state.currentUseDataHookForPayByChain[chainId] != null
        ? !!state.currentUseDataHookForPayByChain[chainId]
        : (state.currentUseDataHookForPay == null ? true : !!state.currentUseDataHookForPay);
      rs.useDataHookForCashOut = state.currentUseDataHookForCashOutByChain && state.currentUseDataHookForCashOutByChain[chainId] != null
        ? !!state.currentUseDataHookForCashOutByChain[chainId]
        : !!state.currentUseDataHookForCashOut;
    } else if (state.shopChoice === 'remove') {
      rs.dataHook = '';
      rs.useDataHookForPay = false;
      rs.useDataHookForCashOut = false;
    }
  } else if (state.shopChoice && state.isOmnichain && state.shopChoice !== 'remove') {
    // JBOmnichainDeployer replaces `metadata.dataHook` with itself and stores the input hook as its separate
    // extra hook. Re-pass that EXTRA hook (not the wrapper address) so queueing/carrying a 721 shop does not
    // silently detach an existing buyback or other composed data hook.
    rs.dataHook = (state.currentDataHookByChain && state.currentDataHookByChain[chainId]) || state.currentDataHook || '';
    rs.useDataHookForPay = state.currentUseDataHookForPayByChain && state.currentUseDataHookForPayByChain[chainId] != null
      ? !!state.currentUseDataHookForPayByChain[chainId]
      : !!state.currentUseDataHookForPay;
    rs.useDataHookForCashOut = state.currentUseDataHookForCashOutByChain && state.currentUseDataHookForCashOutByChain[chainId] != null
      ? !!state.currentUseDataHookForCashOutByChain[chainId]
      : !!state.currentUseDataHookForCashOut;
  }

  if (deadlineOn === false) {
    rs.approvalHook = ZERO;
  } else if (stage.deadline === 'custom') {
    // Custom approval-hook contract — per-chain override → the global default; ENS resolved.
    rs.approvalHook = addrOrZero(chainAddr(state, chainId, 'approval', pickResolved(state.approvalAddress, { resolvedAddress: state.approvalAddressResolved, resolvedFor: state.approvalAddressResolvedFor })));
  } else {
    var dl = DEADLINE_OPTIONS.find(function (d) { return d.key === stage.deadline; });
    if (dl && dl.contract) {
      var dlAddr = getAddress(dl.contract, chainId);
      // Fail CLOSED: a missing preset deployment must never silently encode approvalHook = address(0)
      // (no review window) on an immutable deploy. deadlinePresetIssue gates the button with the same text.
      if (!dlAddr) {
        throw new Error('The ' + dl.label + ' approval hook isn’t deployed on ' + chainName(chainId)
          + ' — pick a different approval condition or deselect the chain.');
      }
      rs.approvalHook = dlAddr;
    } else {
      rs.approvalHook = ZERO;
    }
  }

  rs.pausePay = stage.pausePay; rs.holdFees = stage.holdFees;
  rs.allowSetTerminals = stage.allowSetTerminals; rs.allowSetController = stage.allowSetController;
  rs.allowTerminalMigration = stage.allowTerminalMigration;
  rs.allowSetCustomToken = !!stage.allowSetCustomToken;
  rs.allowAddAccountingContext = !!stage.allowAddAccountingContext;
  rs.allowAddPriceFeed = !!stage.allowAddPriceFeed;

  // Splits + fund access.
  rs.splitGroups = [];
  rs.fundAccessLimitGroups = [];
  if (pkAll) {
    // MULTI-TOKEN: one payout split group + one fund-access group per accounting context, each denominated
    // in that token's own currency/decimals. Surplus allowance (when owner access is on) is unlimited per
    // token — surplus is the project's cumulative total across tokens.
    // Per-token recipient address (per-chain override → default), keyed by token + recipient index.
    var benefK = function (x, kind, idx) { return chainAddr(state, chainId, 'pk:' + kind.key + ':' + idx, pickResolved(x.address, x)); };
    var pidK = function (x, kind, idx) { return projAt(x, 'pkpid:' + kind.key + ':' + idx); };
    var puK = function (v, d) { return priceUnits(v, d); };
    pkAll.forEach(function (kind) {
      var pk = (stage.payoutByKind || {})[kind.key] || { mode: 'none', recipients: [] };
      var token = kind.addrForChain(chainId); if (!token) return;
      var cur = Number(BigInt(token) & 0xffffffffn);
      var payoutLimits = [], surplusAllowances = [], splits = [];
      if (pk.mode === 'unlimited') {
        payoutLimits.push({ amount: UINT224_MAX, currency: cur });
        var pacc = 0;
        splits = (pk.recipients || []).map(function (x, idx) {
          var raw = Math.round((Number(x.percent) || 0) / 100 * SPLITS_TOTAL);
          if (pacc + raw > SPLITS_TOTAL) raw = Math.max(0, SPLITS_TOTAL - pacc);
          pacc += raw;
          return splitState(x, raw, benefK(x, kind, idx), chainId, pidK(x, kind, idx), lockOk);
        });
      } else if (pk.mode === 'limited') {
        var limitedRows = (pk.recipients || []).map(function (x, idx) {
          return { x: x, idx: idx, amount: puK(chainKindPayoutAmount(state, chainId, kind.key, idx, x.amountEth), kind.decimals) };
        }).filter(function (row) { return row.amount > 0n; });
        var totalAmt = limitedRows.reduce(function (s, row) { return s + row.amount; }, 0n);
        if (totalAmt > 0n) payoutLimits.push({ amount: totalAmt, currency: cur });
        var lshares = splitSharesFromAmounts(limitedRows.map(function (row) { return row.amount; }));
        splits = limitedRows.map(function (row, shareIdx) {
          return splitState(row.x, lshares[shareIdx], benefK(row.x, kind, row.idx), chainId, pidK(row.x, kind, row.idx), lockOk);
        });
      }
      if (stage.surplusAllowanceOn && pk.mode !== 'unlimited') surplusAllowances.push({ amount: UINT224_MAX, currency: cur });
      if (splits.length) rs.splitGroups.push({ groupId: uint256FromAddress(token), splits: splits });
      if (payoutLimits.length || surplusAllowances.length) {
        rs.fundAccessLimitGroups.push({ terminal: getAddress('JBMultiTerminal', chainId), token: token, payoutLimits: payoutLimits, surplusAllowances: surplusAllowances });
      }
    });
  } else if (stage.payoutMode !== 'none' || (stage.surplusAllowanceOn && stage.payoutMode !== 'unlimited')) {
    // SINGLE-TOKEN (create flow): one accounting token chosen at Settlement.
    if (stage.payoutMode !== 'none' && stage.payoutRecipients.length) {
      var payoutSplits;
      if (stage.payoutMode === 'unlimited') {
        var pacc1 = 0;
        payoutSplits = stage.payoutRecipients.map(function (x, idx) {
          var raw = Math.round((Number(x.percent) || 0) / 100 * SPLITS_TOTAL);
          if (pacc1 + raw > SPLITS_TOTAL) raw = Math.max(0, SPLITS_TOTAL - pacc1);
          pacc1 += raw;
          return splitState(x, raw, payoutBenef(x, idx), chainId, payoutPid(x, idx), lockOk);
        });
      } else {
        var splitAcct = acctTokenFor(state, chainId);
        var splitCurrency = stage.payoutCurrency || 1;
        var limitedRows1 = stage.payoutRecipients.map(function (x, idx) {
          return { x: x, idx: idx, amount: fundAccessUnits(amtAt(x, idx), splitCurrency, splitAcct) };
        }).filter(function (row) { return row.amount > 0n; });
        var lshares1 = splitSharesFromAmounts(limitedRows1.map(function (row) { return row.amount; }));
        payoutSplits = limitedRows1.map(function (row, shareIdx) {
          return splitState(row.x, lshares1[shareIdx], payoutBenef(row.x, row.idx), chainId, payoutPid(row.x, row.idx), lockOk);
        });
      }
      if (payoutSplits.length) rs.splitGroups.push({ groupId: uint256FromAddress(acctTokenFor(state, chainId).token), splits: payoutSplits });
    }
    var acct = acctTokenFor(state, chainId);
    var payoutLimits1 = [];
    if (stage.payoutMode !== 'none') {
      if (stage.payoutMode === 'unlimited') payoutLimits1.push({ amount: UINT224_MAX, currency: acct.currency });
      else {
        var payoutCurrency = stage.payoutCurrency || 1;
        payoutLimits1.push({ amount: stage.payoutRecipients.reduce(function (s, x, idx) { return s + fundAccessUnits(amtAt(x, idx), payoutCurrency, acct); }, 0n), currency: payoutCurrency });
      }
    }
    var surplusAllowances1 = [];
    if (stage.surplusAllowanceOn && stage.payoutMode !== 'unlimited') {
      if (stage.surplusAllowanceUnlimited) surplusAllowances1.push({ amount: UINT224_MAX, currency: acct.currency });
      else {
        var saCurrency = stage.surplusAllowanceCurrency || 1;
        var saAmt = fundAccessUnits(stage.surplusAllowanceAmount, saCurrency, acct);
        if (saAmt > 0n) surplusAllowances1.push({ amount: saAmt, currency: saCurrency });
      }
    }
    if (payoutLimits1.length || surplusAllowances1.length) {
      rs.fundAccessLimitGroups.push({ terminal: getAddress('JBMultiTerminal', chainId), token: acct.token, payoutLimits: payoutLimits1, surplusAllowances: surplusAllowances1 });
    }
  }
  // Reserved-token splits (group 1) — token-agnostic; same in both paths.
  if (custom && reservedTotalPct > 0) {
    var rrows = stage.reservedRecipients.map(function (x, origIdx) { return { x: x, origIdx: origIdx }; })
      .filter(function (e) { return (Number(e.x.percent) || 0) > 0; });
    var rshares = fillSplits(rrows.map(function (e) { return Math.round((Number(e.x.percent) || 0) / reservedTotalPct * SPLITS_TOTAL); }));
    rs.splitGroups.push({
      groupId: '1',
      splits: rrows.map(function (e, k) { return splitState(e.x, rshares[k], reservedBenef(e.x, e.origIdx), chainId, reservedPid(e.x, e.origIdx), lockOk); }),
    });
  }
  return rs;
}

// Adjust a list of integer split shares so they sum to EXACTLY SPLITS_TOTAL (1e9). Per-row rounding can
// drift a few atoms above/below; JBSplits reverts if a group EXCEEDS SPLITS_TOTAL. We correct the drift on
// the largest share (always non-zero, can't go negative for tiny deltas). Use for groups meant to
// distribute 100% (reserved tokens, limited payouts). Returns the same array, mutated.
export function fillSplits(rawShares) {
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

// Convert fixed-point payout amounts into exact 1e9 split shares without passing through JavaScript Number.
// Amounts may be much larger than Number.MAX_SAFE_INTEGER and may carry token-specific precision. Flooring each
// ratio and assigning the few remaining atoms through fillSplits preserves the exact relative order and sum.
function splitSharesFromAmounts(amounts) {
  if (!amounts.length) return [];
  var total = amounts.reduce(function (sum, amount) {
    amount = BigInt(amount);
    if (amount < 0n) throw new Error('Payout amounts cannot be negative.');
    return sum + amount;
  }, 0n);
  if (total === 0n) return amounts.map(function () { return 0; });
  return fillSplits(amounts.map(function (amount) {
    return Number(BigInt(amount) * BigInt(SPLITS_TOTAL) / total);
  }));
}

function splitState(rec, rawPercent, beneficiaryOverride, chainId, projectIdOverride, allowLock) {
  // lockedUntil only encodes when the stage actually allows locks (splitLockAllowed at the call site) — a
  // stale value from a draft/import or a non-lockable (revnet/Flexible) stage must NOT reach the chain.
  // `allowLock === undefined` (e.g. a direct unit-test call) keeps the value, so existing behavior holds.
  var lockTs = (allowLock !== false && rec.lockedUntil) ? Number(rec.lockedUntil) : 0;
  // "Buyback liquidity" reserved split → routes to the shared JBP6FeeLPSplitHook (same address on every
  // chain). The hook keys off the distributing project, so projectId/beneficiary are pass-through.
  if (rec.type === 'lphook' && chainId != null) {
    var hookAddr = getAddress('JBP6FeeLPSplitHook', chainId);
    // Fail CLOSED where the hook has no deployment: falling through would encode a plain wallet split
    // (hook 0), silently paying the LP share to a wallet on an immutable deploy. lpHookIssue gates the
    // deploy button with the same message; this throw is the encoder backstop.
    if (!hookAddr) {
      throw new Error('The Fund market (LP fee) hook isn’t deployed on ' + chainName(chainId)
        + ' — remove the buyback-liquidity split or deselect the chain.');
    }
    var b = getAccount && getAccount();
    return { preferAddToBalance: false, percent: rawPercent, projectId: 0,
      beneficiary: addrOrZero(b), lockedUntil: lockTs, hook: hookAddr };
  }
  // The address-bearing field is the wallet recipient OR the project / custom-hook token beneficiary.
  var addr = (beneficiaryOverride != null) ? beneficiaryOverride : pickResolved(rec.address, rec); // resolve ENS → 0x
  // Project and custom-hook splits can target a project id (per-chain override → default).
  var pid = (rec.type === 'project' || rec.type === 'customhook')
    ? (projectIdOverride != null ? projectIdOverride : (Number(rec.projectId) || 0)) : 0;
  // Custom split hook → user-supplied hook contract (carries the projectId + beneficiary above to the hook).
  var hook = (rec.type === 'customhook' && isAddr(rec.hookAddress)) ? rec.hookAddress : ZERO;
  return {
    preferAddToBalance: rec.type === 'project' && !!rec.preferAddToBalance,
    percent: rawPercent,
    projectId: pid,
    beneficiary: addrOrZero(addr),
    lockedUntil: lockTs,
    hook: hook,
  };
}

export function build721Config(state, projectUri, chainId) {
  var name = collectionNameOf(state);
  var symbol = collectionSymbolOf(state);
  var col = state.collection || {};
  var priceDecimals = storeDecimals(state);
  var tierEntries = state.nfts
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
    var reserveBenef = addrOrZero(rb);
    var votes = nft.votingOn ? (Number(nft.votingUnits) || 0) : 0;
    var discountPercent = nft.discountOn ? tierDiscountPercentFromPct(nft.discountPct) : 0;
    var sp = itemSplits(nft, state, chainId, e.idx);
    var tier = build721TierConfig({
      price: priceUnits(nft.price, priceDecimals),
      initialSupply: chainSupply,
      unlimited: !limited,
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
    });
    return { tier: tier, order: e.idx };
  });
  var tiers = sortTierEntriesByCategory(tierEntries, function (e) { return e.tier; })
    .map(function (e) { return e.tier; });
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

// Pin each store item's metadata JSON (name + already-pinned media) so its tier resolves to
// {name, image/animation_url}.
// Sets it.metaUri + it.encodedIpfsUri in place. Standalone (mirrors the launch deploy flow) so the queue
// "start a new shop" path can pin before build721Config without touching the launch sequence.
export async function pinShopItemsMetadata(state) {
  if (!(state.nfts && state.nfts.length && hasPinata())) return;
  var mediaIssue = shopMediaUploadIssue(state);
  if (mediaIssue) throw new Error(mediaIssue);
  for (var n = 0; n < state.nfts.length; n++) {
    var it = state.nfts[n];
    if (it.encodedIpfsUri) continue; // already pinned this submit
    var categoryName = storeCategoryName(state, it.category);
    var meta = build721TierMetadata({
      name: it.name || ('Item #' + (n + 1)), description: it.description,
      categoryName: categoryName, mediaUri: it.imageUri, mediaType: it.mediaType,
    });
    try { it.metaUri = await pinJson(meta, (it.name || 'item') + '-item'); it.encodedIpfsUri = encodeIpfsUriToBytes32(it.metaUri); }
    catch (e) { throw new Error('Could not pin metadata for “' + (it.name || ('Item #' + (n + 1))) + '”: ' + (e && e.message || e)); }
  }
}

// Terminal configs: the project's accounting terminal (which token[s] it HOLDS, currency =
// uint32(uint160(token))) plus, optionally, the router terminal (empty contexts — it swaps any incoming
// token into the accounting token[s], like REVDeployer does).
function buildTerminalConfigs(chainId, state, swapRouter) {
  var terminal = getAddress('JBMultiTerminal', chainId);
  // Returning [] here launched a project with ZERO terminals — permanently unable to accept a
  // payment, and unfixable after the fact. Block the deploy like the deployer-address check
  // above does. Dormant today (all manifest chains have a terminal) and must stay that way.
  if (!terminal) throw new Error('No JBMultiTerminal is deployed on ' + chainNameOf(chainId) + ', so a project launched there could never accept payments. Deselect that chain.');
  var accepts = state.accepts || [];
  var contexts = [];
  // Custom ERC-20 accounting token (same address on every chain; its own currency id, no feed).
  if (customAccounting(state) && isAddr(state.customToken.address)) {
    contexts.push({ token: state.customToken.address, decimals: customAcctDecimals(state), currency: customCurrencyId(state) });
  }
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

function storeCategoryName(state, category) {
  var id = Number(category) || 0;
  var found = (state.storeCategories || []).find(function (entry) { return Number(entry.id) === id; });
  return found && String(found.name || '').trim();
}

function buildMetadata(d, storeCategories) {
  var m = { version: 1, name: d.name || '', projectTagline: d.tagline || '', description: d.description || '' };
  // Custom projects don't deploy an ERC-20 at launch (tokens are credits), so the symbol can't live
  // onchain yet — stash it in the project URI metadata so the UI can show "$SYMBOL" until/unless an
  // ERC-20 is deployed later. Revnets pass the ticker to REVDeployer instead (real ERC-20), but it's
  // harmless to also record it here.
  if (d.ticker) m.symbol = d.ticker;
  if (d.logoUri) m.logoUri = d.logoUri;
  if (d.coverImageUri) m.coverImageUri = d.coverImageUri;
  if (d.website) m.infoUri = d.website;
  if (d.twitter) m.twitter = d.twitter.replace(/^@/, '');
  if (d.discord) m.discord = d.discord;
  if (d.telegram) m.telegram = d.telegram;
  if (d.instagram) m.instagram = d.instagram;
  if (d.whatsapp) m.whatsapp = d.whatsapp;
  if (d.payDisclosure) m.payDisclosure = d.payDisclosure;
  if (d.tags && d.tags.length) m.tags = d.tags;
  var categories = {};
  (storeCategories || []).forEach(function (entry) {
    var id = Number(entry && entry.id), name = String((entry && entry.name) || '').trim();
    if (Number.isSafeInteger(id) && id > 0 && name) categories[id] = name;
  });
  if (Object.keys(categories).length) m.storeCategories = categories;
  return m;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function chainName(id) { var c = CHAIN_OPTIONS.find(function (x) { return x.id === id; }); return c ? c.name : ('chain ' + id); }
// Chain icons (mirror discover.js CHAIN_LOGO_SVG — static brand marks) for the per-chain address rows.
var CHAIN_ICON_SVG = {
  eth: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="12" fill="#627EEA"/><path d="M12 4v5.9l5 2.25z" fill="#fff" fill-opacity=".6"/><path d="M12 4L7 12.15l5-2.25z" fill="#fff"/><path d="M12 16v3.99l5-6.92z" fill="#fff" fill-opacity=".6"/><path d="M12 19.99V16l-5-3.07z" fill="#fff"/><path d="M12 15.07l5-2.92-5-2.24z" fill="#fff" fill-opacity=".2"/><path d="M7 12.15l5 2.92v-5.16z" fill="#fff" fill-opacity=".6"/></svg>',
  op: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="12" fill="#FF0420"/><text x="12" y="15.6" font-size="8.5" font-weight="700" fill="#fff" text-anchor="middle" font-family="Helvetica,Arial,sans-serif">OP</text></svg>',
  base: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="12" fill="#0052FF"/><path d="M12 6.2A5.8 5.8 0 0 0 12 17.8V6.2z" fill="#fff"/></svg>',
  arb: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="12" fill="#2D374B"/><path d="M12 6l4.8 11h-2.4L12 11.2 9.6 17H7.2z" fill="#28A0F0"/><path d="M12 6l-1.05 2.45L12 11.2l1.05-2.75z" fill="#fff"/></svg>',
};
function chainIcon(id, titleName) {
  var fam = (id === 1 || id === 11155111) ? 'eth' : (id === 10 || id === 11155420) ? 'op' : (id === 8453 || id === 84532) ? 'base' : (id === 42161 || id === 421614) ? 'arb' : null;
  var span = el('span', 'chain-logo'); if (titleName) span.title = titleName;
  if (fam) span.innerHTML = CHAIN_ICON_SVG[fam]; else span.textContent = '◦';
  return span;
}
function shortAddr(a) { return a && a.length > 10 ? truncAddr(a) : (a || '—'); }
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
export function isEnsName(v) { v = (v || '').trim(); return /\.[a-z]{2,}$/i.test(v) && !/^0x/i.test(v); }
function resolveEns(name) {
  name = (name || '').trim().toLowerCase();
  if (_ensCache[name] !== undefined) return Promise.resolve(_ensCache[name]);
  var norm; try { norm = ensNormalize(name); } catch (_) { return Promise.resolve(null); }
  return ensClient().getEnsAddress({ name: norm }).then(function (addr) { _ensCache[name] = addr || null; return addr || null; })
    .catch(function () { return null; });
}
// Reverse ENS: a 0x address → its primary ENS name (or null). Cached.
var _ensRevCache = {};
export function reverseEns(address) {
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
  if (isAddr(str)) return str;
  if (isEnsName(str)) { var c = _ensCache[str.toLowerCase()]; return c || ''; }
  return str;
}
function createKnownAddressLabel(chainId, addr) {
  if (!chainId || !isAddr(addr)) return '';
  var lc = String(addr || '').toLowerCase();
  if (lc === ZERO.toLowerCase()) return 'Zero address';
  if (lc === NATIVE_TOKEN.toLowerCase()) return 'Native ETH token';
  var cname = resolveContractName(addr, chainId);
  if (cname) return 'Known contract: ' + cname + ' on ' + chainName(chainId);
  var toks = [];
  try { toks = getChainTokens(Number(chainId)) || []; } catch (_) {}
  for (var i = 0; i < toks.length; i++) {
    if (toks[i].address && toks[i].address.toLowerCase() === lc) {
      return 'Known token: ' + String(toks[i].symbol || '').replace(/\s*\(native\)/i, '') + ' on ' + chainName(chainId);
    }
  }
  return '';
}
// Attach ENS resolution to an address input: returns a small hint element that shows the resolved address,
// known local contracts/tokens, or a "resolving…/not found" state, and stores ENS results via store(name,addr).
function attachEns(input, store, opts) {
  opts = opts || {};
  var hint = el('div', 'create-resolve-hint'); hint.style.display = 'none';
  var token = 0, timer = null;
  function go() {
    var v = (input.value || '').trim();
    if (!isEnsName(v)) {
      store(v, null);
      if (isAddr(v)) {
        var known = createKnownAddressLabel(opts.chainId, v);
        if (known) { hint.style.display = ''; hint.className = 'create-resolve-hint ok'; hint.textContent = known; return; }
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
function priceUnits(v, decimals) {
  if (v == null || String(v).trim() === '') return 0n;
  var parsed = parseUnits(String(v).trim(), decimals);
  if (parsed < 0n) throw new Error('Amounts cannot be negative.');
  return parsed;
}
function ipfsHttp(uri) {
  if (!uri) return '';
  if (uri.indexOf('ipfs://') === 0) return ipfsHttpUrl(uri);
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

// ---- Test-only exports (consumed by the vitest suite; unused by app.js → tree-shaken from the bundle). ----
export const __test = {
  suckerConfigFor, tokenMappingFor,
  initState, buildLaunchArgs, buildRevnetArgs, buildTerminalConfigs, revnetAccept, acctTokenFor,
  assembleRuleset, splitState, fillSplits, splitSharesFromAmounts, build721Config, customCurrencyId, customAcctDecimals,
  customAccounting, applyAccountingDefaults, recipientIssue, splitTotalIssue, currentPayoutKinds,
  createPayoutKinds, safeParseEther, priceUnits, fundAccessAmountDecimals, fundAccessUnits, uint256FromAddress,
  deploySalt, storeUnit, splitLockAllowed, tsToDateInput, FOREVER_SECONDS, pcAddrSet, approvalIssue,
  lpHookIssue, deadlinePresetIssue, itemSplits, mergeDraft,
  surplusTokenLabel, itemCashOutOn, anyTokenCashOut, buildMetadata, storeCategoryName, itemDraft, renderRevnetStages,
  // Hand-written ABI fragments, exposed so the ABI-parity suite can diff them against data/abis/*.json.
  revDeployAbi, revDeploy721Abi, deployer721Abi, omnichainAbi, omnichain721Abi,
};
