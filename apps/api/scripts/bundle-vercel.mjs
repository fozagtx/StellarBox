// Bundles the API and its workspace packages (which ship raw .ts sources)
// into one ESM file that Vercel's Node runtime can load without a TS loader.
import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/vercel.ts", import.meta.url).pathname],
  outfile: new URL("../dist/vercel.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["pg-native"],
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});
