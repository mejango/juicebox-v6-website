# Transaction coverage — JB V6 web app vs the v6 contracts

How completely the app's transactions are pinned by tests. **Line coverage is the wrong lens here** — the
app is ~95% DOM rendering, so per-file line % stays low even when the money path is fully tested. The metric
that matters: **does each transaction have a pure `buildXArgs()` round-tripped through its contract ABI?**

Legend: **U** = unit/encoding test (round-trips through the contract ABI + arg assertions); **S** = UI smoke.

## Transactions — builder + test status

| App action | Contract function | Builder | Test |
|---|---|---|---|
| Pay | `JBMultiTerminal.pay` | `buildPayArgs` | **U** (+ slippage-floor regression) |
| Add to balance | `JBMultiTerminal.addToBalanceOf` / `JBRouterTerminalRegistry.addToBalanceOf` | `buildAddToBalanceArgs` | **U** (both canonical ABIs; exact native/ERC-20 value + approval semantics) |
| Cash out | `JBMultiTerminal.cashOutTokensOf` | `buildCashOutArgs` / `cashOutMinReclaimed` | **U** |
| Send payouts | `JBMultiTerminal.sendPayoutsOf` | `buildSendPayoutsArgs` | **U** |
| Launch project | `JBController.launchProjectFor` / omnichain | `buildLaunchArgs` | **U** + **S** |
| Deploy revnet | `REVDeployer.deployFor` | `buildRevnetArgs` | **U** + **S** |
| Queue rulesets | `JBController.queueRulesetsOf` | `buildQueueRulesetsArgs` | **U** |
| Queue omnichain rulesets / start shop | `JBOmnichainDeployer.queueRulesetsOf` overloads | `buildOmnichainQueueArgs` / `buildNewShopQueueCall` | **U** (canonical overload selectors + nested args) |
| Mint | `JBController.mintTokensOf` | `buildMintArgs` | **U** |
| Burn | `JBController.burnTokensOf` | `buildBurnArgs` | **U** |
| Deploy ERC-20 | `JBController.deployERC20For` | `buildDeployErc20Args` | **U** |
| Send reserved | `JBController.sendReservedTokensToSplitsOf` | `buildSendReservedArgs` | **U** |
| Claim credits | `JBController.claimTokensFor` | `buildClaimTokensArgs` | **U** |
| Distribute auto issuance | `REVOwner.autoIssueFor` | `buildAutoIssueArgs` | **U** |
| Add / remove shop items | `JB721TiersHook.adjustTiers` | `buildAdjustTiersArgs` | **U** (all tier fields + remove ids) |
| Mint shop item without payment | `JB721TiersHook.mintFor` | `buildOwnerMintTierIds` | **U** (repeated uint16 quantity, bounds, exact ABI round trip) |
| Set permissions | `JBPermissions.setPermissionsFor` | `buildSetPermissionsArgs` | **U** (ids vs JBPermissionIds.sol) |
| Borrow | `REVLoans.borrowFrom` | `buildBorrowArgs` | **U** (+ slippage floor wired) |
| Repay | `REVLoans.repayLoan` | `buildRepayArgs` | **U** |
| Move between chains | `JBSucker.prepare` → `toRemote` | `buildSuckerPrepareArgs` / `buildSuckerToRemoteArgs` | **U** |
| Set ENS project record | exact resolver `setText(node,"juicebox","chainId:projectId")` | `buildSetEnsProjectRecordCall` | **U** (exact Registry resolver only; no resolver replacement; live tuple authority + resolver authorization rechecked at Safe queue boundaries; direct/Safe postcondition) |
| Publish project handle | `JBProjectHandles.setEnsNamePartsFor` | `buildSetProjectHandleCall` | **U** (canonical reversed labels; encoded tuple’s current owner/operator + exact ENS record rechecked at Safe queue boundaries; direct/Safe postcondition) |

## Structural wallet boundary inventory

