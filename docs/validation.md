# Validation — 0.3.0

Local validation date: **2026-11-05**. Host: **Windows**, **Node.js 24.15.0**, **Firefox 159.0.1**. Tests ran in the intended Windows user environment, using isolated browser profiles and synthetic loopback pages.

## Source checks

The completed `npm run check` gate passed: build, syntax checks for 45 JavaScript modules, ESLint, Knip, and **87 tests**. Extension validation reported zero errors, warnings, or notices. The complete `npm run test:firefox` gate passed **39 checks** across five isolated Firefox workflows (9 core, 8 advanced, 8 MCP/native messaging, 8 interaction, 6 debugging).

The production dependency audit reported zero known vulnerabilities after updating compatible transitive dependencies. The full development tree still reports seven advisories in the ESLint/minimatch and web-ext/addons-linter/deepmerge chains (four moderate, three low). These tools process the local checkout during development; they are not bundled as runtime dependencies. Forced major-version downgrades proposed by npm were not applied. Recheck with `npm audit` when updating the toolchain.

## Browser verification

The local Firefox fixtures passed for:

- Page reading, sensitive-value omission, filling, clicking, PNG capture, access denial, redirect blocking, and revocation. The blocked destination received no requests in the core fixture.
- Frames, screenshot coordinates, panel-confirmed uploads, downloads inside the isolated test directory, native tab groups, network metadata, context, and HTML5 captions.
- The complete MCP → broker → native host → extension path, including tool/resource discovery and automatic reconnection after a broker restart. This path required no copied key or manual reconnect.
- Open shadow roots, actionability and overlay handling, native field setters, synthetic pointer/key behavior, and stale-target rejection.
- Console/errors, element inspection, performance entries, network timing, and debug authorization/lifecycle boundaries.

The panel was inspected at narrow and wide widths in light and dark themes, including long origins, pending requests, and connection errors. The reviewed layouts had no horizontal overflow. Behavioral tests cover control focus and file-selection preservation during refresh.

Raw local reports and screenshots are stored under `test-artifacts/firefox-bridge-validation/` and excluded from source/release packages. GitHub Actions results are separate evidence; this record does not assert a remote CI outcome.

## Limits

- Local browser verification covers the installed Firefox version and synthetic fixtures. It does not establish compatibility with every site or every supported Firefox release.
- Linux and macOS native-host registration branches require validation on those hosts.
- Synthetic input cannot satisfy every trusted-event requirement. The debug tools do not provide CDP, breakpoints, arbitrary evaluation, or complete DevTools parity.
- Visual checks and automated behavior tests do not establish full screen-reader or accessibility certification.
- Generated XPIs are unsigned. Packaging, lint, and local tests do not substitute for Mozilla signing or review.
- The tests do not claim that the extension is installed in the user's normal Firefox profile or that personal tabs were exercised.
