# Releasing Gespenst

Gespenst publishes every public package at one lockstep version. Changesets records future release
notes and version changes; the release workflow publishes only archives that passed the complete CI
and packed-consumer browser suite.

## Normal releases

1. Add Changesets with user-facing changes as pull requests land.
2. Run `pnpm version-packages`, review the generated versions and changelogs, and commit them.
3. Run the local release checks from a clean checkout:

   ```sh
   pnpm install --frozen-lockfile
   pnpm verify:wasm
   pnpm lint
   pnpm typecheck
   pnpm test:coverage
   pnpm test:browser:compat
   pnpm build
   pnpm release:preflight -- --tag vX.Y.Z --require-main --require-clean
   pnpm release:pack
   pnpm test:pack -- --archives .release/npm
   ```

4. Push the release commit to `main`, create the matching `vX.Y.Z` tag, and push the tag.
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

The deployment root includes `apps/docs/public/_headers`, which sends
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. The live
demo runs a WASIX shell, so the page must be cross-origin isolated; without those headers the
bundled `coi-serviceworker` fallback reloads the page on first visit. Keep the file in step with the
`server` and `preview` headers in `apps/docs/vite.config.ts`.

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

## One-time v0.1.0 bootstrap

npm only allows trusted publishing to be configured for packages that already exist. Prepare
`v0.1.0` with the commands above, verify `.release/npm/SHA256SUMS`, and publish the archives in the
order recorded by `.release/npm/publish-plan.tsv` from a maintainer account protected by 2FA:

```sh
cd .release/npm
shasum -a 256 --check SHA256SUMS
while IFS=$'\t' read -r name version archive integrity; do
  npm publish "./${archive}" --access public --tag latest
done < publish-plan.tsv
```

After all packages exist, configure their trusted publishers, enable required approval on the
`npm` GitHub environment, and push `v0.1.0`. That tag run verifies registry integrity and performs no
duplicate publication. All subsequent releases publish through OIDC and include npm provenance.

Never move a published tag. A rerun skips a package only when the registry's integrity exactly
matches the prepared archive; any mismatch fails the release.
