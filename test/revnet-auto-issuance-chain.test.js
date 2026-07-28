// Revnet auto-issuance rows carry a per-row mint chain. REVDeployer folds EVERY row (all chains') into
// encodedConfiguration — which must be byte-identical across chains for cross-chain config parity — and
// mints only rows whose chainId matches block.chainid. So the encoder must send the SAME full row list
// to every chain, each row tagged with its chosen chain (default: the first selected chain), and resolve
// each row's beneficiary against the ROW's chain (where the tokens land), never the config chain.
// Encoding the local chain into every row would mint the same amount N times on an N-chain revnet.
import { describe, it, expect } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { __test, createDraftObject, parseCreateDraftJson } from '../src/create-flow.js';

const { initState, buildRevnetArgs, pcAddrSet, revDeployAbi, renderRevnetStages } = __test;

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const SALT = '0x' + '00'.repeat(32);
const E18 = 10n ** 18n;
const REV_CONFIG_PARAM = revDeployAbi[0].inputs[1];

function revState(chainIds) {
  const s = initState();
  s.projectType = 'revnet';
  s.network = 'mainnet';
  s.chainIds = chainIds;
  s.accepts = ['eth'];
  s.details = Object.assign(s.details, { name: 'Test', ticker: 'TST', owner: ALICE });
  s.revOperator = ALICE;
  return s;
}

// The REVConfig (deployFor arg 1) built for one chain.
function configFor(state, chainId) {
  return buildRevnetArgs(state, chainId, ALICE, 'ipfs://x', SALT, 1000000).args[1];
}

describe('buildRevnetArgs — auto-issuance per-row mint chain', () => {
  it('3-chain revnet: every chain encodes BOTH rows with the rows\' own chainIds, byte-identical configs', () => {
    const s = revState([1, 10, 8453]);
    s.stages[0].autoIssuances = [
      { count: '600', address: ALICE, chainId: 1 },
      { count: '400', address: BOB, chainId: 8453 },
    ];
    const configs = s.chainIds.map((cid) => configFor(s, cid));
    configs.forEach((cfg) => {
      const autos = cfg.stageConfigurations[0].autoIssuances;
      expect(autos.map((a) => a.chainId)).toEqual([1, 8453]);
      expect(autos.map((a) => a.count)).toEqual([600n * E18, 400n * E18]);
      expect(autos.map((a) => a.beneficiary)).toEqual([ALICE, BOB]);
    });
    const encoded = configs.map((cfg) => encodeAbiParameters([REV_CONFIG_PARAM], [cfg]));
    expect(encoded[1]).toBe(encoded[0]);
    expect(encoded[2]).toBe(encoded[0]);
  });

  it('total-mint math: summing rows that match each config\'s own chain mints the user\'s amount exactly once', () => {
    const s = revState([1, 10, 8453]);
    s.stages[0].autoIssuances = [
      { count: '600', address: ALICE, chainId: 1 },
      { count: '400', address: BOB, chainId: 8453 },
    ];
    const minted = s.chainIds.reduce((sum, cid) => {
      const autos = configFor(s, cid).stageConfigurations[0].autoIssuances;
      return sum + autos.filter((a) => a.chainId === cid).reduce((x, a) => x + a.count, 0n);
    }, 0n);
    expect(minted).toBe(1000n * E18);
  });

  it('rows with no chain choice default to the FIRST selected chain on every config (mint once, not N times)', () => {
    const s = revState([1, 10, 8453]);
    s.stages[0].autoIssuances = [{ count: '1000', address: ALICE, chainId: null }];
    const configs = s.chainIds.map((cid) => configFor(s, cid));
    configs.forEach((cfg) => {
      expect(cfg.stageConfigurations[0].autoIssuances.map((a) => a.chainId)).toEqual([1]);
    });
    const minted = s.chainIds.reduce((sum, cid, i) => {
      const autos = configs[i].stageConfigurations[0].autoIssuances;
      return sum + autos.filter((a) => a.chainId === cid).reduce((x, a) => x + a.count, 0n);
    }, 0n);
    expect(minted).toBe(1000n * E18);
  });

  it('single-chain launch defaults rows to that chain', () => {
    const s = revState([1]);
    s.stages[0].autoIssuances = [{ count: '1000', address: ALICE, chainId: null }];
    const autos = configFor(s, 1).stageConfigurations[0].autoIssuances;
    expect(autos).toHaveLength(1);
    expect(autos[0].chainId).toBe(1);
    expect(autos[0].count).toBe(1000n * E18);
  });

  it('per-chain beneficiary overrides resolve against the ROW\'s mint chain on every config (parity preserved)', () => {
    const s = revState([1, 8453]);
    s.stages[0].autoIssuances = [{ count: '100', address: ALICE, chainId: 8453 }];
    pcAddrSet(s, 8453, 'ai:0:0', BOB); // the beneficiary's address on the chain the row mints on
    const configs = s.chainIds.map((cid) => configFor(s, cid));
    configs.forEach((cfg) => {
      expect(cfg.stageConfigurations[0].autoIssuances[0].beneficiary).toBe(BOB);
    });
    const encoded = configs.map((cfg) => encodeAbiParameters([REV_CONFIG_PARAM], [cfg]));
    expect(encoded[1]).toBe(encoded[0]);
  });
});

