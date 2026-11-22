import { build, context } from "esbuild";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMath } from "./build-math.mjs";

const web = fileURLToPath(new URL("../web/", import.meta.url));
await buildMath();
const options = {
  absWorkingDir: web,
  entryPoints: ["app.js", "shell.css"],
  // Existing desktop source updaters publish this generated tree on upgrade and rollback.
  outdir: "assets/markdown/generated/shell",
  bundle: true,
  splitting: true,
  format: "esm",
  target: "esnext",
  charset: "utf8",
  minifyWhitespace: true,
  chunkNames: "[name]",
  logLevel: "info",
  plugins: [
    {
      name: "existing-fonts",
      setup(builder) {
        // Keep Inter's preload and the offline KaTeX fonts at their shipped URLs.
        builder.onResolve({ filter: /\.(woff2?|ttf)$/ }, async ({ path, resolveDir }) => {
          const font = await realpath(resolve(resolveDir, path));
          return { path: "/" + relative(web, font).split(sep).join("/"), external: true };
        });
      }
    }
  ]
};

if (process.argv.includes("--watch")) {
  const compiler = await context({ ...options, sourcemap: "linked" });
  await compiler.watch();
} else {
  await build(options);
}
