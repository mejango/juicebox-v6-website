// src/safe-app.js
// Minimal Safe{Wallet} Apps integration — NO dependency. When this site is opened as a Safe App (inside the
// app.safe.global iframe: Apps → add custom app → this URL), it speaks the Safe Apps postMessage protocol so
// a user can connect their Safe and PROPOSE transactions (pay into a project, etc.) to the Safe's queue for
// the owners to sign & execute. Protocol mirrors @safe-global/safe-apps-sdk's PostMessageCommunicator:
// request  = { id, method, params, env: { sdkVersion } }  → window.parent.postMessage
// response = { id, success, data|error, version }         → window 'message' event
// Reads are proxied to the Safe interface's node via rpcCall; writes go through sendTransactions.

var SDK_VERSION = '9.1.0';
// The trust boundary of the bridge: messages are accepted ONLY when they come from window.parent AND
// an origin the Safe web app actually serves from, and requests are only posted to these origins
// (never '*'). app.safe.global is the production Safe{Wallet}; app.5afe.dev is Safe's staging build.
export var SAFE_APP_ALLOWED_ORIGINS = ['https://app.safe.global', 'https://app.5afe.dev'];
var _pending = {};
var _idCounter = 0;
var _listening = false;
var _parentOrigin = null; // captured from the first valid response; all later requests target it exactly

// Cross-origin parent access throws — that itself means we're framed (a top window can read window.parent).
function inIframe() {
  try { return typeof window !== 'undefined' && window.parent && window.parent !== window; }
  catch (_) { return true; }
}

function ensureListener() {
  if (_listening || typeof window === 'undefined') return;
  _listening = true;
  window.addEventListener('message', function (event) {
    // Only the embedding Safe web app may answer: the event must come from our direct parent window
    // AND from an allowlisted Safe origin. Anything else (sibling iframes, injected scripts posting
    // through the top window, other origins) is ignored.
    if (!event || event.source !== window.parent) return;
    if (SAFE_APP_ALLOWED_ORIGINS.indexOf(event.origin) === -1) return;
    _parentOrigin = event.origin;
    var msg = event.data;
    if (!msg || !msg.id || !_pending[msg.id]) return;
    var p = _pending[msg.id]; delete _pending[msg.id];
    if (msg.success === false || msg.error) p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Safe request failed'));
    else p.resolve(msg.data);
  });
}

function safeRpc(method, params) {
  ensureListener();
  if (!inIframe()) return Promise.reject(new Error('Not running inside Safe{Wallet}.'));
  var id = 'jb-safe-' + (++_idCounter) + '-' + Date.now();
  var message = { id: id, method: method, params: params || {}, env: { sdkVersion: SDK_VERSION } };
  return new Promise(function (resolve, reject) {
    _pending[id] = { resolve: resolve, reject: reject };
    try {
      // Never '*': before the parent's origin is known, post once per allowlisted origin (the browser
      // delivers only to the matching one); afterwards, target the captured origin exactly.
      var targets = _parentOrigin ? [_parentOrigin] : SAFE_APP_ALLOWED_ORIGINS;
      targets.forEach(function (origin) { window.parent.postMessage(message, origin); });
    } catch (e) { delete _pending[id]; reject(e); }
  });
}

// Detect whether we're inside a Safe App iframe. Resolves the Safe info ({ safeAddress, chainId, owners,
// threshold, … }) or null (not framed, or the parent isn't a Safe within the timeout).
export function detectSafeApp(timeoutMs) {
  if (!inIframe()) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var settled = false;
    // Safe Wallet can take more than 500ms to initialise a custom/IPFS app iframe,
    // especially on the first load. A false negative is dangerous: Safe will still
    // intercept eth_sendTransaction, but the app would treat the proposal hash as a
    // mined transaction hash and poll it as a receipt. Give the parent handshake a
    // real startup window and let transaction boundaries await the same probe.
    var timer = setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, timeoutMs == null ? 10000 : timeoutMs);
    safeRpc('getSafeInfo').then(function (info) {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve(info && info.safeAddress ? info : null);
    }).catch(function () { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
  });
}

