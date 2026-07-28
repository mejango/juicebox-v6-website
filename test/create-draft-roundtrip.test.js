// .jb export → import must preserve EVERY user-entered field of the create-flow state. This builds a
// maximal draft touching every subsystem and asserts the round-trip is lossless for all non-transient
// keys — a completeness guard, so a future field added to state but missed by the import whitelist
// (mergeKnownDraftFields only copies keys present in the defaults) fails here instead of silently
// dropping user work.
import { describe, expect, it } from 'vitest';
import { createDraftObject, newCreateDraftState, parseCreateDraftJson, createStage, __test } from '../src/create-flow.js';

const { itemDraft, pcAddrSet } = __test;
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';

// Fields the import path intentionally resets — everything else must round-trip verbatim.
const RESET_ON_IMPORT = ['step', 'tos', 'deploying', 'statusLines', 'done', 'quoteChoice'];

function maximalState() {
  const s = newCreateDraftState();
  s.projectType = 'custom';
  s.network = 'testnet';
  s.chainIds = [11155111, 84532];
  s.accepts = ['custom'];
  s.suckerType = 'ccip';
  s.afterMode = 'terminal';
  s.step = 3;
  s.tos = true;
  s.details = Object.assign(s.details, {
    name: 'Max', ticker: 'MAX', tagline: 'tag', description: 'desc', logoUri: 'ipfs://logo',
    website: 'https://x.yz', twitter: 'x', discord: 'd', telegram: 't', tags: ['a', 'b'],
    owner: ALICE,
  });
  s.customToken = Object.assign(s.customToken, { address: TOKEN, symbol: 'MAX', decimals: 18, status: 'ok' });
  const customCur = Number(BigInt(TOKEN) & 0xffffffffn);
  s.storePricingCurrency = customCur;

  const stage = createStage();
  stage.durationSeconds = 2592000;
  stage.weight = '5000'; stage.reservedPercent = 25; stage.cashOutEnabled = true; stage.cashOutTaxRate = 40;
  // Currencies must be consistent with the custom accounting token (what the live UI enforces via
  // applyAccountingDefaults) — an inconsistent draft is deliberately CORRECTED on import, not preserved.
  // The custom currency id is still a non-default value, so whitelist drops still fail this test.
  stage.payoutMode = 'limited'; stage.baseCurrency = customCur; stage.payoutCurrency = customCur;
  stage.allowAddPriceFeed = true;
  stage.payoutRecipients = [{ type: 'wallet', address: ALICE, projectId: 0, percent: 0, amountEth: '1.5', lockedUntil: 1893456000 }];
  stage.reservedRecipients = [{ type: 'project', projectId: 7, address: BOB, percent: 100, preferAddToBalance: true, lockedUntil: 0 }];
  stage.payoutByKind = { usdc: { mode: 'limited', recipients: [{ type: 'wallet', address: BOB, projectId: 0, percent: 0, amountEth: '9' }] } };
  stage.surplusAllowanceOn = true; stage.surplusAllowanceAmount = '3'; stage.surplusAllowanceCurrency = customCur;
  s.stages = [stage];

  const item = itemDraft();
  item.name = 'Thing'; item.description = 'A thing'; item.imageUri = 'ipfs://img'; item.mediaType = 'image/png';
  item.price = '2'; item.limited = true; item.supply = '100'; item.category = 3;
  item.splitOn = true; item.splitRecipients = [{ pct: '10', recip: BOB, benef: '' }];
  item.discountOn = true; item.discountPct = '25';
  item.reserveOn = true; item.reserveFrequency = '10'; item.reserveBeneficiary = ALICE;
  item.votingOn = true; item.votingUnits = '5';
  item.flags = { allowOwnerMint: true, transfersPausable: true, cantBeRemoved: true, allowCredits: false, ownerCanEditDiscount: false };
  s.shopEnabled = true;
  s.nfts = [item];
  s.storeCategories = [{ id: 3, name: 'Rares' }];
  s.collection = Object.assign(s.collection || {}, { name: 'Col', symbol: 'COL', nameTouched: true, symbolTouched: true });

  // Per-chain overrides of every kind: address, project id, payout amount, kind amount, item supply.
  pcAddrSet(s, 84532, 'p:0:0', BOB);
  pcAddrSet(s, 84532, 'ppid:0:0', '12');
  pcAddrSet(s, 84532, 'pamt:0:0', '2.5');
  pcAddrSet(s, 84532, 'pkamt:usdc:0', '4');
  pcAddrSet(s, 84532, 'isup:0', '7');
  return s;
}

describe('.jb round-trip completeness', () => {
  it('every non-transient field survives export → import', () => {
    const s = maximalState();
    const exported = createDraftObject(s);
    const imported = parseCreateDraftJson(JSON.stringify(exported));

    Object.keys(exported).forEach((key) => {
      if (RESET_ON_IMPORT.includes(key)) return;
      expect(imported[key], `top-level field "${key}" must round-trip`).toEqual(exported[key]);
    });
  });

  it('resets only the intended transients', () => {
    const s = maximalState();
    const imported = parseCreateDraftJson(JSON.stringify(createDraftObject(s)));
    expect(imported.step).toBe(0);
    expect(imported.tos).toBe(false);
    expect(imported.deploying).toBe(false);
  });
});
