import type { Plugin } from "vite";
import { readFile } from "node:fs/promises";

export function sqlTextPlugin(): Plugin {
  return {
    name: "latchmail-sql-text",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(".sql")) return null;
      const sql = await readFile(id, "utf8");
      return `export default ${JSON.stringify(sql)};`;
    },
  };
}