// Poll for the on-chain tx hash a proposed safeTxHash eventually produces (once signed & executed). Optional
// UX nicety; returns the txHash or null if it never lands within the polling window.
export function txHashForSafeTx(safeTxHash, tries) {
  var n = tries == null ? 0 : tries;
  return safeRpc('getTxBySafeTxHash', { safeTxHash: safeTxHash })
    .then(function (r) { return (r && r.txHash) || null; })
    .catch(function () { return null; });
}

// Resolve a Safe proposal to the actual mined execution hash. This is used by
// legacy/direct wallet-write sites which still expect eth_sendTransaction to
// behave like an EOA provider. The proposal hash itself must never be passed to
// eth_getTransactionReceipt.
export function waitForSafeExecution(safeTxHash, pollingIntervalMs) {
  var interval = pollingIntervalMs == null ? 4000 : pollingIntervalMs;
  return new Promise(function (resolve) {
    function poll() {
      txHashForSafeTx(safeTxHash).then(function (hash) {
        if (hash) resolve(hash);
        else setTimeout(poll, interval);
      });
    }
    poll();
  });
}

// Propose a BATCH of transactions as a single Safe queue entry (executed atomically once signed). Used to
// bundle an ERC-20 approval + the main call into one proposal. Returns the safeTxHash.
export function proposeSafeTransactions(txs) {
  return safeRpc('sendTransactions', { txs: txs }).then(function (r) { return r && r.safeTxHash; });
}

// An EIP-1193-shaped provider backed by the Safe. Writes propose to the Safe queue (returning the
// safeTxHash — NOT a mined tx hash, so callers must not waitForTransactionReceipt); reads proxy to the
// Safe interface's node.
export function makeSafeProvider(safeInfo) {
  var chainIdHex = '0x' + Number(safeInfo.chainId).toString(16);
  return {
    isSafe: true,
    safeAddress: safeInfo.safeAddress,
    request: function (args) {
      var method = args && args.method;
      var params = (args && args.params) || [];
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return Promise.resolve([safeInfo.safeAddress]);
        case 'eth_chainId':
          return Promise.resolve(chainIdHex);
        case 'net_version':
          return Promise.resolve(String(Number(safeInfo.chainId)));
        case 'wallet_requestPermissions':
          return Promise.resolve([{ parentCapability: 'eth_accounts' }]);
        case 'wallet_revokePermissions':
          return Promise.resolve(null);
        case 'wallet_switchEthereumChain': {
          var want = params[0] && params[0].chainId;
          if (want && String(want).toLowerCase() === chainIdHex.toLowerCase()) return Promise.resolve(null);
          return Promise.reject({ code: 4902, message: 'This Safe is on chain ' + Number(safeInfo.chainId) + '. Switch the Safe’s network inside Safe{Wallet}.' });
        }
        case 'eth_sendTransaction': {
          var tx = params[0] || {};
          var value;
          try { value = tx.value == null ? '0' : (typeof tx.value === 'string' ? tx.value : ('0x' + BigInt(tx.value).toString(16))); }
          catch (_) { value = '0'; }
          return safeRpc('sendTransactions', { txs: [{ to: tx.to, value: value, data: tx.data || '0x' }] })
            .then(function (r) {
              var safeTxHash = r && r.safeTxHash;
              if (!safeTxHash) throw new Error('Safe returned no proposal hash.');
              return waitForSafeExecution(safeTxHash);
            });
        }
        case 'personal_sign':
          return safeRpc('signMessage', { message: params[0] }).then(function (r) { return r && (r.signature || r.safeTxHash); });
        case 'eth_signTypedData_v4': {
          var td = params[1];
          try { td = typeof td === 'string' ? JSON.parse(td) : td; } catch (_) {}
          return safeRpc('signTypedMessage', { typedData: td }).then(function (r) { return r && (r.signature || r.safeTxHash); });
        }
        default:
          // Reads (eth_call, eth_getBalance, eth_estimateGas, eth_getBlockByNumber, …) — proxy to the Safe
          // interface's node so viem's wallet client can operate normally.
          return safeRpc('rpcCall', { call: method, params: params });
      }
    },
    on: function () {},           // the Safe context doesn't emit accountsChanged/chainChanged mid-session
    removeListener: function () {},
  };
}
