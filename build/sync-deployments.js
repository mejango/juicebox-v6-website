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

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const ABI_DIR = path.join(DATA_DIR, "abis");
const MANIFEST_FILE = path.join(DATA_DIR, "manifest.json");
const DEPLOYMENTS_FILE = path.join(DATA_DIR, "deployments.json");
const DEPLOYMENTS_DIR = process.env.DEPLOY_ALL_DEPLOYMENTS_DIR
  ? path.resolve(process.env.DEPLOY_ALL_DEPLOYMENTS_DIR)
  : path.resolve(ROOT, "..", "deploy-all-v6", "deployments");

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

function main() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    throw new Error(`Deployments directory not found: ${DEPLOYMENTS_DIR}`);
  }

  fs.mkdirSync(ABI_DIR, { recursive: true });

  const chains = {};
  const contracts = {};
  const deployments = {
    source: path.relative(ROOT, DEPLOYMENTS_DIR),
    generatedAt: new Date().toISOString(),
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
    const files = fs
      .readdirSync(chainDir)
      .filter((file) => file.endsWith(".json"))
      .sort();

    for (const file of files) {
      const deploymentName = file.replace(/\.json$/, "");
      const artifactPath = path.join(chainDir, file);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      if (!artifact.abi || !artifact.address || !artifact.chainId) continue;

      const chainId = parseChainId(artifact.chainId);
      const contractName = artifact.contractName || deploymentName.split("__")[0];
      const relativeFile = path.relative(ROOT, artifactPath);

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

main();
