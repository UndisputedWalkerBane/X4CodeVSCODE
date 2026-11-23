import * as esbuild from "esbuild";

import { catalogInputs, renderAbliterationCatalog } from "./resources/abliterationCatalog.mjs";

const watch = process.argv.includes("--watch");

/** Сборка extension host: Node.js, CommonJS. SDK не бандлим — он спавнит CLI из
 *  собственного пакета и должен остаться обычной зависимостью в node_modules. */
const extensionCtx = await esbuild.context({
  entryPoints: { extension: "src/extension.ts", "abliteration-models": "abliteration-models.json" },
  outdir: "dist",
  plugins: [{
    name: "codex-model-catalog",
    setup(build) {
      build.onResolve({ filter: /^abliteration-models\.json$/ }, args => ({ path: args.path, namespace: "catalog" }));
      build.onLoad({ filter: /.*/, namespace: "catalog" }, async () => ({
        contents: await renderAbliterationCatalog(), loader: "copy", watchFiles: catalogInputs,
      }));
    },
  }],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  // bufferutil/utf-8-validate — необязательные ускорители ws, подключаются через try/require.
  external: ["vscode", "@anthropic-ai/claude-agent-sdk", "bufferutil", "utf-8-validate"],
});

/** Сборка webview: браузерный бандл + CSS (импортируется из index.tsx). */
const webviewCtx = await esbuild.context({
  entryPoints: ["webview/index.tsx"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
  loader: { ".css": "css" },
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log("[esbuild] watching…");
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log("[esbuild] build done");
}
