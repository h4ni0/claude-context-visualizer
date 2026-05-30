import { stat } from "node:fs/promises";
import { listProjects, listSessions, findSessionById } from "./indexer.ts";
import { computeSnapshot } from "./snapshot.ts";
import { readCached, writeCached, invalidateCache } from "./cache.ts";

const PORT = Number(process.env.PORT ?? 5174);

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...(init.headers ?? {}),
    },
  });
}

function notFound(msg = "not found") {
  return json({ error: msg }, { status: 404 });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
          },
        });
      }
      if (path === "/api/health") return json({ ok: true });

      if (path === "/api/projects" && req.method === "GET") {
        return json(await listProjects());
      }

      if (path === "/api/sessions" && req.method === "GET") {
        const project = url.searchParams.get("project");
        if (!project) return json({ error: "project required" }, { status: 400 });
        return json(await listSessions(project));
      }

      const snapshotMatch = path.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
      if (snapshotMatch && req.method === "GET") {
        const sessionId = snapshotMatch[1]!;
        const filePath = await findSessionById(sessionId);
        if (!filePath) return notFound("session not found");
        const st = await stat(filePath);
        const cached = await readCached(sessionId, st.mtimeMs);
        if (cached) return json({ ...cached, fromCache: true });
        const snap = await computeSnapshot(filePath, st.mtimeMs);
        await writeCached(snap);
        return json({ ...snap, fromCache: false });
      }

      const invalidateMatch = path.match(/^\/api\/sessions\/([^/]+)\/invalidate-cache$/);
      if (invalidateMatch && req.method === "POST") {
        const sessionId = invalidateMatch[1]!;
        const ok = await invalidateCache(sessionId);
        return json({ ok });
      }

      return notFound();
    } catch (e: any) {
      console.error("[server]", e);
      return json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  },
});

console.log(`[visualizer] backend on http://localhost:${server.port}`);
