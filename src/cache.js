// Cross-session cache for answers that cannot change, or that carry a cheap
// validator proving they haven't.
//
// juicescan is a static bundle with no server and no CDN in front of its data,
// so every reload otherwise re-runs the same paginated multicalls and indexer
// queries from scratch. Entries live in localStorage under a schema version;
// bump SCHEMA when a stored shape changes.
//
// Bigint-safe: onchain reads return bigints throughout and JSON.stringify
// throws on them.
//
// ponytail: localStorage with a per-entry cap and a namespace sweep. It is
// synchronous and ~5MB total; move to IndexedDB if entries start getting
// evicted during normal browsing.

var SCHEMA = 'v1';
var PREFIX = 'jb-cache:' + SCHEMA + ':';
var MAX_ENTRY_CHARS = 400000;

var BIGINT_TAG = '$bigint';

function replacer(key, value) {
  return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
}

function reviver(key, value) {
  if (value && typeof value === 'object' && typeof value[BIGINT_TAG] === 'string') {
    return BigInt(value[BIGINT_TAG]);
  }
  return value;
}

export function cacheSerialize(value) {
  return JSON.stringify(value, replacer);
}

export function cacheDeserialize(raw) {
  return JSON.parse(raw, reviver);
}

/** Read a cached entry. Returns undefined on a miss or any storage failure. */
export function cacheGet(namespace, key) {
  try {
    var raw = localStorage.getItem(PREFIX + namespace + ':' + key);
    if (!raw) return undefined;
    return cacheDeserialize(raw);
  } catch (_) {
    return undefined;
  }
}

/** Store an entry. Silently skips anything over the per-entry budget. */
export function cacheSet(namespace, key, value) {
  try {
    var raw = cacheSerialize(value);
    if (raw.length > MAX_ENTRY_CHARS) return;
    localStorage.setItem(PREFIX + namespace + ':' + key, raw);
  } catch (_) {
    // Quota exceeded: drop this namespace and retry once. Caching is an
    // optimization, so a second failure is simply ignored.
    try {
      cacheClear(namespace);
      localStorage.setItem(PREFIX + namespace + ':' + key, cacheSerialize(value));
    } catch (__) {}
  }
}

export function cacheClear(namespace) {
  try {
    var prefix = PREFIX + namespace + ':';
    var doomed = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) doomed.push(k);
    }
    doomed.forEach(function (k) { localStorage.removeItem(k); });
  } catch (_) {}
}

/**
 * Return the last stored value immediately, then confirm it in the background.
 *
 * `onFresh` receives the live value after it has been stored. A failed refresh
 * leaves the stale entry alone and never calls `onFresh`, so the render layer
 * can keep its `.revalidating` affordance instead of silently blessing old
 * data as current.
 */
export function cacheStale(namespace, key, load, onFresh) {
  var stale = cacheGet(namespace, key);
  var pending;
  try {
    // Invoke the loader now. Besides making the refresh start immediately,
    // this lets callers share the same promise with a cold-load soft timeout.
    pending = load();
  } catch (_) {
    return stale;
  }
  Promise.resolve(pending).then(function (value) {
    // `undefined` is the cache miss sentinel and cannot be serialized.
    if (value === undefined) return;
    cacheSet(namespace, key, value);
    if (onFresh) onFresh(value);
  }).catch(function () {
    // Stale remains explicitly unconfirmed; callers decide when to retry.
  });
  return stale;
}

/**
 * Serve a cached payload when a cheap validator proves it is still current,
 * the way an ETag does. `loadValidator` should be a single cheap read; the
 * expensive `load` only runs when the validator moved or is unavailable.
 *
 * Returns the payload. Never throws on cache problems — only `load` can throw.
 */
export async function cacheValidated(namespace, key, loadValidator, load) {
  var validator = null;
  try {
    validator = await loadValidator();
  } catch (_) {
    validator = null;
  }

  if (validator != null) {
    var hit = cacheGet(namespace, key);
    if (hit && hit.validator === String(validator)) return hit.value;
  }

  var value = await load();
  if (validator != null) {
    cacheSet(namespace, key, { validator: String(validator), value: value });
  }
  return value;
}
