# [Custom Vocabulary Browser](https://p-talapova.github.io/CustomVocabularyBrowser/)

Custom Vocabulary Browser is a static web application for finding and reviewing
OMOP-compatible concepts maintained outside the standard Athena distribution.
It can search a built-in vocabulary snapshot, a compatible public GitHub
repository, or CSV files selected from the user's computer.

The browser supports concept ID, code, name, and synonym search; OMOP filters;
concept provenance; incoming and outgoing relationships; and hierarchy data
when a package supplies a usable ancestor table. It runs entirely as a static
site and does not require an application server or database.

> [!IMPORTANT]
> This project is a review candidate. It is not currently an official OHDSI
> service and its presence in this repository does not imply OHDSI endorsement.
> If it passes technical, governance, security, and licensing review, it is
> intended to be proposed for inclusion in, or linkage from, the appropriate
> OHDSI repository as a separately testable component.

## Contents

- [What is a custom vocabulary?](#what-is-a-custom-vocabulary)
- [Features](#features)
- [Using the browser](#using-the-browser)
- [Supported source formats](#supported-source-formats)
- [Vocabulary package structure](#vocabulary-package-structure)
- [CSV requirements](#csv-requirements)
- [Search and filters](#search-and-filters)
- [Run locally](#run-locally)
- [Build and validate browser data](#build-and-validate-browser-data)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Privacy and security](#privacy-and-security)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Proposed OHDSI integration](#proposed-ohdsi-integration)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## What is a custom vocabulary?

The OMOP Common Data Model represents clinical meaning through concepts. A
concept has an identifier, name, source code, domain, concept class, vocabulary,
validity period, and standardization status. Relationships connect concepts to
each other, while synonyms make the same concept discoverable through alternate
names.

A custom vocabulary is an organization-maintained set of OMOP-compatible
concepts that is not distributed as part of the standard vocabulary release
used by Athena. A custom vocabulary can be useful when a project needs to
represent:

- local instruments, forms, or operational codes;
- research-specific measurements or observations;
- concepts from a source system that has no complete standard representation;
- provisional mappings that still require vocabulary review;
- extensions being prepared for wider community adoption.

Custom concepts should follow OMOP conventions and should be reviewed before
production use. This browser helps users inspect a custom package; it does not
approve concepts, assign governance, or make a vocabulary standard.

A **package ID** is the name of a folder discovered by this application. It is
not the same thing as the OMOP `vocabulary_id` stored on each concept. One
package may contain concepts from more than one `vocabulary_id`.

Useful background:

- [OHDSI](https://www.ohdsi.org/)
- [Athena vocabulary browser](https://athena.ohdsi.org/)
- [OMOP Common Data Model](https://ohdsi.github.io/CommonDataModel/)
- [OMOP CDM 5.4 tables](https://ohdsi.github.io/CommonDataModel/cdm54.html)
- [OHDSI Vocabulary repository](https://github.com/OHDSI/Vocabulary-v5.0)

## Features

- Searches exact concept IDs, concept codes, names, and synonyms.
- Supports normalized prefix, token, and bounded fuzzy matching for names and
  synonyms.
- Uses deterministic ranking and pagination.
- Filters by vocabulary, domain, concept class, standard concept status, and
  validity.
- Displays concept source provenance and authoritative OMOP fields.
- Displays synonyms and both incoming and outgoing relationships.
- Retains unresolved relationship endpoint IDs and labels them as external.
- Displays hierarchy navigation when usable `concept_ancestor_delta.csv` data
  are available.
- Discovers compatible vocabulary packages dynamically.
- Accepts a compatible public GitHub repository and ref.
- Accepts a user-selected local folder without uploading its files.
- Keeps incomplete packages visible with an explanation of missing data.
- Preserves search, filter, paging, sorting, and selected-concept state in the
  browser URL.
- Uses only local application scripts, styles, and fonts at runtime.

## Using the browser

### 1. Select a source

The source panel offers three choices:

1. **Use default** loads the vocabulary snapshot bundled with the browser.
2. **Load source** loads a compatible public GitHub repository.
3. **Choose local folder** reads compatible CSV files selected from the user's
   computer.

After the source is loaded, select a ready vocabulary package. Incomplete or
invalid packages remain visible but cannot be searched.

### 2. Search concepts

Enter a concept ID, concept code, name, or synonym in the search box. Results
update as the query changes. An empty query browses the complete selected
package, subject to the active filters.

### 3. Apply filters

The available data-derived filters are:

| Filter | Meaning |
| --- | --- |
| Vocabulary | The concept's OMOP `vocabulary_id` |
| Domain | The concept's OMOP `domain_id` |
| Concept class | The concept's OMOP `concept_class_id` |
| Standard concept | `S - Standard`, `C - Classification`, or `Non-standard` for blank |
| Validity | `D - Deprecated`, `U - Updated`, or `null - Valid` for blank |

Filters are combined with search terms. Use **Clear** to clear only the search
query or **Clear all filters** to reset the complete search state.

### 4. Inspect a concept

Select a concept name in the results table to open its details. The details view
can include:

- core OMOP fields and validity dates;
- source repository, package, file, and row provenance;
- synonyms associated with the local concept;
- outgoing and incoming relationships;
- unresolved external relationship endpoints;
- ancestors and descendants when usable hierarchy data exist.

## Supported source formats

### Built-in source

The default browser source is a validated, schema-versioned artifact snapshot
stored under `browser/data/`. The manifest records the source repository, ref,
and immutable commit SHA from which the artifacts were built.

Generated JSON artifacts must not be edited manually. Rebuild them from the
authoritative CSV source instead.

### Public GitHub repository

The source field accepts:

```text
owner/repository
owner/repository@ref
http://github.com/owner/repository
https://github.com/owner/repository
https://github.com/owner/repository/tree/ref
```

If no ref is supplied, `main` is used. For a ref containing slashes, use the
short form:

```text
owner/repository@feature/my-branch
```

Only public GitHub repositories are supported. The browser does not request or
store a personal access token. HTTP input is accepted for convenience, but
repository and API traffic is performed over HTTPS.

The browser first looks for a compatible prebuilt
`browser/data/manifest.json`. If it is not present, it discovers packages from
the repository tree and validates their CSV files in browser memory.

Unauthenticated GitHub API limits apply. A very large or truncated repository
tree should provide prebuilt browser artifacts.

### Local folder

Select **Choose local folder** and approve a directory in the browser's system
picker. A web application cannot read an arbitrary typed absolute path.

Supported selections include a repository root, one package directory, or its
`Ontology` directory:

```text
<selected-folder>/
  concept_delta.csv
  concept_synonym_delta.csv
  concept_relationship_delta.csv

<selected-folder>/
  Ontology/
    concept_delta.csv
    concept_synonym_delta.csv
    concept_relationship_delta.csv

<selected-repository>/
  <package>/
    Ontology/
      concept_delta.csv
      concept_synonym_delta.csv
      concept_relationship_delta.csv
```

Local CSV contents stay on the user's computer and are processed in browser
memory. They are not uploaded by this application. The absolute local path is
not written to the URL. A folder must be selected again after a reload or when a
shared URL is opened in another browser.

## Vocabulary package structure

A repository can contain one or more package directories. The recommended
layout is:

```text
repository-root/
  PACKAGE_A/
    Ontology/
      concept_delta.csv
      concept_synonym_delta.csv
      concept_relationship_delta.csv
      concept_ancestor_delta.csv        # optional
      vocabulary_delta.csv              # optional
      domain_delta.csv                  # optional
      concept_class_delta.csv           # optional
      relationship_delta.csv            # optional
      mapping_metadata.csv              # optional, reserved for package metadata
  PACKAGE_B/
    Ontology/
      ...
```

The same recognized files may be placed directly in the package directory when
there is no `Ontology` subdirectory.

### Jointly required files

A package is browseable only when all three core files are present and valid:

```text
concept_delta.csv
concept_synonym_delta.csv
concept_relationship_delta.csv
```

An empty synonym or relationship table is allowed, but the file and its header
must still be present. A package with only concepts is intentionally shown as
unavailable because concept search, synonym search, and relationship inspection
are treated as one review unit.

### Optional files

| File | Use |
| --- | --- |
| `concept_ancestor_delta.csv` | Adds hierarchy navigation when it contains usable non-reflexive paths connected to local concepts |
| `vocabulary_delta.csv` | Adds vocabulary reference metadata |
| `domain_delta.csv` | Adds domain reference metadata |
| `concept_class_delta.csv` | Adds concept class reference metadata |
| `relationship_delta.csv` | Adds relationship definition metadata |
| `mapping_metadata.csv` | Recognized in the package inventory; a dedicated UI view is not currently implemented |

Malformed optional hierarchy or reference data disable only the affected
optional capability and produce a warning. Malformed required core data make
the package unavailable.

## CSV requirements

Files must be UTF-8 comma-separated text with a header row. Quoted fields,
embedded commas, and embedded newlines are supported. Row widths must be
consistent. Header names are case-sensitive and must match the names below.

Source display values are preserved. The validator does not silently trim or
rewrite authoritative concept names, codes, domains, or classes.

### `concept_delta.csv`

Required columns, in any order:

```text
concept_id
concept_name
domain_id
vocabulary_id
concept_class_id
standard_concept
concept_code
valid_start_date
valid_end_date
invalid_reason
```

Example:

```csv
concept_id,concept_name,domain_id,vocabulary_id,concept_class_id,standard_concept,concept_code,valid_start_date,valid_end_date,invalid_reason
2000000001,Example custom concept,Observation,EXAMPLE,Custom,S,EX-001,2025-01-01,2099-12-31,
```

Validation rules include:

- `concept_id` must be a unique positive integer no greater than
  `9007199254740991`;
- `concept_name`, `domain_id`, `vocabulary_id`, `concept_class_id`, and
  `concept_code` must not be blank;
- `standard_concept` must be blank, `S`, or `C`;
- `invalid_reason` must be blank, `D`, or `U`;
- dates must be valid calendar dates in `YYYY-MM-DD` or `YYYYMMDD` format;
- duplicate concept IDs make the package invalid.

### `concept_synonym_delta.csv`

Required columns, in any order:

```text
concept_id
concept_synonym_name
language_concept_id
```

Example:

```csv
concept_id,concept_synonym_name,language_concept_id
2000000001,Example alternate name,4180186
```

`concept_id` and `language_concept_id` must be positive supported integers, and
`concept_synonym_name` must not be blank. A synonym whose `concept_id` is not
present in the same package is reported as an orphan and excluded from search.
Exact duplicate synonym tuples are deduplicated.

### `concept_relationship_delta.csv`

Required columns, in any order:

```text
concept_id_1
concept_id_2
relationship_id
valid_start_date
valid_end_date
invalid_reason
```

Example:

```csv
concept_id_1,concept_id_2,relationship_id,valid_start_date,valid_end_date,invalid_reason
2000000001,2000000002,Maps to,2025-01-01,2099-12-31,
```

Both concept IDs must be positive supported integers, `relationship_id` must
not be blank, dates must be valid, and `invalid_reason` must be blank, `D`, or
`U`. Relationship direction is preserved exactly as supplied. An endpoint that
is not present in the local package is retained as an unresolved external ID.

### `concept_ancestor_delta.csv`

When present, the hierarchy file requires:

```text
ancestor_concept_id
descendant_concept_id
min_levels_of_separation
max_levels_of_separation
```

Separation values must be non-negative integers and the maximum must be greater
than or equal to the minimum. A hierarchy containing only reflexive rows does
not enable hierarchy navigation.

### Optional reference table headers

When supplied, reference tables require these headers:

| File | Required headers |
| --- | --- |
| `vocabulary_delta.csv` | `vocabulary_id`, `vocabulary_name`, `vocabulary_reference`, `vocabulary_version`, `vocabulary_concept_id` |
| `domain_delta.csv` | `domain_id`, `domain_name`, `domain_concept_id` |
| `concept_class_delta.csv` | `concept_class_id`, `concept_class_name`, `concept_class_concept_id` |
| `relationship_delta.csv` | `relationship_id`, `relationship_name`, `is_hierarchical`, `defines_ancestry`, `reverse_relationship_id`, `relationship_concept_id` |

## Search and filters

Search text is normalized with Unicode NFKC normalization, case folding,
leading and trailing whitespace removal, and internal whitespace collapsing.
The original source text remains unchanged for display.

The ranking model distinguishes exact identifiers and codes from lexical name
and synonym matches. Fuzzy matching applies only to names and synonyms, not to
numeric IDs or codes. Equal-score results use deterministic tie-breakers so the
same input produces the same order.

Filters use OR within one facet and AND across different facets. Blank OMOP
values remain actual null values and are not replaced with synthetic source
codes.

## Run locally

### Requirements

- Node.js 20 or newer
- npm supplied with Node.js
- a modern browser with ES modules, `fetch()`, native dialog support, and
  directory selection for the local-folder workflow

There are no third-party runtime or npm package dependencies.

### Start the browser

```bash
npm ci
npm test
npm run build:site
npm run serve
```

Open:

```text
http://127.0.0.1:4173/
```

The local server applies gzip compression to large JSON artifacts. Stop it with
`Ctrl+C`.

Do not open `browser/index.html` by double-clicking it. The `file://` protocol
does not provide the HTTP behavior required by ES modules and `fetch()`.

On Windows PowerShell, use `npm.cmd` instead of `npm` if the local execution
policy blocks `npm.ps1`.

## Build and validate browser data

The committed default data can be rebuilt from a local checkout of a compatible
vocabulary source repository:

```bash
npm run build:data -- \
  --source /path/to/source-repository \
  --repository owner/repository \
  --ref main \
  --commit 0123456789abcdef0123456789abcdef01234567
```

All provenance arguments are required. `--commit` must identify the immutable
source revision represented by the generated artifacts.

Then validate and package the site:

```bash
npm run validate:data
npm run benchmark
npm run build:site
```

The data build writes:

```text
browser/data/manifest.json
browser/data/vocabularies/<package-id>/concepts.json
browser/data/vocabularies/<package-id>/search.json
browser/data/vocabularies/<package-id>/synonyms.json
browser/data/vocabularies/<package-id>/relationships.json
browser/data/vocabularies/<package-id>/hierarchy.json     # when available
browser/data/vocabularies/<package-id>/metadata.json      # when available
```

`npm run build:site` validates `browser/data/` and copies the deployable site to
the ignored `dist/` directory.

### npm commands

| Command | Purpose |
| --- | --- |
| `npm test` | Runs all unit and integration tests |
| `npm run build:data` | Builds browser JSON from authoritative CSV packages |
| `npm run validate:data` | Performs semantic and index-integrity validation of generated artifacts |
| `npm run benchmark` | Runs the search benchmark against a browseable package |
| `npm run build:site` | Validates and packages the static site in `dist/` |
| `npm run serve` | Serves `dist/` at `http://127.0.0.1:4173/` |

## Project structure

```text
.
├── browser/                 # deployable application source
│   ├── css/                 # application styles
│   ├── data/                # generated manifest and vocabulary artifacts
│   ├── fonts/               # locally bundled font and font license
│   ├── js/                  # model, services, store, URL state, and UI modules
│   └── index.html
├── scripts/                 # build, validation, benchmark, and local server
├── tests/                   # unit, integration, and generated-fixture helpers
├── .github/workflows/       # CI and GitHub Pages workflows
├── package.json
└── README.md
```

The UI follows a one-way flow from user actions to store state, services, the
validated model, and DOM rendering. UI modules do not parse CSV directly.

## Testing

Run the complete suite before every pull request:

```bash
npm test
npm run validate:data
npm run build:site
```

The tests cover:

- strict CSV parsing and OMOP field validation;
- the joint requirement for concepts, synonyms, and relationships;
- package discovery for GitHub and local folders;
- search ranking, exact IDs/codes, synonyms, fuzzy boundaries, and pagination;
- nullable OMOP filters and URL state;
- relationship direction and unresolved endpoints;
- generated artifact integrity and source provenance;
- safe local static serving.

CI performs tests, rebuilds data from the pinned vocabulary source, validates
the result, and packages the site. A failed test, build, or data validation step
prevents deployment.

## Deployment

The application is designed for GitHub Pages:

1. Configure GitHub Pages to use **GitHub Actions** as its source.
2. Ensure the workflow can read the configured public vocabulary source.
3. Run or merge through the deployment branch.
4. The workflow tests the application, rebuilds and validates data, creates
   `dist/`, and uploads the static Pages artifact.

The current deployment workflow runs automatically from `main`. The test
workflow runs for pull requests and pushes to `main` or `dev`.

No server-side application, database, secret, or GitHub token is required by
the deployed browser for public repository access.

## Privacy and security

- Repository input is restricted to public `github.com` repositories.
- Embedded credentials, query strings, fragments, unsafe paths, and unsupported
  protocols are rejected.
- Remote repository content is treated as untrusted data and rendered through
  DOM text nodes rather than executable HTML.
- Runtime scripts, styles, and fonts are served locally.
- The Content Security Policy restricts connections to the application origin
  and the GitHub API/content endpoints used by the source loader.
- Local folder contents are processed in memory and are not uploaded.
- The application does not accept or store credentials, API keys, or personal
  access tokens.

Do not place credentials, PHI, PII, or confidential information in a public
vocabulary repository.

## Known limitations

- Private GitHub repositories are not supported.
- GitHub unauthenticated API rate limits can temporarily prevent discovery.
- Very large GitHub trees may require prebuilt browser artifacts.
- The browser does not write changes back to CSV files or repositories.
- The browser does not assign concept IDs or author mappings.
- Baseline OMOP concepts referenced only by relationship ID are not fetched
  from Athena and are shown as unresolved external endpoints.
- Orphan synonym rows are reported but cannot be attached to a concept that is
  absent from the selected package.
- Local-folder permission is not persistent; the user must select the folder
  again after reload.
- This is not a complete replacement for Athena or an OMOP vocabulary release
  process.

## Troubleshooting

### Search fields remain disabled

The browser enables search only after a browseable package is loaded. Check the
status panel and package selector for missing or invalid required files.

### A package is marked unavailable

Confirm that all three required CSV files are in the same package or `Ontology`
directory and that their headers and values satisfy the contract above.

### GitHub returns HTTP 403

The unauthenticated API rate limit was probably reached. Wait for the limit to
reset, use the built-in source, select a local folder, or publish compatible
prebuilt browser artifacts in the source repository.

### The page works through the local server but not by double-clicking HTML

Serve the site over HTTP with `npm run serve`. Do not use `file://`.

## Contributing

Contributions should be small, reviewable, and covered by tests.

1. Create a feature branch from the repository's active development branch.
2. Make one focused change.
3. Do not edit generated browser artifacts manually.
4. Run `npm test`, `npm run validate:data`, and `npm run build:site`.
5. Review the staged file list and exclude local data, credentials, and build
   output.
6. Open a pull request describing behavior changes, validation evidence, and
   any data-contract impact.

Changes to the three-file browseability requirement, accepted schemas, artifact
schema version, search ranking, or source security model require explicit
maintainer review.

## Proposed OHDSI integration

This project is currently maintained as an independent review candidate. If it
passes review, the intended next step is to add it to the appropriate OHDSI
repository or organization as a distinct browser component.

The final integration mechanism has not been selected. Depending on maintainer
preference, it may be a repository transfer, a Git submodule, a subtree, or a
maintained directory within another repository. The term "subrepository" in
project discussions describes this intended relationship; it is not yet a
chosen Git implementation.

Before integration, reviewers should confirm at least:

- ownership and maintainer responsibilities;
- compatibility with OHDSI contribution and governance requirements;
- project-level licensing and third-party asset notices;
- security and privacy review;
- accessibility and supported-browser expectations;
- CI, GitHub Pages, branch-protection, and release configuration;
- vocabulary provenance and artifact-refresh responsibilities;
- whether the default vocabulary source is appropriate for OHDSI hosting.

Until those decisions are recorded and approved, the application should not be
presented as an official OHDSI tool.

## License

A project-level software license has not yet been added to this repository. A
compatible license must be selected and committed before external distribution
or OHDSI integration.

Roboto Condensed is bundled under the SIL Open Font License. Its license notice
is stored at [browser/fonts/OFL.txt](browser/fonts/OFL.txt).

## Acknowledgements

The visual language is inspired by Athena. OMOP and OHDSI names are used to
describe compatibility and the intended review context; they do not imply
official endorsement.
