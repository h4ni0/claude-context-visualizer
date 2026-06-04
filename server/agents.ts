import type { ProjectInfo, SessionListItem } from "./types.ts";
import type { Agent, Provider, SessionMeta } from "./providers/types.ts";
import { AGENTS } from "./providers/types.ts";
import { claudeProvider } from "./providers/claude.ts";
import { openclawProvider } from "./providers/openclaw.ts";
import { hermesProvider } from "./providers/hermes.ts";
import { opencodeProvider } from "./providers/opencode.ts";

const PROVIDERS: Record<Agent, Provider> = {
  claude: claudeProvider,
  openclaw: openclawProvider,
  hermes: hermesProvider,
  opencode: opencodeProvider,
};

function parsePrefixedId(prefixedId: string): { agent: Agent; id: string } | null {
  for (const agent of AGENTS) {
    if (prefixedId.startsWith(`${agent}:`)) {
      return { agent, id: prefixedId.slice(agent.length + 1) };
    }
  }
  return null;
}

export async function listAllProjects(): Promise<(ProjectInfo & { agent: Agent })[]> {
  const results: (ProjectInfo & { agent: Agent })[] = [];
  for (const agent of AGENTS) {
    const provider = PROVIDERS[agent];
    try {
      const projects = await provider.listProjects();
      for (const p of projects) {
        results.push({ ...p, slug: `${agent}:${p.slug}`, agent });
      }
    } catch (e) {
      console.error(`[agents] ${agent} listProjects failed:`, e);
    }
  }
  return results.sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
}

export async function listSessionsForProject(agentSlug: string): Promise<SessionListItem[]> {
  const colonIdx = agentSlug.indexOf(":");
  if (colonIdx === -1) return [];
  const agentName = agentSlug.slice(0, colonIdx) as Agent;
  const projectSlug = agentSlug.slice(colonIdx + 1);
  const provider = PROVIDERS[agentName];
  if (!provider) return [];
  try {
    return await provider.listSessions(projectSlug);
  } catch (e) {
    console.error(`[agents] ${agentName} listSessions failed:`, e);
    return [];
  }
}

export async function findSessionById(prefixedId: string): Promise<{
  filePath: string;
  agent: Agent;
  sessionId: string;
} | null> {
  const parsed = parsePrefixedId(prefixedId);
  if (!parsed) return null;
  const provider = PROVIDERS[parsed.agent];
  if (!provider) return null;
  try {
    const filePath = await provider.findSessionById(parsed.id);
    if (!filePath) return null;
    return { filePath, agent: parsed.agent, sessionId: parsed.id };
  } catch {
    return null;
  }
}

export async function indexSession(agent: Agent, filePath: string): Promise<SessionMeta> {
  const provider = PROVIDERS[agent];
  return provider.indexSessionFile(filePath);
}

export async function computeSnapshot(agent: Agent, filePath: string, knownMtimeMs?: number) {
  const provider = PROVIDERS[agent];
  return provider.computeSnapshot(filePath, knownMtimeMs);
}
