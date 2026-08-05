import { describe, expect, it } from "vitest";
import { PALETTE, formatUptime, initials, pingColorClass, playerColor, serverColor } from "./palette";

describe("serverColor", () => {
  it("cycles the palette and is stable for an id", () => {
    expect(serverColor(0)).toBe(PALETTE[0]);
    expect(serverColor(PALETTE.length)).toBe(PALETTE[0]);
    expect(serverColor(3)).toBe(serverColor(3));
  });
});

describe("playerColor", () => {
  it("is deterministic and stays inside the palette", () => {
    expect(playerColor("abc")).toBe(playerColor("abc"));
    for (const id of ["", "a", "steam_76561198000000000", "🙂"]) {
      expect(PALETTE).toContain(playerColor(id));
    }
  });
});

describe("initials", () => {
  it("takes one letter from each of the first two words", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("  ada   lovelace  ")).toBe("AL");
    expect(initials("Ada Lovelace Byron")).toBe("AL");
  });

  it("takes two letters from a single word", () => {
    expect(initials("ada")).toBe("Ad");
    expect(initials("a")).toBe("A");
  });

  it("falls back to ?? for an empty or blank name", () => {
    expect(initials("")).toBe("??");
    expect(initials("   ")).toBe("??");
  });
});

describe("pingColorClass", () => {
  it("steps at the 60/120ms boundaries", () => {
    expect(pingColorClass(0)).toBe("text-pal-green");
    expect(pingColorClass(60)).toBe("text-pal-green");
    expect(pingColorClass(61)).toBe("text-brand-amber");
    expect(pingColorClass(120)).toBe("text-brand-amber");
    expect(pingColorClass(121)).toBe("text-brand-red");
  });
});

describe("formatUptime", () => {
  it("drops the day part below 24h", () => {
    expect(formatUptime(0)).toBe("0h 0m");
    expect(formatUptime(3660)).toBe("1h 1m");
    expect(formatUptime(86399)).toBe("23h 59m");
  });

  it("includes days once there are any", () => {
    expect(formatUptime(86400)).toBe("1d 0h 0m");
    expect(formatUptime(90061)).toBe("1d 1h 1m");
  });
});
