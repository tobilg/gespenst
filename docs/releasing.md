# Releasing Gespenst

Gespenst publishes every public package at one lockstep version. The repository-owned version tool
updates the private workspace root, every public package, and explicit internal dependency ranges.
The release workflow publishes only archives that passed the complete CI and packed-consumer
browser suite.

## Normal releases

1. Set the intended stable version and regenerate the lockfile:

   ```sh
   pnpm release:version -- X.Y.Z
   pnpm install
   ```

   Review the root and package manifest changes before continuing. The version command rejects tags,
   prereleases, and incomplete semantic versions; pass `0.1.1`, not `v0.1.1`.

2. Run the local release checks:

   ```sh
   pnpm install --frozen-lockfile
   pnpm verify:wasm
   pnpm lint
   pnpm typecheck
   pnpm test:coverage
   pnpm test:browser:compat
   pnpm build
   pnpm release:preflight -- --tag vX.Y.Z
   pnpm release:pack
   pnpm test:pack -- --archives .release/npm
   ```

3. Commit the version changes and push the release commit to `main`.
4. From that clean commit, run the strict preflight and push the matching tag:

   ```sh
   pnpm release:preflight -- --tag vX.Y.Z --require-main --require-clean
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. Approve the protected `npm` GitHub environment. The workflow verifies the tag and publishes the
   previously tested archives using npm trusted publishing.

The npm trusted publisher for every `@gespenst/*` package must identify GitHub repository
`tobilg/gespenst`, workflow `release.yml`, environment `npm`, and allow `npm publish`. The workflow
uses no long-lived npm token. It publishes with Node 24 and npm 11.5.1 or newer.

## Documentation site

`apps/docs` is deployed to Cloudflare Pages as a direct-upload project. CI uploads the built site as
the `docs-site-<tag>` artifact, and the `deploy-docs` job in `release.yml` publishes that exact
artifact after npm publication succeeds, so the site is never built a second time and can only go
live from a release that already passed the full suite.

The deployment root includes `apps/docs/public/_headers` with the site's security and cache policy.
The browser-only demo needs no server process, service-worker bootstrap, or cross-origin isolation.

### One-time setup

1. Create the project, whose name must match the `--project-name` in `release.yml`:

   ```sh
   pnpm dlx wrangler@4 pages project create gespenst-docs --production-branch=main
   ```

2. Create a Cloudflare API token with the **Cloudflare Pages: Edit** permission on the account.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets on a protected
   `cloudflare-pages` GitHub environment, alongside the existing `npm` environment.

The release job passes `--branch=main`, which Cloudflare treats as a production deployment because
it matches the project's production branch. Any other branch value would publish a preview URL
instead.

### Deploying by hand

```sh
pnpm build          # or: pnpm docs:build
pnpm docs:deploy
```

`docs:deploy` fetches Wrangler with `pnpm dlx` rather than adding it to the workspace, and uses the
locally authenticated Wrangler session.

The site is built for the root of its domain. Deploying it under a subpath instead requires
rebuilding with `DOCS_BASE_PATH`, for example `DOCS_BASE_PATH=/gespenst/ pnpm docs:build`, because
the base path is baked into the generated asset and page URLs.

## One-time package bootstrap

npm only allows trusted publishing to be configured for packages that already exist. Prepare
the intended release with the commands above, verify `.release/npm/SHA256SUMS`, and publish only the
new packages in dependency order from a maintainer account protected by 2FA. Local publication must
disable provenance because no supported CI identity exists:

```sh
cd .release/npm
shasum -a 256 --check SHA256SUMS
npm publish ./gespenst-new-package-X.Y.Z.tgz \
  --access public --tag latest --provenance=false --otp=<current-code>
```

After each package exists, configure its trusted publisher and enable required approval on the
`npm` GitHub environment before pushing the tag. The tag run verifies already-published packages,
publishes the remaining archives through OIDC, and includes npm provenance for those CI publications.

Never move a published tag. A rerun skips a package when either the raw archive integrity matches or
the decompressed tar content is identical. The latter handles npm's platform-specific gzip header
without weakening the package-content check; any actual content mismatch fails the release.

## Resuming a failed release

If quality checks produced verified artifacts but publication failed partway through, fix the
release workflow on `main` and resume the original artifacts instead of moving the tag or rebuilding
them. Supply the stable tag and the failed run ID:

```sh
gh workflow run release.yml \
  --ref main \
  -f release_tag=vX.Y.Z \
  -f source_run_id=<run-id>
```

The protected `npm` environment still requires approval. The recovery run downloads the original
npm and documentation artifacts, verifies every archive, skips packages whose contents already
exist, publishes the remainder through OIDC, and deploys the matching documentation artifact.
