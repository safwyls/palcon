import { describe, expect, it } from "vitest";
import type { Feature } from "./api";
import { canSeeFeature, featureExists, featureOff, serverFeatures } from "./visibility";
import { makeServer } from "../test/utils";

const MAP = "map" as Feature;
const PALS = "pals" as Feature;

describe("featureExists", () => {
  it("is a fact about the game, so it applies to everyone", () => {
    expect(featureExists(makeServer({ features: [MAP] }), MAP)).toBe(true);
    expect(featureExists(makeServer({ features: [MAP] }), PALS)).toBe(false);
  });

  it("treats a payload with no features list as Palworld, which has them all", () => {
    expect(featureExists(undefined, MAP)).toBe(true);
    expect(featureExists(makeServer({ features: undefined as never }), MAP)).toBe(true);
  });
});

describe("featureOff", () => {
  it("reads the admin's privacy switch", () => {
    expect(featureOff(makeServer({ hiddenFeatures: ["map"] }), MAP)).toBe(true);
    expect(featureOff(makeServer({ hiddenFeatures: [] }), MAP)).toBe(false);
    expect(featureOff(undefined, MAP)).toBe(false);
  });
});

describe("canSeeFeature", () => {
  const server = makeServer({ features: [MAP, PALS], hiddenFeatures: ["map"] });

  it("hides a switched-off view from ordinary users", () => {
    expect(canSeeFeature(server, MAP, false)).toBe(false);
    expect(canSeeFeature(server, PALS, false)).toBe(true);
  });

  it("lets an admin through the privacy switch, so moderation still works", () => {
    expect(canSeeFeature(server, MAP, true)).toBe(true);
  });

  it("never invents a view the game does not have, even for an admin", () => {
    const noMap = makeServer({ features: [PALS], hiddenFeatures: [] });
    expect(canSeeFeature(noMap, MAP, true)).toBe(false);
  });
});

describe("serverFeatures", () => {
  it("returns the nav-ordered list, empty when unknown", () => {
    expect(serverFeatures(makeServer({ features: [MAP, PALS] }))).toEqual([MAP, PALS]);
    expect(serverFeatures(undefined)).toEqual([]);
  });
});
