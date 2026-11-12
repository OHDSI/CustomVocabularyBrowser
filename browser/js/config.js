export const MANIFEST_SCHEMA_VERSION = "2.0";
// A first visit loads this public source at runtime. No vocabulary is bundled.
export const DEFAULT_SOURCE = Object.freeze({
  provider: "github", owner: "TuftsCTSI", repository: "CVB", ref: "main",
  canonical: "TuftsCTSI/CVB@main",
});
export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZE_OPTIONS = Object.freeze([10, 25, 50, 100]);

