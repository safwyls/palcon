import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, errorDetail, setUnauthorizedHandler } from "./api";

/** Builds a fetch Response the request helper will accept. */
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("request", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  it("prefixes /api and sends cookies, so an authed session is actually used", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api.listServers();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/servers");
    expect(init.credentials).toBe("include");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("returns undefined for 204 rather than choking on an empty body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.deleteServer(1)).resolves.toBeUndefined();
  });

  it("throws ApiError carrying the server's own message", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "ports must be distinct" }, 400));

    const err = await api.listServers().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("ports must be distinct");
    expect(errorDetail(err)).toBe("ports must be distinct");
  });

  it("falls back to the status text when the body carries no error field", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503, statusText: "Service Unavailable" }));

    const err = await api.listServers().catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.message).toBe("Service Unavailable");
  });

  it("notifies the unauthorized handler on a 401, so the app bounces to login once", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse({ error: "expired" }, 401));

    await api.listServers().catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("treats /login's own 401 as a wrong password, not an expired session", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid credentials" }, 401));

    await api.login("admin", "wrong").catch(() => {});
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("errorDetail ignores non-ApiError throwables", () => {
    expect(errorDetail(new Error("boom"))).toBeUndefined();
    expect(errorDetail("boom")).toBeUndefined();
    expect(errorDetail(new ApiError(500, ""))).toBeUndefined();
  });
});

describe("deleteServer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks for a plain row deletion by default", async () => {
    await api.deleteServer(7);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/servers/7");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("opts into container removal only when asked", async () => {
    await api.deleteServer(7, true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/servers/7?removeContainer=true");
  });
});
