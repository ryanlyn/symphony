import { useHashRouter } from "./shared/hooks/useHashRouter";
import { useOpsState } from "./features/ops/hooks/useOpsState";
import { OpsOverview } from "./features/ops/components/OpsOverview";
import { TraceView } from "./features/traceviz/components/TraceView";
import { cn } from "./lib/utils";
import lorenzLogo from "./assets/lorenz-logo.png";

function NavLink({ href, active, children }: { href: string; active: boolean; children: string }) {
  return (
    <a
      href={href}
      className={cn(
        "rounded-lg px-3.5 py-1.5 text-sm transition-colors",
        active
          ? "bg-accent/10 text-accent shadow-[inset_0_0_0_1px_rgba(45,212,168,0.25)]"
          : "text-muted hover:text-foreground",
      )}
    >
      {children}
    </a>
  );
}

export function App() {
  const { route, navigate } = useHashRouter();
  const { state: opsState, connected: opsConnected } = useOpsState();

  return (
    <div className="min-h-screen text-foreground">
      <div className="h-0.5 bg-gradient-to-r from-[#0e7d64] via-30% via-accent to-[#1c5f74]" />
      <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur">
        <div className="bg-gradient-to-b from-accent/[0.05] to-transparent">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
            <a href="#/" className="flex items-center gap-2.5">
              <img src={lorenzLogo} alt="" className="h-6 w-auto" />
              <h1 className="text-base font-semibold tracking-tight">Lorenz</h1>
              <span className="rounded-full border border-border px-2 py-px text-[11px] text-faint">
                observability
              </span>
            </a>
            <nav className="flex items-center gap-1">
              <NavLink href="#/" active={route.view === "overview"}>
                Overview
              </NavLink>
              <NavLink href="#/trace/" active={route.view === "trace"}>
                Issues
              </NavLink>
            </nav>
            <div
              className={cn(
                "ml-auto flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs",
                opsConnected ? "text-muted" : "text-accent-amber",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  opsConnected
                    ? "bg-accent shadow-[0_0_8px_var(--color-accent)]"
                    : "animate-pulse bg-accent-amber",
                )}
              />
              {opsConnected ? "Live stream" : "Connecting…"}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {route.view === "overview" && <OpsOverview state={opsState} connected={opsConnected} />}
        {route.view === "trace" && (
          <TraceView issueId={route.issueId} onBack={() => navigate("/")} />
        )}
      </main>
    </div>
  );
}
