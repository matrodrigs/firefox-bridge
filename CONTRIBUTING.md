# Contributing

## Setup and quality gate

Use Node.js 22 or later and Firefox 142 or later. Prepare a development checkout:

```sh
git clone https://github.com/matrodrigs/firefox-bridge.git
cd firefox-bridge
npm ci
npm run build
npm run setup
```

In Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extension/manifest.json`. Open the extension panel and enable access. Temporary installation lasts until Firefox restarts; reload the extension after rebuilding it. Connect your client using the [installation guide](docs/installation.md#connect-a-client).

Run the quality gates before submitting changes:

```sh
npm run check
npm run test:firefox
```

`check` builds the bundles, checks JavaScript syntax, runs ESLint and Knip, runs behavioral unit tests, and runs `web-ext lint` with warnings treated as errors. `test:firefox` runs real-browser fixtures and a complete MCP-to-extension path. These are separate gates so a missing browser is distinguishable from a failed unit check.

Use `FIREFOX_BINARY` to select an installed Firefox executable. Tests use temporary profiles, synthetic pages served on loopback, and their own runtime state. Reports and logs go to `test-artifacts/firefox-bridge-validation/`. Never point fixtures at a personal profile or real account data. The [validation record](docs/validation.md) states the environment and limits of the release checks.

For a focused iteration, run the relevant Node test file with `node --test test/<name>.test.mjs`, then complete the shared gates before submitting behavior changes. Record unavailable tests and the actual host/runtime versions rather than inferring compatibility from another environment.

## Scope and design

Use Conventional Commits for commit subjects: `type(scope): description`, or `type: description` when no scope is needed. For example, `fix(panel): preserve focus during refresh`.

Keep changes tied to a concrete browser workflow or failure. Prefer explicit module dependencies and ordinary JavaScript over generic plugin systems or speculative abstractions. Public arguments live in `src/contract.mjs`; preserve its validation at all request boundaries.

Read [the specification](docs/spec.md) when touching permissions, observations, navigation, debugging, transport, or files. Add regression tests for the behavior changed, including denial/cleanup paths where applicable. Tests should verify outcomes and boundaries rather than mirror implementation statements.

Edit source modules and source assets, then rebuild generated bundles. Preserve the distinction between synthetic DOM events and trusted/native browser actions in code and documentation. Keep the [README](README.md) concise; put detailed changes in the relevant guide under `docs/`.

Code, filenames, UI, tests, and documentation use English. Use native controls, full readable origins, visible keyboard focus, and the established light/dark color roles. Keep permission decisions close to their target site. See [interface design](docs/design.md) for current UI conventions.

## Diagnostics

`npm run doctor` checks local runtime readiness without generating a credential or changing settings. A nonzero exit before setup or before the extension is connected is expected. Share redacted output, tool error code, reproduction steps, Firefox version, and whether the issue also happens on a synthetic local page.

Keep runtime credentials, private URLs, page contents, screenshots, console output, and profiles out of public reports unless deliberately sanitized. For a vulnerability, follow [Security](SECURITY.md).

## Build and packaging

1. Update the version metadata together in `package.json`, the lockfile, `plugin.json`, `extension/manifest.json`, and `src/version.mjs`. Bump the internal protocol version for incompatible transport changes.
2. Run both quality gates on the intended host. Record actual results; older reports do not establish validation for a new build.
3. Review `CHANGELOG.md`, installation instructions, tool catalog, and limitations against the implementation.
4. Run `npm run package`. Inspect the generated extension and local bridge archives, source archive, and checksums under `artifacts/`.
5. Inspect the archive inventory for local paths, runtime keys, profiles, debug captures, logs, test fixtures, and unexpected generated files. Source test scripts may be included; test run data must not be.
6. Extract the source archive into a fresh directory, run `npm ci` and `npm run build`, and compare the rebuilt extension files with the packaged files.

When updating a development checkout, run `npm ci`, `npm run build`, and `npm run setup`; rerun `install-codex.cmd` if using the plugin. Extension and runtime versions must match.
