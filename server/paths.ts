import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export const CACHE_DIR = join(import.meta.dir, "..", ".cache");

// Project directory names are flattened paths: slashes replaced with dashes,
// and a single leading dash. e.g. "-home-user-projects-my-app".
// We decode by replacing dashes with slashes — lossy but usable as a label.
export function decodeProjectSlug(slug: string): string {
  return slug.replace(/^-/, "/").replace(/-/g, "/");
}
