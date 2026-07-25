import type { ReactNode } from "react";

interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppShell({ sidebar, children }: AppShellProps) {
  return (
    <div className="h-screen flex bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <aside className="w-72 border-r border-gray-800 flex flex-col overflow-hidden">
        {sidebar}
      </aside>

      {/* Content area */}
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
