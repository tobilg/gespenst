# Published-package harness

This fixture validates the packages npm users install, independently of workspace source aliases.
The root orchestrator copies this directory to a temporary consumer, writes exact registry
dependencies, installs them with lifecycle scripts disabled, and builds and runs the copied app.

## Commands

Run the complete desktop and mobile matrix against npm's `latest` tag:

```sh
pnpm test:published
```

Select a fixed version, one or more browser profiles, or preserve the isolated consumer for
inspection:

```sh
pnpm test:published -- --selector 0.1.1
pnpm test:published -- --browser chromium,firefox,mobile-webkit
pnpm test:published -- --keep
```

Available profiles are `chromium`, `firefox`, `webkit`, `mobile-chromium`, and `mobile-webkit`.
Automated published-package validation is deliberately functional-only; performance has its own
runner so package installation checks and noisy timing diagnostics cannot be mistaken for one
another.

Start the inspectable UI without Playwright automation:

```sh
pnpm published:dev -- --selector latest
```

Use `pnpm published:dev -- --host` to bind to the LAN for physical-device testing. The server
prints device URLs. It also exposes a real local PTY protected only by an unguessable run token and
same-origin checks, so use a trusted network and stop the process immediately afterward.

## Functional coverage

The harness checks:

- native core rendering, retained-buffer search, serialization, themes, web fonts, clipboard,
  links, geometry, fitting, scrolling, and mobile textarea input;
- the headless Node entry through a strict NodeNext consumer;
- direct BashKit streams and the stable browser-shell facade, including persistent working
  directory, pipelines, errors, seeded files, and mobile input;
- the WebSocket control protocol with a deterministic mock and an actual local PTY;
- the xterm-compatible API with the official Attach, Fit, Search, Serialize, and Web Links addons;
- React, Vue, and Svelte initialization, updates, callback stability, and disposal;
- Vite's emitted CSS and both default Ghostty WASM assets.

Every public package discovered from the workspace must map to a scenario. Adding a package without
adding coverage makes the harness fail before installation.

## Performance comparison

Run the reproducible browser benchmark separately:

```sh
pnpm bench:browser
pnpm bench:browser -- --profile ci
pnpm bench:browser -- --candidate npm:next --baseline npm:latest --browser chromium,firefox
```

The defaults compare workspace archives with exact packages resolved from npm's `latest` tag and
upstream `@xterm/xterm@6.0.0`. Both Gespenst inputs accept either `workspace` or
`npm:<version-or-tag>`. The runner builds isolated consumers and records the resolved package
versions, npm integrity or workspace archive hashes, git revision and dirty state, browser version,
CPU, OS, memory, sample profile, seed, and randomized implementation order.

Each implementation runs on a visible, fixed-size page in a fresh browser context:

- candidate native Gespenst with product defaults and forced main-thread Canvas2D;
- candidate `@gespenst/xterm`, with and without representative listeners and a parser hook;
- the selected published Gespenst baseline using native and xterm-compatible APIs;
- the selected upstream `@xterm/xterm`, with and without the same listener load.

The workloads cover fresh-context cold startup, warm initialization, 32 B through 16 KiB latency,
calibrated 1 MiB (`ci`) or 10 MiB (`full`) ASCII/ANSI/Unicode/redraw throughput, parser and callback
boundaries, rendering through the following animation frame, burst and paced 1 KiB/16 KiB streams,
single and batched resize, DOM text input, and real append-and-trim work with 1,000, 10,000, and (in
`full`) 100,000 retained rows. Candidate-only symbol hooks expose parse, render wait, render,
compatibility-delta, adapter, buffer-sync, and callback timings without adding a supported public
API. Published versions without those hooks still run through their public completion callbacks.

The page first validates that it is visible and samples animation-frame cadence. Results include
raw observations, p05/median/p95, mean, standard deviation, coefficient of variation, deterministic
bootstrap 95% confidence intervals for the median, tail values, and warnings for unstable or
timer-quantized samples. Where the browser supports it, reports also include long-task counts,
total duration, and longest duration per implementation. Normalized comparisons always use
“greater than 1 is faster” and retain the underlying samples. The `ci` profile is report-only:
infrastructure or correctness failures fail the job, but no performance value blocks a release.

These measurements are diagnostic, not universal rankings or CI gates. Browser scheduling,
renderer selection, GPU and driver state, fonts, thermals, and the different public completion
boundaries of each API affect results. Compare runs on the same machine and inspect raw samples
before drawing conclusions.

## Output

Automated results are written to `test-results/published/<timestamp>/`:

- `report.json` contains resolved versions, npm integrity values, assets, functional results, and
  benchmark samples;
- `summary.md` is the concise human-readable report;
- `<browser>.json` preserves each browser result;
- a screenshot and Playwright trace are retained for a failed browser profile.

Browser benchmark results are written independently to `test-results/benchmarks/<timestamp>/` as
`report.json`, `summary.md`, and long-form `samples.csv`. CI uploads that directory as an artifact
and appends the Markdown report to the job summary.

The temporary consumer is removed by default. Pass `--keep` to print and preserve its path.
