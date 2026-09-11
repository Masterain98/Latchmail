import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeDeploymentArtifacts } from "./cloudflare-config.mjs";
import { runWrangler } from "./run-wrangler.mjs";

export async function deployCloudflare({
  root = process.cwd(),
  environment = process.env,
  run = (args) => runWrangler(args, { root }),
} = {}) {
  const artifacts = await writeDeploymentArtifacts({ root, environment });
  try {
    await run([
      "deploy",
      "--config",
      artifacts.configArgument,
      "--secrets-file",
      artifacts.secretsArgument,
    ]);
  } finally {
    await artifacts.cleanup();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  deployCloudflare().catch((error) => {
    console.error(error instanceof Error ? error.message : "Deployment failed.");
    process.exitCode = 1;
  });
}
