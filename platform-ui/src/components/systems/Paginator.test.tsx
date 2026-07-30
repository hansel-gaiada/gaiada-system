import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, renderHook, act } from "@testing-library/react";
import { Paginator, usePagination } from "./Paginator";

function makeItems(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

describe("usePagination", () => {
  it("puts 30 items on page 1 in full when the list fits on one page", () => {
    const { result } = renderHook(() => usePagination(makeItems(20), 30));
    expect(result.current.pageItems).toEqual(makeItems(20));
    expect(result.current.pageCount).toBe(1);
    expect(result.current.rangeStart).toBe(1);
    expect(result.current.rangeEnd).toBe(20);
    expect(result.current.total).toBe(20);
  });

  it("splits a 214-item list into ceil(214/30) = 8 pages, with the last page short", () => {
    const { result } = renderHook(() => usePagination(makeItems(214), 30));
    expect(result.current.pageCount).toBe(8);
    expect(result.current.pageItems).toHaveLength(30);
    expect(result.current.rangeStart).toBe(1);
    expect(result.current.rangeEnd).toBe(30);

    act(() => result.current.setPage(8));
    expect(result.current.pageItems).toHaveLength(4); // 214 - 7*30
    expect(result.current.rangeStart).toBe(211);
    expect(result.current.rangeEnd).toBe(214);
  });

  it("advancing to page 2 shows items 31-60", () => {
    const { result } = renderHook(() => usePagination(makeItems(90), 30));
    act(() => result.current.setPage(2));
    expect(result.current.pageItems).toEqual(makeItems(90).slice(30, 60));
    expect(result.current.rangeStart).toBe(31);
    expect(result.current.rangeEnd).toBe(60);
  });

  it("clamps setPage requests below 1 or above the last page", () => {
    const { result } = renderHook(() => usePagination(makeItems(90), 30));
    act(() => result.current.setPage(0));
    expect(result.current.page).toBe(1);
    act(() => result.current.setPage(999));
    expect(result.current.page).toBe(3);
  });

  it("clamps the current page down when the underlying list shrinks below it — never an empty page", () => {
    const { result, rerender } = renderHook(({ items }) => usePagination(items, 30), {
      initialProps: { items: makeItems(90) },
    });
    act(() => result.current.setPage(3)); // items 61-90
    expect(result.current.page).toBe(3);

    // The list shrinks to 40 items (e.g. a filter narrowed it) — page 3 no longer exists.
    rerender({ items: makeItems(40) });
    expect(result.current.pageCount).toBe(2);
    expect(result.current.page).toBe(2);
    expect(result.current.pageItems.length).toBeGreaterThan(0);
  });

  it("resets to page 1 when resetKey changes (e.g. the active search term)", () => {
    const { result, rerender } = renderHook(({ items, key }) => usePagination(items, 30, key), {
      initialProps: { items: makeItems(90), key: "" as string },
    });
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);

    rerender({ items: makeItems(90), key: "ops" });
    expect(result.current.page).toBe(1);
  });

  it("does NOT reset the page when only the items array's identity changes but resetKey stays the same (a poll refresh)", () => {
    const { result, rerender } = renderHook(({ items, key }) => usePagination(items, 30, key), {
      initialProps: { items: makeItems(90), key: "same" as string },
    });
    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);

    // New array reference, same length/content shape, same resetKey — simulates a poll re-fetch.
    rerender({ items: makeItems(90), key: "same" });
    expect(result.current.page).toBe(2);
  });

  it("total of 0 yields rangeStart 0 and a single (empty) page", () => {
    const { result } = renderHook(() => usePagination(makeItems(0), 30));
    expect(result.current.total).toBe(0);
    expect(result.current.rangeStart).toBe(0);
    expect(result.current.rangeEnd).toBe(0);
    expect(result.current.pageCount).toBe(1);
  });
});

describe("Paginator", () => {
  it("renders nothing when there is only one page", () => {
    const { container } = render(
      <Paginator page={1} pageCount={1} rangeStart={1} rangeEnd={5} total={5} onPageChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current range and total, and announces the current page", () => {
    render(<Paginator page={2} pageCount={8} rangeStart={31} rangeEnd={60} total={214} onPageChange={() => {}} />);
    expect(screen.getByText("31–60 of 214")).toBeInTheDocument();
    const current = screen.getByText("Page 2 of 8");
    expect(current).toHaveAttribute("aria-current", "page");
  });

  it("disables Previous on the first page and Next on the last page", () => {
    const { rerender } = render(
      <Paginator page={1} pageCount={3} rangeStart={1} rangeEnd={30} total={90} onPageChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();

    rerender(<Paginator page={3} pageCount={3} rangeStart={61} rangeEnd={90} total={90} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Previous page" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("calls onPageChange with page-1/page+1 when Prev/Next are clicked", () => {
    let page = 2;
    const onPageChange = (p: number) => {
      page = p;
    };
    render(<Paginator page={2} pageCount={5} rangeStart={31} rangeEnd={60} total={150} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(page).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(page).toBe(1);
  });
});
