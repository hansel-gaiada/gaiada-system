// WSK-48a — this package compiles with `lib: ["ES2022"]` (no DOM), so the Web `Request` /
// `Response` / `Headers` classes come from @types/node's globals, but the DOM-only `HeadersInit`
// alias does not. The vendored vocabulary (./vocabulary/problem-details.ts) is a byte-derived copy
// of webdesk/delivery/vocabulary and uses `HeadersInit`, so the alias is supplied here instead of
// editing the vendored file (which the drift test forbids) or widening the whole package to DOM.
// It is the same type the DOM alias denotes for undici's Headers constructor.
type HeadersInit = import("undici-types").HeadersInit;
