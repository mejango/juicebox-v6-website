// The confirm dialog's precise argument decoders. Each must interpret real
// builder-shaped bytes exactly, refuse ambiguity rather than guess, and fall
// back to null (the raw view) on anything it can't fully account for.
import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, encodeFunctionData } from 'viem';
import {
  describeJBHookMetadata,
  describePermissionsData,
  describeSafeInitializer,
  describeSafeInnerCall,
  describeSplitGroups,
  describeSuckerClaim,
  prettyArgSteps,
} from '../src/tx-pretty-args.js';
import { getABI } from '../src/abi-registry.js';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';

// Byte-exact port of JBMetadataResolver.createMetadata for fixtures: reserved
// word, word-padded (bytes4 id, uint8 wordOffset) table, word-aligned payloads.
function makeMetadata(ids, payloads) {
  const padded = payloads.map(p => {
    const body = p.slice(2);
    return body.padEnd(Math.ceil(body.length / 64) * 64, '0');
  });
  let offset = 1 + Math.ceil((ids.length * 5) / 32);
  let table = '';
  for (let i = 0; i < ids.length; i++) {
    table += ids[i].slice(2) + offset.toString(16).padStart(2, '0');
    offset += padded[i].length / 64;
  }
  table = table.padEnd(Math.ceil(table.length / 64) * 64, '0');
  return `0x${'0'.repeat(64)}${table}${padded.join('')}`;
}

const rowsOf = steps => (steps ?? []).flatMap(s => s.rows.map(([k, v]) => `${k}=${v}`));

describe('JB hook metadata decoding', () => {
  it('reads 721 mint instructions', () => {
    const metadata = makeMetadata(
      ['0x12345678'],
      [encodeAbiParameters([{ type: 'bool' }, { type: 'uint16[]' }], [false, [4, 4, 7]])],
    );
    const steps = describeJBHookMetadata('pay', metadata);
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toBe('721 shop mint instructions');
    expect(rowsOf(steps)).toContain('Tier IDs to mint=2× #4, #7');
    expect(rowsOf(steps).join()).toContain('Allow overspending=no');
  });

  it('reports degenerate payloads as ambiguous instead of picking a reading', () => {
    const metadata = makeMetadata(
      ['0x12345678'],
      [encodeAbiParameters([{ type: 'bool' }, { type: 'uint16[]' }], [true, []])],
    );
    const steps = describeJBHookMetadata('pay', metadata);
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toContain('matches multiple known shapes');
  });

  it('reads buyback routing and 721 redeems in one cash-out envelope', () => {
    const metadata = makeMetadata(
      ['0xaaaaaaaa', '0xbbbbbbbb'],
      [
        encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [123n, true]),
        encodeAbiParameters([{ type: 'uint256[]' }], [[9n, 12n]]),
      ],
    );
    const steps = describeJBHookMetadata('cashOut', metadata);
    expect(steps.map(s => s.title)).toEqual([
      'Buyback hook cash-out routing',
      '721 shop items to redeem',
    ]);
    expect(rowsOf(steps)).toContain('Minimum swap output=123');
    expect(rowsOf(steps)).toContain('Token IDs=#9, #12');
  });

  it('rejects malformed envelopes', () => {
    expect(describeJBHookMetadata('pay', '0x')).toBeNull();
    expect(describeJBHookMetadata('pay', '0xdead')).toBeNull();
    expect(describeJBHookMetadata('pay', `0x${'00'.repeat(64)}`)).toBeNull();
    const valid = makeMetadata(
      ['0x12345678'],
      [encodeAbiParameters([{ type: 'bool' }, { type: 'uint16[]' }], [true, [4]])],
    );
    expect(describeJBHookMetadata('pay', valid.slice(0, -2))).toBeNull();
  });
});

