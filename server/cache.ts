import { mkdir, readFile, writeFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "./paths.ts";
import { SNAPSHOT_SCHEMA_VERSION, type Snapshot } from "./types.ts";

async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}

function cachePath(sessionId: string) {
  return join(CACHE_DIR, `${sessionId}.json`);
}

export async function readCached(sessionId: string, sourceMtimeMs: number): Promise<Snapshot | null> {
  try {
    const p = cachePath(sessionId);
    const buf = await readFile(p, "utf8");
    const snap = JSON.parse(buf) as Snapshot;
    if (snap.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
    if (Math.abs(snap.mtimeMs - sourceMtimeMs) < 1) return snap;
    return null;
  } catch {
    return null;
  }
}

export async function writeCached(snap: Snapshot): Promise<void> {
  await ensureCacheDir();
  await writeFile(cachePath(snap.sessionId), JSON.stringify(snap));
}

export async function invalidateCache(sessionId: string): Promise<boolean> {
  try {
    await unlink(cachePath(sessionId));
    return true;
  } catch {
    return false;
  }
}
