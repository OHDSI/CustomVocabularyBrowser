# Implementation notes

These notes describe the current implementation. See [README.md](README.md) for
setup and user-facing documentation.

## Data-free distribution

`scripts/build-site.mjs` packages `browser/index.html`, CSS, JavaScript and font
assets into `dist`. It does not copy vocabulary tables or generated package JSON.
The Pages workflow checks for tracked package data, runs tests and builds this
application-only artifact. Source data is loaded at runtime, not downloaded by
the deployment workflow.

## Local processing and storage

### Local streaming imports and remembered vocabulary

- Local files are decoded incrementally in a module worker. **Cancel operation**
  remains available during validation. A failed local import keeps the open data.
- **Remember vocabulary on this device** is off by default. Turning it on asks
  for explicit consent to keep one unencrypted copy in this browser profile.
  It supports local folders and public GitHub sources, including prebuilt data.
- After consent, successful source loads remember their loaded packages and
  complete details. A new copy atomically replaces the previous copy. Nothing is
  uploaded or added to this repository. Cancelled or failed saves keep the old copy.
- Reloading or reopening the same app restores the remembered copy automatically,
  with no vocabulary network request or local-file permission. It is a snapshot:
  its date is shown, and **Load source** or choosing the folder again gets updates.
  An explicit URL for a different repository takes precedence over the saved copy.
- Unchecking asks for confirmation, removes this app's stored copy and consent,
  and leaves original files and the open dataset untouched. **Clear source** only
  clears the current view; uncheck remembering to prevent restoration next time.
- The checkbox is a storage preference, not proof that the current data was saved.
  Quota, cancellation, unsupported storage and corrupt-copy errors remain visible.
  Copies may be evicted or cleared; keep original files. Private browsing may not
  retain data. Use the same browser profile, scheme, hostname and port.
- IndexedDB and Web Locks are required. A tab cannot publish a copy after another
  tab turns remembering off. Older manually saved copies are not automatically
  opened until the user opts in to the new remembering behavior.

Snapshot writes use chunked mapping rows and an atomic active-generation pointer.
Web Locks coordinate readers, saves and cleanup across tabs. A failed save keeps
the previous complete generation. Successful saves retain one generation; orphaned
parts from an interrupted save are cleaned during the next save.

The existing ranked concept search and provenance/detail logic are preserved.
This integration does not replace them with the benchmark's mapping-search API.
Parsed tables and final artifacts still occupy memory. Snapshot reopen restores
the full dataset into memory; this is not an out-of-core search engine or a claim
of bounded total memory use.

## Additional mapping record visibility

Additional mapping records are currently hidden by
`SHOW_ADDITIONAL_MAPPING_RECORDS = false` in
`browser/js/ui/conceptDetails.js`. The display gate does not delete source
records. If this section is enabled again, review duplicate presentation and
update `tests/unit/additionalMappingVisibility.test.js` before release.

## Implementation references

- `browser/js/services/csvStream.js`: incremental CSV parsing.
- `browser/js/services/localPackageWorker.js`: local table parsing and artifact creation.
- `browser/js/services/localPackageWorkerClient.js`: worker lifecycle and cancellation.
- `browser/js/services/localSnapshotService.js`: browser storage and cross-tab locking.
- `browser/js/services/startupSource.js`: remembered-source restoration policy.
- `browser/js/main.js`: source activation, storage consent and operation feedback.

## Verification

Run the checks against the revision being reviewed rather than relying on a
historical test count:

```sh
npm test
npm run check:no-package-data
npm run preflight:publication
npm run build:site
```

Automated checks do not replace rendered-browser and accessibility testing.
Verify first-visit loading, local imports, cancellation, remembering, reopening,
opt-out and narrow-screen layout in supported browsers before release.
