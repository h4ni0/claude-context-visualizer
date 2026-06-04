import { useEffect, useMemo, useState } from "react";
import { api, type ProjectInfo, type SessionListItem } from "../api";

type Props = {
  selected: string | null;
  onSelect: (s: SessionListItem) => void;
  collapsed: boolean;
  onToggle: () => void;
};

const AGENT_ORDER = ["claude", "opencode", "openclaw", "hermes"] as const;
const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  opencode: "OpenCode",
};
const AGENT_COLORS: Record<string, string> = {
  claude: "#d97706",
  openclaw: "#7c3aed",
  hermes: "#059669",
  opencode: "#0284c7",
};

function fmtTokens(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < 7 * day) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Sidebar({ selected, onSelect, collapsed, onToggle }: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionListItem[]>
  >({});
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(
    new Set(["claude"]),
  );
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.projects().then((p) => {
      setProjects(p);
      // Auto-expand first agent group
      const agents = new Set(p.map((x) => x.agent));
      if (agents.size > 0) setExpandedAgents(new Set([[...agents][0]!]));
    });
  }, []);

  useEffect(() => {
    for (const slug of expandedProjects) {
      if (!sessionsByProject[slug]) {
        api.sessions(slug).then((s) => {
          setSessionsByProject((prev) => ({ ...prev, [slug]: s }));
        });
      }
    }
  }, [expandedProjects]);

  const grouped = useMemo(() => {
    const groups: {
      agent: string;
      label: string;
      color: string;
      projects: ProjectInfo[];
    }[] = [];
    for (const agent of AGENT_ORDER) {
      const ps = projects.filter((p) => p.agent === agent);
      if (ps.length > 0) {
        groups.push({
          agent,
          label: AGENT_LABELS[agent] ?? agent,
          color: AGENT_COLORS[agent] ?? "#a1a1aa",
          projects: ps,
        });
      }
    }
    return groups;
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return grouped;
    return grouped
      .map((g) => ({
        ...g,
        projects: g.projects.filter(
          (p) =>
            p.path.toLowerCase().includes(q) ||
            (sessionsByProject[p.slug] ?? []).some((s) =>
              s.title.toLowerCase().includes(q),
            ),
        ),
      }))
      .filter((g) => g.projects.length > 0);
  }, [grouped, query, sessionsByProject]);

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-rail">
        <button
          className="rail-toggle"
          onClick={onToggle}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          »
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="dot" />
          <span className="brand-label">Context Visualizer</span>
          <button
            className="rail-toggle collapse"
            onClick={onToggle}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            «
          </button>
        </div>
        <input
          placeholder="Search projects or titles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {filtered.length === 0 && (
        <div className="empty-state-sidebar">No matches.</div>
      )}
      {filtered.map((group) => {
        const agentOpen = expandedAgents.has(group.agent);

        return (
          <div key={group.agent} className="agent-group">
            <div
              className={`agent-name ${agentOpen ? "open" : ""}`}
              onClick={() => {
                setExpandedAgents((prev) => {
                  const n = new Set(prev);
                  if (n.has(group.agent)) n.delete(group.agent);
                  else n.add(group.agent);
                  return n;
                });
              }}
            >
              <span className="chevron">▶</span>
              <span className="agent-dot" style={{ background: group.color }} />
              <span className="label">{group.label}</span>
            </div>
            {agentOpen &&
              group.projects.map((p, i, p_arr) => {
                const isOpen = expandedProjects.has(p.slug);
                const shortLabel =
                  p.path.split("/").slice(-2).join("/") || p.path;

                return (
                  <div key={p.slug} className="project-group">
                    <div
                      className={`project-name ${isOpen ? "open" : ""}`}
                      onClick={() => {
                        setExpandedProjects((prev) => {
                          const n = new Set(prev);
                          if (n.has(p.slug)) n.delete(p.slug);
                          else n.add(p.slug);
                          return n;
                        });
                      }}
                      title={p.path}
                    >
                      <span className="project-chevron">▶</span>
                      <span className="label">{shortLabel}</span>
                      <span className="count">{p.sessionCount}</span>
                    </div>
                    {isOpen &&
                      (sessionsByProject[p.slug] ?? []).map((s) => (
                        <div
                          key={s.id}
                          className={`session-row${selected === s.id ? " selected" : ""}`}
                          onClick={() => onSelect(s)}
                          title={s.title}
                        >
                          <div className="session-title">{s.title}</div>
                          <div className="session-meta">
                            <span className="tokens">
                              {fmtTokens(s.realTotal)} tok
                            </span>
                            {s.hasCompaction && (
                              <span className="compaction-mark">compacted</span>
                            )}
                            <span className="sep">·</span>
                            <span>{fmtDate(s.mtimeMs)}</span>
                          </div>
                        </div>
                      ))}
                    {isOpen && !sessionsByProject[p.slug] && (
                      <div
                        className="loading"
                        style={{ padding: "12px 16px", textAlign: "left" }}
                      >
                        Loading…
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })}
    </aside>
  );
}
