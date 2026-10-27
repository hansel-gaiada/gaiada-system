import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PinOverlay, pinsFromComments } from "./PinOverlay";

const FILE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const comments = [
  { id: "c-1", body: "No pin here", anchor: null },
  { id: "c-2", body: "Move the logo up", anchor: { x: 0.25, y: 0.5, fileId: FILE } },
  { id: "c-3", body: "Another file's pin", anchor: { x: 0.9, y: 0.9, fileId: OTHER } },
  { id: "c-4", body: "Crop the right edge", anchor: { x: 0.8, y: 0.1, fileId: FILE } },
];

const rect = (w: number, h: number, l = 0, t = 0) => () => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON: () => ({}) });

describe("pinsFromComments", () => {
  it("numbers the anchored comments in thread order and skips the others", () => {
    const pins = pinsFromComments(comments);
    expect(pins.map((p) => [p.id, p.n])).toEqual([["c-2", 1], ["c-3", 2], ["c-4", 3]]);
  });

  it("shortens a long comment to a label", () => {
    const [p] = pinsFromComments([{ id: "x", body: "w".repeat(200), anchor: { x: 0, y: 0, fileId: FILE } }]);
    expect(p.label!.length).toBeLessThanOrEqual(60);
  });
});

describe("PinOverlay (SCP-1l)", () => {
  const pins = pinsFromComments(comments);

  it("draws a labelled button for each pin of the file it shows, positioned by its fractions, and none of another file's", () => {
    render(<PinOverlay src="/mock.jpg" alt="Mock design" fileId={FILE} pins={pins} />);
    const one = screen.getByRole("button", { name: "Pin 1: Move the logo up" });
    expect(one).toHaveTextContent("1");
    expect(one).toHaveStyle({ left: "25%", top: "50%" });
    expect(screen.getByRole("button", { name: "Pin 3: Crop the right edge" })).toHaveStyle({ left: "80%", top: "10%" });
    expect(screen.queryByRole("button", { name: /Pin 2/ })).not.toBeInTheDocument();
    expect(screen.getByAltText("Mock design")).toBeInTheDocument();
  });

  it("a pin is reachable by keyboard and reports its selection", () => {
    const onSelectPin = vi.fn();
    render(<PinOverlay src="/mock.jpg" alt="Mock design" fileId={FILE} pins={pins} onSelectPin={onSelectPin} selectedId="c-4" />);
    const first = screen.getByRole("button", { name: /Pin 1/ });
    first.focus();
    expect(first).toHaveFocus();
    fireEvent.click(first);
    expect(onSelectPin).toHaveBeenCalledWith(expect.objectContaining({ id: "c-2", n: 1 }));
    expect(screen.getByRole("button", { name: /Pin 3/ })).toHaveAttribute("aria-pressed", "true");
    expect(first).toHaveAttribute("aria-pressed", "false");
  });

  it("offers no place surface unless in place mode", () => {
    render(<PinOverlay src="/mock.jpg" alt="Mock design" fileId={FILE} pins={[]} onPlace={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Place a pin/ })).not.toBeInTheDocument();
  });

  it("a click in place mode answers the anchor as fractions of the image", () => {
    const onPlace = vi.fn();
    render(<PinOverlay src="/mock.jpg" alt="Mock design" fileId={FILE} pins={[]} placing onPlace={onPlace} />);
    const surface = screen.getByRole("button", { name: /Place a pin/ });
    surface.getBoundingClientRect = rect(200, 100, 100, 50);
    fireEvent.click(surface, { clientX: 150, clientY: 100, detail: 1 });
    expect(onPlace).toHaveBeenCalledWith({ x: 0.25, y: 0.5, fileId: FILE });
  });

  it("a click outside the box is clamped into 0 to 1", () => {
    const onPlace = vi.fn();
    render(<PinOverlay src="/mock.jpg" alt="Mock design" fileId={FILE} pins={[]} placing onPlace={onPlace} />);
    const surface = screen.getByRole("button", { name: /Place a pin/ });
    surface.getBoundingClientRect = rect(100, 100);
    fireEvent.click(surface, { clientX: 150, clientY: -20, detail: 1 });
    expect(onPlace).toHaveBeenCalledWith({ x: 1, y: 0, fileId: FILE });
  });

  it("place mode works from the keyboard alone: arrows move the marker, Enter places, Escape cancels", () => {
    const onPlace = vi.fn();
    const onCancelPlace = vi.fn();
    render(<PinOverlay src="/mock.jpg" alt="Mock design" fileId={FILE} pins={[]} placing onPlace={onPlace} onCancelPlace={onCancelPlace} />);
    const surface = screen.getByRole("button", { name: /Place a pin/ });
    surface.focus();
    expect(surface).toHaveFocus();
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    fireEvent.keyDown(surface, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(onPlace).toHaveBeenCalledTimes(1);
    const a = onPlace.mock.calls[0][0] as { x: number; y: number; fileId: string };
    expect(a.fileId).toBe(FILE);
    expect(a.x).toBeCloseTo(0.55, 5);
    expect(a.y).toBeCloseTo(0.51, 5);
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(onCancelPlace).toHaveBeenCalledTimes(1);
  });

  it("the marker never leaves the image", () => {
    const onPlace = vi.fn();
    render(<PinOverlay src="/mock.jpg" alt="Mock design" fileId={FILE} pins={[]} placing onPlace={onPlace} />);
    const surface = screen.getByRole("button", { name: /Place a pin/ });
    for (let i = 0; i < 30; i++) fireEvent.keyDown(surface, { key: "ArrowLeft" });
    for (let i = 0; i < 30; i++) fireEvent.keyDown(surface, { key: "ArrowUp" });
    fireEvent.keyDown(surface, { key: " " });
    expect(onPlace).toHaveBeenCalledWith({ x: 0, y: 0, fileId: FILE });
  });
});
