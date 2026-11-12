import test from 'node:test';
import assert from 'node:assert/strict';
import { combinePackages, conceptKey } from '../../browser/js/services/dataService.js';
import { SearchService } from '../../browser/js/services/searchService.js';
import { createShareableUrl, readUrlState } from '../../browser/js/urlState.js';

function dataset(packageId, name, synonym) {
  const concepts = [{ conceptId: '2000000001', conceptName: name, conceptCode: 'A', vocabularyId: packageId,
    domainId: 'Observation', conceptClassId: 'Term', standardConcept: null, invalidReason: null }];
  return { entry: {packageId, warnings: []}, concepts, search: {documents: [{conceptOrdinal: 0,
    conceptId: '2000000001', normalizedName: name, normalizedCode: 'a', normalizedSynonyms: [synonym]}]} };
}

test('all-package search keeps overlapping IDs and synonym ordinals distinct', () => {
  const combined = combinePackages([dataset('A', 'alpha', 'first'), dataset('B', 'beta', 'second')]);
  assert.equal(combined.conceptById.size, 2);
  assert.equal(combined.conceptById.get(conceptKey('B', '2000000001')).conceptName, 'beta');
  const search = new SearchService(combined);
  assert.equal(search.search({query: '2000000001'}).total, 2);
  assert.equal(search.search({query: 'second'}).items[0].concept.packageId, 'B');
  assert.equal(search.search({filters: {vocabularyId: ['A']}}).total, 1);
});

test('share link round-trips package-scoped identity without delimiter collisions', () => {
  const key = conceptKey('A:[] / B', '2000000001');
  const url = createShareableUrl({source: {provider: "github", owner: "ExampleOrg", repository: "FixtureCVB", ref: "main"}, selectedPackageId: '__all__', selectedConceptId: key});
  const restored = readUrlState(new URL(url).search);
  assert.equal(restored.selectedConceptId, key);
  assert.equal(restored.selectedPackageId, '__all__');
});

test('selected packages retain scope in dataset and share link', () => {
  const scope = JSON.stringify(['A', 'C']);
  const combined = combinePackages([dataset('A', 'alpha', 'first'), dataset('C', 'gamma', 'third')], scope);
  assert.equal(combined.entry.packageId, scope);
  assert.equal(combined.conceptById.size, 2);
  const url = createShareableUrl({source: {provider: "github", owner: "ExampleOrg", repository: "FixtureCVB", ref: "main"}, selectedPackageId: scope});
  assert.equal(readUrlState(new URL(url).search).selectedPackageId, scope);
});

test('query-aware facet candidates use full search semantics before filters', () => {
  const combined = combinePackages([dataset('A', 'alpha', 'first'), dataset('B', 'beta', 'second')]);
  const search = new SearchService(combined);
  assert.deepEqual(search.matchingConcepts('second').map((concept) => concept.packageId), ['B']);
  assert.equal(search.matchingConcepts('2000000001').length, 2);
  assert.equal(search.matchingConcepts('missing').length, 0);
  assert.equal(search.matchingConcepts('').length, 2);
});
