import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The FreeMono files live once, in shared/ui/fonts. Each app's index.css asks
// for them at /fonts/<file>.ttf: the dev server answers from here, and the
// build copies them next to the app's other assets.
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fonts");

export default function sharedFonts() {
  let outDir = "dist";
  return {
    name: "libreloom-shared-fonts",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/fonts", (req, res, next) => {
        const name = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\/+/, "");
        const file = path.join(FONT_DIR, name);
        const stat = file.startsWith(FONT_DIR + path.sep) && fs.statSync(file, { throwIfNoEntry: false });
        if (!stat || !stat.isFile()) return next();
        res.setHeader("content-type", "font/ttf");
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      fs.cpSync(FONT_DIR, path.join(outDir, "fonts"), { recursive: true });
    },
  };
}
