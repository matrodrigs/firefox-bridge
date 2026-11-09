# Installation

Firefox Bridge has two parts: the **Fox Bridge** extension and a local bridge that connects it to your MCP client. Install the bridge once; Firefox starts it automatically when needed.

## Requirements

- Firefox 142 or later.
- Node.js 22 or later.
- A client supporting local MCP `stdio` servers.
- Codex CLI for the Windows Codex installation helper.

Windows has direct host validation and Linux has Ubuntu CI coverage. macOS registration remains untested. Browser integration tests use an isolated Firefox profile.

## Install the extension

Install [Fox Bridge from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/fox-bridge/). Firefox handles extension updates automatically. You can also download the XPI from the [GitHub release](https://github.com/matrodrigs/firefox-bridge/releases/latest), open `about:addons`, choose the gear menu, then **Install Add-on From File**.

The extension cannot install the local bridge on your computer. Complete the following setup before connecting an assistant.

## Set up the local bridge

1. Download the [local bridge package](https://github.com/matrodrigs/firefox-bridge/releases/latest/download/Firefox-Bridge-0.1.0.zip) and extract it to a permanent folder inside your user profile.
2. On Windows, run `setup.cmd`. On Linux or macOS, run `node scripts/setup.mjs` from the extracted folder.
3. Open **Fox Bridge** in the Firefox toolbar, or use `Ctrl+Shift+Y` for its sidebar.
4. Enable access and review the site permissions.

The package includes compiled code; you do not need to clone the repository, build the project, or install npm dependencies. For Codex on Windows, `install-codex.cmd` combines bridge setup and client registration, so you can use it instead of `setup.cmd`.

Setup registers a native messaging host for the current user, restricted to the extension identifier. It uses your installed Node executable and the extracted folder. Keep that folder in place. The extension connects automatically and manages its local credential internally; there is no key to copy.

The distributed configuration allows browsing on all HTTP/HTTPS sites. Choose the ask-per-site default if you prefer individual grants. Existing profile settings take precedence over the bundled default. Downloads, uploads, and debugging still require separate decisions.

## Connect a client

### Codex on Windows

Run `install-codex.cmd` from the extracted bridge folder inside your Windows user profile. It registers the native host, stages the plugin in a sibling `firefox-bridge-plugin` folder, and registers it with the personal Codex marketplace. Keep both folders in place.

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

Keep the extension and local bridge on the same version. Extract the updated bridge package to its permanent folder and rerun setup, or `install-codex.cmd` if using the plugin. Update the extension through its add-on listing or install the matching XPI. Setup replaces an authenticated incompatible Firefox Bridge broker, and the new native host starts the matching broker automatically.

Run `uninstall.cmd` on Windows, or `node scripts/setup.mjs --remove`, to unregister the native host. Remove the extension through Firefox. Remove a Codex plugin with `codex plugin remove firefox-bridge@personal`, or a plain MCP entry with `codex mcp remove firefox-bridge`. Unregistering the native host does not remove unrelated client configuration or erase your saved policy. Profile storage and local runtime data are separate from the installation folder; review [stored data](reference.md#configuration-and-stored-data) before deleting them.

## Native host registration

The host name is `io.github.matrodrigs.firefox_bridge`; its manifest allows only `firefox-bridge@matrodrigs`, the identifier declared in `extension/manifest.json`. Setup must be run from the matching product version.

| Platform | Registration location |
| --- | --- |
| Windows | `%LOCALAPPDATA%/FirefoxBridge/native-hosts/`, referenced by `HKCU\Software\Mozilla\NativeMessagingHosts\io.github.matrodrigs.firefox_bridge` |
| Linux | `~/.mozilla/native-messaging-hosts/` |
| macOS | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |

Setup writes a manifest and launcher referencing the current Node executable and built native host. If you move the bridge folder or change the Node installation, run setup again. Windows is tested directly and Linux in Ubuntu CI; macOS registration remains untested.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `FIREFOX_DISCONNECTED` | Keep Firefox running with the extension loaded. Run setup if the native host has not been registered. |
| Native host unavailable | Run `setup.cmd` or `node scripts/setup.mjs` from the permanent bridge folder, then restart Firefox. |
| `PAUSED` | Enable access in the panel. |
| `APPROVAL_REQUIRED` | Review the target origin and capability in the panel. Debug, uploads, and downloads are separate from browsing. |
| `SITE_BLOCKED` | Review the explicit block; the global allow default does not override it. |
| `BROWSER_PERMISSION_REQUIRED` | Enable the requested optional browser capability in the panel. |
| Another profile is connected | Close the other Firefox profile first. The broker accepts one active profile. |
| Version mismatch | Update the bridge package and extension to the same version, then rerun setup. |
| Expired element or screenshot | Read or capture again, then select the newly observed target. |
| `OUTCOME_UNKNOWN` | Inspect the page before retrying. The previous action may have completed. |
| `MODULE_NOT_FOUND` | Extract the complete local bridge package and run setup from that folder. |

`node scripts/doctor.mjs` checks local prerequisites and connection readiness without changing browser permissions or generating credentials. A nonzero result before setup or before Firefox connects is expected. Include its non-secret output and a minimal reproduction when reporting a setup problem. For source builds and temporary development installs, see [Contributing](../CONTRIBUTING.md).
