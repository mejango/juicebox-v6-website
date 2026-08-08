#!/usr/bin/env node
/**
 * extract-sources.js — Parse Solidity source files and extract per-function
 * bodies + line numbers, keyed by contract.functionName(signature). Output
 * goes to data/contract-sources.json and is consumed by generate-registry.js.
 *
 * Sources are read at the ref the DEPLOYMENT was built from, never from a
 * checked-out working tree. Each contract's ref comes from the deployment
 * artifact (`data/deployments.json` → deployments[*].chains[*].gitCommit,
 * e.g. "npm:@bananapus/core-v6@1.0.2") together with the artifact's
 * `sourceName` (e.g. "node_modules/@bananapus/core-v6/src/JBController.sol").
 * A contract whose deployed ref cannot be resolved is NOT emitted and the run
 * fails: a wrong body under a deployed signature is worse than no body.
 *
 * Usage:
 *   node build/extract-sources.js            # write data/contract-sources.json
 *   node build/extract-sources.js --verify   # assert the committed file is pinned
 *   node build/extract-sources.js --offline  # never reach the npm registry
 *
 * Output: data/contract-sources.json
 * {
 *   "<ContractName>": {
 *     "repo": "nana-core-v6",
 *     "githubUrl": "https://github.com/Bananapus/nana-core-v6",
 *     "sourceRef": "npm:@bananapus/core-v6@1.0.2",
 *     "ref": "<git sha the deployed file content resolves to, or null>",
 *     "path": "src/JBController.sol",
 *     "startLine": 23,
 *     "endLine": 1186,
 *     "functionsByName": {
 *       "launchProjectFor": [{
 *         "name": "launchProjectFor",
 *         "paramTypes": ["address", "string"],
 *         "startLine": 145,
 *         "endLine": 192,
 *         "source": "function launchProjectFor(...) external returns (...) {\n  ...\n}"
 *       }]
 *     }
 *   }
 * }
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPOS_DIR = path.resolve(ROOT, "..", "..");
const DEPLOY_ALL_DIR = path.join(REPOS_DIR, "deploy-all-v6");
const DATA_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(DATA_DIR, "contract-sources.json");
const DEPLOYMENTS_FILE = path.join(DATA_DIR, "deployments.json");
const CACHE_DIR = path.join(__dirname, ".source-cache");

const VERIFY = process.argv.includes("--verify");
const OFFLINE = process.argv.includes("--offline") || process.env.JUICESCAN_SOURCES_OFFLINE === "1";

// Contracts whose Solidity bodies are surfaced in the UI. Every name here must
// have a deployment artifact; the artifact — not this list — decides which repo,
// which file and which version the body is read from.
const MANIFEST = [
  "JBMultiTerminal", "JBController", "JBDirectory", "JBTerminalStore",
  "JBTokens", "JBRulesets", "JBSplits", "JBPermissions", "JBPrices",
  "JBProjects", "JBFundAccessLimits", "JBERC20", "JBFeelessAddresses",
  "JBDeadline1Day", "JBDeadline3Days", "JBDeadline3Hours", "JBDeadline7Days",
  "JB721TiersHook", "JB721TiersHookStore", "JB721TiersHookDeployer",
  "JB721TiersHookProjectDeployer",
  "JBBuybackHookRegistry",
  "JBSuckerRegistry", "JBOptimismSucker", "JBArbitrumSucker", "JBCCIPSucker",
  "JBBaseSucker",
  "JBOmnichainDeployer",
  "JBProjectPayer", "JBProjectPayerDeployer",
  "JBRouterTerminal", "JBRouterTerminalRegistry",
  "JBProjectHandles",
  "JBAddressRegistry",
  "REVDeployer", "REVLoans",
  "CTDeployer", "CTPublisher", "CTProjectOwner",
  "DefifaDeployer", "DefifaHook", "DefifaGovernor",
  "Banny721TokenUriResolver",
  "JBUniswapV4LPSplitHook", "JBUniswapV4LPSplitHookDeployer",
  "JBUniswapV4Hook",
];

// ---------------------------------------------------------------------------
// Deployed-ref resolution
// ---------------------------------------------------------------------------

function loadDeployments() {
  if (!fs.existsSync(DEPLOYMENTS_FILE)) {
    throw new Error(
      `${DEPLOYMENTS_FILE} not found — run \`npm run sync-deployments\` first.`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
  return parsed.deployments || {};
}

// Every deployment record that carries this contract's bytecode: the record
// keyed by the contract name plus any instance record (JBP6FeeLPSplitHook,
// JBCCIPSucker__ARB, …) whose `contractName` points back at it.
function deploymentRecordsFor(deployments, contractName) {
  const records = [];
  for (const [deploymentName, record] of Object.entries(deployments)) {
    if (deploymentName === contractName || record.contractName === contractName) {
      records.push([deploymentName, record]);
    }
  }
  return records;
}

// { sourceRef, sourceName } for a contract, or { error } when the deployment
// artifacts disagree or are absent.
function deployedRefFor(deployments, contractName) {
  const records = deploymentRecordsFor(deployments, contractName);
  if (records.length === 0) return { error: "no deployment artifact" };

  const refs = new Set();
  const sourceNames = new Set();
  for (const [, record] of records) {
    if (record.sourceName) sourceNames.add(record.sourceName);
    for (const chain of Object.values(record.chains || {})) {
      if (chain.gitCommit) refs.add(chain.gitCommit);
    }
  }
  if (refs.size === 0) return { error: "deployment artifact carries no gitCommit" };
  if (refs.size > 1) {
    return { error: `chains disagree on the source ref (${[...refs].sort().join(", ")})` };
  }
  if (sourceNames.size !== 1) {
    return { error: `chains disagree on sourceName (${[...sourceNames].sort().join(", ")})` };
  }
  return { sourceRef: [...refs][0], sourceName: [...sourceNames][0] };
}

// "npm:@bananapus/core-v6@1.0.2" → { pkg, version }
function parseNpmRef(sourceRef) {
  const m = /^npm:(@?[^@]+(?:\/[^@]+)?)@([^@]+)$/.exec(sourceRef);
  return m ? { pkg: m[1], version: m[2] } : null;
}

// "node_modules/@bananapus/core-v6/src/JBController.sol" → "src/JBController.sol"
function pathWithinPackage(sourceName, pkg) {
  const prefix = `node_modules/${pkg}/`;
  return sourceName.startsWith(prefix) ? sourceName.slice(prefix.length) : null;
}

// ---------------------------------------------------------------------------
// Package-tree resolution (deployed version only — never the working tree)
// ---------------------------------------------------------------------------

function installedVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  } catch (e) {
    return null;
  }
}

const packageRootCache = new Map();

function cacheDirFor(pkg, version) {
  return path.join(CACHE_DIR, pkg.replace(/[/@]/g, "_") + "@" + version, "package");
}

// Fetch the published tarball for pkg@version into CACHE_DIR. Returns the
// extracted package root, or null when the fetch fails / is disallowed.
function fetchPackage(pkg, version) {
  if (OFFLINE) return null;
  const dest = cacheDirFor(pkg, version);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "juicescan-src-"));
  try {
    const out = execFileSync("npm", ["pack", `${pkg}@${version}`, "--silent", "--pack-destination", stage], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tgz = out.trim().split("\n").pop().trim();
    const tarball = path.isAbsolute(tgz) ? tgz : path.join(stage, tgz);
    execFileSync("tar", ["xzf", tarball, "-C", stage]);
    const extracted = path.join(stage, "package");
    if (!fs.existsSync(extracted)) return null;
    if (installedVersion(extracted) !== version) return null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(extracted, dest, { recursive: true });
    return dest;
  } catch (e) {
    return null;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// The source tree pkg@version was published from. Prefers deploy-all-v6's own
// node_modules when its installed version still matches the deployed pin (that
// directory IS what the artifact's `sourceName` points at), then a previously
// fetched tarball, then a fresh fetch. Never falls back to a submodule checkout.
function resolvePackageRoot(pkg, version) {
  const key = `${pkg}@${version}`;
  if (packageRootCache.has(key)) return packageRootCache.get(key);

  let root = null;
  const installed = path.join(DEPLOY_ALL_DIR, "node_modules", pkg);
  if (installedVersion(installed) === version) {
    root = { dir: installed, origin: "deploy-all node_modules" };
  }
  if (!root) {
    const cached = cacheDirFor(pkg, version);
    if (installedVersion(cached) === version) root = { dir: cached, origin: "cache" };
  }
  if (!root) {
    const fetched = fetchPackage(pkg, version);
    if (fetched) root = { dir: fetched, origin: "npm registry" };
  }

  packageRootCache.set(key, root);
  return root;
}

function githubUrlFromPackage(packageRoot) {
  let repository;
  try {
    repository = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
    ).repository;
  } catch (e) {
    return null;
  }
  const url = typeof repository === "string" ? repository : repository && repository.url;
  if (!url) return null;
  return url
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\.git$/, "");
}

// ---------------------------------------------------------------------------
// Permalink ref: the git commit whose blob for `relPath` is byte-identical to
// the deployed file. Best-effort — a null ref just means the GitHub link falls
// back to the repo's default branch.
// ---------------------------------------------------------------------------

const localRepoCache = new Map();

function localRepoFor(githubUrl) {
  if (!githubUrl) return null;
  if (localRepoCache.has(githubUrl)) return localRepoCache.get(githubUrl);
  let found = null;
  for (const entry of fs.readdirSync(REPOS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(REPOS_DIR, entry.name);
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    let remote;
    try {
      remote = execSync(`git -C "${dir}" config --get remote.origin.url`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (e) {
      continue;
    }
    const normalized = remote
      .replace(/^git\+/, "")
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "");
    if (normalized.toLowerCase() === githubUrl.toLowerCase()) {
      found = dir;
      break;
    }
  }
  localRepoCache.set(githubUrl, found);
  return found;
}

function resolveCommitForFile(githubUrl, relPath, absFile) {
  const repoDir = localRepoFor(githubUrl);
  if (!repoDir) return null;
  try {
    const blob = execSync(`git -C "${repoDir}" hash-object "${absFile}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commits = execSync(
      `git -C "${repoDir}" log --all --format=%H -- "${relPath}"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const commit of commits) {
      let candidate;
      try {
        candidate = execSync(`git -C "${repoDir}" rev-parse "${commit}:${relPath}"`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch (e) {
        continue;
      }
      if (candidate === blob) return commit;
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Solidity parsing (unchanged)
// ---------------------------------------------------------------------------

// Strip /* … */ block comments and // line comments, preserving line breaks.
// Preserves string literals so we don't accidentally remove tokens inside them.
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // String literal
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = src[i];
        out += ch;
        if (ch === "\\" && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
        if (ch === quote) { i++; break; }
        i++;
      }
      continue;
    }
    // Line comment
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    // Block comment — preserve newlines so line numbers stay correct
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 2; // skip closing */
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Find the offset of the opening brace of `contract <Name> { ... }`. Returns
// { startOffset (of "contract"), bodyOpen, bodyClose } or null.
function findContractBlock(stripped, contractName) {
  const re = new RegExp(`(?:^|\\s)((?:abstract\\s+)?contract\\s+${contractName}\\b)`, "g");
  const m = re.exec(stripped);
  if (!m) return null;
  const startOffset = m.index + (m[0].length - m[1].length);
  // Find first '{' after match
  let i = re.lastIndex;
  while (i < stripped.length && stripped[i] !== "{") i++;
  if (i >= stripped.length) return null;
  const bodyOpen = i;
  // Find matching close
  let depth = 1;
  i++;
  while (i < stripped.length && depth > 0) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { startOffset, bodyOpen, bodyClose: i - 1 };
}

