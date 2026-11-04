import { promises as fs } from "node:fs";
import * as path from "node:path";

export async function ensureProjectIgnored(projectRoot: string, directory: ".asdm" | ".codebuddy"): Promise<void> {
  const gitignore = path.join(projectRoot, ".gitignore");
  let content = "";
  try { content = await fs.readFile(gitignore, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const equivalent = new RegExp(`^\\s*\\/?\\${directory}\\/?\\s*$`);
  if (content.split(/\r?\n/).some(line => equivalent.test(line))) return;
  await fs.appendFile(gitignore, `${content && !content.endsWith("\n") ? "\n" : ""}/${directory}/\n`);
}
