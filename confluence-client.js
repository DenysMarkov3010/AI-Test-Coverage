const fetch = globalThis.fetch || require("node-fetch");

class ConfluenceClient {
  constructor(baseUrl, email, apiToken) {
    // Confluence base URL (can be same as Jira or different)
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Basic ${this.auth}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Confluence API error: ${response.status} ${response.statusText}. ${errorText}`);
    }

    return response.json();
  }

  async searchByLabels(labels, expand = "body.storage,metadata.labels,version") {
    // CQL query to search pages by labels
    const labelQuery = labels.map(l => `"${l}"`).join(", ");
    const cql = `label in (${labelQuery}) AND type=page`;
    const encodedCql = encodeURIComponent(cql);
    
    return this.request(`/wiki/rest/api/content/search?cql=${encodedCql}&expand=${expand}`, {
      method: "GET",
    });
  }

  async getPageContent(pageId, expand = "body.storage,metadata.labels,version") {
    return this.request(`/wiki/rest/api/content/${pageId}?expand=${expand}`, {
      method: "GET",
    });
  }

  extractPageData(page) {
    return {
      id: page.id,
      title: page.title,
      body: page.body?.storage?.value || "",
      labels: page.metadata?.labels?.results?.map(l => l.name) || [],
      version: page.version?.number || 1,
      url: page._links?.webui || null,
      space: page.space?.key || null,
    };
  }
}

module.exports = { ConfluenceClient };
