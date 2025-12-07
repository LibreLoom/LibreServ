import api from './client';

export const appsApi = {
  // Catalog - available apps
  async getCatalog() {
    return api.get('/catalog');
  },

  async getCatalogApp(appId) {
    return api.get(`/catalog/${appId}`);
  },

  async getCategories() {
    return api.get('/catalog/categories');
  },

  async refreshCatalog() {
    return api.post('/catalog/refresh');
  },

  // Installed apps
  async listInstalled() {
    return api.get('/apps');
  },

  async getInstalled(instanceId) {
    return api.get(`/apps/${instanceId}`);
  },

  async install(appId, config = {}) {
    return api.post('/apps', { app_id: appId, config });
  },

  async uninstall(instanceId) {
    return api.delete(`/apps/${instanceId}`);
  },

  async getStatus(instanceId) {
    return api.get(`/apps/${instanceId}/status`);
  },

  async start(instanceId) {
    return api.post(`/apps/${instanceId}/start`);
  },

  async stop(instanceId) {
    return api.post(`/apps/${instanceId}/stop`);
  },

  async restart(instanceId) {
    return api.post(`/apps/${instanceId}/restart`);
  },

  async update(instanceId) {
    return api.post(`/apps/${instanceId}/update`);
  },

  // Health and metrics
  async getHealth(instanceId) {
    return api.get(`/apps/${instanceId}/health`);
  },

  async getMetrics(instanceId) {
    return api.get(`/apps/${instanceId}/metrics`);
  },

  async getMetricsHistory(instanceId, since, limit = 100) {
    const params = new URLSearchParams();
    if (since) params.append('since', since);
    if (limit) params.append('limit', limit);
    return api.get(`/apps/${instanceId}/metrics/history?${params}`);
  },
};

export default appsApi;
