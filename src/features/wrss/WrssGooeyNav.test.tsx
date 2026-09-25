import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import WrssGooeyNav from "./WrssGooeyNav";

describe("WrssGooeyNav", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects content views and leaves auxiliary views unselected", () => {
    const onChange = vi.fn();
    const { rerender } = render(<WrssGooeyNav view="latest" onChange={onChange} reduced />);
    expect(screen.getByRole("button", { name: "最新文章" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "我的收藏" }));
    expect(onChange).toHaveBeenCalledWith("favorites");
    rerender(<WrssGooeyNav view="authorization" onChange={onChange} reduced />);
    expect(screen.getAllByRole("button").every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("forms stable nowrap rows from intrinsic widths at narrow sizes", () => {
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "BUTTON" ? 80 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("wrss-gooey-nav") ? 190 : 0;
    });
    const { container } = render(<WrssGooeyNav view="latest" onChange={() => {}} reduced />);
    act(() => resize());
    expect(container.querySelectorAll(".wrss-gooey-nav > ul")).toHaveLength(2);
    expect([...container.querySelectorAll(".wrss-gooey-nav > ul")].map((row) => row.children.length)).toEqual([2, 1]);
    const markup = container.innerHTML;
    act(() => { resize(); resize(); resize(); });
    expect(container.innerHTML).toBe(markup);
    vi.restoreAllMocks();
  });
});
