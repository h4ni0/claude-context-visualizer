import { stat } from "node:fs/promises";
import { listProjects, listSessions, findSessionById } from "./indexer.ts";
import { computeSnapshot } from "./snapshot.ts";
import { readCached, writeCached, invalidateCache } from "./cache.ts";
import { findSessionById as findSessionByIdAgent, computeSnapshot as computeSnapshotAgent } from "./agents.ts";
import type { Agent } from "./providers/types.ts";

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
        const prefixedId = decodeURIComponent(snapshotMatch[1]!);
        // Try multi-agent lookup first (prefixed IDs like claude:uuid)
        const agentResult = await findSessionByIdAgent(prefixedId);
        if (agentResult) {
          const { filePath, agent, sessionId } = agentResult;
          try {
            let mtimeMs: number;
            if (filePath.startsWith("opencode://")) {
              mtimeMs = Date.now();
            } else {
              mtimeMs = (await stat(filePath)).mtimeMs;
            }
            const cacheKey = prefixedId;
            const cached = await readCached(cacheKey, mtimeMs);
            if (cached) return json({ ...cached, fromCache: true });
            const snap = await computeSnapshotAgent(agent, filePath, mtimeMs);
            snap.headline.agent = agent;
            snap.sessionId = prefixedId;
            await writeCached(cacheKey, snap);
            return json({ ...snap, fromCache: false });
          } catch (e: any) {
            return json({ error: String(e?.message ?? e) }, { status: 500 });
          }
        }
        // Fallback: legacy Claude Code lookup (bare UUID)
        const filePath = await findSessionById(prefixedId);
        if (!filePath) return notFound("session not found");
        const st = await stat(filePath);
        const cached = await readCached(prefixedId, st.mtimeMs);
        if (cached) return json({ ...cached, fromCache: true });
        const snap = await computeSnapshot(filePath, st.mtimeMs);
        await writeCached(prefixedId, snap);
        return json({ ...snap, fromCache: false });
      }

      const invalidateMatch = path.match(/^\/api\/sessions\/([^/]+)\/invalidate-cache$/);
      if (invalidateMatch && req.method === "POST") {
        const prefixedId = decodeURIComponent(invalidateMatch[1]!);
        const ok = await invalidateCache(prefixedId);
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
