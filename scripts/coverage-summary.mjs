import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const report = JSON.parse(
  await readFile(resolve(import.meta.dirname, '../coverage/coverage-summary.json'), 'utf8')
);
const total = report.total;

if (!total) throw new Error('Coverage report has no total summary');

console.log('## Test coverage\n');
console.log('| Metric | Covered | Total | Percent |');
console.log('| --- | ---: | ---: | ---: |');
for (const name of ['statements', 'branches', 'functions', 'lines']) {
  const metric = total[name];
  console.log(
    `| ${name[0].toUpperCase()}${name.slice(1)} | ${metric.covered} | ${metric.total} | ${metric.pct}% |`
  );
}
