import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Pagination } from "./Pagination";

describe("Pagination", () => {
  it("renders nothing when everything fits on one page", () => {
    const { container } = render(<Pagination page={1} pageCount={1} rangeStart={1} rangeEnd={5} total={5} onPageChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the range and page, and disables Prev/Next at the ends", () => {
    render(<Pagination page={1} pageCount={3} rangeStart={1} rangeEnd={15} total={40} onPageChange={() => {}} />);
    expect(screen.getByText("1–15 of 40")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });

  it("calls onPageChange with the adjacent page", () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageCount={3} rangeStart={16} rangeEnd={30} total={40} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});
