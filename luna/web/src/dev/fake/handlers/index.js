// Importing a handler module registers its routes. One file per product area so
// areas can grow independently — add yours here. Routes are matched most-specific-first
// and a duplicate method + pattern throws, so the order of these lines never matters.
import "./files.js";
import "./backups.js";
import "./core.js";
import "./settings.js";
import "./gallery.js";
import "./access.js";
