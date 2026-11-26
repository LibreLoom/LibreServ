import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import lazyWithPreload from "../../lib/lazyWithPreload.js";

const LunaConnectCategory = lazyWithPreload(() => import("./categories/LunaConnectCategory.jsx"));

/** Category id → the component that draws it. Shared by the page and the settings search. */
export const CATEGORY_COMPONENTS = {
  appearance: AppearanceCategory,
  // Retired id: old links still land on the merged Luna Connect entry.
  cloud_backup: LunaConnectCategory,
  luna_connect: LunaConnectCategory,
  users: lazyWithPreload(() => import("./categories/UsersCategory.jsx")),
  devices: lazyWithPreload(() => import("./categories/DevicesCategory.jsx")),
  security: lazyWithPreload(() => import("./categories/AccessCategory.jsx")),
  about: lazyWithPreload(() => import("./categories/AboutCategory.jsx")),
};

/** @param {{ id: string, label: string }[]} categories */
export function settingsIndexCategories(categories) {
  return categories.flatMap(({ id, label }) => {
    const Component = CATEGORY_COMPONENTS[id];
    if (!Component) return [];
    return [{
      id,
      label,
      Component,
      loadComponent: Component.preload
        ? () => Component.preload().then((module) => module.default)
        : undefined,
    }];
  });
}
