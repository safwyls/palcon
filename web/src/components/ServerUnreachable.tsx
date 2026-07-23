export function ServerUnreachable() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <img src="/relaxasaurus.png" alt="Server unreachable" className="w-full max-w-md rounded-lg" />
      <p className="text-sm text-muted-foreground">
        Couldn't reach the server — check that it's running and REST/RCON is reachable from Palcon.
      </p>
    </div>
  );
}
