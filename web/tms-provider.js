/**
 * Which test management provider a run imports into, for the pages that name it.
 *
 * The Setup page owns the "In use" toggle; Create and Update only read it. They
 * read it once per load on purpose — the value cannot change without a save,
 * and a save happens on a different page.
 *
 * Nothing is In use until someone picks a provider (DEFAULT_PROVIDER on the
 * server is empty), and an unusable answer (older server, request blocked,
 * malformed body) reads the same way: the import steps stay disabled.
 */
const TmsProvider = (() => {
  const NONE = { id: "", title: "" };
  let current = NONE;

  /**
   * @param {(path: string) => string} apiUrl the page's own origin helper
   * @returns {Promise<{ id: string, title: string }>}
   */
  async function load(apiUrl) {
    try {
      const res = await fetch(apiUrl("/__da/tms/active"), { method: "GET" });
      if (!res.ok) return current;
      const body = await res.json();
      if (body && body.ok) {
        current = body.id ? { id: String(body.id), title: String(body.title || body.id) } : NONE;
      }
    } catch {
      // Keep NONE: the rest of the page is still usable offline.
    }
    return current;
  }

  return {
    load,
    /** Last known provider; NONE until load() resolves. */
    get: () => current,
    isSet: () => !!current.id,
    isAdo: () => current.id === "ado",
    /** The provider's name, or a generic one while none is In use. */
    title: () => current.title || "test management system",
  };
})();
