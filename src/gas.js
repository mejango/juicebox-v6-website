/**
 * Give every wallet transaction twice its RPC estimate. Juicebox terminal
 * calls can catch a failed internal fee payment, so the cheaper fallback path
 * may otherwise produce a successful but undersized estimate. Unused gas is
 * not charged.
 */
export function gasWithHeadroom(estimate) {
  return BigInt(estimate) * 2n;
}

export async function contractGasWithHeadroom(publicClient, request) {
  return gasWithHeadroom(await publicClient.estimateContractGas(
    Object.assign({}, request, { gas: undefined })
  ));
}

export async function transactionGasWithHeadroom(publicClient, request) {
  return gasWithHeadroom(await publicClient.estimateGas(
    Object.assign({}, request, { gas: undefined })
  ));
}
