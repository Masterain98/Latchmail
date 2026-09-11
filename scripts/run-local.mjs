import { access, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, relative } from "node:path";
import {
  localDeploymentValues,
  writeGeneratedConfig,
} from "./cloudflare-config.mjs";
import { runWrangler } from "./run-wrangler.mjs";

export async function runLocal({ root = process.cwd(), environment = process.env } = {}) {
  const configPath = await writeGeneratedConfig({
    root,
    values: localDeploymentValues(environment),
    filename: "wrangler.local.json",
  });
  const argumentsList = [
    "dev",
    "--local",
    "--config",
    relative(root, configPath),
  ];
  const envFile = resolve(root, ".dev.vars");
  try {
    await access(envFile);
    argumentsList.push("--env-file", relative(root, envFile));
  } catch {
    // Wrangler will report missing required runtime secrets when the API is used.
  }
  try {
    await runWrangler(argumentsList, { root });
  } finally {
    await rm(configPath, { force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runLocal().catch((error) => {
    console.error(error instanceof Error ? error.message : "Local Worker failed.");
    process.exitCode = 1;
  });
}
