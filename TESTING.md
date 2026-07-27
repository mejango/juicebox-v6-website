# Testing and CI

The test stack protects four different contracts with users. Each layer is deterministic in pull requests; live RPC and Bendystraw checks remain explicit canaries rather than flaky merge gates.

| Layer | Command | What it protects |
|---|---|---|
| Dependency graph | `npm run deps:check` | Rejects missing, invalid, or incompatible packages after the exact lockfile install. |
| Source parsing | `npm run check:source` | Every shipped/build/test JavaScript file parses on the supported Node runtime. |
| Deployment parity | `npm run check:deployments` | Recomputes the exact deployment-artifact digest consumed by the generator and compares it with both the reviewed deploy-all-v6 pin and `data/deployments.json`, without writing generated files. |
| Generated contract data | CI regeneration | Rebuilds `data/abis/`, `data/manifest.json`, `data/deployments.json`, and `src/abi-registry.js` from the independent pinned checkout and rejects any diff, preventing a correct digest from masking stale generated consumers. |
| Transaction inventory | `npm run transaction:check` | Counts every production direct-write, Relayr, Safe, signature, and raw wallet boundary and ties each site to `test/TX_COVERAGE.md`; a new or moved signing path fails CI until reviewed. |
| Protocol unit tests | `npm test` | ABI selectors and encode/decode round trips, transaction arguments, currencies/decimals, split totals, slippage floors, Safe/Relayr state, untrusted metadata, and indexer fallbacks. Unstubbed fetch/XHR/WebSocket/EventSource traffic fails closed. |
| Coverage floor | `npm run test:coverage` | Counts every executable `src/**/*.js` file, including unimported entry points and generated runtime registry code. App/form/guide orchestration and pay/Safe/wallet trust boundaries have tighter per-file floors. |
| Production bundle | `npm run bundle` | Builds the same static assets published to IPFS, using committed generated contract data. |
| Size budget | `npm run check:bundle` | Caps raw and gzip size for entry assets, lazy PDF runtime/worker assets, the logo, and their total distribution size. Budget increases require an explicit review. |
| Browser shape | `npm run test:browser` | Runs the production bundle at 320, 390, 768, and 1280 px; checks shell containment, all eight routable surfaces (including the intentionally navigation-hidden Actions route), hash navigation, a visible keyboard focus indicator, reduced-motion preference, and zero serious/critical axe findings across WCAG 2.0/2.1/2.2 AA—including zero color-contrast and target-size debt in the active surface and shared shell. Service workers are blocked, all chain RPCs are redirected to same-origin fail-fast endpoints before app startup, and any external HTTP/WebSocket attempt fails. |
| Production audit | `npm run audit:prod` | Blocks high and critical advisories in runtime dependencies. CI runs this after the exact lockfile install; low and moderate severities remain visible for review rather than triggering an unsafe forced upgrade. |
| Full local gate | `npm run check` | Verifies the locked dependency graph, runs the production dependency audit, and then runs every deterministic CI check. This is the final pre-publish gate. |
| Live canary | `npm run test:ui` | Exercises known deployed projects, custom accounting tokens, LP/loan flows, and the create wizard. This is intentionally manual because it depends on live RPC and Bendystraw state. |

CI runs on the fixed Ubuntu 24.04 image. Every reusable GitHub Action is pinned to an immutable full commit SHA, test checkouts disable persisted credentials, and the workflow keeps repository permissions read-only.

Dependabot checks npm and GitHub Actions weekly. Minor and patch updates are grouped; majors remain separate for deliberate review. Action updates must preserve immutable full-SHA pins, and no dependency update should merge until the complete deterministic suite and the high/critical production audit pass.

`npm run test:ci` runs every deterministic layer locally, including regeneration
and a clean-diff assertion for contract-derived artifacts. `npm run check` adds
the network-backed `audit:prod` gate; `npm run publish` delegates to that same
complete gate before invoking the IPFS publisher, so a failed invariant cannot
publish. The browser server uses an isolated port
(`4181` by default, overridable with `PLAYWRIGHT_APP_PORT`) and refuses to reuse
an existing process, so it cannot accidentally test another local app. CI
installs its own Chromium and uploads Playwright traces/screenshots/video when a
browser assertion fails. A retry may collect additional diagnostics, but
`failOnFlakyTests` makes a pass-on-retry fail CI rather than hiding a flaky
regression.

## Contract deployment pin

CI checks out `Bananapus/deploy-all-v6` at commit `316e9d4d3f9e1c5b41a5df7c0ad6183abbeccc7f`, limited to its `deployments/` directory. The expected generator digest is `sha256:443959a5a09616f4b73a0b4046e82674bab5e4e86287380d43642fa4aa898484`. `DEPLOY_ALL_DEPLOYMENTS_DIR` points the read-only verifier at that checkout; locally it defaults to `../../deploy-all-v6/deployments`.

Updating the pin is an explicit contract review:

1. Check out the proposed deploy-all-v6 commit and review its deployment artifact changes.
2. Run `DEPLOY_ALL_DEPLOYMENTS_DIR=/path/to/deploy-all-v6/deployments npm run sync-deployments` and review the generated ABI, manifest, address, and metadata diff.
3. Update the commit in `.github/workflows/test.yml` and the commit/digest constants in `scripts/check-deployment-parity.mjs` to the same reviewed source.
4. Run `npm run check:deployments` before accepting the generated snapshot. Bendystraw data may describe indexed activity, but it is never accepted as deployment or calldata truth.

## Coverage policy

The global all-production floors are 18% statements, 15% branches, 18% functions, and 22% lines. These deliberately include large generated and rendering-heavy files at zero when untested. Critical per-file floors are much higher: app entry orchestration (55/43/55/60), generic contract forms (80/68/75/90), pay routing/submission (44/45/50/50), Safe execution and terminal states (60/46/80/72), wallet lifecycle (68/49/70/76), and guide rendering (95/60/90/98), in statements/branches/functions/lines order. Lowering a ratchet requires an explicit explanation in review.

## Browser accessibility policy

The production browser gate contains 40 cases: 32 whole-visible-page axe scans (eight surfaces at four viewports) plus eight shell and route-shape cases. The supported widths are 1280, 768, 390, and 320 px. Every scan includes the active product surface and the shared header, navigation, footer, and font selector; hidden tabs are exercised when they become active in their own case. There are no color-contrast allowances: any serious or critical WCAG 2.0, 2.1, or 2.2 AA axe result fails the build. The current measured result is zero contrast and zero target-size violations in all 32 scans.

Each viewport explicitly requests reduced motion. Production CSS removes animation and transition motion under that preference, and the media unit test independently prevents autoplay. The browser gate also requires the first keyboard-reachable control to expose a visible outline at least 2 px wide; the production token is a 3 px brand-colored ring. Guide navigation links preserve the compact layout while meeting the WCAG 2.2 24 px minimum target size.

## Transaction rule

Every new write path must have a pure argument builder and a test that encodes and decodes it through the canonical deployed V6 ABI. The assertion must cover the target, chain, payable value, recipient/beneficiary, token decimals and currency, and any slippage or deadline floor. Bendystraw fixtures may explain a view, but they must never be the oracle for authorization or transaction construction.

See `test/TX_COVERAGE.md` for the current action-to-contract map and
`test/transaction-sites.json` for the structural wallet-boundary inventory.
When a new action or signing site is added, update both in the same change.
