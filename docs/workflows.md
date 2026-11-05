# Workflows and examples

## Read, act, verify

Start with `firefox_status` and `firefox_list_tabs`. Select the intended tab, then call `firefox_read_page` to obtain text, elements, `snapshotId`, and element references. Use those references for interactions and read again to verify the outcome.

```text
Use Firefox Bridge on my existing task board tab. Read the page, find the
search field, enter "release", and summarize the results.
```

Give the assistant an explicit intended action when a click sends a message, submits a form, or changes external data. Page text is evidence about the interface, not permission to perform actions. For a loading state, use `firefox_wait` for visible text or a semantic role instead of retrying a click.

For frames, call `firefox_frames`, then pass the observed `frameId` to page tools. Frame access is checked independently. Open shadow roots are traversed by page observation; closed roots are outside this interface.

## Click and recover

Prefer an element reference for a named control. Clicks check that the observed target still exists and is actionable. If a modal, overlay, or layout change blocks the target, inspect the page and resolve that state before retrying.

For a visible control without a useful reference, capture the page with `firefox_screenshot`, then use `firefox_point` with the returned `screenshotId` and coordinates in the image. The capture is single-use and short-lived; a scroll, mutation, resize, navigation, or permission change can invalidate it.

```text
Read the current tab and click the button labeled "Load more" once.
Check that more results appeared. If the button is covered or the page
changed, explain the current state before trying again.
```

After a timeout or `OUTCOME_UNKNOWN`, inspect the resulting page. Repeating a delivered click can duplicate its effect.

## Diagnose a page issue

Grant debug access for the exact site in the extension panel. Debugging also requires read access. This is separate from the default browsing permission.

```text
Investigate why Save does not work on this tab. Inspect the observed Save
button, start console and network collection, click Save once, and report
the errors and failed requests. Stop collection when finished.
```

Use the tools together:

1. `firefox_read_page` identifies the affected element.
2. `firefox_inspect` examines its DOM, computed style, geometry, and accessibility-related properties using the current reference.
3. `firefox_console` starts collection in the selected document. Reproduce the issue, read the bounded buffer, then stop collection.
4. `firefox_network` records request metadata. Start before reproducing, inspect status and timing, then stop.
5. `firefox_performance` reads the current document's navigation, paint, and available resource timings.

Console collection starts at the request, not at page load. Start a separate collection for a frame when needed. Navigation replaces the document and ends its console session; start again on the new document. Page code can alter console instrumentation, so treat recorded content as untrusted observations rather than an authoritative DevTools transcript.

## Examine layout and performance

```text
Inspect the search field and its computed styles. Explain whether it is
hidden, disabled, covered, or outside the viewport. Then report navigation
timing and the slowest visible resource timing entries for this page.
```

Resource timing is limited to information exposed by the browser and authorized origins. Missing transfer sizes or timings can result from cache behavior or cross-origin timing restrictions. The bridge does not attach a debugger, set breakpoints, or execute arbitrary JavaScript supplied by the assistant.

## Upload a file

```text
Find the attachment field on this page and request an upload. I will choose
the document in the Firefox Bridge panel.
```

`firefox_upload` creates a request tied to the observed file input. Choose files and confirm attachment in the panel. `firefox_upload_status` reports the result. The agent does not supply a filesystem path; the site may send the files as soon as they are attached.

## Download a file

```text
Download the report from this direct URL as report.csv and show the save
dialog. Check whether the bridge's download completed.
```

Downloads require both the origin's download grant and Firefox's optional `downloads` permission. `firefox_downloads` can manage only downloads created by the bridge in the current session. URLs that redirect or exceed the documented size limit are rejected.

## Return to manual browsing

Use `firefox_release_tab` or release all controlled tabs in the panel when finished. Released tabs return to manual navigation. Pausing stops agent operations while retaining navigation protection on tabs still controlled by the bridge.
