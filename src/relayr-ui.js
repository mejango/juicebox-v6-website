// src/relayr-ui.js
// The one DOM builder for the "Paid Relayr request" receipt card. The create flow, the add-items modal,
// and the Discover recovery panel all show the same card (head + bundle + payment + per-chain rows + note);
// only their note wording, state labels, and action buttons differ, so those stay at the call sites.
// relayr.js stays DOM-free; this module owns the shared presentation.

import { el, truncAddr, txExplorerUrl } from './component-base.js';
import { relayrProgress, relayrStateIsSuccess, relayrStateIsFailed, relayrDestinationHash } from './relayr.js';

// Default per-chain state label: Confirmed / Failed / the raw Relayr state while pending.
export function relayrReceiptStateLabel(record, verifiedOnchain) {
  var state = String(record && record.status && record.status.state || '');
  if (relayrStateIsSuccess(state)) return verifiedOnchain
    ? { text: 'Confirmed', kind: 'ok' }
    : { text: 'Relayr reported success — verifying', kind: 'pending' };
  if (relayrStateIsFailed(state)) return { text: 'Failed', kind: 'err' };
  return { text: state || 'Waiting for Relayr', kind: 'pending' };
}

// Render the receipt card body into `panel` (cleared first). Callers append their own action buttons.
// opts: { noteText, stateLabel(record) -> {text, kind}, chainNameOf(chainId) -> string }.
// Returns the session's relayrProgress.
export function renderRelayrReceiptInto(panel, session, opts) {
  opts = opts || {};
  panel.innerHTML = '';
  var progress = relayrProgress(session.records, session.expectedCount);
  var head = el('div', 'relayr-pending-head');
  var title = el('strong'); title.textContent = 'Paid Relayr request'; head.appendChild(title);
  var count = el('span', 'relayr-pending-count' + (progress.failed ? ' err' : ''));
  count.textContent = progress.confirmed + '/' + progress.total + (opts.verifiedOnchain ? ' confirmed' : ' reported complete'); head.appendChild(count);
  panel.appendChild(head);
  var bundle = el('div', 'relayr-pending-meta'); bundle.appendChild(document.createTextNode('Bundle '));
  var bundleId = document.createElement('code'); bundleId.textContent = session.bundleUuid; bundle.appendChild(bundleId);
  panel.appendChild(bundle);
  if (session.paymentHash) {
    var payment = el('div', 'relayr-pending-meta'); payment.appendChild(document.createTextNode('Payment '));
    var href = txExplorerUrl(session.paymentChainId, session.paymentHash);
    if (href) {
      var link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = truncAddr(session.paymentHash); payment.appendChild(link);
    } else payment.appendChild(document.createTextNode(truncAddr(session.paymentHash)));
    panel.appendChild(payment);
  }
  var rows = el('div', 'relayr-pending-chains');
  var chains = session.chains || [], records = session.records || [];
  var rowCount = Math.max(Number(session.expectedCount) || 0, chains.length, records.length);
  var stateLabel = opts.stateLabel || function (record) { return relayrReceiptStateLabel(record, opts.verifiedOnchain); };
  for (var i = 0; i < rowCount; i++) {
    var row = el('div', 'relayr-pending-chain');
    var chain = chains[i]; var name = el('span');
    name.textContent = (chain && chain.name) || (chain && opts.chainNameOf && opts.chainNameOf(chain.id)) || ('Chain ' + (i + 1));
    row.appendChild(name);
    var state = stateLabel(records[i]);
    var destinationHash = relayrDestinationHash(records[i]);
    var destinationHref = destinationHash && chain && txExplorerUrl(chain.id, destinationHash);
    var value = destinationHref ? document.createElement('a') : document.createElement('span');
    value.className = 'relayr-pending-chain-state ' + state.kind; value.textContent = state.text;
    if (destinationHref) { value.href = destinationHref; value.target = '_blank'; value.rel = 'noopener'; }
    row.appendChild(value); rows.appendChild(row);
  }
  panel.appendChild(rows);
  if (opts.noteText) {
    var note = el('div', 'relayr-pending-note'); note.textContent = opts.noteText; panel.appendChild(note);
  }
  return progress;
}
