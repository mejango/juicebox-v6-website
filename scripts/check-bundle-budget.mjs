import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const budgets = {
  // Stage-level 721 transfer controls and the reviewed owner-mint flow add a
  // small amount of deliberate wallet UI to the monolithic client bundle.
  'dist/app.js': { raw: 8_600_000, gzip: 1_210_000 },
  'dist/style.css': { raw: 240_000, gzip: 50_000 },
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
