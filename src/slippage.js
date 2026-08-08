// src/slippage.js
// The single minimum-output floor used by every transaction that carries a slippage guard.
//
// Lives in a leaf module because discover.js imports payouts-component.js: the four call sites (cash out, payouts,
// pay, borrow) grew four parallel implementations of the same expression, and a floor policy is exactly the kind of
// rule that must not be changeable in one place only.

function toBigInt(value) {
  if (value === null || value === undefined || value === '') return 0n;
  try { return BigInt(value); } catch (_) { return 0n; }
}

/**
 * The minimum output to accept for a quoted amount, in basis points of that quote (default 9900 = a 1% floor).
 * A positive quote never floors to zero: rounding a real quote down to 0 would encode "any amount is acceptable",
 * so it clamps to 1. A zero/negative/unparseable quote returns 0n — the caller decides whether that is legal.
 */
export function quotedOutputFloor(quoted, bps) {
  quoted = toBigInt(quoted);
  bps = bps == null ? 9900n : BigInt(bps);
  if (quoted <= 0n) return 0n;
  var floor = quoted * bps / 10000n;
  return floor > 0n ? floor : 1n;
}
