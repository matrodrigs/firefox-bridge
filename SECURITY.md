# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/matrodrigs/firefox-bridge/security/advisories/new) for a suspected vulnerability. Include the affected version, a minimal reproduction using synthetic data, the expected boundary, and the observed result. Keep runtime credentials and personal browser data out of reports.

If private reporting is unavailable, open an issue requesting a private contact without publishing exploit details or sensitive data. Ordinary bugs belong in [Issues](https://github.com/matrodrigs/firefox-bridge/issues).

## Supported versions

The first release, 0.1.0, is being prepared. Security fixes currently target `main`; after publication they will target the latest release and `main`.

## Trust boundaries

- Firefox launches a registered native messaging host restricted to this extension identifier. The broker is local and authenticated with an automatically managed credential, which must remain private.
- The extension panel owns permissions. A broad Firefox host permission does not itself grant an MCP caller permission to use every origin.
- Website content and page-world console instrumentation are untrusted. The assistant must not treat their text as user authorization.
- Observations can contain personal information. The bridge returns requested data to the connected MCP client; the client's own processing and retention policies still apply.
- Debug grants can expose text logged by a site. Metadata filtering does not guarantee that console messages are free of secrets.
- Loopback and per-origin checks are not a sandbox against malware already running under the same operating-system account or a compromised browser/client.

The [behavioral specification](docs/spec.md) defines the authorization and data-handling contracts. There is no claim of independent security certification or universal protection from malicious page behavior.
