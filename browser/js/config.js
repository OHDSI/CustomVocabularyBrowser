import { resolveSource } from "./services/sourceResolver.js";

export const MANIFEST_SCHEMA_VERSION = "2.0";
export const DEFAULT_SOURCE = resolveSource("TuftsCTSI/CVB@main");
export const LOCAL_MANIFEST_URL = new URL("../data/manifest.json", import.meta.url).href;
export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZE_OPTIONS = Object.freeze([10, 25, 50, 100]);

