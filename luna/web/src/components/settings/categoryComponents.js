import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import LunaConnectCategory from "./categories/LunaConnectCategory.jsx";
import DevicesCategory from "./categories/DevicesCategory.jsx";
import AccessCategory from "./categories/AccessCategory.jsx";
import UsersCategory from "./categories/UsersCategory.jsx";
import AboutCategory from "./categories/AboutCategory.jsx";

/** Category id → the component that draws it. Shared by the page and the settings search. */
export const CATEGORY_COMPONENTS = {
  appearance: AppearanceCategory,
  // Retired id: old links still land on the merged Luna Connect entry.
  cloud_backup: LunaConnectCategory,
  luna_connect: LunaConnectCategory,
  users: UsersCategory,
  devices: DevicesCategory,
  security: AccessCategory,
  about: AboutCategory,
};
