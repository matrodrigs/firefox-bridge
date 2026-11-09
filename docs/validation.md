# Validation — 0.1.0

The local checks below cover the Fox Bridge 0.1.0 extension and the matching Firefox Bridge runtime package.

Latest local validation date: **2026-11-09**. Host: **Windows**, **Node.js 24.15.0**, **Firefox 159.0.1**. Tests ran in the intended Windows user environment, using isolated browser profiles and synthetic loopback pages.

## Recorded checks

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

Packaging generated the extension, local runtime, development and source archives, and checksums. A clean build from the source archive reproduced the XPI byte for byte. The runtime ZIP was extracted outside the repository and exercised without `node_modules`: its diagnostics ran and its MCP server exposed 32 tools. Seven panel previews were regenerated with the Fox Bridge name and retained their overflow checks.

Raw local reports and screenshots are stored under `test-artifacts/firefox-bridge-validation/` and excluded from packages. An [earlier CI run](https://github.com/matrodrigs/firefox-bridge/actions/runs/42014742753) passed on Windows and Ubuntu with Node 22/24 and ran Firefox integration workflows on Ubuntu. That run predates the extension name and runtime packaging changes tested locally here.

## Distribution verification

[Fox Bridge 0.1.0](https://addons.mozilla.org/firefox/addon/fox-bridge/) is publicly available on Firefox Add-ons. The downloaded XPI matched the SHA-256 published by the store: `c3555d14884a12d244335369e39f8f8bccbf3c63bafd49da2287745fad52ce67`. Its application files match the local build; only the manifest's JSON formatting differs.

Eight additional checks passed in a fresh profile of standard Firefox with signature enforcement enabled. Firefox rejected the unsigned package, permanently installed the approved XPI, and recorded it as active and signed. The unmodified extension connected through native messaging, exposed 32 MCP tools, and answered status requests both before and after restarting Firefox. The profile started paused as intended. The test used an isolated runtime directory and port; it did not change the user's Firefox profile or native-host registration.

Release packaging preserves the approved XPI unchanged and publishes checksums for that file, the local runtime, and the source archive. Distribution test reports are stored under `test-artifacts/release-validation/` and excluded from packages.

## Limits

- Local browser verification covers the installed Firefox version and synthetic fixtures. It does not establish compatibility with every site or every supported Firefox release.
- Linux native-host registration and reconnection passed in the Ubuntu CI fixture. macOS registration remains untested.
- Synthetic input cannot satisfy every trusted-event requirement. The debug tools do not provide CDP, breakpoints, arbitrary evaluation, or complete DevTools parity.
- Visual checks and automated behavior tests do not establish full screen-reader or accessibility certification.
- Permanent signed installation and restart recovery were verified in an isolated Windows profile. Other operating systems and existing user profiles were not covered by that installation check.
- The tests do not claim that the extension is installed in the user's normal Firefox profile or that personal tabs were exercised.
