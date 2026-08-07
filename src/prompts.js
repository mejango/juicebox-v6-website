// src/prompts.js
// Generate LLM prompts for protocol auditing and per-function context

import { registry } from './abi-registry.js';

var ECOSYSTEM_REPO_URL = 'https://github.com/Bananapus/version-6';

function getContractRepo(contractName) {
  var src = registry && registry.sources && registry.sources[contractName];
  if (!src) return null;
  return {
    repo: src.repo || null,
    githubUrl: src.githubUrl || null,
    path: src.path || null,
  };
}

function pushRepoContext(lines, contractName) {
  lines.push('## Source Repositories');
  lines.push('- Full ecosystem (start here for cross-repo audits): ' + ECOSYSTEM_REPO_URL + ' — read its root `AUDIT_INSTRUCTIONS.md` for the audit engine.');
  var src = getContractRepo(contractName);
  if (src && src.githubUrl) {
    var contractRef = '- This contract’s repo: ' + src.githubUrl;
    if (src.path) contractRef += ' (' + src.path + ')';
    lines.push(contractRef);
    lines.push('- Repo-local audit notes: ' + src.githubUrl + '/blob/main/AUDIT_INSTRUCTIONS.md');
  }
  lines.push('');
}

var CONTRACT_DESCRIPTIONS = {
  JBMultiTerminal: 'Holds funds and executes pay, payout, cash out, surplus allowance, and fee-processing flows. Multi-token. Handles fees (2.5%, 28-day hold). Permit2 integration.',
  JBTerminalStore: 'Owns accounting and surplus logic. Records payment minting, payout limit usage, and bonding curve reclaim math. Data hook integration point.',
  JBController: 'Orchestrator for project lifecycle — ruleset queuing, token minting/burning, reserved token distribution, ERC2771 meta-transactions.',
  JBDirectory: 'Routes projects to their terminals and controllers. Handles migration hooks.',
  JBRulesets: 'Stores current and queued economic parameters. Linked-list via basedOnId. Weight decay with cache. Approval hooks.',
  JBTokens: 'Dual token system: internal credits + ERC-20. Credits burned first on cash out. 18-decimal requirement.',
  JBSplits: 'Packed split storage for payout and reserved token distribution. Locked splits enforcement.',
  JBFundAccessLimits: 'Payout limits and surplus allowances per terminal/token/currency.',
  JBPrices: 'Price feed registry with project-specific and protocol default fallback. Inverse auto-calculation. Immutable feeds.',
  JBPermissions: '256-bit packed permissions. ROOT (1) grants all. Wildcard projectId=0 for cross-project access.',
  JBProjects: 'ERC-721 project ownership NFTs.',
  JBERC20: 'Cloneable ERC20Votes+Permit token. Owned by JBTokens.',
  JBFeelessAddresses: 'Fee-exempt address registry.',
  JB721TiersHook: 'Tiered NFT rewards hook. Tiers sorted by category. Supports pay and cash out hooks.',
  JB721TiersHookStore: 'Storage for 721 tier data, pricing, and metadata.',
  JB721TiersHookDeployer: 'Factory for deploying 721 tiered hooks.',
  JB721TiersHookProjectDeployer: 'Combined project + 721 hook deployment.',
  JBBuybackHook: 'Pay data hook that routes a payment through a Uniswap pool to buy back the project token when that yields more tokens than minting. Otherwise minting proceeds normally.',
  JBBuybackHookRegistry: 'Registry for buyback hooks that route payments through DEXs when cheaper than minting.',
  JBSuckerRegistry: 'Registry for cross-chain sucker bridges.',
  JBAddressRegistry: 'Maps deployed contract addresses to their deployers for trust verification.',
  REVDeployer: 'Deploys and manages revnet (revenue network) projects.',
  REVOwner: 'Runtime data hook for every revnet — coordinates the 721 and buyback hooks at pay time, aggregates cross-chain supply/surplus, and routes the 2.5% fee at cash out. Split from REVDeployer for EIP-170 size limits.',
  REVLoans: 'Loan system using project tokens as collateral.',
  JBRouterTerminal: 'Universal payment terminal: accepts any token and converts it into whatever the destination project accepts, picking the route (direct forward, Uniswap V3/V4 swap, recursive cash out) that yields the most project tokens. Never holds a balance.',
  JBRouterTerminalRegistry: 'Registry for router terminal configurations.',
  JBProjectHandles: 'Maps ENS names to project IDs.',
  JBProjectPayer: 'Payment relay that auto-forwards received ETH/ERC-20 to a project’s terminal via receive(), or routes explicitly via pay/addToBalanceOf. Deployed as an EIP-1167 clone.',
  JBProjectPayerDeployer: 'Factory that deploys JBProjectPayer EIP-1167 minimal-proxy clones.',
  JBOmnichainDeployer: 'One-stop deployer for omnichain projects: launches a project with a tiered 721 hook and cross-chain suckers in one transaction, then inserts itself as every ruleset data hook to coordinate the 721/buyback hooks and compute cross-chain total supply and surplus.',
  JBOptimismSucker: 'Cross-chain bridge to/from Optimism: cashes out a project’s tokens locally and queues funds+tokens into an outbox merkle tree, then mints them to beneficiaries on the peer chain via an inbox merkle proof. Registered via JBSuckerRegistry.',
  JBArbitrumSucker: 'Cross-chain bridge to/from Arbitrum, using merkle outbox/inbox trees to move a project’s tokens and backing funds between chains. Registered via JBSuckerRegistry.',
  JBBaseSucker: 'Cross-chain bridge to/from Base, using merkle outbox/inbox trees to move a project’s tokens and backing funds between chains. Registered via JBSuckerRegistry.',
  JBUniswapV4Hook: 'Uniswap V4 hook that routes swaps to whichever venue — V4 pool or Juicebox project — gives the user more tokens. Uses a 30-minute TWAP oracle to resist price manipulation.',
  JBUniswapV4LPSplitHook: 'Split hook that builds and manages a project-owned Uniswap V4 liquidity position, seeded by the project’s reserved-token distributions via a two-stage accumulate-then-deploy lifecycle.',
  JBUniswapV4LPSplitHookDeployer: 'Factory that deploys lightweight JBUniswapV4LPSplitHook clones.',
  DefifaDeployer: 'Deploys and manages Defifa prediction-market games — each game has tiers representing outcomes; players mint tier NFTs during the MINT phase, a scorecard assigns cash out weights after the event, and the pooled funds are distributed proportionally to winning holders. Phases: COUNTDOWN → MINT → REFUND → SCORING → COMPLETE/NO_CONTEST.',
  DefifaHook: 'The 721 hook powering Defifa games — enforces game-phase rules on minting and cash out, and applies the scorecard cash out weights per tier.',
  DefifaGovernor: 'Manages ratification of Defifa scorecards via token-weighted attestation — NFT holders attest to proposed cash out weights with power proportional to NFTs held; a scorecard ratifies once it reaches quorum.',
  CTPublisher: 'The Croptop publishing engine. Anyone can publish NFT posts to a project’s 721 hook subject to per-category criteria (min price, supply bounds, allowlist) set by the collection owner; routes a 5% fee to the fee project, pays the remainder into the project terminal, and dedups duplicate IPFS URIs to reuse existing tiers.',
  CTDeployer: 'Deploys Juicebox projects pre-configured for Croptop — a permissionless NFT publishing system — and registers posting permissions/criteria.',
  CTProjectOwner: 'A dead-end project owner that locks ownership while preserving Croptop posting permissions.',
  JBMatchingPriceFeed: 'A 1:1 price feed used when a payout limit is denominated in the same currency as the terminal token, so no conversion is needed.',
  JBHeldFees: 'External library for held-fee storage operations used by JBMultiTerminal during the 28-day fee hold.',
};

