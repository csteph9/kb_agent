// Copy this folder, rename manifest.id, implement retrieval, then configure a source.
export async function createConnector(source) {
  return {
    async check() { throw new Error('Connector template is not implemented'); },
    async fetchPage({ cursor, limit, has }) {
      // Fetch at most limit new items. Use has(externalId, revision) to avoid expensive downloads.
      // Return a serializable cursor for the next page, or null when the scan is complete.
      // Runner persists that cursor only after the items are durably queued.
      throw new Error('Connector template is not implemented');
    }
  };
}