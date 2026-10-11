import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

// ProseMirror (the visual markdown editor) measures the DOM when a transaction scrolls the selection into view; jsdom has no
// layout engine, so give it empty geometry instead of an exception.
if (typeof Range !== "undefined") {
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = empty;
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
}
if (typeof document !== "undefined" && !document.elementFromPoint) document.elementFromPoint = () => null;
