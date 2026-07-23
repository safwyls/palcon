import { ServerCog } from "lucide-react";

export function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <ServerCog className="h-10 w-10 text-muted-foreground/50" />
      <p className="text-muted-foreground">Select a server from the sidebar, or add one to get started.</p>
    </div>
  );
}