describe('.jb draft import — auto-issuance chainId sanitization', () => {
  it('rows with a missing or unselected chainId import as null (first selected chain at encode time)', () => {
    const s = revState([10, 8453]);
    s.stages[0].autoIssuances = [
      { count: '5', address: ALICE },            // no chainId (older draft)
      { count: '7', address: BOB, chainId: 999 }, // not a selectable chain
    ];
    const imported = parseCreateDraftJson(JSON.stringify(createDraftObject(s)));
    expect(imported.stages[0].autoIssuances.map((a) => a.chainId)).toEqual([null, null]);
    const autos = configFor(imported, 8453).stageConfigurations[0].autoIssuances;
    expect(autos.map((a) => a.chainId)).toEqual([10, 10]); // first selected chain
  });

  it('a still-selected chainId round-trips verbatim through export → import', () => {
    const s = revState([1, 8453]);
    s.stages[0].autoIssuances = [{ count: '5', address: ALICE, chainId: 8453 }];
    const imported = parseCreateDraftJson(JSON.stringify(createDraftObject(s)));
    expect(imported.stages[0].autoIssuances[0].chainId).toBe(8453);
  });
});

describe('revnet stage editor — auto-issuance chain selector UI', () => {
  function editorFor(s) {
    s.stages[0].expanded = true;
    return renderRevnetStages(s, function () {});
  }

  it('multi-chain: each row renders a chain select listing the selected chains, defaulting to the row\'s chain', () => {
    const s = revState([1, 10, 8453]);
    s.stages[0].autoIssuances = [
      { count: '600', address: ALICE, chainId: null },
      { count: '400', address: BOB, chainId: 8453 },
    ];
    const dom = editorFor(s);
    const sels = dom.querySelectorAll('select.create-ai-chain');
    expect(sels).toHaveLength(2);
    expect(Array.from(sels[0].options).map((o) => o.value)).toEqual(['1', '10', '8453']);
    expect(sels[0].value).toBe('1');    // no choice yet → first selected chain
    expect(sels[1].value).toBe('8453'); // the row's stored choice
  });

  it('choosing a chain stores it on the row', () => {
    const s = revState([1, 10, 8453]);
    s.stages[0].autoIssuances = [{ count: '600', address: ALICE, chainId: null }];
    const dom = editorFor(s);
    const sel = dom.querySelector('select.create-ai-chain');
    sel.value = '10';
    sel.dispatchEvent(new Event('change'));
    expect(s.stages[0].autoIssuances[0].chainId).toBe(10);
  });

  it('single-chain: no chain select renders', () => {
    const s = revState([1]);
    s.stages[0].autoIssuances = [{ count: '600', address: ALICE, chainId: null }];
    expect(editorFor(s).querySelectorAll('select.create-ai-chain')).toHaveLength(0);
  });

  it('the total hint breaks down per chain when rows mint on different chains', () => {
    const s = revState([1, 10, 8453]);
    s.stages[0].autoIssuances = [
      { count: '600', address: ALICE, chainId: 1 },
      { count: '400', address: BOB, chainId: 8453 },
    ];
    const hints = Array.from(editorFor(s).querySelectorAll('.create-hint')).map((h) => h.textContent);
    const total = hints.find((t) => t.indexOf('Total auto issuance') !== -1);
    expect(total).toContain('1000');
    expect(total).toContain('600 on Ethereum');
    expect(total).toContain('400 on Base');
  });

  it('single-chain: the total hint stays a plain total', () => {
    const s = revState([1]);
    s.stages[0].autoIssuances = [{ count: '600', address: ALICE, chainId: null }];
    const hints = Array.from(editorFor(s).querySelectorAll('.create-hint')).map((h) => h.textContent);
    const total = hints.find((t) => t.indexOf('Total auto issuance') !== -1);
    expect(total).toBe('Total auto issuance of 600 $TST.');
  });
});
