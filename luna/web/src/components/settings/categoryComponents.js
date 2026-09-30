import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import ExternalServicesCategory from "./categories/ExternalServicesCategory.jsx";
import DevicesCategory from "./categories/DevicesCategory.jsx";
import AccessCategory from "./categories/AccessCategory.jsx";
import AboutCategory from "./categories/AboutCategory.jsx";

/** Category id → the component that draws it. Shared by the page and the settings search. */
export const CATEGORY_COMPONENTS = {
  appearance: AppearanceCategory,
  external_services: ExternalServicesCategory,
  devices: DevicesCategory,
  security: AccessCategory,
  about: AboutCategory,
};
