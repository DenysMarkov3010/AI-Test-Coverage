/**
 * Which test management provider a run imports into, for the pages that name it.
 *
 * The Setup page owns the "In use" toggle; Create and Update only read it. They
 * read it once per load on purpose — the value cannot change without a save,
 * and a save happens on a different page.
 *
 * Azure DevOps is the fallback whenever the answer is unusable (older server,
 * request blocked, malformed body), which matches DEFAULT_PROVIDER on the
 * server: a page that cannot reach the toggle still works, it just keeps the
 * labels it shipped with.
 */
const TmsProvider = (() => {
  const FALLBACK = { id: "ado", title: "Azure DevOps" };
  let current = FALLBACK;

  /**
   * @param {(path: string) => string} apiUrl the page's own origin helper
   * @returns {Promise<{ id: string, title: string }>}
   */
  async function load(apiUrl) {
    try {
      const res = await fetch(apiUrl("/__da/tms/active"), { method: "GET" });
      if (!res.ok) return current;
      const body = await res.json();
      if (body && body.id) {
        current = { id: String(body.id), title: String(body.title || body.id) };
      }
    } catch {
      // Keep FALLBACK: the rest of the page is still usable offline.
    }
    return current;
  }

  return {
    load,
    /** Last known provider; FALLBACK until load() resolves. */
    get: () => current,
    isAdo: () => current.id === "ado",
  };
})();