export function getAuditPrompt() {
  return [
    'You are a world-class security engineer auditing the Juicebox V6 protocol — an open-source, permissionless programmable money system deployed on Ethereum and L2s (Optimism, Arbitrum, Base, and possibly more). Your goal is to prove me wrong: once we have deployed projects (revnets) 1-7 alongside the ecosystem in deploy-all-v6 Deploy.s.sol, and other juicebox projects begin being created (revnets and omnichain deployed), and they all start receiving payments and being used in their full capacity, you cannot find a way to brick any of them, steal their funds, or corrupt project owner and token holder invariants on your own, you cannot find a way to have made project operations more efficient for any and all network participants that we should have considered before deployment, and you cannot find ways to have made documentation more clear, efficient, and friendly for both AIs and humans looking to get things done with the protocol. Find as many ways as you can to prove me wrong, don’t stop at just your first find — the wellbeing and safety of the protocol that we will be deploying depends on you. Start from first principles, using the other audit files in the repos as reference but not as a priority guide. Use a new .md file as a scratchpad as needed and for results.',
    '',
    'Start by cloning the full ecosystem repo and following its top-level audit engine:',
    '',
    '```bash',
    'git clone --recursive https://github.com/Bananapus/version-6',
    '```',
    '',
    'Then read `AUDIT_INSTRUCTIONS.md` at the root of that repo — it is the audit engine that walks through depth, subsystem, and adversarial-persona selection, decomposes the work into components, and tells you where to submit findings. The context below is a fast primer; the repo and its `AUDIT_INSTRUCTIONS.md` are the source of truth.',
    '',
    '## Protocol Architecture',
    '',
    'The protocol is built from ~47 contracts across 17 repositories under github.com/Bananapus.',
    '',
    'Core contracts:',
    '- JBMultiTerminal: Holds funds. Executes pay, payout, cash out, surplus allowance, and fee-processing flows. Multi-token. 2.5% fee with 28-day hold.',
    '- JBTerminalStore: Accounting engine. Records balances, computes surplus, bonding curve reclaim math.',
    '- JBController: Project lifecycle orchestrator. Ruleset queuing, token mint/burn, reserved token distribution.',
    '- JBRulesets: Economic parameter storage. Linked-list with weight decay, approval hooks, bit-packed metadata.',
    '- JBTokens: Dual token system (internal credits + ERC-20). Credits burned first.',
    '- JBPermissions: 256-bit packed operator permissions. ROOT grants all. Wildcard projectId=0.',
    '- JBPrices: Price feed registry. Immutable feeds, inverse auto-calculation.',
    '- JBSplits: Payout and reserved token split distribution.',
    '- JBFundAccessLimits: Per-cycle payout limits and surplus allowances.',
    '- JBDirectory: Routes projects to terminals and controllers.',
    '',
    '## Key Flows',
    '',
    '1. Payment: accept funds → STORE.recordPaymentFrom (weight calc, data hook) → mint tokens → fulfill pay hooks',
    '2. Cash out: STORE.recordCashOutFor (bonding curve, data hook) → burn tokens → transfer reclaim → fulfill hooks → take fees',
    '3. Payouts: STORE.recordPayoutFor → distribute to splits → leftover to owner → take fees',
    '4. Reserved tokens: accumulated in pendingReservedTokenBalanceOf → sendReservedTokensToSplitsOf mints and distributes',
    '',
    '## Critical Invariants',
    '',
    '1. Terminal solvency: internal balances + held-fee obligations must reconcile with actual token balances',
    '2. No over-withdrawal: payouts and allowance usage must never exceed configured per-cycle limits',
    '3. Cash out correctness: surplus, total supply, tax rate, fee treatment, and hook overrides must produce correct reclaim',
    '4. Ruleset integrity: active ruleset and fallback/cycling behavior must match exact timing and approval-hook semantics',
    '5. Token accounting: credits, ERC-20 supply, reserved balance, and burn/mint paths must stay coherent',
    '6. Privilege containment: permissions, wildcards, controller migration, and terminal routing must not allow unauthorized control',
    '7. Held-fee correctness: deferred fees must not be forgiven, duplicated, or charged to the wrong place',
    '8. Preview coherence: previewPayFor and previewCashOutFrom must not drift from actual execution',
    '',
    '## Omnichain Resilience',
    '',
    'The protocol deploys across Ethereum, Optimism, Arbitrum, Base, and possibly more. Each chain has unique properties:',
    '- Native token varies: ETH on Ethereum/L2s, CELO on Celo. Some chains may have no native token. The protocol uses NATIVE_TOKEN (0x...EEEe) as a sentinel and WRAPPED_NATIVE_TOKEN (WETH9-compatible) for wrapping.',
    '- Token addresses differ per chain: USDC, USDT, DAI, etc. have different contract addresses on each chain. The protocol must not assume a token address is portable.',
    '- Decimals vary: USDC has 6 decimals, ETH has 18. The protocol uses JBFixedPointNumber for decimal adjustment and JBPrices for cross-currency conversion.',
    '- Cross-chain bridging: JBSucker contracts use merkle trees (outbox/inbox) to bridge tokens between chains. Token mappings are immutable once the outbox tree has entries.',
    '- Sequencer risk on L2s: JBChainlinkV3SequencerPriceFeed checks L2 sequencer status and enforces a grace period after restart.',
    '- Amount caps: Cross-chain amounts use uint128 for SVM/Solana compatibility.',
    '',
    '## Omnitoken Resilience',
    '',
    'The protocol is multi-token by design. Each terminal can hold multiple token types simultaneously:',
    '- Accounting contexts track token address, decimals, and currency per terminal. Duplicate prevention is enforced.',
    '- Currency (uint32) is derived from token address: uint32(uint160(tokenAddress)). This is distinct from baseCurrency (1=ETH, 2=USD) used in ruleset metadata.',
    '- groupId (uint256) and currency (uint32) represent the same token but with different bit widths — mixing them up causes silent bugs.',
    '- Surplus aggregation converts across all terminals and tokens via JBPrices to a target currency. A feed that REVERTS is skipped, not propagated: JBPrices tries each registered feed in order inside a try/catch and falls through to the next (JBPrices.sol:338-341), then to project-0 defaults and inverse feeds. The operation reverts only when NO feed in that lookup path returns a non-zero price (JBPrices_PriceFeedNotFound).',
    '- Fee-free intra-terminal payouts track per token. Payout limits and surplus allowances are scoped per terminal/token/currency.',
    '- Empty fundAccessLimitGroups means zero payouts (NOT unlimited). Use uint224.max for unlimited.',
    '- ERC-20 fee-on-transfer, rebasing, and non-standard decimals are potential edge cases at system boundaries.',
    '',
    '## Attack Surfaces',
    '',
    '- pay, cashOutTokensOf, sendPayoutsOf, and useAllowanceOf entry points',
    '- preview paths when downstream repos treat them as execution truth',
    '- held-fee lifecycle and _processFee',
    '- surplus aggregation across terminals and token types',
    '- controller and terminal migration',
    '- setPermissionsFor and wildcard semantics',
    '- hook reentrancy: pay hooks, cash out hooks, split hooks',
    '- cross-chain token mapping and bridge message integrity',
    '- native token handling on chains where the native token is not ETH',
    '',
    '## Key Constants',
    '',
    '- FEE = 25 / 1000 = 2.5% (1000 is the fee denominator, not an achievable fee value)',
    '- MAX_RESERVED_PERCENT = 10,000 (basis points)',
    '- MAX_CASH_OUT_TAX_RATE = 10,000',
    '- SPLITS_TOTAL_PERCENT = 1,000,000,000',
    '- NATIVE_TOKEN = 0x000000000000000000000000000000000000EEEe',
    '- Fee holding: 28 days (2,419,200 seconds)',
    '',
    '## Known Issues (accepted risks)',
    '',
    '- Pending reserved tokens inflate totalSupply, reducing cashout value',
    '- Bonding curve subadditivity violation from mulDiv rounding (<0.01%)',
    '',
    '## Source Repositories',
    '',
    '- Core: github.com/Bananapus/nana-core-v6',
    '- 721 Hook: github.com/Bananapus/nana-721-hook-v6',
    '- Buyback Hook: github.com/Bananapus/nana-buyback-hook-v6',
    '- Suckers (cross-chain): github.com/Bananapus/nana-suckers-v6',
    '- Revnet: github.com/rev-net/revnet-core-v6',
    '- Router Terminal: github.com/Bananapus/nana-router-terminal-v6',
    '',
    '## How to Contribute',
    '',
    'Review any contract function for:',
    '- Logic errors that break invariants listed above',
    '- Reentrancy paths through hooks',
    '- Integer overflow/underflow or precision loss in accounting',
    '- Permission bypasses',
    '- State inconsistencies between preview and execution',
    '',
    'Report findings with: affected function, severity, description, and proof of concept.',
  ].join('\n');
}

