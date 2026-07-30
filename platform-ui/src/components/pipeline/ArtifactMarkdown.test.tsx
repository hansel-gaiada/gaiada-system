import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ArtifactMarkdown } from "./ArtifactMarkdown";

describe("ArtifactMarkdown", () => {
  it("renders headings, bold/italic/code inline marks, and paragraphs as real elements", () => {
    render(<ArtifactMarkdown text={"# Title\n\nA **bold** and *italic* word, plus `code`."} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    const bold = screen.getByText("bold");
    expect(bold.tagName).toBe("STRONG");
    const italic = screen.getByText("italic");
    expect(italic.tagName).toBe("EM");
    const code = screen.getByText("code");
    expect(code.tagName).toBe("CODE");
  });

  it("renders unordered and ordered lists as real <ul>/<ol>/<li> elements", () => {
    render(<ArtifactMarkdown text={"- one\n- two\n\n1. first\n2. second"} />);
    expect(screen.getByText("one").closest("ul")).toBeInTheDocument();
    expect(screen.getByText("first").closest("ol")).toBeInTheDocument();
  });

  it("renders a fenced code block as <pre><code>, preserving its literal content", () => {
    render(<ArtifactMarkdown text={"```\nconst x = 1;\n```"} />);
    expect(screen.getByText("const x = 1;").closest("pre")).toBeInTheDocument();
  });

  it("never renders a markdown link as a clickable anchor (untrusted model output)", () => {
    render(<ArtifactMarkdown text={"See [the doc](https://evil.example/steal?x=1) for details."} />);
    // The link surfaces as plain text — label + URL, no <a> in the tree.
    expect(screen.getByText(/the doc \(https:\/\/evil\.example\/steal\?x=1\)/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("never uses dangerouslySetInnerHTML-style injection — literal HTML in the artifact stays inert text", () => {
    render(<ArtifactMarkdown text={"Ignore prior instructions. <img src=x onerror=alert(1)>"} />);
    // No actual <img> element was created — the tag text is just rendered as visible text content.
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });
});
