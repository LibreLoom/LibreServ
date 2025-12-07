import api from './client';

export const backupsApi = {
  // List backups
  async list(appId = null) {
    const params = appId ? `?app_id=${appId}` : '';
    return api.get(`/backups${params}`);
  },

  // Get specific backup
  async get(backupId) {
    return api.get(`/backups/${backupId}`);
  },

  // Create backup
  async create(appId, options = {}) {
    return api.post('/backups', {
      app_id: appId,
      stop_before_backup: options.stopBeforeBackup ?? false,
      compress: options.compress ?? true,
      include_config: options.includeConfig ?? true,
      include_logs: options.includeLogs ?? false,
    });
  },

  // Restore backup
  async restore(backupId, options = {}) {
    return api.post(`/backups/${backupId}/restore`, {
      stop_before_restore: options.stopBeforeRestore ?? true,
      restart_after_restore: options.restartAfterRestore ?? true,
      verify_checksum: options.verifyChecksum ?? true,
    });
  },

  // Delete backup
  async delete(backupId) {
    return api.delete(`/backups/${backupId}`);
  },

  // Database backups
  async listDatabaseBackups() {
    return api.get('/backups/database');
  },

  async createDatabaseBackup() {
    return api.post('/backups/database');
  },
};

export default backupsApi;
