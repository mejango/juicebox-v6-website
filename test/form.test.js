import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  account: null,
  chainId: 1,
  client: null,
  wallet: null,
  walletListeners: [],
}));

vi.mock('../src/inputs.js', () => ({
  renderInput(param) {
    const input = document.createElement('div');
    input.className = 'mock-input';
    input.dataset.name = param.name;
    input.dataset.description = param.description || '';
    input.getValue = () => param.testValue;
    input.validate = () => param.testError || null;
    return input;
  },
}));

vi.mock('../src/wallet.js', () => ({
  getAccount: vi.fn(() => state.account),
  getWalletClient: vi.fn(() => state.wallet),
  createPublicClientForChain: vi.fn(() => state.client),
  connect: vi.fn(() => Promise.resolve()),
  onWalletChange: vi.fn(listener => state.walletListeners.push(listener)),
  switchChain: vi.fn(() => Promise.resolve()),
}));

const transactionReview = vi.hoisted(() => vi.fn());
vi.mock('../src/component-base.js', () => ({
  confirmTransactionModal: transactionReview,
  shouldKeepSubmittedTransactionPending: (hash, error) => !!hash && !error?.onchainRevert,
  truncAddr: value => `${String(value).slice(0, 6)}…${String(value).slice(-4)}`,
  waitForTrackedTransactionReceipt: (client, hash) => client.waitForTransactionReceipt({ hash }),
  friendlyTransactionError: () => null,
}));

const chainState = vi.hoisted(() => ({ setCurrent: vi.fn(), setRpc: vi.fn() }));
vi.mock('../src/chain.js', () => ({
  getCurrentChainId: () => state.chainId,
  setCurrentChainId: chainState.setCurrent,
  getManifestChains: () => ({
    1: { name: 'Ethereum', testnet: false },
    10: { name: 'Optimism', testnet: false },
    11155111: { name: 'Sepolia', testnet: true },
  }),
  getCustomRpc: () => '',
  setCustomRpc: chainState.setRpc,
  chainNameFor: id => ({ 1: 'Ethereum', 10: 'Optimism', 11155111: 'Sepolia' })[id] || `chain ${id}`,
  CHAINS: {
    1: { name: 'Ethereum', rpcUrls: { default: { http: ['https://eth.invalid'] } } },
    10: { name: 'Optimism', rpcUrls: { default: { http: ['https://op.invalid'] } } },
    11155111: { name: 'Sepolia', rpcUrls: { default: { http: ['https://sepolia.invalid'] } } },
  },
}));

import * as walletModule from '../src/wallet.js';
import { renderFunctionForm } from '../src/form.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ACCOUNT = '0x2222222222222222222222222222222222222222';

