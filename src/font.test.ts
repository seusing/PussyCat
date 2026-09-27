import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("global MiSans font", () => {
  it("imports the MiSans variable face and applies it with a narrow mask bullet", () => {
    const css = readFileSync(resolve("src/index.css"), "utf8");
    expect(css).toContain('@import "misans/lib/Normal/MiSansVF.min.css";');
    expect(css).toContain('font-family: "Mask Bullet", "MiSans VF", sans-serif !important;');
    expect(css).toContain("unicode-range: U+2022;");
    expect(css).not.toContain("Helvetica");
    expect(css).not.toContain("font-style: oblique");
    expect(css).not.toContain("@fontsource-variable/inter");
  });
});
