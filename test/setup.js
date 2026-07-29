import { beforeEach, vi } from 'vitest';

function requestedUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function blockedNetworkConstructor(transport) {
  return class {
    constructor(url) {
      throw new Error(
        `Unexpected ${transport} connection in unit test: ${requestedUrl(url ?? 'unknown URL')}`,
      );
    }
  };
}

// jsdom (29.1.1) ships HTMLDialogElement with `open` attribute reflection but no top-layer
// implementation: showModal(), close(), and the cancel/close events are all absent. Every modal in the
// app is a native <dialog>, so unit tests get this minimal, spec-shaped stand-in — enough for the
// DOM-render tests and for asserting that Escape reaches the TOP dialog only. Real modality (the page
// behind going inert, focus containment, the top layer itself) is browser-only and is asserted by the
// Playwright suite instead. TEST-ONLY: nothing here ships in the bundle.
const dialogPrototype = globalThis.HTMLDialogElement ? globalThis.HTMLDialogElement.prototype : null;
if (dialogPrototype && typeof dialogPrototype.showModal !== 'function') {
  const openModals = [];
  const dropClosedOrDetached = () => {
    for (let i = openModals.length - 1; i >= 0; i -= 1) {
      if (!openModals[i].isConnected || !openModals[i].open) openModals.splice(i, 1);
    }
  };
  dialogPrototype.show = function show() {
    if (!this.open) this.open = true;
  };
  dialogPrototype.showModal = function showModal() {
    // Matches the browser: showModal() on an already-open dialog is an InvalidStateError.
    if (this.open) throw new DOMException('showModal() called on an open dialog', 'InvalidStateError');
    this.open = true;
    openModals.push(this);
  };
  dialogPrototype.close = function close(returnValue) {
    if (!this.open) return;
    if (returnValue !== undefined) this.returnValue = String(returnValue);
    this.open = false;
    const at = openModals.indexOf(this);
    if (at !== -1) openModals.splice(at, 1);
    this.dispatchEvent(new Event('close'));
  };
  // Escape fires a cancelable `cancel` on the TOP modal dialog only; unprevented, it closes that one.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    dropClosedOrDetached();
    const top = openModals[openModals.length - 1];
    if (!top) return;
    event.preventDefault();
    if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
  });
}

// Unit tests are deterministic and offline by default. Tests which exercise a
// transport boundary must install an explicit fetch stub in their own setup.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((input) => Promise.reject(
    new Error(`Unexpected network request in unit test: ${requestedUrl(input)}`),
  )));
  vi.stubGlobal('XMLHttpRequest', blockedNetworkConstructor('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', blockedNetworkConstructor('WebSocket'));
  vi.stubGlobal('EventSource', blockedNetworkConstructor('EventSource'));
});
