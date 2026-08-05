import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render, type RenderOptions } from "@testing-library/react";
import type { Server } from "../lib/api";

/**
 * A query client tuned for tests: no retries (a deliberate 400 in a test
 * would otherwise be retried three times and the assertion would race the
 * backoff) and no caching between cases.
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderOptions & { route?: string } = {},
) {
  const { route = "/", ...rest } = options;
  const queryClient = makeQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {/* The v7 flags only silence upgrade warnings in test output; they
          don't change behaviour under v6. */}
      <MemoryRouter
        initialEntries={[route]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...rest }) };
}

/** A fully-populated server row; override only what a case cares about. */
export function makeServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 1,
    name: "Palhalla",
    game: "palworld",
    features: [],
    host: "10.99.0.5",
    rconPort: 25575,
    hasRconPassword: true,
    restPort: 8212,
    hasRestPassword: true,
    gamePort: 8211,
    joinAddress: "",
    useRest: true,
    enabled: true,
    savePath: "",
    configPath: "",
    installPath: "",
    agentUrl: "",
    hasAgentToken: false,
    containerName: "",
    hiddenFeatures: [],
    ...overrides,
  };
}
