---
'@gespenst/shell': patch
---

Remove the discontinued `@gespenst/wasmer` package and simplify `@gespenst/shell` to a stable,
BashKit-only browser-shell facade. Browser-only shells no longer need alternate-runtime startup
probes, cross-origin isolation headers, or a service-worker bootstrap.
