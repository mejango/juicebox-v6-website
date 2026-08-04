// Juicescan intentionally stays SDK-independent at runtime, but mirrors the covered
// `build721RulesetMetadata` / `decode721RulesetMetadata` contract in juice-sdk-v4.
// JBRulesetMetadata.metadata is uint14 and is shared by hook integrations, so every
// write must preserve bits it does not own (Revnet currently uses another bit).

export var JB721_RULESET_METADATA_PAUSE_TRANSFERS = 1 << 0;
export var JB721_RULESET_METADATA_PAUSE_MINT_PENDING_RESERVES = 1 << 1;
export var JB_RULESET_METADATA_APP_BITS_MAX = 0x3fff;

function checkedMetadata(value) {
  var metadata = value == null ? 0 : Number(value);
  if (!Number.isInteger(metadata) || metadata < 0 || metadata > JB_RULESET_METADATA_APP_BITS_MAX) {
    throw new Error('Ruleset app metadata must be an integer between 0 and ' + JB_RULESET_METADATA_APP_BITS_MAX + '.');
  }
  return metadata;
}

function setFlag(metadata, flag, enabled) {
  if (enabled == null) return metadata;
  return enabled ? (metadata | flag) : (metadata & ~flag);
}

export function build721RulesetMetadata(input) {
  input = input || {};
  var metadata = checkedMetadata(input.metadata);
  metadata = setFlag(metadata, JB721_RULESET_METADATA_PAUSE_TRANSFERS, input.pauseTransfers);
  return setFlag(metadata, JB721_RULESET_METADATA_PAUSE_MINT_PENDING_RESERVES, input.pauseMintPendingReserves);
}

export function decode721RulesetMetadata(value) {
  var metadata = checkedMetadata(value);
  return {
    pauseTransfers: (metadata & JB721_RULESET_METADATA_PAUSE_TRANSFERS) !== 0,
    pauseMintPendingReserves: (metadata & JB721_RULESET_METADATA_PAUSE_MINT_PENDING_RESERVES) !== 0,
  };
}

// `mintFor` encodes quantity by repeating a uint16 tier id. Bound the batch so
// one mistaken input cannot produce an unexpectedly large calldata/gas request.
export function buildOwnerMintTierIds(tierId, quantity) {
  tierId = Number(tierId); quantity = Number(quantity);
  if (!Number.isSafeInteger(tierId) || tierId < 1 || tierId > 0xffff) throw new Error('The item tier ID is invalid.');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50) throw new Error('Mint between 1 and 50 items at once.');
  return Array.from({ length: quantity }, function () { return tierId; });
}
