#!/usr/bin/env node
/**
 * Sync ABIs and addresses from deploy-all-v6/deployments.
 *
 * This makes deploy-all deployment artifacts the website's source of truth for:
 * - data/abis/*.json
 * - data/manifest.json contract addresses
 * - data/deployments.json deployment metadata
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const ABI_DIR = path.join(DATA_DIR, "abis");
const MANIFEST_FILE = path.join(DATA_DIR, "manifest.json");
const DEPLOYMENTS_FILE = path.join(DATA_DIR, "deployments.json");
const DEPLOYMENTS_DIR = process.env.DEPLOY_ALL_DEPLOYMENTS_DIR
  ? path.resolve(process.env.DEPLOY_ALL_DEPLOYMENTS_DIR)
  : path.resolve(ROOT, "..", "..", "deploy-all-v6", "deployments");

const CHAIN_NAMES = {
  "1": "Ethereum",
  "10": "Optimism",
  "8453": "Base",
  "42161": "Arbitrum",
  "11155111": "Sepolia",
  "11155420": "OP Sepolia",
  "84532": "Base Sepolia",
  "421614": "Arbitrum Sepolia",
};

function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sortedObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => String(a).localeCompare(String(b)))
  );
}

function parseChainId(chainId) {
  if (typeof chainId === "number") return String(chainId);
  if (typeof chainId === "string" && chainId.startsWith("0x")) {
    return BigInt(chainId).toString(10);
  }
  return String(chainId);
}

function chainNameFor(slug, chainId) {
  if (CHAIN_NAMES[chainId]) return CHAIN_NAMES[chainId];
  return slug
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function docsFromArtifact(artifact) {
  let devdoc = {};
  let userdoc = {};
  let contractNotice = "";
  let contractTitle = "";
  const metadata = artifact.rawMetadata || artifact.metadata || "";

  if (metadata) {
    try {
      const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
      const output = parsed.output || {};
      devdoc = (output.devdoc && output.devdoc.methods) || {};
      userdoc = (output.userdoc && output.userdoc.methods) || {};
      contractNotice = (output.userdoc && output.userdoc.notice) || "";
      contractTitle = (output.devdoc && output.devdoc.title) || "";
    } catch (_) {
      // Keep ABIs usable even when metadata is not parseable.
    }
  }

  const result = {
    abi: artifact.abi || [],
    devdoc,
    userdoc,
  };
  if (contractNotice) result.contractNotice = contractNotice;
  if (contractTitle) result.contractTitle = contractTitle;
  if (artifact.contractName) result.contractName = artifact.contractName;
  if (artifact.sourceName) result.sourceName = artifact.sourceName;
  return result;
}

function writeJSON(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function deploymentJsonFiles(chainDir) {
  return fs
    .readdirSync(chainDir)
    .filter((file) => file.endsWith(".json"))
    .filter((file) => {
      const deploymentName = file.replace(/\.json$/, "");
      // Skip superseded records: _deprecated, _deprecated2, … and the TWAP upgrade snapshot.
      return !/_deprecated\d*$/.test(deploymentName) && !deploymentName.endsWith("__TwapOracleUpgrade");
    })
    .sort();
}

// Hash the exact deployment bytes consumed by the generator. Exported so the
// read-only CI parity check cannot drift from snapshot generation semantics.
function deploymentSourceDigest(deploymentsDir) {
  const sourceHash = crypto.createHash("sha256");
  const chainSlugs = fs
    .readdirSync(deploymentsDir)
    .filter((entry) => fs.statSync(path.join(deploymentsDir, entry)).isDirectory())
    .sort();

  for (const chainSlug of chainSlugs) {
    const chainDir = path.join(deploymentsDir, chainSlug);
    for (const file of deploymentJsonFiles(chainDir)) {
      sourceHash
        .update(chainSlug)
        .update("\0")
        .update(file)
        .update("\0")
        .update(fs.readFileSync(path.join(chainDir, file), "utf8"))
        .update("\0");
    }
  }
  return `sha256:${sourceHash.digest("hex")}`;
}

// Preserve the timestamp when the deployment inputs are byte-for-byte identical. This makes `npm run build`
// reproducible (and keeps a clean worktree clean) while still recording when a changed snapshot was generated.
// SOURCE_DATE_EPOCH gives CI/release builds a standard deterministic timestamp when accepting new inputs.
function nextGeneratedAt(previous, sourceDigest) {
  if (previous && previous.sourceDigest === sourceDigest && previous.generatedAt) return previous.generatedAt;
  if (process.env.SOURCE_DATE_EPOCH) {
    const epochSeconds = Number(process.env.SOURCE_DATE_EPOCH);
    const generatedAt = new Date(epochSeconds * 1000);
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0 || Number.isNaN(generatedAt.getTime())) {
      throw new Error("SOURCE_DATE_EPOCH must be non-negative integer seconds in the supported date range");
    }
    return generatedAt.toISOString();
  }
  return new Date().toISOString();
}

function deploymentArtifactFile(logicalSource, deploymentsDir, artifactPath) {
  const relativeArtifactPath = path.relative(deploymentsDir, artifactPath);
  return path.posix.join(
    logicalSource.split(path.sep).join(path.posix.sep),
    relativeArtifactPath.split(path.sep).join(path.posix.sep)
  );
}

function main() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    throw new Error(`Deployments directory not found: ${DEPLOYMENTS_DIR}`);
  }

  fs.mkdirSync(ABI_DIR, { recursive: true });

  const chains = {};
  const contracts = {};
  const previousDeployments = loadJSON(DEPLOYMENTS_FILE, {});
  const deployments = {
    // Keep this informational path stable when CI regenerates from its pinned
    // sparse checkout at a different filesystem location. Content identity is
    // enforced by sourceDigest and the separately pinned git commit.
    source: previousDeployments.source || path.relative(ROOT, DEPLOYMENTS_DIR),
    generatedAt: null,
    sourceDigest: null,
    chains: {},
    deployments: {},
  };
  const abiByDeployment = {};
  const abiFingerprints = {};

  const chainSlugs = fs
    .readdirSync(DEPLOYMENTS_DIR)
    .filter((entry) => fs.statSync(path.join(DEPLOYMENTS_DIR, entry)).isDirectory())
    .sort();

  for (const chainSlug of chainSlugs) {
    const chainDir = path.join(DEPLOYMENTS_DIR, chainSlug);
    const files = deploymentJsonFiles(chainDir);

    for (const file of files) {
      const deploymentName = file.replace(/\.json$/, "");
      const artifactPath = path.join(chainDir, file);
      const artifactJson = fs.readFileSync(artifactPath, "utf8");
      const artifact = JSON.parse(artifactJson);
      if (!artifact.abi || !artifact.address || !artifact.chainId) continue;

      const chainId = parseChainId(artifact.chainId);
      const contractName = artifact.contractName || deploymentName.split("__")[0];
      const relativeFile = deploymentArtifactFile(
        deployments.source,
        DEPLOYMENTS_DIR,
        artifactPath
      );

      chains[chainId] = chains[chainId] || {
        name: chainNameFor(chainSlug, chainId),
        testnet: /sepolia/i.test(chainSlug),
      };
      deployments.chains[chainId] = {
        id: chainId,
        name: chains[chainId].name,
        slug: chainSlug,
        testnet: !!chains[chainId].testnet,
      };

      contracts[deploymentName] = contracts[deploymentName] || {
        singleton: true,
        contractName,
        deploymentName,
        addresses: {},
      };
      contracts[deploymentName].addresses[chainId] = artifact.address;

      deployments.deployments[deploymentName] =
        deployments.deployments[deploymentName] || {
          deploymentName,
          contractName,
          sourceName: artifact.sourceName || null,
          abi: deploymentName,
          addresses: {},
          chains: {},
        };

      deployments.deployments[deploymentName].addresses[chainId] = artifact.address;
      deployments.deployments[deploymentName].chains[chainId] = {
        chain: chainSlug,
        address: artifact.address,
        file: relativeFile,
        transactionHash:
          (artifact.receipt && artifact.receipt.transactionHash) || null,
        blockNumber: (artifact.receipt && artifact.receipt.blockNumber) || null,
        gitCommit: artifact.gitCommit || null,
        gitDirty: artifact.gitDirty ?? null,
      };

      const docs = docsFromArtifact(artifact);
      const fingerprint = JSON.stringify(docs.abi);
      if (!abiByDeployment[deploymentName]) {
        abiByDeployment[deploymentName] = docs;
        abiFingerprints[deploymentName] = fingerprint;
      } else if (abiFingerprints[deploymentName] !== fingerprint) {
        console.warn(
          `WARNING: ABI mismatch for ${deploymentName}; keeping first ABI and using all addresses`
        );
      }
    }
  }

  const nextAbiFiles = new Set(
    Object.keys(abiByDeployment).map((name) => `${name}.json`)
  );
  for (const file of fs.readdirSync(ABI_DIR)) {
    if (file.endsWith(".json") && !nextAbiFiles.has(file)) {
      fs.unlinkSync(path.join(ABI_DIR, file));
    }
  }
  for (const [name, abiDoc] of Object.entries(abiByDeployment).sort()) {
    writeJSON(path.join(ABI_DIR, `${name}.json`), abiDoc);
  }

  const manifest = {
    chains: sortedObject(chains),
    contracts: sortedObject(contracts),
  };
  deployments.sourceDigest = deploymentSourceDigest(DEPLOYMENTS_DIR);
  deployments.generatedAt = nextGeneratedAt(previousDeployments, deployments.sourceDigest);
  deployments.chains = sortedObject(deployments.chains);
  deployments.deployments = sortedObject(deployments.deployments);

  writeJSON(MANIFEST_FILE, manifest);
  writeJSON(DEPLOYMENTS_FILE, deployments);

  console.log("sync-deployments.js");
  console.log("-------------------");
  console.log(`Source:      ${DEPLOYMENTS_DIR}`);
  console.log(`Chains:      ${Object.keys(deployments.chains).length}`);
  console.log(`Deployments: ${Object.keys(deployments.deployments).length}`);
  console.log(`ABI files:   ${Object.keys(abiByDeployment).length}`);
}

if (require.main === module) main();

module.exports = { deploymentArtifactFile, deploymentSourceDigest, nextGeneratedAt };
