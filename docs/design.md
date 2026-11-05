# Interface design

The extension panel is a compact control surface for connection status, access, and pending decisions. It uses English throughout. Connection setup details belong in the installation guide; normal use requires no key field or reconnection form.

## Information order

1. Product identity and a plain-language connection status.
2. Access state with one primary enable/pause action.
3. Pending access and file requests, shown only when needed.
4. Controlled-tab count and release action, shown only when applicable.
5. Expandable site access, browser features, and recent activity.
6. Help and version information.

Keep exceptional setup assistance in the disconnected/error state. Routine connection is automatic. The retry control is a recovery option rather than a required step in normal use.

## Visual system

Use the system font and the semantic custom properties in `extension/panel.css`. Neutral ink and muted text establish hierarchy; the green accent identifies actions and successful connection. The access summary uses a subtle filled surface, while settings are separated with spacing and rules. Preserve corresponding light and dark colors when adding states.

The layout remains one column from a narrow popup/sidebar to the wider options page. Permission controls use two columns in narrow panels and four when there is room. Long origins wrap rather than being truncated; the full scheme, host, and port are relevant to the decision.

The local SVG mark is independent project artwork. It must remain legible at toolbar size and must not imply Mozilla or OpenAI endorsement.

## Interaction and accessibility

- Prefer native controls and expandable sections. Keep explicit labels for permission selectors and file inputs.
- Preserve visible keyboard focus and text status messages; color alone must not communicate connection, authorization, or failure.
- Keep polling from replacing a focused control or clearing a chosen file. Restore focus only when the same logical control remains active.
- Name actions by their effect. Removing a site rule restores the default, which can permit access; it does not always revoke it.
- Attribute access-request reasons to the requesting agent. Display the exact origin and requested capability beside the decision.
- File attachment confirms a transfer to a particular page. Preserve the file size limit and explain that the site can send a file immediately after attachment.

## Review

Check a narrow panel, wider options page, light and dark themes, long origins, empty states, pending requests, disconnected state, and keyboard navigation. Automated panel behavior tests do not establish full screen-reader or visual accessibility certification. Record only the manual and automated checks actually performed for a release.
