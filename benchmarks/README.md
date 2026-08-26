# Benchmarks

Run the reproducible headless parse and render benchmark with:

```sh
pnpm bench:throughput
```

Set `GESPENST_MIN_MIB_S` in a controlled CI runner to turn the median throughput into a
regression budget. Do not compare results across different CPUs, browsers, or power modes.
