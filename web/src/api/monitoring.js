import api from './client';

export const monitoringApi = {
  // System health
  async getSystemHealth() {
    return api.get('/monitoring/system');
  },

  // Cleanup old data
  async cleanup(retentionDays = 7) {
    return api.post(`/monitoring/cleanup?retention_days=${retentionDays}`);
  },
};

export default monitoringApi;
