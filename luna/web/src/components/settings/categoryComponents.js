import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import CloudBackupCategory from "./categories/CloudBackupCategory.jsx";
import RemoteCategory from "./categories/RemoteCategory.jsx";
import DevicesCategory from "./categories/DevicesCategory.jsx";
import AccessCategory from "./categories/AccessCategory.jsx";
import UsersCategory from "./categories/UsersCategory.jsx";
import AboutCategory from "./categories/AboutCategory.jsx";

/** Category id → the component that draws it. Shared by the page and the settings search. */
export const CATEGORY_COMPONENTS = {
  appearance: AppearanceCategory,
  cloud_backup: CloudBackupCategory,
  luna_connect: RemoteCategory,
  users: UsersCategory,
  devices: DevicesCategory,
  security: AccessCategory,
  about: AboutCategory,
};