These rows describe shared or deliberately generic signing boundaries rather
than one ABI builder. `npm run transaction:check` counts every production
occurrence, including the boundary definitions, so adding, moving, or bypassing
one cannot silently enter the app.

| Action | Boundary | Safety coverage |
|---|---|---|
| Reviewed direct write boundary | `executeTransaction` | Exact review payload, account/chain rechecks, simulation, receipt status, approval ordering, and Safe routing are unit-tested. |
| Reviewed single-chain direct write | `discover.js` direct dispatcher | One-chain management calls use the exact review modal, recheck the account and chain, simulate the raw call, submit directly, and require a successful receipt. Relayr is reserved for bundles spanning multiple chains. |
| Generic ABI contract write | `form.js` reviewed write | Displays target/function/arguments/calldata/value, rechecks account and chain, simulates, then requires a successful receipt. |
| Relayr forwarded bundle / payment | `relayrPostBundle` / `relayrPay` | Canonical forward request, signer/account identity, quote/payment state, persistence, polling, expected bundle cardinality, and partial-chain failure are unit-tested. The prepaid native-payment target, selector, runtime hash, token, bundle UUID, and deadline are pinned and decoded client-side; the exact target/value/calldata receive a separate mandatory review before a bounded raw simulation and wallet send. |
| Safe proposal / confirmation / execution | Safe App and Safe service boundaries | Proposal hashes remain distinct from execution; canonical Safe proxy/singleton identity, bounded CCIP-off reads, exact `execTransaction` tuples, current owners/threshold/nonce/confirmations, raw bounded simulation, post-review freshness, and receipt status are tested. |
| Permit2 and direct approvals | reviewed approval helpers | Canonical Permit2 domain/spender, amount/deadline/nonce, account rechecks, simulations, post-receipt allowance checks, valid-allowance reuse, and typed-signature fallback to an approval-block-anchored on-chain authorization are tested. |
| Project management actions | `discover.js` reviewed action handlers | Individual ABI builders are tracked above; all submission paths must remain behind the shared review, Safe, or Relayr boundaries. |
| Bounded exact ENS / handle reads | `project-handles.js` raw `eth_call` | Exact-node resolver and handle reads use explicit gas, pin Registry + resolver reads where applicable, supply `JBProjectHandles` as caller, bound returndata, reject noncanonical handles, and bypass CCIP redirects. |
| Wallet connection / network request | EIP-1193 provider requests | Only account permission, account enumeration, chain switching, and the chain-gated `eth_getTransactionReceipt` poll are allowed here; all write/sign APIs are inventoried separately. |

Plus create-flow encoding invariants (**U**): custom-token currency id consistency, `splitState` per recipient
type, split-group sums, the approval-hook (preset/custom/per-chain) + split-lock encoding, the deploy preflight
gates (recipient / over-100% / custom-token / approval), `parseAmount`/`addrOrZero` safety, `deploySalt`.

## Views (display logic)

| Area | Test |
|---|---|
| `bendystraw-format` volumeUsd / bigint / bool | **U** (`views.test.js`) |
| create-flow steps, accounting pills, approval condition, split lock, deploy gating | **S** (`ui-smoke.mjs`) |

## Not yet under unit test
- Broader view rendering (discover cards, project-detail tabs) — covered by UI smoke + manual CDP, not unit.

Safe `execTransaction` encoding is covered in `components-tx.test.js`, including
the exact outer tuple assembled from the queued Safe transaction and signatures.
The project and account queue paths execute reviewed same-chain Safe batches
directly, in nonce order; only batches spanning multiple distinct chains use
Relayr.

## Adherence
`verify-tx-builders-vs-contracts` (workflow, 5 agents) confirmed **every builder encodes correctly** against the
deployed V6 contracts (selectors, arg order, types, payability) — zero HIGH/MEDIUM. The three LOW findings
(deploy-erc20 permission label, permission display grouping, borrow slippage floor) are fixed.