function formatTupleType(param) {
  if (!param.components) return param.type;
  var fields = param.components.map(function(c) {
    return c.type + ' ' + (c.name || '');
  }).join(', ');
  return 'tuple(' + fields + ')' + (param.type.endsWith('[]') ? '[]' : '');
}

// Extract current field values from a component’s DOM
function extractComponentFields(componentEl) {
  var fields = [];
  var sections = componentEl.querySelectorAll('.component-section');
  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    var label = sec.querySelector('.input-label');
    var labelText = label ? label.childNodes[0].textContent.trim() : '';

    // Text/number inputs
    var input = sec.querySelector('input.field, input.amount-input, textarea.field');
    if (input) {
      var val = input.value || '';
      if (val) fields.push({ label: labelText, value: val });
      // Also check token dropdown in same section
      var tokenDd = sec.querySelector('.token-dropdown');
      if (tokenDd) {
        fields.push({ label: labelText + ' token', value: tokenDd.options[tokenDd.selectedIndex].text });
      }
      continue;
    }

    // Select dropdowns
    var select = sec.querySelector('select.field, select.network-dropdown');
    if (select) {
      fields.push({ label: labelText, value: select.options[select.selectedIndex].text });
      continue;
    }

    // Pills (chain pills, option pills)
    var selectedPill = sec.querySelector('.chain-pill.selected, .pill.selected');
    if (selectedPill) {
      fields.push({ label: labelText, value: selectedPill.textContent.trim() });
      continue;
    }
  }

  // Chain selector at top level
  var chainPill = componentEl.querySelector('.chain-pills-row .chain-pill.selected');
  if (chainPill && !fields.some(function(f) { return f.label === 'chain'; })) {
    fields.push({ label: 'chain', value: chainPill.textContent.trim() });
  }

  // Network dropdown
  var netDd = componentEl.querySelector('.network-dropdown');
  if (netDd) {
    fields.push({ label: 'network', value: netDd.options[netDd.selectedIndex].text });
  }

  return fields;
}

