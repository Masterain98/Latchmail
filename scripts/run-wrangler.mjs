import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function runWrangler(args, { root = process.cwd(), stdio = "inherit" } = {}) {
  const executable = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: root,
      env: process.env,
      stdio,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(
        new Error(
          signal
            ? `Wrangler exited after signal ${signal}.`
            : `Wrangler exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}
