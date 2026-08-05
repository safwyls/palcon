import { describe, expect, it } from "vitest";
import { ELEMENT_COLORS, elementColor, elementCounters } from "./elements";

describe("elementColor", () => {
  it("returns the token for each of the nine elements", () => {
    expect(elementColor("Fire")).toBe(ELEMENT_COLORS.Fire);
    expect(Object.keys(ELEMENT_COLORS)).toHaveLength(9);
  });

  it("falls back to the Normal token for anything unknown", () => {
    expect(elementColor("Plastic")).toBe("#9C9186");
    expect(elementColor("")).toBe("#9C9186");
  });
});

describe("elementCounters", () => {
  it("follows the cycle", () => {
    expect(elementCounters(["Fire"])).toEqual(["Water"]);
    expect(elementCounters(["Water"])).toEqual(["Electricity"]);
    expect(elementCounters(["Electricity"])).toEqual(["Earth"]);
    expect(elementCounters(["Earth"])).toEqual(["Leaf"]);
    expect(elementCounters(["Leaf"])).toEqual(["Fire"]);
  });

  it("handles the two strays off the cycle", () => {
    // Ice loses to Fire rather than to its own predecessor, and Normal
    // only loses to Dark.
    expect(elementCounters(["Ice"])).toEqual(["Fire"]);
    expect(elementCounters(["Normal"])).toEqual(["Dark"]);
    expect(elementCounters(["Dragon"])).toEqual(["Ice"]);
    expect(elementCounters(["Dark"])).toEqual(["Dragon"]);
  });

  it("deduplicates while keeping the order given", () => {
    // Leaf and Ice are both answered by Fire; it should appear once.
    expect(elementCounters(["Leaf", "Ice"])).toEqual(["Fire"]);
    expect(elementCounters(["Dragon", "Fire"])).toEqual(["Ice", "Water"]);
  });

  it("returns nothing for a typeless pal, which is the honest answer", () => {
    expect(elementCounters([])).toEqual([]);
    expect(elementCounters(["Cosmic"])).toEqual([]);
  });
});
