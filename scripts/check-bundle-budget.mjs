import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const budgets = {
  // Verified ENS-handle routing, the resumable two-transaction editor, indexer-independent authority lookup,
  // strict Safe/queue lifecycle checks, and authenticated Relayr payments add to the monolithic bundle
  // (3fcb1da: 1,209,174 B; handle review: 1,226,879 B; queue-bound handle verifier: 1,239,966 B;
  // persisted exact Relayr/Safe completion proof: 8,667,995 B raw / 1,246,408 B gzip;
  // EIP-7702 authority support + exact pending-Safe-call reuse: 8,684,397 B raw / 1,249,797 B gzip;
  // complete Permissions card — owner row, wildcard-scope grants, per-chain sets: 8,695,219 B raw;
  // amounts-first LP sizing — range solver + mode toggle in the add-liquidity modal: 8,700,528 B raw).
  'dist/app.js': { raw: 8_710_000, gzip: 1_260_000 },
  'dist/style.css': { raw: 243_000, gzip: 50_000 },
  'dist/index.html': { raw: 20_000, gzip: 5_000 },
  'dist/pdf.min.mjs': { raw: 470_000, gzip: 140_000 },
  'dist/pdf.worker.min.mjs': { raw: 1_350_000, gzip: 400_000 },
  'dist/jblogo.gif': { raw: 220_000, gzip: 205_000 },
};

const failures = [];
for (const [file, budget] of Object.entries(budgets)) {
  const raw = (await stat(file)).size;
  const gzip = gzipSync(await readFile(file), { level: 9 }).byteLength;
  console.log(`${file}: ${raw.toLocaleString()} B raw, ${gzip.toLocaleString()} B gzip`);
  if (raw > budget.raw) failures.push(`${file} raw ${raw} > ${budget.raw}`);
  if (gzip > budget.gzip) failures.push(`${file} gzip ${gzip} > ${budget.gzip}`);
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

const distributionFiles = await filesBelow('dist');
const totalGzip = (await Promise.all(distributionFiles.map(async file =>
  gzipSync(await readFile(file), { level: 9 }).byteLength
))).reduce((sum, size) => sum + size, 0);
const totalGzipBudget = 2_050_000;
if (totalGzip > totalGzipBudget) failures.push(`total distribution gzip ${totalGzip} > ${totalGzipBudget}`);
if (failures.length) {
  console.error(`Bundle budget exceeded:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Total distribution: ${totalGzip.toLocaleString()} B gzip (budget ${totalGzipBudget.toLocaleString()} B).`);
