// A default first-visit source is not an explicit request. A remembered local or
// remote copy takes priority unless the URL asks for a different source.
export function shouldRestoreRememberedSource(initialState, preference) {
  if (!preference.enabled || !preference.savedAt) return false;
  if (!initialState.explicitSourceRequested) return true;
  if (initialState.localSourceRequested) return preference.source?.provider === "local-directory";
  return Boolean(initialState.source && initialState.source.canonical === preference.source?.canonical);
}
