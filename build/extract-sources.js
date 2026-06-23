#!/usr/bin/env node
/**
 * extract-sources.js — Parse Solidity source files and extract per-function
 * bodies + line numbers, keyed by contract.functionName(signature). Output
 * goes to data/contract-sources.json and is consumed by generate-registry.js.
 *
 * Usage:
 *   node build/extract-sources.js
 *
 * Output: data/contract-sources.json
 * {
 *   "<ContractName>": {
 *     "repo": "nana-core-v6",
 *     "githubUrl": "https://github.com/Bananapus/nana-core-v6",
 *     "branch": "main",
 *     "path": "src/JBController.sol",
 *     "startLine": 23,
 *     "endLine": 1186,
 *     "functions": {
 *       "launchProjectFor(address,string,(...)[],(...)[],string)": {
 *         "name": "launchProjectFor",
 *         "startLine": 145,
 *         "endLine": 192,
 *         "source": "function launchProjectFor(...) external returns (...) {\n  ...\n}"
 *       }
 *     }
 *   }
 * }
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPOS_DIR = path.resolve(ROOT, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(DATA_DIR, "contract-sources.json");

// repo → [contract names] (mirrors build/extract-abis.sh manifest)
const MANIFEST = {
  "nana-core-v6": [
    "JBMultiTerminal", "JBController", "JBDirectory", "JBTerminalStore",
    "JBTokens", "JBRulesets", "JBSplits", "JBPermissions", "JBPrices",
    "JBProjects", "JBFundAccessLimits", "JBERC20", "JBFeelessAddresses",
    "JBDeadline1Day", "JBDeadline3Days", "JBDeadline3Hours", "JBDeadline7Days",
  ],
  "nana-721-hook-v6": [
    "JB721TiersHook", "JB721TiersHookStore", "JB721TiersHookDeployer",
    "JB721TiersHookProjectDeployer",
  ],
  "nana-buyback-hook-v6": ["JBBuybackHookRegistry"],
  "nana-suckers-v6": [
    "JBSuckerRegistry", "JBOptimismSucker", "JBArbitrumSucker",
    "JBCCIPSucker", "JBBaseSucker",
  ],
  "nana-omnichain-deployers-v6": ["JBOmnichainDeployer"],
  "nana-distributor-v6": ["JBTokenDistributor", "JB721Distributor"],
  "nana-project-payer-v6": ["JBProjectPayer", "JBProjectPayerDeployer"],
  "nana-router-terminal-v6": [
    "JBRouterTerminal", "JBRouterTerminalRegistry", "JBPayRouteResolver",
  ],
  "nana-project-handles-v6": ["JBProjectHandles"],
  "nana-address-registry-v6": ["JBAddressRegistry"],
  "nana-fee-project-deployer-v6": ["FeeProjectConfigBuilder"],
  "revnet-core-v6": ["REVDeployer", "REVLoans"],
  "croptop-core-v6": ["CTDeployer", "CTPublisher", "CTProjectOwner"],
  "defifa": ["DefifaDeployer", "DefifaHook", "DefifaGovernor"],
  "banny-retail-v6": ["Banny721TokenUriResolver"],
  "univ4-lp-split-hook-v6": [
    "JBUniswapV4LPSplitHook", "JBUniswapV4LPSplitHookDeployer",
  ],
  "univ4-router-v6": ["JBUniswapV4Hook"],
};

function getRepoGithubUrl(repo) {
  try {
    const url = execSync(
      `git -C "${path.join(REPOS_DIR, repo)}" config --get remote.origin.url`,
      { encoding: "utf8" }
    ).trim();
    return url.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  } catch (e) {
    return null;
  }
}

function getRepoBranch(repo) {
  try {
    return execSync(
      `git -C "${path.join(REPOS_DIR, repo)}" symbolic-ref --short HEAD`,
      { encoding: "utf8" }
    ).trim();
  } catch (e) {
    return "main";
  }
}

// Walk repo's source dirs to find a .sol file defining the given contract.
function findContractFile(repo, contractName) {
  const candidates = ["src", "contracts", "test"];

  function walk(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = walk(p);
        if (found) return found;
      } else if (e.isFile() && e.name.endsWith(".sol")) {
        const content = fs.readFileSync(p, "utf8");
        const re = new RegExp(`(?:^|\\s)(?:abstract\\s+)?contract\\s+${contractName}\\b`);
        if (re.test(content)) return p;
      }
    }
    return null;
  }

  for (const sub of candidates) {
    const found = walk(path.join(REPOS_DIR, repo, sub));
    if (found) return found;
  }
  return null;
}

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

function extractRepo(repo, contracts) {
  const githubUrl = getRepoGithubUrl(repo);
  const branch = getRepoBranch(repo);
  const result = {};

  for (const contractName of contracts) {
    const filepath = findContractFile(repo, contractName);
    if (!filepath) {
      console.warn(`  ✗ ${contractName} — source not found in ${repo}`);
      continue;
    }
    const relPath = path.relative(path.join(REPOS_DIR, repo), filepath);
    const raw = fs.readFileSync(filepath, "utf8");
    const stripped = stripComments(raw);

    const block = findContractBlock(stripped, contractName);
    if (!block) {
      console.warn(`  ✗ ${contractName} — could not find contract block in ${relPath}`);
      continue;
    }

    const fns = findFunctions(stripped, block.bodyOpen, block.bodyClose);
    const functions = {};
    const fnsByName = {};

    for (const fn of fns) {
      if (fn.isAbstract) continue; // skip declarations without bodies
      const startLine = offsetToLine(raw, fn.headerOffset);
      const endLine = offsetToLine(raw, fn.endOffset);
      const source = raw.slice(fn.headerOffset, fn.endOffset + 1);
      const entry = {
        name: fn.name,
        paramTypes: fn.signatureTypes,
        startLine,
        endLine,
        source,
      };
      // Bucket by name to handle overloads
      if (!fnsByName[fn.name]) fnsByName[fn.name] = [];
      fnsByName[fn.name].push(entry);
    }

    result[contractName] = {
      repo,
      githubUrl,
      branch,
      path: relPath,
      startLine: offsetToLine(raw, block.startOffset),
      endLine: offsetToLine(raw, block.bodyClose),
      functionsByName: fnsByName,
    };

    const fnCount = Object.values(fnsByName).reduce((a, b) => a + b.length, 0);
    console.log(`  ✓ ${contractName} — ${relPath} (${fnCount} fns)`);
  }

  return result;
}

function main() {
  console.log("extract-sources.js");
  console.log("──────────────────");
  const all = {};
  for (const [repo, contracts] of Object.entries(MANIFEST)) {
    console.log(`── ${repo} ──`);
    Object.assign(all, extractRepo(repo, contracts));
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2));
  const fnTotal = Object.values(all).reduce(
    (sum, c) => sum + Object.values(c.functionsByName).reduce((a, b) => a + b.length, 0),
    0
  );
  console.log("");
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`Contracts: ${Object.keys(all).length}`);
  console.log(`Functions: ${fnTotal}`);
  console.log(`Size:      ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);
}

main();