// Within a stripped contract body, find every function definition and return
// { name, signatureTypes (string[]), startOffset, endOffset, headerOffset }.
function findFunctions(stripped, bodyOpen, bodyClose) {
  const fns = [];
  const re = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  re.lastIndex = bodyOpen + 1;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    if (m.index >= bodyClose) break;
    const name = m[1];
    const parenOpen = re.lastIndex - 1;
    // Find matching close paren
    let i = parenOpen;
    let depth = 0;
    while (i < bodyClose) {
      const c = stripped[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
      i++;
    }
    if (depth !== 0) { re.lastIndex = parenOpen + 1; continue; }
    const parenClose = i;
    const paramStr = stripped.slice(parenOpen + 1, parenClose);

    // Find body start: '{' before ';' (interfaces / abstract have ';')
    let j = parenClose + 1;
    let isAbstract = false;
    while (j < bodyClose) {
      const c = stripped[j];
      if (c === "{") break;
      if (c === ";") { isAbstract = true; break; }
      j++;
    }
    if (isAbstract || j >= bodyClose) {
      // Header line, no body — record range only for the signature
      fns.push({
        name,
        paramStr,
        signatureTypes: parseParamTypes(paramStr),
        headerOffset: m.index,
        bodyOpen: -1,
        endOffset: j,
        isAbstract: true,
      });
      re.lastIndex = j + 1;
      continue;
    }
    // Match braces
    let depth2 = 1;
    let k = j + 1;
    while (k < stripped.length && depth2 > 0) {
      const c = stripped[k];
      if (c === "{") depth2++;
      else if (c === "}") depth2--;
      k++;
    }
    if (depth2 !== 0) { re.lastIndex = j + 1; continue; }
    fns.push({
      name,
      paramStr,
      signatureTypes: parseParamTypes(paramStr),
      headerOffset: m.index,
      bodyOpen: j,
      endOffset: k - 1,
      isAbstract: false,
    });
    re.lastIndex = k;
  }
  return fns;
}

