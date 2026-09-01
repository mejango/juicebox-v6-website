// src/tx-pretty-args.js
// Precise decoders for confirm-dialog arguments that would otherwise render as
// opaque bytes. Every decoder is strict: it re-encodes what it decoded and
// compares bytes (or validates the full structure) before claiming an
// interpretation, and returns null on ANY mismatch so the raw view shows
// instead — a pretty rendering must never paper over bytes it can't fully
// account for. Mirrors the revnet.money / juicebox.money review decoders.

import { decodeAbiParameters, encodeAbiParameters, decodeFunctionData, encodeFunctionData } from 'viem';
import { getABI } from './abi-registry.js';
import { PERMISSION_IDS } from './permissions-component.js';

var ZERO_ADDR = '0x0000000000000000000000000000000000000000';
/** JBConstants.SPLITS_TOTAL_PERCENT — a split group's whole is 1e9. */
var SPLITS_TOTAL_PERCENT = 1000000000;

function bigintJson(value) {
  return JSON.stringify(value, function (_, item) { return typeof item === 'bigint' ? item.toString() : item; });
}

/** Strict decode + byte-exact re-encode round trip, else null. */
function roundTripDecode(types, payload) {
  try {
    var decoded = decodeAbiParameters(types, payload);
    if (encodeAbiParameters(types, decoded).toLowerCase() !== payload.toLowerCase()) return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

// ── 1. JB hook metadata (JBMetadataResolver envelope) ────────────────────────
// Layout (JBMetadataResolver.createMetadata): a 32-byte protocol-reserved word,
// a word-padded table of (bytes4 id, uint8 wordOffset) entries, then
// word-aligned payload segments. Offsets are word counts, strictly increasing,
// and the segments must tile the remainder of the bytes exactly.

function parseHookMetadataEnvelope(value) {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(value)) return null;
  var body = value.slice(2).toLowerCase();
  if (body.length % 64 !== 0) return null;
  var totalWords = body.length / 64;
  if (totalWords < 3) return null; // reserved word + table word + ≥1 payload word
  var firstOffset = parseInt(body.slice(64 + 8, 64 + 10), 16);
  var tableWords = firstOffset - 1;
  if (!(tableWords >= 1) || firstOffset >= totalWords) return null;
  var tableArea = body.slice(64, 64 + tableWords * 64);
  var entries = [];
  var cursor = 0;
  while (cursor + 10 <= tableArea.length) {
    var chunk = tableArea.slice(cursor, cursor + 10);
    if (/^0+$/.test(chunk)) break;
    var id = chunk.slice(0, 8);
    var offset = parseInt(chunk.slice(8, 10), 16);
    if (/^0+$/.test(id)) return null; // a zero id with a nonzero offset is malformed
    entries.push({ id: '0x' + id, offset: offset });
    cursor += 10;
  }
  if (!entries.length) return null;
  if (!/^0*$/.test(tableArea.slice(cursor))) return null; // table tail must be padding
  if (Math.ceil((entries.length * 5) / 32) !== tableWords) return null; // count sized the table
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].offset >= totalWords) return null;
    if (i > 0 && entries[i].offset <= entries[i - 1].offset) return null;
  }
  var segments = entries.map(function (entry, idx) {
    var start = entry.offset * 64;
    var end = idx + 1 < entries.length ? entries[idx + 1].offset * 64 : body.length;
    return { id: entry.id, payload: '0x' + body.slice(start, end) };
  });
  return { reserved: '0x' + body.slice(0, 64), entries: segments };
}

/** Aggregate repeated tier ids into "2× #4" form, preserving first-seen order. */
function tierIdCounts(tierIds) {
  var counts = new Map();
  tierIds.forEach(function (id) { counts.set(id, (counts.get(id) || 0) + 1); });
  var parts = [];
  counts.forEach(function (count, id) { parts.push(count > 1 ? count + '× #' + id : '#' + id); });
  return parts.join(', ');
}

/**
 * Decode a `pay`/`addToBalanceOf`/`cashOutTokensOf` `metadata` argument into
 * hook entries, with typed interpretations for the payload shapes this
 * ecosystem's builders produce (721 mints/redeems, buyback routing). Payloads
 * that byte-match MULTIPLE known shapes are reported as ambiguous rather than
 * picking one.
 */
