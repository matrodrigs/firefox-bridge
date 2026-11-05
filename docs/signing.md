# Signing and initial release

**0.1.0 is the initial release and remains unpublished until Mozilla signing is complete.** The public repository contains development source; GitHub release artifacts stay in a draft. The extension identity is `firefox-bridge@matrodrigs`, separate from the original local prototype.

## Prepare the submission

```sh
npm ci
npm run check
npm run test:firefox
npm run package
```

The packaging command creates:

| File | Purpose |
| --- | --- |
| `Firefox-Bridge-0.1.0-unsigned.xpi` | Upload to Mozilla for validation and signing |
| `Firefox-Bridge-0.1.0-source.zip` | Attach as source code for the review |
| `Firefox-Bridge-0.1.0-dev.zip` | Complete local development/test package; not the public signed release |
| `SHA256SUMS` | Checksums for these preparation artifacts |

The source ZIP includes [`AMO-REVIEW.md`](../AMO-REVIEW.md) with exact build instructions. Source submission is required because the extension scripts are bundled. [Mozilla source submission](https://extensionworkshop.com/documentation/publish/source-code-submission/).

## Submit to Mozilla

1. Open the [Add-on Developer Hub](https://addons.mozilla.org/developers/addon/submit/).
2. For downloads hosted on GitHub, choose self-distribution (unlisted, “On your own”). A public AMO listing is an alternative if you also want distribution through Mozilla's catalog.
3. Upload `Firefox-Bridge-0.1.0-unsigned.xpi`, then attach `Firefox-Bridge-0.1.0-source.zip` when asked for sources. Include the build instructions from `AMO-REVIEW.md` in reviewer notes.
4. Complete the disclosures and submission in your Mozilla account. Resolve any validation or review feedback, then download the signed XPI for this version.

Signing is performed by Mozilla; local packaging or the presence of a `META-INF` directory alone does not establish a valid signature. [Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Publish only after signing

- Confirm the returned extension has version `0.1.0` and ID `firefox-bridge@matrodrigs`.
- Install it in standard Firefox using a separate test profile and verify the signed installation, automatic native connection, and core workflow. Rerun setup for the new extension identity if replacing a prototype registration.
- Preserve the signed XPI bytes. Do not edit or rebuild that file after signing.
- Prepare the public package with the signed XPI and local runtime, update installation instructions to use the signed add-on, and generate new checksums from the final files.
- Replace development artifacts in the GitHub draft with the verified signed distribution, set the final changelog date, and publish `v0.1.0`.

Do not publish the unsigned XPI or development ZIP as the normal end-user release. If the source changes after submission, rebuild and submit the matching source and XPI again before publishing.
