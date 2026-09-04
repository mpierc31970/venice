import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Venice Studio project directory *is* Remotion's public dir. Nothing is copied and
 * nothing has to be kept in step: the renderer writes timeline/<section>.json and
 * clips/<section>/<id>.mp4 there, and Remotion reads them from the same place through
 * staticFile(). The finished section lands next to them in sections/.
 *
 * VENICE_PROJECT_DIR wins; otherwise the registry the server keeps, by id or first entry.
 */
export function projectDir() {
  if (process.env.VENICE_PROJECT_DIR) return process.env.VENICE_PROJECT_DIR;

  const file = path.join(os.homedir(), ".venice-studio", "registry.json");
  let projects = [];
  try {
    ({ projects = [] } = JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    throw new Error(`Cannot read ${file} — set VENICE_PROJECT_DIR to the project directory.`);
  }
  const id = process.env.VENICE_PROJECT_ID;
  const entry = id ? projects.find((p) => p.id === id) : projects[0];
  if (!entry?.dir) {
    throw new Error(
      id ? `No project "${id}" in ${file}.` : `No projects in ${file} — set VENICE_PROJECT_DIR.`
    );
  }
  return entry.dir;
}
