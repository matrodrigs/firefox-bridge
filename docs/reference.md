# Technical reference

## MCP tools

The server exposes 32 tools. The authoritative input schemas and descriptions are in [`src/contract.mjs`](../src/contract.mjs), and clients receive them through MCP tool discovery. Optional `frameId` selects a document within an authorized tab; omitted means the top document.

| Tool | Purpose |
| --- | --- |
| `firefox_status` | Connection, enabled state, and available capabilities |
| `firefox_request_access` | Submit an exact-origin permission request to the panel |
| `firefox_list_tabs` | List tabs with permanent read access |
| `firefox_open_tab` | Open an authorized HTTP/HTTPS URL |
| `firefox_navigate` | Navigate an authorized tab to an authorized destination |
| `firefox_read_page` | Read visible text and interactive elements with current references |
| `firefox_find` | Find observed controls by text, label, value, or role |
| `firefox_wait` | Wait for text or a semantic role to appear/disappear, returning a fresh observation |
| `firefox_click` | Click an observed element after checking its current state |
| `firefox_fill` | Fill a supported ordinary field or editable element |
| `firefox_select` | Select observed options in a native select |
| `firefox_key` | Send a supported key to an observed element |
| `firefox_scroll` | Scroll a document in CSS pixels |
| `firefox_screenshot` | Capture the authorized tab as PNG with a capture identifier |
| `firefox_point` | Click, double-click, hover, or context-click in a recent screenshot |
| `firefox_frames` | List accessible frames |
| `firefox_context` | Read the document URL, title, and text selection |
| `firefox_tab_action` | Activate, reload, pin, unpin, or close a tab |
| `firefox_tab_history` | Move backward or forward within tab history |
| `firefox_tab_group` | List, create, update, or ungroup authorized tabs |
| `firefox_release_tab` | Return a controlled tab to manual navigation |
| `firefox_bookmarks` | Search bookmarks or create one for an authorized URL |
| `firefox_history` | Search recent history, filtered to readable origins |
| `firefox_download` | Download a bounded file from a direct authorized URL |
| `firefox_downloads` | List, pause, resume, or cancel this session's bridge downloads |
| `firefox_upload` | Request files chosen by the user for an observed file input |
| `firefox_upload_status` | Read the upload request's state |
| `firefox_media` | Inspect HTML5 media/captions or play, pause, and seek |
| `firefox_network` | Start, read, clear, or stop a network metadata buffer |
| `firefox_console` | Start, read, clear, or stop page console/error collection |
| `firefox_inspect` | Inspect an element's geometry, computed styles, and accessibility signals |
| `firefox_performance` | Read document navigation, paint, and resource timings |

Authorized tabs are also exposed as MCP resources at `firefox://tab/<tabId>`. Reading a resource performs the same authorized page observation; the resource does not grant additional access or register a native `@Firefox` browser mention.

## Permissions

Rules apply to exact origins: scheme, host, and port. `https://example.com`, `http://example.com`, and `https://example.com:8443` are different origins.

| Panel control | Capabilities |
| --- | --- |
| **Browsing** | `read`, `interact`, `navigate`, `capture` |
| **Downloads** | `download` |
| **Uploads** | `upload` |
| **Debugging** | `debug` |

The global browsing default is `allow` in `extension/user-defaults.json`; access starts paused on a new profile. Saved settings override this default. A per-origin block takes precedence. Removing a rule returns to the global default; it does not necessarily block a site.

Panel decisions can allow a capability permanently, block it, ask again, or inherit the default. A one-operation grant expires after five minutes and is consumed by the matching operation. Continuous console and network sessions require permanent read and debug grants.

Bookmarks, history, downloads, and tab groups also require optional Firefox permissions enabled in the panel's browser capabilities section. Group operations require every member tab to be authorized. History search covers the last 30 days and returns at most 100 matching records.

## Observations and interactions

`firefox_read_page` returns bounded visible text, element metadata, `snapshotId`, and references. The default text limit is 20,000 characters; callers can request 1,000–50,000. At most 500 interactive elements are returned. Sensitive field values are omitted.

References belong to that document's latest observation. A new read replaces the earlier references; interaction tools invalidate them after acting. Removed, hidden, disabled, changed, or otherwise unfit targets are rejected. Unrelated page changes do not alone invalidate a referenced target. Read again after an action or a stale-observation error.

Observations traverse open shadow roots and include native/explicit roles, accessible labels, checked/readonly/disabled state, and viewport metadata. Clicks scroll the target into view, wait briefly for stable geometry, test multiple points for occlusion, and recheck after pointer handlers before activating the target. Filling uses native value setters and input events for framework compatibility; contenteditable text is inserted literally. Enter and Space activate supported native controls, and Tab advances focus; other supported keys dispatch synthetic events without promising native editing behavior.

`firefox_wait` requires `text`, `role`, or both; `state` is `present` by default or `absent`. Text matching is case-insensitive and matches visible text/element labels; role matching is exact. `timeoutMs` is bounded to 10,000. A successful wait returns a new snapshot and matching elements. It does not repeat actions while waiting, and navigation invalidates the wait.

Screenshots use image pixel coordinates. `firefox_point` converts them to viewport CSS coordinates and requires the associated `screenshotId`. A capture is valid for at most 60 seconds, for one coordinate operation, and only while its recorded document, mutation count, viewport, scroll position, and permissions remain valid. Coordinate tools do not automatically cross iframe boundaries.

Clicks and key actions are DOM events, not native operating-system input. Trusted-event checks, native dialogs, protected pages, and closed shadow roots remain outside this interface. Passwords, card details, and authentication codes require manual entry.

## Debugging