// Convert "address account, uint256 amount" → ["address", "uint256"].
// Handles tuples/structs at a shallow level: a parameter that looks like
// "Foo memory x" yields the type name "Foo" (we'll match by-name only since
// the ABI signature uses canonical tuple types like "(address,uint256)" which
// won't match struct names directly — fallback in canonicalize below).
function parseParamTypes(paramStr) {
  const trimmed = paramStr.trim();
  if (!trimmed) return [];
  // Split top-level commas only
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(trimmed.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(trimmed.slice(start).trim());
  return parts.map((p) => {
    if (!p) return "";
    // Remove storage location keywords + names. Keep the type token chain.
    const tokens = p.split(/\s+/);
    // Take leading type tokens (skip "memory", "calldata", "storage", and the
    // trailing identifier).
    const typeTokens = [];
    for (const t of tokens) {
      if (["memory", "calldata", "storage"].includes(t)) break;
      typeTokens.push(t);
    }
    // If no storage keyword, last token is the parameter name; drop it.
    if (typeTokens.length > 1) typeTokens.pop();
    return typeTokens.join(" ");
  });
}

function offsetToLine(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

function parseContract(raw, contractName) {
  const stripped = stripComments(raw);
  const block = findContractBlock(stripped, contractName);
  if (!block) return null;

  const fns = findFunctions(stripped, block.bodyOpen, block.bodyClose);
  const fnsByName = {};
  for (const fn of fns) {
    if (fn.isAbstract) continue; // skip declarations without bodies
    const entry = {
      name: fn.name,
      paramTypes: fn.signatureTypes,
      startLine: offsetToLine(raw, fn.headerOffset),
      endLine: offsetToLine(raw, fn.endOffset),
      source: raw.slice(fn.headerOffset, fn.endOffset + 1),
    };
    // Bucket by name to handle overloads
    if (!fnsByName[fn.name]) fnsByName[fn.name] = [];
    fnsByName[fn.name].push(entry);
  }
  return {
    startLine: offsetToLine(raw, block.startOffset),
    endLine: offsetToLine(raw, block.bodyClose),
    functionsByName: fnsByName,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function extractContract(contractName, ref, previous) {
  const npm = parseNpmRef(ref.sourceRef);
  if (!npm) {
    return { error: `source ref "${ref.sourceRef}" is not an npm pin` };
  }
  const relPath = pathWithinPackage(ref.sourceName, npm.pkg);
  if (!relPath) {
    return { error: `sourceName "${ref.sourceName}" is not inside ${npm.pkg}` };
  }

  const root = resolvePackageRoot(npm.pkg, npm.version);
  if (!root) {
    // The deployed tree is unavailable. Reuse the committed entry only when it
    // was itself extracted at this exact ref; otherwise emit nothing.
    const prior = previous[contractName];
    if (prior && prior.sourceRef === ref.sourceRef && prior.functionsByName) {
      return { entry: prior, origin: "committed (ref matches)" };
    }
    return {
      error: `cannot resolve ${npm.pkg}@${npm.version}` +
        (OFFLINE ? " (offline)" : " — `npm pack` failed"),
    };
  }

  const absFile = path.join(root.dir, relPath);
  if (!fs.existsSync(absFile)) {
    return { error: `${relPath} missing from ${npm.pkg}@${npm.version}` };
  }
  const raw = fs.readFileSync(absFile, "utf8");
  const parsed = parseContract(raw, contractName);
  if (!parsed) {
    return { error: `contract block not found in ${relPath} @ ${npm.pkg}@${npm.version}` };
  }

  const githubUrl = githubUrlFromPackage(root.dir) ||
    (previous[contractName] && previous[contractName].githubUrl) || null;

  return {
    origin: root.origin,
    entry: {
      repo: githubUrl ? githubUrl.split("/").pop() : npm.pkg,
      githubUrl,
      sourceRef: ref.sourceRef,
      ref: resolveCommitForFile(githubUrl, relPath, absFile),
      path: relPath,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      functionsByName: parsed.functionsByName,
    },
  };
}

function verify(deployments, current) {
  const problems = [];
  for (const contractName of MANIFEST) {
    const ref = deployedRefFor(deployments, contractName);
    const entry = current[contractName];
    if (ref.error) {
      if (entry) problems.push(`${contractName}: emitted but ${ref.error}`);
      continue;
    }
    if (!entry) {
      problems.push(`${contractName}: missing from ${path.basename(OUT_FILE)} (deployed at ${ref.sourceRef})`);
      continue;
    }
    if (entry.sourceRef !== ref.sourceRef) {
      problems.push(
        `${contractName}: pinned to "${entry.sourceRef}" but deployed at "${ref.sourceRef}"`
      );
    }
  }
  for (const contractName of Object.keys(current)) {
    if (!MANIFEST.includes(contractName)) {
      problems.push(`${contractName}: present in ${path.basename(OUT_FILE)} but not in the manifest`);
    }
  }
  return problems;
}

function main() {
  const deployments = loadDeployments();

  if (VERIFY) {
    console.log("extract-sources.js --verify");
    console.log("───────────────────────────");
    const current = loadPrevious();
    const problems = verify(deployments, current);
    if (problems.length) {
      console.error("");
      console.error("SOURCE PIN DRIFT — data/contract-sources.json no longer matches the deployments:");
      for (const p of problems) console.error(`  ✗ ${p}`);
      console.error("");
      console.error("Run `node build/extract-sources.js` (network access required for");
      console.error("newly pinned package versions) and commit the result.");
      process.exit(1);
    }
    console.log(`  ✓ ${MANIFEST.length} contracts pinned to their deployed source refs`);
    return;
  }

  console.log("extract-sources.js");
  console.log("──────────────────");
  const previous = loadPrevious();
  const all = {};
  const failures = [];
  const skipped = [];

  for (const contractName of MANIFEST) {
    const ref = deployedRefFor(deployments, contractName);
    if (ref.error) {
      // Nothing is deployed under this name, so nothing in the registry can
      // reference its source. Dropping it is not a source-integrity failure.
      skipped.push(`${contractName} — ${ref.error}`);
      continue;
    }
    const result = extractContract(contractName, ref, previous);
    if (result.error) {
      failures.push(`${contractName} @ ${ref.sourceRef} — ${result.error}`);
      continue;
    }
    all[contractName] = result.entry;
    const fnCount = Object.values(result.entry.functionsByName).reduce((a, b) => a + b.length, 0);
    console.log(
      `  ✓ ${contractName} — ${ref.sourceRef} (${fnCount} fns, via ${result.origin})`
    );
  }

  for (const s of skipped) console.log(`  · ${s} — skipped`);

  if (failures.length) {
    console.error("");
    console.error("REFUSING TO EMIT — these contracts could not be read at their deployed ref:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error("");
    console.error(`${OUT_FILE} was left unchanged. A wrong function body under a`);
    console.error("deployed signature is worse than no body, so nothing is written until every");
    console.error("contract resolves. Re-run with network access, or fix the deployment artifact.");
    process.exit(1);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2));
  const fnTotal = Object.values(all).reduce(
    (sum, c) => sum + Object.values(c.functionsByName).reduce((a, b) => a + b.length, 0),
    0
  );
  const unresolvedRefs = Object.values(all).filter((c) => !c.ref).length;
  console.log("");
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`Contracts: ${Object.keys(all).length}`);
  console.log(`Functions: ${fnTotal}`);
  if (unresolvedRefs) {
    console.log(`Permalink commits unresolved: ${unresolvedRefs} (links fall back to the default branch)`);
  }
  console.log(`Size:      ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);
}

main();
