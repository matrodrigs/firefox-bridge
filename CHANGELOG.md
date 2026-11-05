# Changelog

## 0.3.0 — 2026-11-05

- Expand page interaction with open-shadow-root observation and stronger target/actionability checks.
- Add bounded console/error collection, DOM/style inspection, page performance metrics, and explicit waits.
- Add network timing and result filters while retaining per-origin authorization and metadata-only collection.
- Strengthen transport compatibility and request lifecycle handling.
- Connect automatically through a registered Firefox native messaging host, without copying pairing keys.
- Standardize code, UI, filenames, tests, and documentation in English.
- Simplify the panel with responsive light/dark layouts, a refined icon, and keyboard-safe live updates.
- Add ESLint and Knip to CI; remove obsolete manual pairing helpers and unused exports.
- Add local readiness diagnostics, shared quality checks, isolated browser regression coverage, and release checksums.
- Organize installation, workflows, reference, behavior, architecture, and agent guidance under a concise project README.

Generated XPIs remain unsigned. See [Contributing](CONTRIBUTING.md) for verification and packaging; platform and browser limitations are documented in the [reference](docs/reference.md).

## 0.2.1

Imported prototype baseline: local MCP bridge, origin permissions, page observations and basic synthetic interactions, tab/browser management, file-transfer approvals, and network metadata. Historical machine-specific validation and installation claims are not carried forward as evidence for 0.3.0.
