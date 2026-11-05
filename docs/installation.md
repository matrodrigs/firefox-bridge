# Installation

Version **0.1.0** is awaiting Mozilla signing. The public release is withheld until its signed XPI is verified. The checkout workflow below supports development and temporary testing in the meantime.

## Requirements

- Firefox 142 or later.
- Node.js 22 or later.
- A client supporting local MCP `stdio` servers.
- Codex CLI for the Windows Codex installation helper.

Windows has direct host validation and Linux has Ubuntu CI coverage. macOS registration remains untested. Browser integration tests use an isolated Firefox profile.

## Prepare a checkout

```sh
git clone https://github.com/matrodrigs/firefox-bridge.git
cd firefox-bridge
npm ci
npm run build
npm run setup
```

Keep the checkout in a permanent location while the client uses it. After the signed release is published, its complete ZIP will include compiled bundles; users of that package can run `node scripts/setup.mjs` directly, or `setup.cmd` on Windows, without installing npm dependencies just to run the bridge.

Setup registers a native messaging host for the current user, restricted to the Firefox Bridge extension identifier. It uses your installed Node executable and project location. This is a one-time setup step; after installation, Firefox starts the host and the bridge reconnects automatically.

## Load the extension for development

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select `extension/manifest.json`.
3. Open **Firefox Bridge** from the toolbar, or use `Ctrl+Shift+Y` for its sidebar.
4. The extension connects automatically through the registered native host. There is no key to paste or manual reconnect step.
5. Enable access in the extension panel and review the site permissions.

The native host and MCP server manage their local transport credential internally. The credential is never shown in the panel. If the extension reports that the native host is unavailable, run setup from the permanent project folder and reload the extension.

The distributed configuration allows browsing on all HTTP/HTTPS sites. Choose the ask-per-site default if you prefer individual grants. Existing profile settings take precedence over the bundled default. Downloads, uploads, and debugging still require separate decisions.

Temporary installation lasts until Firefox restarts. Local packaging does not sign the extension. See Mozilla's [temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## Install the signed release

Once 0.1.0 is published, download the complete package and signed XPI from the project's GitHub release. Extract the package to a permanent folder and run setup. In Firefox, open `about:addons`, choose the gear menu, select **Install Add-on From File**, and choose the signed XPI. Then enable access in Firefox Bridge and connect an MCP client as described below.

Mozilla signing is required for permanent installation in standard Firefox, including extensions distributed through GitHub. A public AMO listing is optional; the self-distributed channel provides signing without a store listing. See Mozilla's [signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Connect a client

### Codex on Windows

Run `install-codex.cmd` from a checkout or complete release folder inside your Windows user profile. It registers the native host, stages the plugin in a sibling `firefox-bridge-plugin` folder, and registers it with the personal Codex marketplace. Keep both folders in place.

The helper preserves unrelated plugins and rejects a conflicting source already registered under the same name. If Codex CLI is outside `PATH`, set `CODEX_CLI_PATH` to its executable. After installation, select **Firefox Bridge** in Codex; open a new chat if the previous tool catalog is still loaded.

For a plain MCP registration instead of the plugin, run:

```powershell
codex mcp add firefox-bridge -- node "C:\path\to\firefox-bridge\dist\mcp.cjs"
```

Use one registration method to avoid duplicate tools. The plugin includes the same local server; it does not require an OpenAI API key. Client configuration follows [Codex MCP support](https://developers.openai.com/codex/mcp).

### Other MCP clients

Configure a local process using an absolute path:

```json
{
  "mcpServers": {
    "firefox-bridge": {
      "command": "node",
      "args": ["C:/path/to/firefox-bridge/dist/mcp.cjs"]
    }
  }
}
```

Use the corresponding absolute path on your operating system. The server reserves stdout for MCP messages. No hosted service, public endpoint, or tunnel is needed.

## Verify readiness

Ask your assistant:

> Run firefox_status, then firefox_list_tabs. Report whether the extension is connected and enabled and whether my target tab is visible.

An empty tab list can mean that no current tab has a permanent read grant. Review the panel's default and rules before assuming the connection failed. A one-operation grant enables the corresponding operation; it does not expose all tabs through discovery.

## Updates and removal

After updating source, run `npm ci`, `npm run build`, and `npm run setup`; rerun `install-codex.cmd` if using the plugin. Reload the extension in `about:debugging`. Extension, native host, and broker versions must match. Setup authenticates the existing local broker and stops it if it belongs to Firefox Bridge but has an incompatible version or protocol. The new native host then starts the matching broker automatically.

Run `npm run setup -- --remove`, `node scripts/setup.mjs --remove`, or `uninstall.cmd` on Windows to unregister the native host. Remove the extension through Firefox. Remove a Codex plugin with `codex plugin remove firefox-bridge@personal`, or a plain MCP entry with `codex mcp remove firefox-bridge`. Unregistering the native host does not remove unrelated client configuration or erase your saved policy. Profile storage and local runtime data are separate from the checkout; review [stored data](reference.md#configuration-and-stored-data) before deleting them.

## Native host registration

The host name is `io.github.matrodrigs.firefox_bridge`; its manifest allows only `firefox-bridge@matrodrigs`, the identifier declared in `extension/manifest.json`. Setup must be run from the matching product version.

| Platform | Registration location |
| --- | --- |
| Windows | `%LOCALAPPDATA%/FirefoxBridge/native-hosts/`, referenced by `HKCU\Software\Mozilla\NativeMessagingHosts\io.github.matrodrigs.firefox_bridge` |
| Linux | `~/.mozilla/native-messaging-hosts/` |
| macOS | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |

Setup writes a manifest and launcher referencing the current Node executable and built native host. If you move the checkout or change the Node installation, run setup again. Windows is tested directly and Linux in Ubuntu CI; macOS registration remains untested.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `FIREFOX_DISCONNECTED` | Keep Firefox running with the extension loaded. Run setup if the native host has not been registered. |
| Native host unavailable | Run `npm run setup` from the permanent checkout, then reload the extension. |
| `PAUSED` | Enable access in the panel. |
| `APPROVAL_REQUIRED` | Review the target origin and capability in the panel. Debug, uploads, and downloads are separate from browsing. |
| `SITE_BLOCKED` | Review the explicit block; the global allow default does not override it. |
| `BROWSER_PERMISSION_REQUIRED` | Enable the requested optional browser capability in the panel. |
| Another profile is connected | Close the other Firefox profile first. The broker accepts one active profile. |
| Version mismatch | Update/rebuild, rerun setup, and reload the matching extension. Setup replaces an authenticated incompatible Firefox Bridge broker automatically. |
| Expired element or screenshot | Read or capture again, then select the newly observed target. |
| `OUTCOME_UNKNOWN` | Inspect the page before retrying. The previous action may have completed. |
| `MODULE_NOT_FOUND` | Extract the complete ZIP, including `scripts/`, `src/`, `dist/`, and `extension/`; or rebuild the checkout. |

`npm run doctor` checks local prerequisites and connection readiness without changing browser permissions or generating credentials. A nonzero result before setup or before Firefox connects is expected. Include its non-secret output and a minimal reproduction when reporting a setup problem.
