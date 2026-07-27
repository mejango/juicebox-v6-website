// The Safe App provider is a money path: writes must PROPOSE to the Safe (sendTransactions), never send a
// bare tx, and reads must proxy through the Safe. This locks the postMessage protocol + request mapping.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { detectSafeApp, makeSafeProvider, proposeSafeTransactions } from '../src/safe-app.js';

const SAFE = '0x1111111111111111111111111111111111111111';

// Minimal Safe parent stub: answer postMessages by method, echoing the id back on the window.
function installSafeParent(answers, delayMs) {
  const calls = [];
  const parent = {
    postMessage(msg) {
      calls.push(msg);
      const data = answers[msg.method];
      const reply = () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { id: msg.id, success: data !== undefined, data, version: '9.1.0' },
        }));
      };
      if (delayMs) setTimeout(reply, delayMs);
      else queueMicrotask(reply);
    },
  };
  Object.defineProperty(window, 'parent', { configurable: true, value: parent });
  return calls;
}

describe('Safe App provider', () => {
  beforeEach(() => {
    // Default: no parent answers (times out) — individual tests install their own.
  });

  it('detects a Safe via getSafeInfo when framed', async () => {
    installSafeParent({ getSafeInfo: { safeAddress: SAFE, chainId: 8453, owners: [SAFE], threshold: 1 } });
    const info = await detectSafeApp(200);
    expect(info).not.toBeNull();
    expect(info.safeAddress).toBe(SAFE);
    expect(info.chainId).toBe(8453);
  });

  it('does not misclassify a slow first-load Safe iframe as an ordinary wallet', async () => {
    installSafeParent(
      { getSafeInfo: { safeAddress: SAFE, chainId: 8453, owners: [SAFE], threshold: 1 } },
      650,
    );
    const info = await detectSafeApp();
    expect(info).toMatchObject({ safeAddress: SAFE, chainId: 8453 });
  });

  it('returns the Safe address for eth_accounts and the chain for eth_chainId', async () => {
    installSafeParent({});
    const p = makeSafeProvider({ safeAddress: SAFE, chainId: 8453 });
    expect(await p.request({ method: 'eth_accounts' })).toEqual([SAFE]);
    expect(await p.request({ method: 'eth_requestAccounts' })).toEqual([SAFE]);
    expect(await p.request({ method: 'eth_chainId' })).toBe('0x2105'); // 8453
    expect(p.isSafe).toBe(true);
  });

  it('never exposes a proposal hash as a mined eth_sendTransaction hash', async () => {
    const calls = installSafeParent({
      sendTransactions: { safeTxHash: '0xabc' },
      getTxBySafeTxHash: { txHash: '0xdef' },
    });
    const p = makeSafeProvider({ safeAddress: SAFE, chainId: 8453 });
    const res = await p.request({ method: 'eth_sendTransaction', params: [{ to: SAFE, value: '0x0', data: '0xdead' }] });
    expect(res).toBe('0xdef');
    const sent = calls.find((c) => c.method === 'sendTransactions');
    expect(sent.params.txs).toEqual([{ to: SAFE, value: '0x0', data: '0xdead' }]);
    expect(calls.some((c) => c.method === 'getTxBySafeTxHash')).toBe(true);
  });

  it('batches multiple txs via proposeSafeTransactions', async () => {
    const calls = installSafeParent({ sendTransactions: { safeTxHash: '0xbatch' } });
    const txs = [
      { to: SAFE, value: '0', data: '0xapprove' },
      { to: SAFE, value: '0x0', data: '0xpay' },
    ];
    expect(await proposeSafeTransactions(txs)).toBe('0xbatch');
    expect(calls.find((c) => c.method === 'sendTransactions').params.txs).toEqual(txs);
  });

  it('rejects switching to a chain other than the Safe’s', async () => {
    installSafeParent({});
    const p = makeSafeProvider({ safeAddress: SAFE, chainId: 8453 });
    await expect(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }))
      .rejects.toMatchObject({ code: 4902 });
    // Same chain resolves.
    await expect(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }))
      .resolves.toBeNull();
  });
});
