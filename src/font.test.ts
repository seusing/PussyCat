import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("global Helvetica font", () => {
  it("ships the supplied static face and applies it without a fallback family", () => {
    const css = readFileSync(resolve("src/index.css"), "utf8");
    const font = resolve("src/assets/fonts/Helvetica.ttf");
    expect(statSync(font).size).toBeGreaterThan(40_000);
    expect(readFileSync(font).subarray(0, 4).toString("hex")).toBe("00010000");
    expect(css).toContain('font-family: "Helvetica";');
    expect(css).toContain('url("./assets/fonts/Helvetica.ttf")');
    expect(css).toContain("font-display: swap");
    expect(css).toContain("font-style: oblique");
    expect(css).toContain("font-weight: 700");
    expect(css).not.toContain("@fontsource-variable/inter");
  });
});
