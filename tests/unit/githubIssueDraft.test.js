import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubIssueDraft, MAX_ISSUE_URL_LENGTH } from "../../browser/js/services/reviewService.js";
const draft = { kind: "concept", status: "draft-not-submitted", record: { concept_name: "Example & test? # unicode 🧬" }, metadata: { rationale: "Evidence" } };

test("GitHub issue composer has fixed origin, escaped JSON, configurable visible destination and no auto-submit", () => {
  const result = createGitHubIssueDraft(draft, "OHDSI/CustomVocabularyBrowser");
  const url = new URL(result.url);
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/OHDSI/CustomVocabularyBrowser/issues/new");
  assert.equal(result.includesJson, true);
  assert.ok(url.searchParams.get("body").includes(JSON.stringify(draft, null, 2)));
  assert.ok(url.searchParams.get("title").includes("& test? # unicode 🧬"));
  assert.ok(result.notice.includes("sends the previewed JSON"));
  assert.equal(new URL(createGitHubIssueDraft(draft, "my-team/my.repo").url).pathname, "/my-team/my.repo/issues/new");
});
test("GitHub issue destination rejects URLs, credentials, path injection and hostile encodings", () => {
  for (const repository of ["https://github.com/owner/repo", "owner/repo?x=1", "owner/repo#frag", "owner/repo/issues", "owner/..", "../repo", "owner/repo%2Fnew", "owner@evil.test/repo", "owner/repo\\other", "owner/repo\nInjected", "-owner/repo", "owner-/repo"]) {
    assert.throws(() => createGitHubIssueDraft(draft, repository), /owner\/repository/);
  }
  assert.throws(() => createGitHubIssueDraft(null), /Validate/);
  assert.throws(() => createGitHubIssueDraft({ ...draft, status: "published" }), /Validate/);
});
test("oversized issue JSON stays out of URL and directs user to download and paste it", () => {
  const result = createGitHubIssueDraft({ ...draft, metadata: { rationale: "PRIVATE-LARGE-DRAFT ".repeat(3000) } });
  const url = new URL(result.url);
  assert.equal(result.includesJson, false);
  assert.ok(result.url.length <= MAX_ISSUE_URL_LENGTH);
  assert.ok(!result.url.includes("PRIVATE-LARGE-DRAFT"));
  assert.ok(url.searchParams.get("body").includes("Add JSON draft here"));
  assert.ok(result.notice.includes("Download it first"));
});

test("batch proposals produce a prefilled review issue without submitting", () => {
  const batch = { schema: "cvb-review-batch/1", status: "draft-not-submitted", kind: "batch", records: [draft] };
  const result = createGitHubIssueDraft(batch);
  const url = new URL(result.url);
  assert.equal(url.pathname, "/OHDSI/CustomVocabularyBrowser/issues/new");
  assert.ok(url.searchParams.get("title").includes("batch"));
  assert.ok(url.searchParams.get("body").includes(JSON.stringify(batch, null, 2)));
});
