import { dataUrlImageLoader, runPluginBuild } from "./esbuild.shared.mjs";

await runPluginBuild({
  loader: dataUrlImageLoader,
});