export function describeJBHookMetadata(context, value) {
  var envelope = parseHookMetadataEnvelope(value);
  if (!envelope) return null;
  var steps = [];
  if (!/^0x0+$/.test(envelope.reserved)) {
    steps.push({ title: 'Protocol-reserved word (nonzero)', rows: [['Value', envelope.reserved]] });
  }
  envelope.entries.forEach(function (entry) {
    var payloadWords = (entry.payload.length - 2) / 64;
    var base = [['Hook lookup id', entry.id]];
    var readings = [];
    if (context === 'pay') {
      var mint = roundTripDecode([{ type: 'bool' }, { type: 'uint16[]' }], entry.payload);
      if (mint) {
        readings.push({
          title: '721 shop mint instructions',
          rows: base.concat([
            ['Tier IDs to mint', mint[1].length ? tierIdCounts(mint[1]) : 'none (credits only)'],
            ['Allow overspending', mint[0] ? 'yes — excess becomes pay credits' : 'no — any excess reverts'],
          ]),
        });
      }
      if (payloadWords === 3) {
        var swap = roundTripDecode([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], entry.payload);
        if (swap) {
          readings.push({
            title: 'Buyback hook swap instructions',
            rows: base.concat([
              ['Amount to swap', swap[0].toString()],
              ['Minimum swap output', swap[1].toString() + ' — reverts below this'],
              ['Skip splits on swapped tokens', swap[2] ? 'yes' : 'no'],
            ]),
          });
        }
      }
    } else {
      if (payloadWords === 2) {
        var buyback = roundTripDecode([{ type: 'uint256' }, { type: 'bool' }], entry.payload);
        if (buyback) {
          readings.push({
            title: 'Buyback hook cash-out routing',
            rows: base.concat([
              ['Minimum swap output', buyback[0].toString()],
              ['Force the direct terminal path', buyback[1] ? 'yes — never route through the pool' : 'no'],
            ]),
          });
        }
      }
      var redeem = roundTripDecode([{ type: 'uint256[]' }], entry.payload);
      if (redeem) {
        readings.push({
          title: '721 shop items to redeem',
          rows: base.concat([
            ['Token IDs', redeem[0].length ? redeem[0].map(function (id) { return '#' + id; }).join(', ') : 'none'],
          ]),
        });
      }
    }
    if (readings.length === 1) {
      steps.push(readings[0]);
    } else if (readings.length > 1) {
      steps.push({
        title: 'Payload matches multiple known shapes — verify against the raw bytes',
        rows: base.concat(readings.map(function (reading, idx) {
          return ['Reading ' + (idx + 1), reading.title + ': ' + reading.rows.slice(base.length).map(function (row) {
            return row[0].toLowerCase() + ': ' + row[1];
          }).join('; ')];
        })),
      });
    } else {
      steps.push({
        title: 'Unrecognized hook payload (' + payloadWords + ' word' + (payloadWords === 1 ? '' : 's') + ')',
        rows: base.concat([['Payload', entry.payload]]),
      });
    }
  });
  return steps;
}

// ── 2. Sucker bridge claim ───────────────────────────────────────────────────

/** A bytes32 that is a left-padded address renders as the address. */
function paddedAddress(value) {
  if (/^0x000000000000000000000000[0-9a-fA-F]{40}$/.test(value)) return '0x' + value.slice(26);
  return value;
}

export function describeSuckerClaim(value) {
  var claim = value || null;
  if (!claim || typeof claim.token !== 'string' || !claim.leaf) return null;
  var leaf = claim.leaf;
  var proofOk = Array.isArray(claim.proof) && claim.proof.length === 32 &&
    claim.proof.every(function (hash) { return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash); });
  if (
    !proofOk ||
    typeof leaf.beneficiary !== 'string' ||
    typeof leaf.index !== 'bigint' ||
    typeof leaf.projectTokenCount !== 'bigint' ||
    typeof leaf.terminalTokenAmount !== 'bigint'
  ) {
    return null;
  }
  var rows = [
    ['Terminal token', claim.token],
    ['Leaf index', leaf.index.toString()],
    ['Beneficiary', paddedAddress(leaf.beneficiary)],
    ['Project tokens', leaf.projectTokenCount.toString()],
    ['Terminal token amount', leaf.terminalTokenAmount.toString()],
  ];
  if (typeof leaf.metadata === 'string' && !/^0x0+$/.test(leaf.metadata)) rows.push(['Leaf metadata', leaf.metadata]);
  rows.push(['Merkle proof', '32 hashes — exact bytes in the raw data below']);
  return [{ title: "Claim a bridged balance from the sucker's inbox tree", rows: rows }];
}

// ── 3. Safe execTransaction inner call ───────────────────────────────────────

