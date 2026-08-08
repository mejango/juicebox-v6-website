import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_CONCEPTS } from '../src/discover.js';

/**
 * The definitions in PROTOCOL_CONCEPTS are duplicated into juicebox-money
 * (src/lib/protocol-concepts.ts) and revnet-money (src/lib/protocolConcepts.ts) because the
 * three clients are separate repos with no shared package. Three copies of one source of truth
 * is the exact divergent-duplication failure the 2026-08 audit spent its time removing, and
 * nothing else stops these from drifting apart sentence by sentence.
 *
 * So: hash the entries all three clients carry, and pin it. The constant below is IDENTICAL in
 * all three repos, which makes cross-repo agreement checkable by eye — grep SHARED_CONCEPT_HASH
 * in the other two and compare.
 *
 * This app carries a SUBSET (it has no loans UI, so no prepaid fee), which is why the hash
 * covers only the shared keys rather than the whole map.
 */
const SHARED_CONCEPT_KEYS = [
  'issuance',
  'reservedShare',
  'autoIssuance',
  'cashOutTax',
  'surplusAllowance',
  'twapWindow',
];

/** Must match juicebox-money and revnet-money. Update all three together, never one. */
const SHARED_CONCEPT_HASH = '41c5c9369e51e09e';

function hashSharedConcepts(concepts, keys) {
  const body = [...keys]
    .sort()
    .map((key) => `${key}\n${concepts[key]}`)
    .join('\n---\n');
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

describe('shared concept copy', () => {
  it('carries every definition the other clients rely on', () => {
    for (const key of SHARED_CONCEPT_KEYS) {
      expect(PROTOCOL_CONCEPTS[key], `${key} is missing`).toBeTruthy();
    }
  });

  it('matches the copy shipped by juicebox-money and revnet-money', () => {
    expect(
      hashSharedConcepts(PROTOCOL_CONCEPTS, SHARED_CONCEPT_KEYS),
      'Shared concept copy changed. Make the same edit in juicebox-money ' +
        '(src/lib/protocol-concepts.ts) and revnet-money (src/lib/protocolConcepts.ts), then ' +
        'update SHARED_CONCEPT_HASH in all three.',
    ).toBe(SHARED_CONCEPT_HASH);
  });
});
