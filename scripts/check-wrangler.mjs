import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, relative } from "node:path";
import {
  checkDeploymentValues,
  writeGeneratedConfig,
} from "./cloudflare-config.mjs";
import { runWrangler } from "./run-wrangler.mjs";

export async function checkWrangler({ root = process.cwd() } = {}) {
  const configPath = await writeGeneratedConfig({
    root,
    values: checkDeploymentValues(),
    filename: "wrangler.check.json",
  });
  try {
    await runWrangler(
      [
        "deploy",
        "--dry-run",
        "--config",
        relative(root, configPath),
        "--outdir",
        resolve(root, ".wrangler-dry-run"),
      ],
      { root },
    );
  } finally {
    await rm(configPath, { force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  checkWrangler().catch((error) => {
    console.error(error instanceof Error ? error.message : "Wrangler dry run failed.");
    process.exitCode = 1;
  });
}
