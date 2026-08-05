import { describe, expect, it } from "vitest";
import type { Feature } from "./api";
import { FEATURE_ROUTES, featureBlurb, featureLabel, gameProfile } from "./games";
import { makeServer } from "../test/utils";

describe("gameProfile", () => {
  it("returns the Palworld profile by id", () => {
    expect(gameProfile("palworld").name).toBe("Palworld");
  });

  it("falls back to Palworld for an empty id — every pre-multi-game server", () => {
    expect(gameProfile("")).toBe(gameProfile("palworld"));
    expect(gameProfile(undefined)).toBe(gameProfile("palworld"));
  });

  it("falls back for a game this build doesn't know, so nav still works", () => {
    // The backend is the authority on which views exist; an unknown game
    // navigates correctly, just with borrowed words.
    expect(gameProfile("ark")).toBe(gameProfile("palworld"));
  });
});

describe("featureLabel", () => {
  it("uses the game's own vocabulary", () => {
    const server = makeServer({ game: "palworld" });
    expect(featureLabel(server, "paldex" as Feature)).toBe("Paldex");
    expect(featureLabel(server, "pals" as Feature)).toBe("Player pals");
  });

  it("degrades to the raw key for a feature the profile has no word for", () => {
    expect(featureLabel(makeServer(), "brandnew" as Feature)).toBe("brandnew");
  });

  it("works with no server at all", () => {
    expect(featureLabel(undefined, "map" as Feature)).toBe("Live map");
  });
});

describe("featureBlurb", () => {
  it("describes a view from the player's side", () => {
    expect(featureBlurb(makeServer(), "map" as Feature)).toMatch(/where players are/i);
  });

  it("is empty for an unknown feature", () => {
    expect(featureBlurb(makeServer(), "brandnew" as Feature)).toBe("");
  });
});

describe("FEATURE_ROUTES", () => {
  it("keeps the pals view at its historical /players segment", () => {
    // The segment is part of the URL contract; changing it breaks bookmarks.
    expect(FEATURE_ROUTES.pals).toBe("players");
  });

  it("covers every labelled feature", () => {
    for (const key of Object.keys(gameProfile("palworld").labels) as Feature[]) {
      expect(FEATURE_ROUTES[key], key).toBeTruthy();
    }
  });
});