export function getComponentAuditPrompt(fn, contractName, fnNatspec, componentEl) {
  var lines = [];
  lines.push('I’m about to execute a Juicebox V6 transaction using a frontend component. Please audit what I’m about to sign — verify the parameters are correct, flag any risks, and confirm the onchain effect matches my intent.');
  lines.push('');

  pushRepoContext(lines, contractName);

  // What component
  var title = componentEl.querySelector('.component-title');
  lines.push('## Action: ' + (title ? title.textContent : fn.name));
  lines.push('');

  // Contract context
  lines.push('## Contract: ' + contractName);
  if (CONTRACT_DESCRIPTIONS[contractName]) {
    lines.push(CONTRACT_DESCRIPTIONS[contractName]);
  }
  lines.push('');

  // Function signature
  var paramList = fn.inputs.map(function(p) {
    return p.type + ' ' + (p.name || '');
  }).join(', ');
  lines.push('## Solidity Function');
  lines.push('`' + fn.name + '(' + paramList + ')`');
  lines.push('State mutability: ' + fn.stateMutability);
  lines.push('');

  // Current field values from the form
  var fields = extractComponentFields(componentEl);
  if (fields.length > 0) {
    lines.push('## My Current Input Values');
    for (var i = 0; i < fields.length; i++) {
      lines.push('- **' + fields[i].label + '**: ' + fields[i].value);
    }
    lines.push('');
  }

  // NatSpec
  if (fnNatspec) {
    if (fnNatspec.notice) {
      lines.push('## Function Description');
      lines.push(fnNatspec.notice);
      lines.push('');
    }
  }

  // Parameters with types
  if (fn.inputs.length > 0) {
    lines.push('## Parameter Specification');
    for (var j = 0; j < fn.inputs.length; j++) {
      var p = fn.inputs[j];
      var desc = '';
      if (fnNatspec && fnNatspec.params) {
        desc = fnNatspec.params[p.name] || fnNatspec.params[p.name.replace(/^_/, '')] || '';
      }
      var typeStr = p.type;
      if (p.components) {
        typeStr = formatTupleType(p);
      }
      lines.push('- `' + (p.name || 'param' + j) + '` (' + typeStr + ')' + (desc ? ': ' + desc : ''));
    }
    lines.push('');
  }

  // What to check
  lines.push('## Please Verify');
  lines.push('1. Do my input values correctly map to the function parameters?');
  lines.push('2. Will the onchain effect match what I intend (based on the action name and values)?');
  lines.push('3. Are there any risks, gotchas, or edge cases with these specific values?');
  if (fn.stateMutability === 'payable') {
    lines.push('4. This function accepts ETH via msg.value — is the amount and token correct?');
  }
  lines.push('');

  // Protocol context
  lines.push('## Protocol Context');
  lines.push('Juicebox V6 is an open-source programmable money protocol. Key invariants: terminal solvency, no over-withdrawal, correct bonding curve cashout, privilege containment via JBPermissions.');
  lines.push('');
  lines.push('Known gotchas: empty fundAccessLimitGroups = zero payouts (not unlimited), pending reserved tokens inflate totalSupply reducing cashout value, currency (uint32) != baseCurrency (1=ETH, 2=USD).');

  return lines.join('\n');
}
