import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEPLOY_ALL_COMMIT = '20883a7c7fcd58b6264f8375b6156a59ab9a2597';
const DEPLOY_ALL_SOURCE_DIGEST = 'sha256:443959a5a09616f4b73a0b4046e82674bab5e4e86287380d43642fa4aa898484';
const root = resolve(import.meta.dirname, '..');
const deploymentsDir = resolve(
  process.env.DEPLOY_ALL_DEPLOYMENTS_DIR || resolve(root, '..', '..', 'deploy-all-v6', 'deployments'),
);

if (!existsSync(deploymentsDir)) {
  throw new Error(`Pinned deploy-all-v6 deployments directory not found: ${deploymentsDir}`);
}

const require = createRequire(import.meta.url);
const { deploymentSourceDigest } = require('../build/sync-deployments.js');
const committedSnapshot = JSON.parse(readFileSync(resolve(root, 'data/deployments.json'), 'utf8'));
const actualDigest = deploymentSourceDigest(deploymentsDir);

const failures = [];
if (actualDigest !== DEPLOY_ALL_SOURCE_DIGEST) {
  failures.push(`pinned deploy-all-v6 contents: expected ${DEPLOY_ALL_SOURCE_DIGEST}, got ${actualDigest}`);
}
if (committedSnapshot.sourceDigest !== actualDigest) {
  failures.push(`website snapshot: expected ${actualDigest}, got ${committedSnapshot.sourceDigest || '(missing)'}`);
}

// A git checkout gives an additional identity check. Raw/copied deployment
// directories remain verifiable by content digest when no repository is present.
const deployAllRoot = dirname(deploymentsDir);
const gitHead = spawnSync('git', ['-C', deployAllRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (gitHead.status === 0 && gitHead.stdout.trim() !== DEPLOY_ALL_COMMIT) {
  failures.push(`deploy-all-v6 checkout: expected ${DEPLOY_ALL_COMMIT}, got ${gitHead.stdout.trim()}`);
}

if (failures.length) {
  console.error(`Deployment parity failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`Deployment parity: ${DEPLOY_ALL_COMMIT}`);
console.log(`Source digest: ${actualDigest}`);
console.log(`Snapshot: data/deployments.json (${Object.keys(committedSnapshot.deployments || {}).length} deployments)`);
