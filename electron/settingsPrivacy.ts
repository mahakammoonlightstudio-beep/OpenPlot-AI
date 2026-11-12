/**
 * The settings row is a mixed bag: UI preferences plus a few credentials.
 * Only the main process should ever see the credential values. This helper is
 * the single boundary used by the `db:getAllSettings` IPC reply, so a future
 * setting cannot accidentally become renderer-readable just by being added.
 */
export function settingsForRenderer(
  rows: Record<string, string> | null | undefined,
  hasWebSearchKey: boolean
): Record<string, string> {
  const source = rows && typeof rows === 'object' ? rows : {};
  return {
    ...source,
    webSearchApiKey: '',
    webSearchHasKey: hasWebSearchKey ? 'true' : 'false'
  };
}
