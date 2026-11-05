# Behavioral specification

This document defines the behavior maintained by tests. [`src/contract.mjs`](../src/contract.mjs) is the input-schema source of truth; [the reference](reference.md) describes user-facing capabilities and limits.

## Authorization

1. A new profile begins paused. Resuming enables operations according to saved policy and the bundled browsing default; it does not grant debug or file-transfer access.
2. Only the trusted extension panel can change policy. MCP callers may request access but cannot approve it, alter the default, enable optional permissions, or retrieve local credentials.
3. Site identity is the exact HTTP/HTTPS origin. URLs with embedded credentials and non-HTTP(S) targets are rejected. Private tabs are excluded.
4. Explicit per-origin blocks override the global allow default and one-operation grants. Removing a rule restores inheritance.
5. An operation obtains a capability ticket, then revalidates policy and target state around asynchronous browser work. A policy version change invalidates tickets even when the resulting permission appears equivalent.
6. Frame operations require read access to the top document and the operation's capabilities for the frame. Unauthorized frame URLs are not exposed by discovery. A screenshot requires read and capture access for every frame.
7. Continuous debug capture requires permanent read and debug access. A one-operation grant may authorize one inspection, not ongoing observation.

## Managed tabs and navigation

Using a tab makes it controlled by the bridge. Document navigation requests in controlled tabs are checked against destination authorization, including redirects and subframes. Child tabs opened by controlled tabs inherit management. Navigation protection applies to documents; ordinary page subresource requests continue to work.

Releasing a tab returns its navigation to manual control and clears associated transient bridge state. Pausing stops agent work while retaining navigation protection on tabs that remain controlled. Releasing a tab does not remove its site permissions.

Navigation can occur between a browser API call and verification. Responses whose observation no longer matches the target are rejected. When an action has already produced an effect, a later verification failure cannot undo it; callers must inspect before repeating.

## Observation and action

Page readings are bounded and mark page content as untrusted. Secret input values are excluded. Interactive elements receive references tied to the current snapshot and their observed state; the client does not invent references or reuse a prior document's references.

Before a referenced interaction, verify that the document and snapshot match and the target remains connected, visible, enabled, and consistent with the observation. Pointer interactions must act on an available hit-tested target. Mutations invalidate references; the next action uses a fresh observation.

Coordinate actions require a recent, single-use screenshot record. Validate screenshot ownership, expiry, policy version, image bounds, document identity, mutation count, viewport size, and scroll offsets before translating image pixels into CSS pixels. A coordinate observation does not authorize interaction inside another frame.

Waits poll read-only observations for a bounded interval and return the latest snapshot. They do not replay a click or fill. Navigation and changed authorization terminate the wait rather than silently selecting a new document.

Synthetic pointer/keyboard events cannot acquire native trusted-event status. The implementation must report unsupported actions honestly rather than claiming success based solely on event dispatch. Callers verify the resulting page state.

After a mutating injection is dispatched, a rejected injection, missing result, page error, or failed final verification returns `ACTION_OUTCOME_UNCERTAIN`. This is conservative: a page handler may have produced effects before failing, even when the final click did not complete. Inspect before retrying. Pure preflight authorization failures and read-only queries retain their ordinary errors.

## Debug lifecycle

Console capture installs a fixed recorder in the selected page world, never arbitrary caller code. Page-world data is an untrusted observation: the page can detect or tamper with the recorder. Capturing one document does not imply capture of workers or other frames.

Console and network buffers have explicit entry/session limits and expiry. Loss of required permissions, pause, tab release, and closure clear associated debug state. Unrelated policy changes preserve sessions that remain authorized. Document navigation ends console collection. Network capture can survive same-origin navigation but ends on a different top-level origin.

Every read rechecks authorization. Network/performance entries from unauthorized origins are omitted. Network and timing URLs exclude query strings and fragments; collection does not include headers, cookies, or request/response bodies. Console text may itself contain site-provided sensitive data, which is disclosed in the tool guidance and requires an explicit debug grant.

DOM inspection returns an allowlist of properties rather than raw HTML, input values, or caller-selected arbitrary expressions. An ambiguous selector is an error. Debug output is never copied into the operation audit.

## File-transfer boundaries

An upload is bound to a document, observed file input, and expiring panel request. File selection and attachment confirmation happen in the panel. An agent-supplied path cannot select files. Recheck authorization and document identity before attachment, enforce the aggregate size/count bounds, and preserve explicit upload blocks.

A download is a bounded direct request to an authorized HTTP/HTTPS origin. Reject redirects and unsafe filenames; use Firefox's conflict handling rather than overwriting files. Download-management operations are limited to IDs created by this bridge session. The bridge never launches downloaded content.

## Local protocol and recovery

Firefox connects to a registered native messaging host restricted to the extension identifier. The host starts automatically and bridges the extension to the local broker; the user does not copy a key or reconnect manually.

The broker binds to loopback and authenticates requests with an automatically managed random 256-bit key. Validate the Host header, allowed origin, client identity, protocol version, and extension version. A running incompatible broker or extension fails explicitly; do not silently mix catalogs or protocols.

Each RPC is correlated with a unique request ID and can be delivered once. Bound queued work, body sizes, and request lifetimes. Expired/disconnected requests must not remain available for future execution. Late or unrelated extension responses must not resolve another client's operation.

The controller checks the deadline and native connection cancellation when a queued operation reaches execution. Disconnecting cancels queued operations from that port; already-running effects cannot be undone. Both MCP callers and native hosts must send matching protocol and release versions.

Timeout before delivery and uncertain outcome after delivery are distinct. No component automatically replays a mutating operation after delivery. Reconnection resumes the channel, not the previous action.

The local key file is runtime state and never belongs in an archive or repository. Profiles, logs, screenshots, downloaded fixtures, and test artifacts are excluded from release packages. The audit stores operational metadata rather than request payloads.

## Compatibility

The supported interface is a Firefox WebExtension paired with a local MCP server. It does not control browser chrome, private tabs, internal pages, native dialogs, or other desktop applications. It does not implement proprietary OpenAI browser protocols, register a native browser mention, or expose CDP. Local unsigned XPIs are submission/development candidates; public releases require a verified Mozilla-signed XPI.
