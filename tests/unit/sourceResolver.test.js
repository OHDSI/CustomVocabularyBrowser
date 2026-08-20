import test from "node:test";
import assert from "node:assert/strict";

import {
  SourceResolutionError,
  resolveSource
} from "../../browser/js/services/sourceResolver.js";

const descriptor = (owner, repository, ref = "main") => ({
  provider: "github",
  owner,
  repository,
  ref,
  canonical: `${owner}/${repository}@${ref}`
});

test("resolves supported short identifiers", () => {
  assert.deepEqual(resolveSource("TuftsCTSI/CVB"), descriptor("TuftsCTSI", "CVB"));
  assert.deepEqual(
    resolveSource("TuftsCTSI/CVB@release-1.2"),
    descriptor("TuftsCTSI", "CVB", "release-1.2")
  );
  assert.deepEqual(
    resolveSource("TuftsCTSI/CVB@feature/source-browser"),
    descriptor("TuftsCTSI", "CVB", "feature/source-browser")
  );
  assert.deepEqual(resolveSource("TuftsCTSI/CVB.git"), descriptor("TuftsCTSI", "CVB"));
});

test("resolves supported HTTPS GitHub URLs", () => {
  assert.deepEqual(
    resolveSource("https://github.com/TuftsCTSI/CVB"),
    descriptor("TuftsCTSI", "CVB")
  );
  assert.deepEqual(
    resolveSource("https://GITHUB.com/TuftsCTSI/CVB.git/"),
    descriptor("TuftsCTSI", "CVB")
  );
  assert.deepEqual(
    resolveSource("https://github.com/TuftsCTSI/CVB/tree/develop"),
    descriptor("TuftsCTSI", "CVB", "develop")
  );
  assert.deepEqual(
    resolveSource("https://github.com/TuftsCTSI/CVB/tree/v1.2.3/"),
    descriptor("TuftsCTSI", "CVB", "v1.2.3")
  );
});

test("normalizes HTTP GitHub input without changing the HTTPS-only data transport", () => {
  assert.deepEqual(
    resolveSource("http://github.com/TuftsCTSI/CVB"),
    descriptor("TuftsCTSI", "CVB")
  );
});

test("returns a frozen canonical descriptor", () => {
  const source = resolveSource("TuftsCTSI/CVB@develop");
  assert.equal(Object.isFrozen(source), true);
  assert.equal(source.canonical, "TuftsCTSI/CVB@develop");
  assert.throws(() => {
    source.ref = "other";
  }, TypeError);
});

test("throws a typed error for non-string and malformed identifiers", () => {
  const invalidSources = [
    null,
    undefined,
    42,
    {},
    "",
    " ",
    " TuftsCTSI/CVB",
    "TuftsCTSI/CVB ",
    "TuftsCTSI",
    "TuftsCTSI/CVB/extra",
    "TuftsCTSI/CVB@",
    "TuftsCTSI/CVB@main@other",
    "-owner/CVB",
    "owner-/CVB",
    "owner--name/CVB",
    "owner/repo name",
    "owner/.git"
  ];

  for (const source of invalidSources) {
    assert.throws(
      () => resolveSource(source),
      error => error instanceof SourceResolutionError,
      `expected rejection for ${String(source)}`
    );
  }
});

test("rejects unsupported protocols, hosts, ports, and credentials", () => {
  const invalidSources = [
    "ftp://github.com/owner/repo",
    "https://gitlab.com/owner/repo",
    "https://api.github.com/owner/repo",
    "https://github.com.evil.example/owner/repo",
    "https://github.com:8443/owner/repo",
    "https://user@github.com/owner/repo",
    "https://user:password@github.com/owner/repo"
  ];

  for (const source of invalidSources) {
    assert.throws(() => resolveSource(source), SourceResolutionError, source);
  }
});

test("rejects query strings, fragments, controls, and path separator attacks", () => {
  const invalidSources = [
    "https://github.com/owner/repo?ref=main",
    "https://github.com/owner/repo?",
    "https://github.com/owner/repo#readme",
    "https://github.com/owner/repo#",
    "https://github.com/owner%2Frepo/name",
    "https://github.com/owner/repo/tree/feature%2Fbranch",
    "https://github.com/owner/repo/tree/feature%5Cbranch",
    "owner/repo@feature\\branch",
    "owner/repo\n"
  ];

  for (const source of invalidSources) {
    assert.throws(() => resolveSource(source), SourceResolutionError, source);
  }
});

test("rejects traversal and malformed refs", () => {
  const invalidSources = [
    "./repo",
    "../repo",
    "owner/.",
    "owner/..",
    "owner/repo@.",
    "owner/repo@..",
    "owner/repo@feature/./branch",
    "owner/repo@feature/../branch",
    "owner/repo@feature//branch",
    "owner/repo@/main",
    "owner/repo@main/",
    "owner/repo@main..next",
    "owner/repo@.hidden",
    "owner/repo@feature.lock",
    "owner/repo@feature branch",
    "owner/repo@feature~branch",
    "https://github.com/owner/repo/tree/.",
    "https://github.com/owner/repo/tree/..",
    "https://github.com/owner/repo/tree/%2e%2e"
  ];

  for (const source of invalidSources) {
    assert.throws(() => resolveSource(source), SourceResolutionError, source);
  }
});

test("rejects ambiguous or unsupported GitHub repository paths", () => {
  const invalidSources = [
    "https://github.com/owner/repo/issues",
    "https://github.com/owner/repo/tree",
    "https://github.com/owner/repo/tree/main/src",
    "https://github.com/owner/repo/blob/main/file.csv",
    "https://github.com/owner/repo//tree/main"
  ];

  for (const source of invalidSources) {
    assert.throws(() => resolveSource(source), SourceResolutionError, source);
  }
});
