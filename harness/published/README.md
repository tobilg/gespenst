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
Chromium runs the performance comparison in addition to functional scenarios.

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

Each implementation runs in a fresh same-origin iframe to isolate globals and terminal state:

- published native Gespenst with recommended defaults;
- published native Gespenst forced to main-thread Canvas2D;
- published `@gespenst/xterm` with recommended defaults;
- the latest published upstream `@xterm/xterm`.

The runner records cold and warm initialization, 64 KiB and 1 MiB ASCII/ANSI/Unicode writes,
resize and reflow, input callback throughput, production bundle sizes, and memory when the browser
exposes `measureUserAgentSpecificMemory()`. It takes three warm-up samples and ten reported samples
for repeated cases and reports median, p95, minimum, maximum, and raw observations.

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

The temporary consumer is removed by default. Pass `--keep` to print and preserve its path.