All inspection tools require read and debug access for the target document; frame origins are checked separately. Debug data is untrusted and may include site-provided text. Console text can contain sensitive information intentionally logged by the site. Debug data is returned to the MCP client but not copied into the operation audit log.

### Console

`firefox_console` accepts `start`, `read`, `clear`, or `stop`; optional `levels` filters `log`, `info`, `warn`, `error`, `debug`, `exception`, and `rejection`. `maxResults` is 1–200.

Collection uses fixed page-world instrumentation and begins only after `start`. It captures future messages in that document, not earlier messages, other frames, workers, browser-internal messages, or a DevTools history. Start separately for each required frame.

The buffer retains at most 200 entries, with text limited to 2,000 characters per entry. Values are summarized without walking object properties. The page can observe, replace, or falsify instrumentation; it is not an authenticated record of application behavior. Collection expires after 15 minutes. Navigation, tab release/closure, pausing, or loss of required permissions discards the session. Unrelated permission changes preserve authorized sessions. `clear` empties a running buffer; `stop` ends collection. At most 20 console sessions can be active.

### DOM inspection

`firefox_inspect` accepts either a current `snapshotId`/`ref` pair or a unique CSS `selector`. A selector is searched across the document and open shadow roots; zero or multiple matches are errors.

The response contains an allowlist of attributes and computed styles, geometry, and accessibility-related signals. It excludes input values and raw HTML and does not evaluate assistant-supplied JavaScript. These signals help diagnose a specific element; they are not a full accessibility audit or browser accessibility-tree export.

### Network

`firefox_network` accepts `start`, `read`, `clear`, or `stop`. Read filters include `type`, `statusMin`, and `errorsOnly`; `maxResults` is 1–300. Entries include request identity, method, resource type, status/error, timing, completion state, and cache information where available.

URLs omit query strings and fragments. Headers, cookies, request bodies, and response bodies are not collected. Each request origin needs read and debug access; allowing a page does not automatically authorize all third-party resource origins.

The buffer retains up to 300 entries and reports discarded entries. At most 20 network sessions can exist, each lasting 15 minutes. Same-origin navigation keeps capture active; cross-origin navigation, tab release/closure, pausing, or loss of required permissions ends it. Unrelated permission changes preserve authorized sessions. `clear` empties a running buffer.

This is session metadata observation through Firefox's web request API, not a full HAR export or packet capture. Events can arrive asynchronously after a page action completes; wait for the relevant request outcome before interpreting an empty or pending result. Requests from before capture started are not reconstructed.

### Performance

`firefox_performance` reads native Navigation, Paint, and Resource Timing entries, with at most 200 resource results. Resource entries are filtered to debug-authorized origins, and URLs omit query strings and fragments. Cross-origin timing restrictions can hide timing/size fields, and some APIs may be absent. No CPU profiler, heap snapshot, request interception, or debugger breakpoints are provided.

## File transfers

**Uploads:** up to 10 files and 5 MiB total per request. The agent identifies an observed file input; the user chooses files and confirms attachment in the panel. Confirmation authorizes that transfer. Existing upload blocks remain effective. Requests expire after five minutes. The source document and reference must still match. The site may upload a file immediately after attachment.

**Downloads:** direct HTTP/HTTPS GET, no redirects, up to 20 MiB. The filename must be a simple safe filename. A save dialog is shown unless explicitly disabled. Existing files are not overwritten; Firefox uniquifies conflicts. Only bridge-created downloads in the current extension session can be managed. The bridge does not execute downloaded files.

## Configuration and stored data

| Setting or location | Purpose |
| --- | --- |
| Registered Firefox native messaging host | Automatic extension connection; limited to the extension identifier |
| `127.0.0.1:39281` | Default local broker address used by Node processes |
| `FIREFOX_BRIDGE_DATA_DIR` | Override local runtime data directory |
| `FIREFOX_BRIDGE_PORT` | Override the Node broker port for isolated tests/custom environments |
| `CODEX_CLI_PATH` | Override the Codex executable used by Windows setup helpers |
| `FIREFOX_BINARY` | Select Firefox for development/integration tests |
| `%LOCALAPPDATA%/FirefoxBridge/connection-key` | Automatically managed local transport credential on Windows |
| `~/.local/share/FirefoxBridge/connection-key` | Fallback runtime location when `LOCALAPPDATA` is absent |
| Firefox extension local storage | Client identifier, access policy, and bounded audit history |

The native host and MCP process must use the same runtime directory and broker endpoint. Normal setup uses the defaults automatically. No key is exposed in the extension panel or exchanged manually; the internal local credential remains outside the repository.

The audit retains at most 200 operation records containing time, operation, origin, outcome, and error code. It excludes typed values, file contents, console messages, and full URLs. Page observations and screenshots can contain personal information and are sent to the connected MCP client when requested. The bridge has no telemetry service; how a client handles tool output depends on that client.

## Recovery

Errors are structured tool failures. Authorization or observation failures require a new decision/read; an ordinary retry does not grant access. `REQUEST_TIMEOUT` means a request expired before execution, including while queued. `REQUEST_CANCELLED` means its native connection closed while it was queued. `OUTCOME_UNKNOWN` means delivery occurred and the external effect may already exist.

`ACTION_OUTCOME_UNCERTAIN` reports a failed mutating injection or final verification: page handlers may already have produced effects. This conservative result can also cover a failure inside injected preconditions. Inspect state before repeating a mutating tool. `VERSION_MISMATCH` requires matching extension, broker, native host, and MCP client versions; restart an old client after updating.

See [troubleshooting](installation.md#troubleshooting) for setup errors and [the specification](spec.md) for the underlying contracts.
