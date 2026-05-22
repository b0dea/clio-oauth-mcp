import { describe, it, expect } from "vitest";
import { toIso } from "../calendar.js";

describe("toIso", () => {
  describe("date-only input", () => {
    it("expands to start of day by default", () => {
      expect(toIso("2026-06-01")).toBe("2026-06-01T00:00:00");
    });

    it("expands to end of day when endOfDay=true", () => {
      expect(toIso("2026-06-01", true)).toBe("2026-06-01T23:59:59");
    });
  });

  describe("date+HH:MM input", () => {
    it("pads seconds", () => {
      expect(toIso("2026-06-01T09:00")).toBe("2026-06-01T09:00:00");
    });

    it("endOfDay flag is ignored when time is present", () => {
      expect(toIso("2026-06-01T09:00", true)).toBe("2026-06-01T09:00:00");
    });
  });

  describe("date+HH:MM:SS input", () => {
    it("passes through unchanged", () => {
      expect(toIso("2026-06-01T09:00:00")).toBe("2026-06-01T09:00:00");
    });

    it("endOfDay flag is ignored when time is present", () => {
      expect(toIso("2026-06-01T09:00:00", true)).toBe("2026-06-01T09:00:00");
    });
  });
});