function click(element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function formFor(fn, address = ADDRESS, natspec) {
  return renderFunctionForm(fn, 'JBExample', () => address, [fn], natspec);
}

describe('generic ABI function form', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    state.account = null;
    state.chainId = 1;
    state.client = null;
    state.wallet = null;
    state.walletListeners.length = 0;
    chainState.setCurrent.mockClear();
    chainState.setRpc.mockClear();
    transactionReview.mockReset();
    vi.mocked(walletModule.connect).mockClear();
  });

  it('renders NatSpec, validates reads, selects networks, and displays a successful tuple result', async () => {
    const parameter = { name: '_projectId', type: 'uint256', testValue: 7n };
    const fn = {
      type: 'function',
      name: 'metadataOf',
      stateMutability: 'view',
      inputs: [parameter],
      outputs: [{ name: 'owner', type: 'address' }, { name: 'start', type: 'uint256' }],
    };
    const form = formFor(fn, ADDRESS, {
      notice: 'Reads canonical project metadata.',
      details: 'The contract is the source of truth.',
      params: { projectId: 'Canonical project identifier.' },
    });
    document.body.appendChild(form);

    expect(form.querySelector('.natspec-notice').textContent).toBe('Reads canonical project metadata.');
    expect(form.querySelector('.mock-input').dataset.description).toBe('Canonical project identifier.');
    expect([...form.querySelectorAll('.chain-pill')].map(node => node.textContent)).toEqual(['Ethereum', 'Optimism']);

    const network = form.querySelector('.network-dropdown');
    network.value = 'testnet';
    network.dispatchEvent(new Event('change', { bubbles: true }));
    expect(chainState.setCurrent).toHaveBeenCalledWith(11155111);
    expect(form.querySelector('.chain-pill').textContent).toBe('Sepolia');

    state.client = {
      readContract: vi.fn().mockResolvedValue([ACCOUNT, 1_700_000_000n]),
    };
    click(form.querySelector('.btn-query'));
    await vi.waitFor(() => expect(form.querySelector('.result-box')).not.toBeNull());
    expect(state.client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: ADDRESS,
      functionName: 'metadataOf',
      args: [7n],
    }));
    expect(form.querySelector('.result-box').textContent).toMatch(/owner: 0x2222…2222/);
    expect(form.querySelector('.result-box').textContent).toMatch(/2023-11-14/);
  });

  it('fails closed when a read has no RPC, address, or valid input', async () => {
    const parameter = { name: 'id', type: 'uint256', testValue: 1n };
    const fn = { type: 'function', name: 'projectOf', stateMutability: 'view', inputs: [parameter], outputs: [] };
    const noRpc = formFor(fn);
    click(noRpc.querySelector('.btn-query'));
    expect(noRpc.querySelector('.error-box').textContent).toMatch(/No RPC available/);

    state.client = { readContract: vi.fn() };
    const noAddress = formFor(fn, '');
    click(noAddress.querySelector('.btn-query'));
    expect(noAddress.querySelector('.error-box').textContent).toMatch(/No contract address/);

    parameter.testError = 'id is required';
    const invalid = formFor(fn);
    click(invalid.querySelector('.btn-query'));
    expect(invalid.querySelector('.error-box').textContent).toMatch(/id is required/);
    expect(state.client.readContract).not.toHaveBeenCalled();
  });

  it('keeps writes behind connection, exact review, simulation, and receipt confirmation', async () => {
    const fn = {
      type: 'function',
      name: 'pay',
      stateMutability: 'payable',
      inputs: [{ name: 'projectId', type: 'uint256', testValue: 7n }],
      outputs: [],
    };
    const form = formFor(fn);
    document.body.appendChild(form);
    const transact = form.querySelector('.btn-connect');
    expect(transact.textContent).toBe('CONNECT WALLET');
    click(transact);
    expect(walletModule.connect).toHaveBeenCalledOnce();

    state.account = ACCOUNT;
    state.walletListeners.forEach(listener => listener());
    expect(transact.textContent).toBe('TRANSACT');

    const request = { address: ADDRESS, functionName: 'pay' };
    state.wallet = {
      getChainId: vi.fn().mockResolvedValue(1),
      writeContract: vi.fn().mockResolvedValue(`0x${'ab'.repeat(32)}`),
    };
    state.client = {
      simulateContract: vi.fn().mockResolvedValue({ request }),
      estimateContractGas: vi.fn().mockResolvedValue(50_000n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        blockNumber: 123n,
        transactionHash: `0x${'cd'.repeat(32)}`,
      }),
    };
    transactionReview.mockResolvedValue(true);
    form.querySelector('.payable-field').value = '0.25';
    click(transact);

    await vi.waitFor(() => expect(state.wallet.writeContract).toHaveBeenCalledOnce());
    expect(transactionReview).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pay',
      address: ADDRESS,
      args: [7n],
      value: 250000000000000000n,
      calldata: expect.stringMatching(/^0x/),
    }), { title: 'Confirm transaction' });
    expect(state.client.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      account: ACCOUNT,
      address: ADDRESS,
      args: [7n],
      value: 250000000000000000n,
    }));
    expect(state.wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 100_000n }),
    );
    await vi.waitFor(() => expect(form.querySelector('.fn-output').textContent).toMatch(/Confirmed in block 123/));

    state.client.waitForTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 124n,
      transactionHash: `0x${'ef'.repeat(32)}`,
    });
    click(transact);
    await vi.waitFor(() => expect(form.querySelector('.error-box').textContent).toMatch(/reverted onchain/i));
    expect(form.querySelector('.fn-output').textContent).not.toMatch(/Confirmed in block 124/);

    state.client.waitForTransactionReceipt.mockRejectedValue(new Error('Invalid RPC parameters'));
    click(transact);
    await vi.waitFor(() => expect(form.querySelector('.fn-output').textContent).toMatch(/confirmation tracking is temporarily unavailable/i));
    expect(form.querySelector('.error-box')).toBeNull();
  });

  it('simulates without sending and exposes custom RPC selection', async () => {
    const fn = {
      type: 'function',
      name: 'queueRulesetsOf',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: [{ name: 'ok', type: 'bool' }],
    };
    state.client = { simulateContract: vi.fn().mockResolvedValue({ result: true }) };
    const form = formFor(fn);
    document.body.appendChild(form);

    click(form.querySelector('.custom-rpc-toggle'));
    const rpc = form.querySelector('.custom-rpc-input');
    expect(rpc.placeholder).toBe('https://eth.invalid');
    rpc.value = ' https://rpc.example ';
    rpc.dispatchEvent(new Event('change', { bubbles: true }));
    expect(chainState.setRpc).toHaveBeenCalledWith(1, 'https://rpc.example');

    click(form.querySelector('.btn-simulate'));
    await vi.waitFor(() => expect(form.querySelector('.sim-success')).not.toBeNull());
    expect(state.client.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      address: ADDRESS,
      functionName: 'queueRulesetsOf',
      account: null,
    }));
    expect(form.querySelector('.result-box').textContent).toContain('ok: true');
  });
});
