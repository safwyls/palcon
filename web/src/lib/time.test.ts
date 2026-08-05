import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agoLabel, agoSeconds, lastSeenLabel, seenLabel, seenPhrase, seenSentence } from "./time";

const NOW = new Date("2026-08-04T12:00:00Z");

describe("agoSeconds", () => {
  it("picks the largest unit that fits", () => {
    expect(agoSeconds(0)).toBe("0s ago");
    expect(agoSeconds(59)).toBe("59s ago");
    expect(agoSeconds(60)).toBe("1m ago");
    expect(agoSeconds(3599)).toBe("59m ago");
    expect(agoSeconds(3600)).toBe("1h ago");
    expect(agoSeconds(86399)).toBe("23h ago");
    expect(agoSeconds(86400)).toBe("1d ago");
    expect(agoSeconds(86400 * 9)).toBe("9d ago");
  });

  it("clamps a negative age to zero rather than printing '-3s ago'", () => {
    expect(agoSeconds(-3)).toBe("0s ago");
  });
});

describe("relative labels", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("agoLabel measures back from now", () => {
    expect(agoLabel(new Date(NOW.getTime() - 7200_000).toISOString())).toBe("2h ago");
  });

  it("lastSeenLabel blanks a missing stamp and softens the recent past", () => {
    // Offline times are only ever save-accurate, so anything inside 90s is
    // reported as "just now" rather than a precise-looking second count.
    expect(lastSeenLabel(0)).toBe("");
    expect(lastSeenLabel(NOW.getTime() / 1000 - 30)).toBe("just now");
    expect(lastSeenLabel(NOW.getTime() / 1000 - 89)).toBe("just now");
    expect(lastSeenLabel(NOW.getTime() / 1000 - 91)).toBe("1m ago");
  });

  describe("seen* say 'joined' whenever the fallback stamp is in use", () => {
    const seenOnly = { lastSeen: NOW.getTime() / 1000 - 7200, lastOnline: 0 };
    const onlineOnly = { lastSeen: 0, lastOnline: NOW.getTime() / 1000 - 18000 };
    const neither = { lastSeen: 0, lastOnline: 0 };

    it("seenLabel", () => {
      expect(seenLabel(seenOnly)).toBe("2h ago");
      expect(seenLabel(onlineOnly)).toBe("joined 5h ago");
      expect(seenLabel(neither)).toBe("");
    });

    it("seenPhrase", () => {
      expect(seenPhrase(seenOnly)).toBe("seen 2h ago");
      expect(seenPhrase(onlineOnly)).toBe("joined 5h ago");
      expect(seenPhrase(neither)).toBe("");
    });

    it("seenSentence", () => {
      expect(seenSentence(seenOnly)).toBe("Last seen 2h ago");
      expect(seenSentence(onlineOnly)).toBe("Joined 5h ago");
      expect(seenSentence(neither)).toBe("Offline");
    });

    it("prefers palcon's own observation over the save's login stamp", () => {
      // lastOnline is written at *login* and never updated, so it would
      // understate an offline player by their whole last session.
      const both = { lastSeen: NOW.getTime() / 1000 - 60, lastOnline: NOW.getTime() / 1000 - 86400 };
      expect(seenSentence(both)).toBe("Last seen just now");
    });
  });
});
