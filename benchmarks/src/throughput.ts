import { performance } from 'node:perf_hooks';
import { createCoreRuntime } from '@gespenst/core/headless';

const row = `\x1b[38;2;80;180;130mbenchmark\x1b[0m ${'x'.repeat(96)}\r\n`;
const payload = new TextEncoder().encode(row.repeat(8_192));
const samples = 7;
const runtime = await createCoreRuntime();
const terminal = runtime.createTerminal({ cols: 120, rows: 40, scrollbackLines: 0 });

for (let index = 0; index < 2; index += 1) terminal.write(payload);
const results: number[] = [];
for (let index = 0; index < samples; index += 1) {
  const start = performance.now();
  terminal.write(payload);
  terminal.render();
  const duration = performance.now() - start;
  results.push(payload.byteLength / 1024 / 1024 / (duration / 1000));
}

results.sort((left, right) => left - right);
const median = results[Math.floor(results.length / 2)] ?? 0;
const minimum = Number(process.env.GESPENST_MIN_MIB_S ?? 0);
console.log(
  JSON.stringify(
    {
      benchmark: 'headless-parse-and-render',
      payloadBytes: payload.byteLength,
      samples,
      medianMiBPerSecond: Number(median.toFixed(2)),
    },
    null,
    2
  )
);

runtime.dispose();
if (minimum > 0 && median < minimum) {
  throw new Error(`Median throughput ${median.toFixed(2)} MiB/s is below ${minimum}`);
}
