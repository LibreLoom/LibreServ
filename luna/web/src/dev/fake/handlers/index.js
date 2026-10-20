// Importing a handler module registers its routes. One file per product area so
// areas can grow independently — add yours here.
// files.js goes first on purpose: its backups and private-item answers know about
// drives and paths, and the first handler registered for a route wins.
import "./files.js";
import "./core.js";
import "./settings.js";
import "./gallery.js";
import "./access.js";
