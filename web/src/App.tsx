import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Detail } from "./components/Detail";
import type { SessionListItem } from "./api";

export function App() {
  const [selected, setSelected] = useState<SessionListItem | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar
        selected={selected?.id ?? null}
        onSelect={setSelected}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
      <main className="main">
        {selected ? (
          <Detail session={selected} />
        ) : (
          <div className="empty">
            <h2>Claude Context Visualizer</h2>
            <p>Select a session from the left to see its context breakdown.</p>
          </div>
        )}
      </main>
    </div>
  );
}