var SAFE_INNER_ABI_NAMES = ['JBController', 'JBMultiTerminal', 'JBDirectory', 'JBTokens', 'JBPermissions', 'JBSplits', 'JBProjects'];
var ERC20_MINI_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

export function describeSafeInnerCall(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(value)) return null;
  var candidates = SAFE_INNER_ABI_NAMES.map(function (name) {
    try { return { name: name, abi: getABI(name) }; } catch (e) { return null; }
  }).filter(Boolean).concat([{ name: 'ERC-20', abi: ERC20_MINI_ABI }]);
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (!candidate.abi) continue;
    try {
      var decoded = decodeFunctionData({ abi: candidate.abi, data: value });
      var item = candidate.abi.find(function (entry) { return entry.type === 'function' && entry.name === decoded.functionName; });
      var rows = (decoded.args || []).map(function (argument, idx) {
        var name = (item && item.inputs[idx] && item.inputs[idx].name) || ('argument ' + (idx + 1));
        return [name, bigintJson(argument)];
      });
      return [{
        title: 'Queued call — ' + candidate.name + '.' + decoded.functionName + '(…)',
        rows: rows.length ? rows : [['Arguments', 'none']],
      }];
    } catch (e) { /* try the next candidate ABI */ }
  }
  return null;
}

// ── 4. Safe proxy initializer ────────────────────────────────────────────────

