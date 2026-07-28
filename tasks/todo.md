# Thorough test coverage — transactions + views

Pattern: extract inline `executeTransaction({...})` arg-building into a pure exported `buildXArgs(...)`
returning `{address, abi, functionName, args, value}`; component calls it (spread / Object.assign);
unit test round-trips through the contract ABI + asserts amounts/decimals/recipients/slippage.

## Transactions
- [x] pay (JBMultiTerminal.pay) — buildPayArgs (+ fixed a real slippage-floor bug: was reading state.preview.received which doesn't exist → 0n)
- [x] cashout (cashOutTokensOf) — buildCashOutArgs / cashOutMinReclaimed (95% floor)
- [x] move between chains (JBSucker.prepare → toRemote) — buildSuckerPrepareArgs / buildSuckerToRemoteArgs
- [x] loan (REVLoans.borrowFrom / repayLoan) — buildBorrowArgs / buildRepayArgs (+ wired the 99% borrow slippage floor)
- [x] mint (mintTokensOf) / burn (burnTokensOf)
- [x] deploy ERC-20 (deployERC20For)
- [x] send payouts (sendPayoutsOf)
- [x] send reserved (sendReservedTokensToSplitsOf)
- [x] queue ruleset (queueRulesetsOf) — buildQueueRulesetsArgs
- [x] claim credits (claimTokensFor)
- [x] permissions (setPermissionsForOperator) — + fixed display grouping (31 Router, 36 Omnichain)
- [x] Safe (execTransaction) — safeExecArgs (shared by direct + relayr paths)
- [ ] autoIssueFor / adjustTiers (721) / omnichain-queue — built as pre-encoded relayr/Safe `data` (runtime-validated); lower priority
- [ ] addToBalanceOf — ABI present, no active call site

## Views
- [x] bendystraw-format (volumeUsd / bigint / bool) — views.test.js
- [x] create-flow steps / pills / approval / lock / deploy gating — ui-smoke.mjs
- [ ] discover cards + project-detail tabs — UI smoke + manual CDP (no unit)

## Docs / audit-readiness
- [x] README.md (architecture, build pipeline, currency model, tx→contract map, testing, IPFS)
- [x] contract-adherence review (workflow) — all builders correct; 3 LOW fixed
- [x] TX_COVERAGE.md updated

## Review
91 vitest tests (8 files) + 9 UI smoke, all green. Build clean. Branch: audit-fixes-tx-security-and-tests.
Uncommitted — left for review.

## 2026-07-28 — kmac88 operator feedback (metadata round-trip, pay notice, kept fields, reserved-split removal)
- [x] Tests first: test/metadata-edit-roundtrip.test.js (merge helper, payDisclosure semantics, kept-keys helper, modal wiring)
- [x] Tests first: test/reserved-splits-empty.test.js (empty-group payload, empty setSplitGroupsOf encode, queue 0% reserved, UI copy)
- [x] 1. mergeProjectMetadataEdit: spread live projectUri JSON, overwrite only dirty form fields; fail closed when live JSON unreadable (submitProjectEdit + addStoreCategories)
- [x] 2. Payment notice textarea in edit-project modal (payDisclosure key, untouched≠cleared)
- [x] 3. "Other fields kept: …" read-only line from unmanagedProjectMetadataKeys(loadedMeta)
- [x] 4a. Verify queue flow encodes reservedPercent 0 with no reserved recipients (test only — already derived from row sum)
- [x] 4b. Reserved-splits modal: link "queue a new ruleset with a 0% reserved rate" → openQueueRulesetModal
- [x] 4c. Allow submitting an EMPTY reserved group (drop "Add at least one recipient" gate; owner-accrual explainer; locked rows already frozen)
- [x] Full suite + drift gates + bundle green; no commit

### Review
Root causes: (1) edit-project save fell back to `{}` when the live projectUri JSON couldn't be fetched, and always overwrote all known fields (degrading untouched rich descriptions); (4) submitSplitsEdit hard-refused an empty recipients list ("Add at least one recipient"), and the 0%-reserved lever actually lives in queue-ruleset (rate = sum of reserved rows — already encodes 0 with no rows, now test-locked).
Changes: mergeProjectMetadataEdit + unmanagedProjectMetadataKeys + loadLiveProjectMetadata (fail-closed, shared with addStoreCategories); dirty-tracked form fields; Payment notice (payDisclosure) textarea; "Other fields kept:" line; buildSplitsEditPayload allows empty groups; owner-accrual explainer + queue-ruleset deep-link in the reserved editor; "Splits cleared" status.
Tests: test/metadata-edit-roundtrip.test.js (10) + test/reserved-splits-empty.test.js (11). Full suite 94 files / 674 tests green; check:source/deployments/generated/transaction + bundle budget green. Uncommitted.

## 2026-07-28 — reserved-splits card + editor (6 defects, confirmed onchain)
kmac88's Base Sepolia projects have NO splits on any ruleset and reservedPercent = 0 everywhere — the
"100% to an address" they saw was fabricated by our UI.
- [x] Tests first: test/reserved-splits-card.test.js (36 tests, one describe per defect)
- [x] D1 fillSplits → renderSplitsInto: empty group renders PROSE, never a synthesized 100% owner row; leftover row only when the group has recipients; owner LABEL beside the address (funds-card payouts row too)
- [x] D2 editor switched to GROUP-SHARE percentages (rows sum to 100% of the group, like jbm/revnet/juicy); issuance equivalent is derived read-only text; buildSplitsEditPayload(rows) takes no limit → the 0-limit dead end is gone
- [x] D3 rows show issuance share + "(x% of limit)" companion (jbm idiom); section note when reservedPercent is 0
- [x] D4 createRulesetSplitsLoader(project) — every read takes its CHAIN; cache keyed chain:ruleset; ensureUpcoming + openEditSplitsModal + lock duration follow the selected chain
- [x] D5 editor names the ruleset id/cycle it verified and warns when it differs from the card's
- [x] D6 JBSplits.splitsOf fallback (ruleset 0) read per chain; clearing blocked when the fallback is non-empty; fails closed on read error (mirrors juicy-vision SetSplitsForm)
- [x] Full suite + drift gates + bundle + playwright green; no commit

### Review
Root causes: (1) `fillSplits` synthesized a leftover row for an EMPTY group and wiped the owner label when
project.owner was known; (2) `verifiedLimit = reservedPercent/100` was 0 and consumed unguarded, so the
editor showed "0% of 0% limit" and rejected every percentage; (4) `faPid`/`faHome` were captured once from
the home chain while the chain dropdown swapped in another chain's ruleset id; (6) `JBSplits.splitsOf`
falls back to ruleset 0 when a group is empty (JBSplits.sol:154-159), so "clearing sends tokens to the
owner" only holds when the fallback group is empty.
New exports: renderSplitsInto, splitShareDisplay, splitsEditorTotalText, splitsEditorRulesetNotice,
splitsClearGuard, createRulesetSplitsLoader. Removed: splitLimitPctFor (dead once percentages are group
shares), the reserved-limit drift check in submitSplitsEdit (encoding no longer depends on the rate).
Tests: test/reserved-splits-card.test.js (36 new) + test/reserved-splits-empty.test.js retargeted to
group-share semantics. 95 files / 722 tests green; check:source/deployments/generated/transaction, bundle
budget (1,893,827 B gzip of 2,050,000 B) and 44 playwright tests green. Uncommitted.
