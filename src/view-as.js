// src/view-as.js
// Site-wide "View as" (impersonation) mode: browse the whole site as any address.
// Pure, localStorage-persisted store. Display/data reads resolve through
// getEffectiveAccount() (component-base.js); transaction paths keep the REAL
// connected account and refuse to send while this mode is active.

var KEY = 'js-view-as-v1';
var listeners = [];

export var VIEW_AS_TX_ERROR = "You're viewing the site as another account — exit View as to transact.";

function readStored() {
  try {
    var v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    return v || null;
  } catch (_) { return null; }
}

var current = readStored();

export function getViewAs() {
  return current;
}

export function setViewAs(address) {
  var next = (address && String(address).trim()) || null;
  if (next === current) return;
  current = next;
  try {
    if (typeof localStorage !== 'undefined') {
      if (current) localStorage.setItem(KEY, current);
      else localStorage.removeItem(KEY);
    }
  } catch (_) {}
  notify();
}

export function clearViewAs() {
  setViewAs(null);
}

export function onViewAsChange(fn) {
  listeners.push(fn);
  return function unsubscribeViewAsChange() {
    var index = listeners.indexOf(fn);
    if (index !== -1) listeners.splice(index, 1);
  };
}

function notify() {
  // Iterate a snapshot (a callback may unsubscribe) and isolate callback failures.
  listeners.slice().forEach(function (fn) {
    try { fn(current); } catch (error) {
      if (typeof console !== 'undefined' && console.error) console.error('View-as listener failed:', error);
    }
  });
}
