import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachProjectIdResolver,
  lookupProjectIdentity,
  projectIdentityHint,
  __test,
} from '../src/project-id-resolver.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('project ID field resolution', () => {
  it('extracts a name from indexed metadata when the top-level name is absent', () => {
    expect(__test.metadataName('{"name":"Metadata project"}')).toBe('Metadata project');
    expect(__test.metadataName({ name: 'Object project' })).toBe('Object project');
    expect(__test.metadataName('not json')).toBeNull();
  });

  it('summarizes exact-chain and partial multichain matches', () => {
    expect(projectIdentityHint(11, [84532], [
      { chainId: 84532, found: true, name: 'KMAC', suckerGroupId: '0xabc' },
    ])).toEqual({ kind: 'ok', text: 'KMAC' });
    expect(projectIdentityHint(11, [84532, 11155111], [
      { chainId: 84532, found: true, name: 'KMAC', suckerGroupId: '0xabc' },
      { chainId: 11155111, found: false, name: null, suckerGroupId: null },
    ])).toEqual({ kind: 'warn', text: 'KMAC found on Base Sepolia only — set project IDs per chain.' });
  });

  // An indexer outage is not evidence that a project is missing. Reporting "No project #N found"
  // during one makes a user treat a valid recipient id as a typo and change a correct entry.
  it('separates a failed lookup from a genuine miss', async () => {
    expect(projectIdentityHint(11, [84532], [
      { chainId: 84532, found: false, name: null, suckerGroupId: null, unavailable: true },
    ])).toEqual({
      kind: 'warn',
      text: 'Could not check project #11 right now — verify it before submitting.',
    });
    expect(projectIdentityHint(11, [84532], [
      { chainId: 84532, found: false, name: null, suckerGroupId: null, unavailable: false },
    ])).toEqual({
      kind: 'warn',
      text: 'No project #11 found on the selected chain.',
    });
  });

  it('marks a lookup unavailable when the indexer query fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(lookupProjectIdentity(424242, 84532)).resolves.toMatchObject({
      chainId: 84532, found: false, unavailable: true,
    });
  });

  it('queries the testnet indexer for a testnet project ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { project: { name: 'Resolved project', handle: null, metadata: null, suckerGroupId: '0x1' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(lookupProjectIdentity(987654, 84532)).resolves.toMatchObject({
      chainId: 84532, found: true, name: 'Resolved project', suckerGroupId: '0x1',
    });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('https://testnet.bendystraw.xyz/'), expect.any(Object));
  });

  it('renders the resolved name in standard subtext beneath the input', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { project: { name: 'Project eleven', handle: null, metadata: null, suckerGroupId: '0x11' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    var input = document.createElement('input'); input.value = '7654321';
    var hint = attachProjectIdResolver(input, [84532]);
    document.body.append(input, hint);
    await vi.runAllTimersAsync();
    expect(hint.className).toBe('create-resolve-hint ok');
    expect(hint.textContent).toBe('Project eleven');
  });

  it('stays silent for an address in a mixed address-or-project recipient field', async () => {
    var input = document.createElement('input');
    input.value = '0x1111111111111111111111111111111111111111';
    var hint = attachProjectIdResolver(input, [84532], { silentUnlessNumeric: true });
    await Promise.resolve();
    expect(hint.style.display).toBe('none');
    expect(hint.textContent).toBe('');
  });
});
