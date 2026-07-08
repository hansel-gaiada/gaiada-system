import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ConfigField, type ConfigActionState } from "./ConfigField";
import type { ConfigField as ConfigFieldType } from "@/lib/admin";

async function noopAction(_prev: ConfigActionState | null, _formData: FormData): Promise<ConfigActionState> {
  return { ok: true };
}

describe("ConfigField", () => {
  it("renders the field label and a text control", () => {
    const field: ConfigFieldType = {
      key: "digestOptIn",
      label: "Digest opt-in",
      value: "12:00",
      kind: "text",
      editable: true,
    };
    render(<ConfigField field={field} action={noopAction} />);
    expect(screen.getByText("Digest opt-in")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("12:00");
  });

  it("renders a boolean field as a checkbox", () => {
    const field: ConfigFieldType = {
      key: "digestEnabled",
      label: "Digest enabled",
      value: true,
      kind: "boolean",
      editable: true,
    };
    render(<ConfigField field={field} action={noopAction} />);
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("never renders a secret's value — only a Configured/Absent presence badge", () => {
    const field: ConfigFieldType = {
      key: "geminiApiKey",
      label: "Gemini API key",
      value: "sk-super-secret-value",
      kind: "secretPresence",
      editable: true,
    };
    render(<ConfigField field={field} action={noopAction} />);
    expect(screen.getByText("Gemini API key")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("sk-super-secret-value")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("sk-super-secret-value");
  });

  it("renders Absent when a secret is not configured", () => {
    const field: ConfigFieldType = {
      key: "geminiApiKey",
      label: "Gemini API key",
      value: "",
      kind: "secretPresence",
      editable: true,
    };
    render(<ConfigField field={field} action={noopAction} />);
    expect(screen.getByText("Absent")).toBeInTheDocument();
  });
});
