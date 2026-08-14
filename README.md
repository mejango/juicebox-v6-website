# Juicebox V6 Explorer

A self-contained, client-only web app for discovering, paying, managing, and deploying [Juicebox V6](https://juicebox.money) projects and [Revnets](https://revnet.app) across every chain the protocol is deployed on. It reads the chain directly and builds every transaction in the browser — there is no backend, and the production build is a static bundle published to IPFS.

- **No server.** All reads go to public RPCs; all writes are signed by the user's wallet. The app is a directory/explorer that happens to also compose protocol transactions.
- **Multichain.** Mainnet (Ethereum, Optimism, Base, Arbitrum) and the matching testnets. Project token balances and accounting bridge between chains via JBSucker.
- **Contract-faithful.** Every transaction is encoded against the deployed V6 ABIs (generated from `deploy-all-v6/deployments`) and its arguments are pinned by tests that round-trip through those ABIs.

## Quick start

```bash
nvm use
npm ci
npm run dev          # regenerate the registry, bundle, and serve at http://localhost:3000
npm run build        # regenerate data + bundle to dist/
npm run test         # vitest unit/encoding suite
npm run test:browser # deterministic production-bundle shape/a11y checks
npm run test:ci      # every deterministic CI gate
npm run check        # production dependency audit + every deterministic gate
```

`dist/` is the entire deployable app: `index.html` + `app.js` (the bundle, with all ABIs/data inlined) + `style.css` + a couple of static assets.

`npm run serve` serves the existing `dist/` without rebuilding it. Set `PORT` to override its default port; Playwright does this automatically so its isolated test server remains on port 4181.

Project URLs mirror their hash route into `?project=<chain>:<id>`. The bundle still works unchanged on
IPFS; when it is served by `npm run serve`, that crawler-visible query lets the lightweight static server
add a project-specific link card (logo, name, slogan, balance, and payment count). The project data remains
read-only Bendystraw/IPFS data and no transaction path moves server-side.

## Architecture

Vanilla ES modules, no framework, bundled with esbuild. State lives in plain objects; views are built with a tiny `el()` DOM helper and re-rendered on change. The whole app is one IIFE in `dist/app.js`.

```
src/
  app.js                  entry — routing (#discover, #learn, …), tab shell
  discover.js             the big one: project directory + project detail
                          (tokens / owners / settlement / loans / stages),
                          loans (borrow/repay), cross-chain move, Safe flows, 721 mgmt
  create-flow.js          the project-creation wizard (custom projects + revnets)
  pay-component.js        pay a project (direct terminal OR buyback/AMM route)
  cashout-component.js    burn tokens to reclaim surplus
  mint/burn/deploy-erc20/reserved/payouts/permissions-component.js
                          single-purpose controller/terminal actions
  launch-component.js     standalone launch + the shared ruleset encoders
  queue-ruleset-component.js   queue new rulesets on an existing project
  component-base.js       executeTransaction(), wallet, ENS, address/amount helpers
  encoding.js             parseAmount/formatAmount (decimals-correct)
  chain.js / wallet.js / relayr.js / safe.js   chain config, wallet, relayer, Safe
  bendystraw-*.js         the (optional) indexer client + formatters
  abi-registry.js         GENERATED — all contract ABIs + addresses (do not edit)
  data/*.json             GENERATED — deployments, contract sources

build/                    the data pipeline + bundler + IPFS publisher
test/                     vitest unit/encoding tests + a CDP UI-smoke runner
```

### Build pipeline

`npm run build` runs four steps; the deployed bytecode's ABIs/addresses are the source of truth:

1. `sync-deployments` — pull ABIs + addresses from `../../deploy-all-v6/deployments` into `data/`.
2. `extract-sources` — pull verified contract sources (for the in-app source viewer).
3. `generate-registry` — fold everything into `src/abi-registry.js` (one importable module).
4. `bundle` — esbuild → `dist/app.js`; `style.css` is copied verbatim.

> `src/abi-registry.js` and `data/*.json` are generated. Regenerate with `npm run build`; never hand-edit them. They change only when `deploy-all-v6/deployments` changes (e.g. a new chain or a redeploy).

### Currency model (important)

Juicebox separates two notions of "currency":

- **`baseCurrency`** — a standard id (`ETH = 1`, `USD = 2`) used for issuance/pricing. Chain-portable.
- **`JBAccountingContext.currency`** — `uint32(uint160(token))`, i.e. derived from the token address. Per-token, per-chain.

`JBPrices` bridges them via feeds. A **custom accounting token** uses its own currency id everywhere (base == accounting), so no feed is needed. An **ETH+USDC** project must use `baseCurrency = USD(2)` so both legs resolve through the default ETH/USD + USDC/USD feeds. The wizard enforces this.

## Transactions

Every write is composed in the browser and handed to the wallet through `executeTransaction()` (`component-base.js`), which handles approvals/permits, simulation, confirmation, and status. The argument-building for each transaction is a **pure `buildXArgs()` function** so it can be unit-tested in isolation, round-tripped through the contract ABI, and reused.

| Action | Contract function | Builder |
|---|---|---|
| Pay | `JBMultiTerminal.pay` | `buildPayArgs` (pay-component) |
| Add to balance | `JBMultiTerminal.addToBalanceOf` / router registry | `buildAddToBalanceArgs` |
| Cash out | `JBMultiTerminal.cashOutTokensOf` | `buildCashOutArgs` |
| Send payouts | `JBMultiTerminal.sendPayoutsOf` | `buildSendPayoutsArgs` |
| Launch project | `JBController.launchProjectFor` / omnichain | `buildLaunchArgs` (create-flow) |
| Deploy revnet | `REVDeployer.deployFor` | `buildRevnetArgs` |
| Queue rulesets | `JBController.queueRulesetsOf` | queue-ruleset-component |
| Queue omnichain rulesets / shop | `JBOmnichainDeployer.queueRulesetsOf` overloads | `buildOmnichainQueueArgs` / `buildNewShopQueueCall` |
| Mint / Burn | `JBController.mintTokensOf` / `burnTokensOf` | `buildMintArgs` / `buildBurnArgs` |
| Deploy ERC-20 | `JBController.deployERC20For` | `buildDeployErc20Args` |
| Send reserved | `JBController.sendReservedTokensToSplitsOf` | `buildSendReservedArgs` |
| Set permissions | `JBPermissions.setPermissionsFor` | `buildSetPermissionsArgs` |
| Borrow / Repay | `REVLoans.borrowFrom` / `repayLoan` | `buildBorrowArgs` / `buildRepayArgs` |
| Auto issuance | `REVOwner.autoIssueFor` | `buildAutoIssueArgs` |
| Add / remove shop items | `JB721TiersHook.adjustTiers` | `buildAdjustTiersArgs` |
| Move between chains | `JBSucker.prepare` → `toRemote` | `buildSuckerPrepareArgs` / `buildSuckerToRemoteArgs` |

**Safety floors.** `pay` and `cashOutTokensOf` send a slippage floor (99% of previewed mint output; 95% of previewed reclaim) rather than `0`, so an adverse swap / surplus drop reverts instead of silently succeeding.

## Testing

```bash
npm run test       # vitest: encoding, validation, ABI-selector, and tx-builder round-trips
npm run test:coverage # unit suite plus regression coverage floors
npm run test:browser  # Chromium at phone/tablet/desktop widths; no live services
npm run test:ui    # CDP UI smoke (needs Brave on :9222 + dist served on :8799)
npm run check      # full local pre-publish gate (audit + deterministic suite)
```

- **Unit/encoding** (`test/*.test.js`) — every `buildXArgs()` is round-tripped through its contract ABI (`encodeFunctionData`→`decodeFunctionData`) and arg-checked for the right currency id, decimals, recipient, value, and slippage floor. Plus invariants: split-group sums, custom-token currency consistency, deploy preflight gates, the approval-hook + split-lock encoding.
- **Browser shape** (`test/e2e`) — gates the production bundle at 320/390/768/1280 px with contained-layout, keyboard, navigation, axe assertions, and a no-regression contrast-debt ratchet. External requests are blocked, so pull requests never depend on RPC or indexer uptime.
- **Live UI canary** (`test/ui-smoke.mjs`) — drives deployed project fixtures and asserts create/accounting/LP/loan behavior. It is deliberately manual because its RPC and Bendystraw inputs can change independently of this repository.
- See `TESTING.md` for the complete deterministic-vs-live policy.
- See `test/TX_COVERAGE.md` for the transaction→contract→test map and `test/AUDIT_FOLLOWUPS.md` for the running audit/fix log.

## Deploy (IPFS)

```bash
npm run publish    # build + pin dist/ to Pinata; prints the CID
```

Requires `PINATA_JWT` in `.env` (untracked). The app is fully static and content-addressed; the printed CID is the deployable artifact (open via any IPFS gateway).

## Conventions

- Generated files (`abi-registry.js`, `data/*.json`) are never hand-edited.
- New transactions get a pure `buildXArgs()` + a round-trip test before they ship.
- Address fields resolve ENS and coerce blanks/garbage to the zero address; any field that could silently encode `address(0)` for a fund/authority destination is gated at deploy time.
