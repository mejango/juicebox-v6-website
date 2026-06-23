#!/usr/bin/env bash
#
# extract-abis.sh — Build repos with forge, then extract ABIs into data/abis/
#
# Usage:
#   bash build/extract-abis.sh            # build all repos + extract
#   bash build/extract-abis.sh --skip-build  # extract only (assumes already built)
#   bash build/extract-abis.sh --only nana-core-v6  # build+extract one repo only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPOS_DIR="$(dirname "$PROJECT_DIR")"          # /Users/.../evm/
ABI_DIR="$PROJECT_DIR/data/abis"

SKIP_BUILD=false
ONLY_REPO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --only)       shift; ONLY_REPO="${1:-}"; shift ;;
    *)            shift ;;
  esac
done

mkdir -p "$ABI_DIR"

# ── Contract manifest: repo → contract names ──────────────────────────────────
# Each line is "repo:Contract1,Contract2,..."
MANIFEST=(
  "nana-core-v6:JBMultiTerminal,JBController,JBDirectory,JBTerminalStore,JBTokens,JBRulesets,JBSplits,JBPermissions,JBPrices,JBProjects,JBFundAccessLimits,JBERC20,JBFeelessAddresses,JBDeadline1Day,JBDeadline3Days,JBDeadline3Hours,JBDeadline7Days"
  "nana-721-hook-v6:JB721TiersHook,JB721TiersHookStore,JB721TiersHookDeployer,JB721TiersHookProjectDeployer"
  "nana-buyback-hook-v6:JBBuybackHookRegistry"
  "nana-suckers-v6:JBSuckerRegistry,JBOptimismSucker,JBArbitrumSucker,JBCCIPSucker,JBBaseSucker"
  "nana-omnichain-deployers-v6:JBOmnichainDeployer"
  "nana-distributor-v6:JBTokenDistributor,JB721Distributor"
  "nana-project-payer-v6:JBProjectPayer,JBProjectPayerDeployer"
  "nana-router-terminal-v6:JBRouterTerminal,JBRouterTerminalRegistry,JBPayRouteResolver"
  "nana-project-handles-v6:JBProjectHandles"
  "nana-address-registry-v6:JBAddressRegistry"
  "nana-fee-project-deployer-v6:FeeProjectConfigBuilder"
  "revnet-core-v6:REVDeployer,REVLoans"
  "croptop-core-v6:CTDeployer,CTPublisher,CTProjectOwner"
  "defifa:DefifaDeployer,DefifaHook,DefifaGovernor"
  "banny-retail-v6:Banny721TokenUriResolver"
  "univ4-lp-split-hook-v6:JBUniswapV4LPSplitHook,JBUniswapV4LPSplitHookDeployer"
  "univ4-router-v6:JBUniswapV4Hook"
)

# ── Helpers ───────────────────────────────────────────────────────────────────

extract_abi() {
  local repo="$1"
  local contract="$2"
  local artifact="$REPOS_DIR/$repo/out/${contract}.sol/${contract}.json"

  # If not at the standard path, search for it in the out/ directory
  if [ ! -f "$artifact" ]; then
    local found
    found=$(find "$REPOS_DIR/$repo/out" -name "${contract}.json" -type f 2>/dev/null | head -1)
    if [ -n "$found" ]; then
      artifact="$found"
    else
      echo "  ⚠  artifact not found for $contract in $repo/out/"
      return 1
    fi
  fi

  # Extract .abi + NatSpec (devdoc/userdoc) from the forge artifact JSON
  python3 -c "
import json, sys
import re

def normalize_doc(value):
    if isinstance(value, str):
        return re.sub(r'(?<=[.!?])(?=[A-Z])', ' ', value)
    if isinstance(value, dict):
        return {k: normalize_doc(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize_doc(v) for v in value]
    return value

with open('$artifact') as f:
    data = json.load(f)
abi = data.get('abi', [])
if not abi:
    print('  ⚠  empty ABI for $contract', file=sys.stderr)
    sys.exit(1)
devdoc = {}
userdoc = {}
contract_notice = ''
contract_title = ''
source_name = ''
rm = data.get('rawMetadata', '')
if rm:
    try:
        meta = json.loads(rm)
        output_meta = meta.get('output', {})
        devdoc = output_meta.get('devdoc', {}).get('methods', {})
        userdoc = output_meta.get('userdoc', {}).get('methods', {})
        contract_notice = output_meta.get('userdoc', {}).get('notice', '')
        contract_title = output_meta.get('devdoc', {}).get('title', '')
        compilation_target = meta.get('settings', {}).get('compilationTarget', {})
        if compilation_target:
            source_path = next(iter(compilation_target.keys()))
            try:
                with open('$REPOS_DIR/$repo/package.json') as pkg_file:
                    package_name = json.load(pkg_file).get('name', '$repo')
            except Exception:
                package_name = '$repo'
            source_name = 'node_modules/' + package_name + '/' + source_path
    except (json.JSONDecodeError, TypeError):
        pass
result = {'abi': abi, 'devdoc': normalize_doc(devdoc), 'userdoc': normalize_doc(userdoc)}
result['contractName'] = '$contract'
if source_name:
    result['sourceName'] = source_name
if contract_notice:
    result['contractNotice'] = normalize_doc(contract_notice)
if contract_title:
    result['contractTitle'] = normalize_doc(contract_title)
json.dump(result, sys.stdout, separators=(',', ':'))
" > "$ABI_DIR/${contract}.json"

  echo "  ✓  $contract ($(wc -c < "$ABI_DIR/${contract}.json" | tr -d ' ') bytes)"
}

build_repo() {
  local repo="$1"
  local repo_path="$REPOS_DIR/$repo"

  if [ ! -d "$repo_path" ]; then
    echo "  ✗  repo not found: $repo_path"
    return 1
  fi

  echo "  building $repo..."
  (cd "$repo_path" && forge build --silent 2>&1) || {
    echo "  ✗  forge build failed for $repo"
    return 1
  }
  echo "  ✓  build complete"
}

# ── Main ──────────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════╗"
echo "║  Juicebox v6 — ABI Extraction                   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Repos dir: $REPOS_DIR"
echo "ABI dir:   $ABI_DIR"
echo ""

total=0
extracted=0
failed=0

for entry in "${MANIFEST[@]}"; do
  repo="${entry%%:*}"
  contracts_csv="${entry#*:}"

  # Filter if --only specified
  if [ -n "$ONLY_REPO" ] && [ "$repo" != "$ONLY_REPO" ]; then
    continue
  fi

  echo "── $repo ──"

  # Build step
  if [ "$SKIP_BUILD" = false ]; then
    build_repo "$repo" || { echo "  skipping extraction due to build failure"; echo ""; continue; }
  fi

  # Extract ABIs
  IFS=',' read -ra contracts <<< "$contracts_csv"
  for contract in "${contracts[@]}"; do
    total=$((total + 1))
    if extract_abi "$repo" "$contract"; then
      extracted=$((extracted + 1))
    else
      failed=$((failed + 1))
    fi
  done

  echo ""
done

echo "════════════════════════════════════════════════════"
echo "Done. $extracted/$total ABIs extracted ($failed failed)."
echo "Output: $ABI_DIR/"
echo ""

if [ "$failed" -gt 0 ]; then
  echo "Some extractions failed. Missing artifacts may need 'forge build' in the repo."
  exit 1
fi