describe('sucker claim decoding', () => {
  const claim = {
    token: ZERO,
    leaf: {
      index: 7n,
      beneficiary: `0x000000000000000000000000${ALICE.slice(2)}`,
      projectTokenCount: 1000n,
      terminalTokenAmount: 25n,
      metadata: `0x${'00'.repeat(32)}`,
    },
    proof: Array.from({ length: 32 }, (_, i) => `0x${String(i).padStart(2, '0').repeat(32)}`),
  };

  it('renders the leaf and summarizes the proof', () => {
    const steps = describeSuckerClaim(claim);
    const rows = rowsOf(steps);
    expect(rows).toContain('Leaf index=7');
    expect(rows).toContain(`Beneficiary=${ALICE}`);
    expect(rows.join()).toContain('Merkle proof=32 hashes');
  });

  it('rejects a short proof and routes through prettyArgSteps', () => {
    expect(describeSuckerClaim({ ...claim, proof: claim.proof.slice(0, 31) })).toBeNull();
    expect(prettyArgSteps('claim', 'claimData', claim)).not.toBeNull();
  });
});

describe('Safe execution decoding', () => {
  it('decodes a queued JB call through the registry ABIs', () => {
    const data = encodeFunctionData({
      abi: getABI('JBController'),
      functionName: 'sendReservedTokensToSplitsOf',
      args: [41n],
    });
    const steps = describeSafeInnerCall(data);
    expect(steps[0].title).toBe('Queued call — JBController.sendReservedTokensToSplitsOf(…)');
    expect(rowsOf(steps)).toContain('projectId="41"');
    expect(describeSafeInnerCall('0xdeadbeef')).toBeNull();
  });

  it('decodes a canonical Safe initializer including the SafeToL2Setup hook', () => {
    const setupAbi = [{
      type: 'function', name: 'setup', stateMutability: 'nonpayable',
      inputs: [
        { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
        { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
        { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
        { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' },
      ], outputs: [],
    }];
    const toL2Abi = [{
      type: 'function', name: 'setupToL2', stateMutability: 'nonpayable',
      inputs: [{ name: 'l2Singleton', type: 'address' }], outputs: [],
    }];
    const plain = encodeFunctionData({
      abi: setupAbi, functionName: 'setup',
      args: [[ALICE, BOB], 2n, ZERO, '0x', BOB, ZERO, 0n, ZERO],
    });
    const rows = rowsOf(describeSafeInitializer(plain));
    expect(rows).toContain(`Owners=${ALICE}, ${BOB}`);
    expect(rows).toContain('Threshold=2 of 2');
    expect(rows).toContain('Setup hook=none');

    const l2Data = encodeFunctionData({ abi: toL2Abi, functionName: 'setupToL2', args: [BOB] });
    const withHook = encodeFunctionData({
      abi: setupAbi, functionName: 'setup',
      args: [[ALICE], 1n, ALICE, l2Data, BOB, ZERO, 0n, ZERO],
    });
    expect(rowsOf(describeSafeInitializer(withHook)).join()).toContain(`SafeToL2Setup.setupToL2(${BOB})`);
    expect(describeSafeInitializer('0xdeadbeef')).toBeNull();
  });
});

describe('permissions and splits decoding', () => {
  it('names permission ids and flags ROOT and the all-projects scope', () => {
    const steps = describePermissionsData({ operator: BOB, projectId: 0n, permissionIds: [1, 2, 200] });
    const rows = rowsOf(steps).join('\n');
    expect(rows).toContain('ROOT (1)');
    expect(rows).toContain('QUEUE_RULESETS (2)');
    expect(rows).toContain('UNKNOWN PERMISSION (200)');
    expect(rows).toContain('EVERY project');
    expect(rows).toContain('Warning=ROOT grants every permission');
  });

  it('renders split percents with an honest total', () => {
    const steps = describeSplitGroups([
      {
        groupId: 1n,
        splits: [
          { percent: 500000000, projectId: 0n, beneficiary: ALICE, preferAddToBalance: false, lockedUntil: 0, hook: ZERO },
          { percent: 250000000, projectId: 3n, beneficiary: BOB, preferAddToBalance: false, lockedUntil: 0, hook: ZERO },
        ],
      },
    ]);
    expect(steps[0].title).toBe('Reserved tokens');
    const rows = rowsOf(steps).join('\n');
    expect(rows).toContain('Split 1 — 50%');
    expect(rows).toContain(`project #3 (beneficiary ${BOB})`);
    expect(rows).toContain("Total=75% — the remainder follows the ruleset's default");
  });
});
