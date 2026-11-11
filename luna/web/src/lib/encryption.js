import { getJson, postJson } from "./api.js";

export const getDriveEncryption = (driveId) => getJson(`/api/v1/drives/${driveId}/encryption`);
export const unlockDrive = (driveId, password) => postJson(`/api/v1/drives/${driveId}/unlock`, { password });
export const lockDrive = (driveId) => postJson(`/api/v1/drives/${driveId}/lock`, {});
export const changeDrivePassword = (driveId, currentPassword, newPassword) => postJson(`/api/v1/drives/${driveId}/password`, { current_password: currentPassword, new_password: newPassword });
