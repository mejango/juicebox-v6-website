import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  createPublicClient: vi.fn(options => ({ kind: 'public', options })),
  createWalletClient: vi.fn(options => ({ kind: 'wallet', options })),
  currentChain: 1,
  customRpc: '',
  detectSafeApp: vi.fn(async () => runtime.safeInfo),
  mobile: false,
  safeInfo: null,
  safeProvider: null,
}));

vi.mock('viem', () => ({
  createWalletClient: runtime.createWalletClient,
  createPublicClient: runtime.createPublicClient,
  custom: provider => ({ kind: 'custom', provider }),
  http: url => ({ kind: 'http', url }),
}));

vi.mock('../src/chain.js', () => ({
  CHAINS: {
    1: {
      id: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://eth.invalid'] } },
      blockExplorers: { default: { url: 'https://etherscan.io' } },
    },
    10: {
      id: 10,
      name: 'Optimism',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://op.invalid'] } },
      blockExplorers: { default: { url: 'https://optimistic.etherscan.io' } },
    },
    11155111: {
      id: 11155111,
      name: 'Sepolia',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://sepolia.invalid'] } },
    },
  },
  getCurrentChainId: () => runtime.currentChain,
  getCustomRpc: () => runtime.customRpc,
  defaultRpcFor: chainId => `https://default-${chainId}.invalid`,
}));

vi.mock('../src/wallet-links.js', () => ({ isMobileDevice: () => runtime.mobile }));
vi.mock('../src/safe-app.js', () => ({
  detectSafeApp: runtime.detectSafeApp,
  makeSafeProvider: () => runtime.safeProvider,
  proposeSafeTransactions: vi.fn(),
}));

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SAFE = '0x2222222222222222222222222222222222222222';

describe('wallet provider runtime states', () => {
  it('waits for MetaMask Mobile to announce a provider injected after page load', async () => {
    delete window.ethereum;
    localStorage.clear();
    runtime.currentChain = 1;
    runtime.mobile = true;
    runtime.safeInfo = null;
    runtime.safeProvider = null;
    vi.resetModules();

    const wallet = await import('../src/wallet.js');
    const provider = {
      isMetaMask: true,
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_requestAccounts') return [ACCOUNT];
        if (method === 'wallet_revokePermissions') return null;
        throw new Error(`unexpected method ${method}`);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    const connecting = wallet.connect();
    Object.defineProperty(window, 'ethereum', { configurable: true, value: provider });
    window.dispatchEvent(new Event('ethereum#initialized'));

    await expect(connecting).resolves.toBeUndefined();
    expect(wallet.getAccount()).toBe(ACCOUNT);
    expect(provider.request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    expect(provider.request).not.toHaveBeenCalledWith(expect.objectContaining({
      method: 'wallet_requestPermissions',
    }));
    await wallet.disconnect();
    delete window.ethereum;
  });

  it('fails closed without a provider, connects one selected provider, switches/adds chains, restores, and disconnects', async () => {
    delete window.ethereum;
    localStorage.clear();
    runtime.currentChain = 1;
    runtime.customRpc = '';
    runtime.mobile = false;
    runtime.safeInfo = null;
    runtime.safeProvider = null;
    runtime.createPublicClient.mockClear();
    runtime.createWalletClient.mockClear();
    vi.resetModules();

    const wallet = await import('../src/wallet.js');
    await expect(wallet.connect()).rejects.toThrow(/No wallet detected/);
    expect(wallet.getAccount()).toBeNull();
    expect(wallet.getWalletClient()).toBeNull();
    expect(wallet.createPublicClientForChain(999999)).toBeNull();

    const handlers = {};
    let switchAttempts = 0;
    let restoredAccounts = [ACCOUNT];
    const provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
        if (method === 'eth_requestAccounts') return [ACCOUNT];
        if (method === 'eth_accounts') return restoredAccounts;
        if (method === 'wallet_revokePermissions') return null;
        if (method === 'wallet_switchEthereumChain') {
          switchAttempts++;
          if (switchAttempts === 1) throw Object.assign(new Error('unknown chain'), { code: 4902 });
          return null;
        }
        if (method === 'wallet_addEthereumChain') return null;
        throw new Error(`unexpected method ${method}`);
      }),
      on: vi.fn((event, callback) => { handlers[event] = callback; }),
      removeListener: vi.fn(),
    };
    const detail = {
      info: { uuid: 'wallet-1', name: 'Test Wallet', rdns: 'org.example.wallet', icon: '' },
      provider,
    };
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    expect(wallet.getProviders()).toHaveLength(1);

    const seen = [];
    const unsubscribe = wallet.onWalletChange(state => seen.push(state));
    await wallet.connect(wallet.getProviders()[0]);
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    });
    expect(provider.request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    expect(wallet.getAccount()).toBe(ACCOUNT);
    expect(wallet.getWalletClient()).toMatchObject({ kind: 'wallet' });
    expect(localStorage.getItem('jb-wallet-connected')).toBe('1');
    expect(localStorage.getItem('jb-wallet-rdns')).toBe('org.example.wallet');
    expect(seen.at(-1)).toEqual({ account: ACCOUNT, connected: true });

    await wallet.switchChain(10);
    expect(provider.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'wallet_addEthereumChain',
      params: [expect.objectContaining({ chainId: '0xa', chainName: 'Optimism' })],
    }));
    const callCount = provider.request.mock.calls.length;
    await wallet.switchChain(999999);
    expect(provider.request).toHaveBeenCalledTimes(callCount);

    const firstRead = wallet.createPublicClientForChain(1);
    expect(wallet.createPublicClientForChain(1)).toBe(firstRead);
    runtime.customRpc = 'https://custom.invalid';
    expect(wallet.createPublicClientForChain(1)).not.toBe(firstRead);
    expect(runtime.createPublicClient).toHaveBeenLastCalledWith(expect.objectContaining({
      transport: { kind: 'http', url: 'https://custom.invalid' },
      batch: { multicall: { wait: 32 } },
    }));

    handlers.accountsChanged([]);
    expect(wallet.getAccount()).toBeNull();
    expect(wallet.getWalletClient()).toBeNull();
    expect(localStorage.getItem('jb-wallet-connected')).toBeNull();

    localStorage.setItem('jb-wallet-connected', '1');
    localStorage.setItem('jb-wallet-rdns', 'org.example.wallet');
    await wallet.eagerConnect();
    expect(wallet.getAccount()).toBe(ACCOUNT);
    handlers.chainChanged('0xa');
    expect(wallet.getWalletClient()).toMatchObject({ kind: 'wallet' });

    restoredAccounts = [];
    await wallet.disconnect();
    expect(wallet.getAccount()).toBeNull();
    expect(localStorage.getItem('jb-wallet-connected')).toBeNull();
    expect(seen.at(-1)).toEqual({ account: null, connected: false });
    unsubscribe();

    runtime.safeInfo = { safeAddress: SAFE, chainId: 10 };
    runtime.safeProvider = { isSafe: true, request: vi.fn(), on: vi.fn() };
    await expect(wallet.initSafeApp()).resolves.toEqual(runtime.safeInfo);
    expect(wallet.isSafeConnected()).toBe(true);
    expect(wallet.getSafeInfo()).toEqual(runtime.safeInfo);
    expect(wallet.getAccount()).toBe(SAFE);
    expect(wallet.getProviders()[0].info.name).toMatch(/Safe \(0x2222…2222\)/);
  });
});
