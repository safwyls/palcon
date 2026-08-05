import { afterEach, describe, expect, it, vi } from "vitest";
import { cn, copyText, isPrivateHost, joinAddressFor } from "./utils";

describe("cn", () => {
  it("merges conflicting tailwind classes, last one winning", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-sm", false && "hidden", undefined, "font-bold")).toBe("text-sm font-bold");
  });
});

describe("isPrivateHost", () => {
  it("recognises the RFC1918 ranges and their neighbours", () => {
    for (const h of [
      "10.0.0.5",
      "127.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.10",
      "169.254.1.1",
    ]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it("rejects public v4 and the 172.x addresses outside 16-31", () => {
    for (const h of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "203.0.113.7"]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });

  it("recognises loopback, local-ish names and IPv6 unique-local", () => {
    for (const h of ["localhost", "LOCALHOST", "nas.local", "box.lan", "x.home.arpa", "::1", "[fd00::1]", "fc00::5"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it("treats a blank host and a public name as not private", () => {
    expect(isPrivateHost("")).toBe(false);
    expect(isPrivateHost("   ")).toBe(false);
    expect(isPrivateHost("play.example.com")).toBe(false);
    expect(isPrivateHost("2001:db8::1")).toBe(false);
  });
});

describe("joinAddressFor", () => {
  it("falls back to host:gamePort with no custom address", () => {
    expect(joinAddressFor({ host: "10.0.0.5", gamePort: 8211 })).toBe("10.0.0.5:8211");
    expect(joinAddressFor({ host: "10.0.0.5", gamePort: 8211, joinAddress: "  " })).toBe("10.0.0.5:8211");
  });

  it("appends the game port to a custom address that lacks one", () => {
    expect(joinAddressFor({ host: "10.0.0.5", gamePort: 8211, joinAddress: "play.example.com" })).toBe(
      "play.example.com:8211",
    );
  });

  it("leaves a custom address that already carries a port", () => {
    expect(joinAddressFor({ host: "10.0.0.5", gamePort: 8211, joinAddress: "play.example.com:9999" })).toBe(
      "play.example.com:9999",
    );
  });

  it("does not mistake an IPv6 literal's colons for a port", () => {
    expect(joinAddressFor({ host: "h", gamePort: 8211, joinAddress: "[2001:db8::1]" })).toBe(
      "[2001:db8::1]:8211",
    );
    expect(joinAddressFor({ host: "h", gamePort: 8211, joinAddress: "[2001:db8::1]:9999" })).toBe(
      "[2001:db8::1]:9999",
    );
  });
});

describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the clipboard API in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand on plain-HTTP LAN deployments", async () => {
    // navigator.clipboard only exists in secure contexts, which is exactly
    // where palcon usually isn't.
    vi.stubGlobal("isSecureContext", false);
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;

    await expect(copyText("hello")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    // The scratch textarea must not be left behind in the DOM.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("falls back when the clipboard API rejects", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;

    await expect(copyText("hello")).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it("reports failure when the legacy path throws", async () => {
    vi.stubGlobal("isSecureContext", false);
    document.execCommand = vi.fn().mockImplementation(() => {
      throw new Error("nope");
    });

    await expect(copyText("hello")).resolves.toBe(false);
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
