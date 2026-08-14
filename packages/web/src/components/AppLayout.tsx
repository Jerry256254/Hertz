import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