/** Canonical Safe v1.3/v1.4 setup + SafeToL2Setup signatures. */
var SAFE_SETUP_ABI = [{
  type: 'function', name: 'setup', stateMutability: 'nonpayable',
  inputs: [
    { name: '_owners', type: 'address[]' },
    { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' },
    { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' },
    { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' },
    { name: 'paymentReceiver', type: 'address' },
  ],
  outputs: [],
}];
var SAFE_TO_L2_SETUP_ABI = [{
  type: 'function', name: 'setupToL2', stateMutability: 'nonpayable',
  inputs: [{ name: 'l2Singleton', type: 'address' }], outputs: [],
}];

export function describeSafeInitializer(value) {
  if (typeof value !== 'string' || !value.startsWith('0x')) return null;
  var decoded;
  try { decoded = decodeFunctionData({ abi: SAFE_SETUP_ABI, data: value }); } catch (e) { return null; }
  if (decoded.functionName !== 'setup' || !decoded.args) return null;
  // Reject noncanonical encodings so the summary can never disagree with the bytes.
  var canonical = encodeFunctionData({ abi: SAFE_SETUP_ABI, functionName: 'setup', args: decoded.args });
  if (canonical.toLowerCase() !== value.toLowerCase()) return null;
  var owners = decoded.args[0];
  var threshold = decoded.args[1];
  var to = decoded.args[2];
  var data = decoded.args[3];
  var fallbackHandler = decoded.args[4];
  var paymentToken = decoded.args[5];
  var payment = decoded.args[6];
  var paymentReceiver = decoded.args[7];
  var rows = [
    ['Owners', owners.length ? owners.join(', ') : 'none'],
    ['Threshold', threshold.toString() + ' of ' + owners.length],
    ['Fallback handler', fallbackHandler],
  ];
  if (String(to).toLowerCase() === ZERO_ADDR && data === '0x') {
    rows.push(['Setup hook', 'none']);
  } else {
    var hook = 'DELEGATECALL to ' + to + ' — data in the raw view below';
    try {
      var inner = decodeFunctionData({ abi: SAFE_TO_L2_SETUP_ABI, data: data });
      if (inner.functionName === 'setupToL2' && inner.args &&
        encodeFunctionData({ abi: SAFE_TO_L2_SETUP_ABI, functionName: 'setupToL2', args: inner.args }).toLowerCase() === data.toLowerCase()) {
        hook = 'SafeToL2Setup.setupToL2(' + inner.args[0] + ') via ' + to;
      }
    } catch (e) { /* keep the generic delegatecall warning */ }
    rows.push(['Setup hook', hook]);
  }
  if (payment !== 0n || String(paymentToken).toLowerCase() !== ZERO_ADDR) {
    rows.push(['Deployment payment', payment.toString() + ' of ' + paymentToken + ' to ' + paymentReceiver + ' — unusual, verify']);
  }
  return [{ title: 'Safe setup', rows: rows }];
}

// ── 5. Permission grants ─────────────────────────────────────────────────────

var PERMISSION_NAME_BY_ID = new Map(PERMISSION_IDS.map(function (entry) { return [entry.id, entry.name]; }));

export function describePermissionsData(value) {
  var data = value || null;
  if (
    !data || typeof data.operator !== 'string' ||
    (typeof data.projectId !== 'bigint' && typeof data.projectId !== 'number') ||
    !Array.isArray(data.permissionIds) ||
    !data.permissionIds.every(function (id) { return typeof id === 'number' && Number.isInteger(id); })
  ) {
    return null;
  }
  var projectId = BigInt(data.projectId);
  var names = data.permissionIds.map(function (id) {
    var name = PERMISSION_NAME_BY_ID.get(id);
    return name ? name + ' (' + id + ')' : 'UNKNOWN PERMISSION (' + id + ')';
  });
  var rows = [
    ['Operator', data.operator],
    ['Scope', projectId === 0n ? 'project 0 — EVERY project this account ever owns' : 'project #' + projectId],
    ['Permissions', names.length ? names.join(', ') : 'none — revokes everything previously granted'],
  ];
  if (data.permissionIds.indexOf(1) >= 0) {
    rows.push(['Warning', 'ROOT grants every permission across all Juicebox contracts']);
  }
  return [{ title: 'Set operator permissions', rows: rows }];
}

// ── 6. Split groups ──────────────────────────────────────────────────────────

function splitPercent(percent) {
  var share = (percent * 100) / SPLITS_TOTAL_PERCENT;
  return Number(share.toFixed(4)) + '%';
}

export function describeSplitGroups(value) {
  if (!Array.isArray(value)) return null;
  var steps = [];
  for (var g = 0; g < value.length; g++) {
    var group = value[g];
    if (!group || typeof group.groupId !== 'bigint' || !Array.isArray(group.splits)) return null;
    var groupLabel = group.groupId === 1n
      ? 'Reserved tokens'
      : group.groupId < (1n << 160n)
        ? 'Payouts of 0x' + group.groupId.toString(16).padStart(40, '0')
        : 'Group ' + group.groupId;
    var rows = [];
    var total = 0;
    for (var i = 0; i < group.splits.length; i++) {
      var split = group.splits[i];
      if (!split || typeof split.percent !== 'number' || typeof split.beneficiary !== 'string' || typeof split.projectId !== 'bigint') return null;
      total += split.percent;
      var parts = [
        split.projectId !== 0n
          ? 'project #' + split.projectId + ' (beneficiary ' + split.beneficiary + ')'
          : split.beneficiary,
      ];
      if (typeof split.hook === 'string' && split.hook.toLowerCase() !== ZERO_ADDR) parts.push('via hook ' + split.hook);
      if (split.preferAddToBalance === true) parts.push('prefers add-to-balance');
      if (typeof split.lockedUntil === 'number' && split.lockedUntil > 0) {
        parts.push('locked until ' + new Date(split.lockedUntil * 1000).toLocaleString());
      }
      rows.push(['Split ' + (i + 1) + ' — ' + splitPercent(split.percent), parts.join(' | ')]);
    }
    rows.push(['Total', splitPercent(total) + (total === SPLITS_TOTAL_PERCENT ? '' : " — the remainder follows the ruleset's default")]);
    steps.push({ title: groupLabel, rows: rows.length > 1 ? rows : [['Splits', 'none']] });
  }
  return steps.length ? steps : null;
}

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * The decoded steps for an argument the default renderer would show as opaque
 * bytes (or misleading raw numbers), or null to keep the default rendering.
 * `fn` is the outer function name; `inputName` the ABI input's name.
 */
export function prettyArgSteps(fn, inputName, value) {
  if ((fn === 'pay' || fn === 'addToBalanceOf') && inputName === 'metadata') {
    return describeJBHookMetadata('pay', value);
  }
  if (fn === 'cashOutTokensOf' && inputName === 'metadata') {
    return describeJBHookMetadata('cashOut', value);
  }
  if (fn === 'claim') return describeSuckerClaim(value);
  if (fn === 'execTransaction' && inputName === 'data') return describeSafeInnerCall(value);
  if (fn === 'execTransaction' && inputName === 'operation') {
    var operation = typeof value === 'bigint' ? Number(value) : value;
    if (operation === 1) {
      return [{ title: 'Operation', rows: [['1', "DELEGATECALL: runs foreign code with the Safe's own storage and funds"]] }];
    }
    if (operation === 0) return [{ title: 'Operation', rows: [['0', 'CALL']] }];
    return null;
  }
  if (fn === 'createProxyWithNonce' && inputName === 'initializer') return describeSafeInitializer(value);
  if (fn === 'setPermissionsFor' && inputName === 'permissionsData') return describePermissionsData(value);
  if (fn === 'setSplitGroupsOf' && inputName === 'splitGroups') return describeSplitGroups(value);
  return null;
}
