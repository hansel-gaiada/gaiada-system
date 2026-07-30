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

  it("renders a plain string[] select (options) unchanged — the pre-existing contract still works", () => {
    const field: ConfigFieldType = {
      key: "protocol",
      label: "Protocol",
      value: "https",
      kind: "select",
      options: ["http", "https"],
      editable: true,
    };
    render(<ConfigField field={field} action={noopAction} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("https");
    expect(screen.getByRole("option", { name: "http" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "https" })).toBeInTheDocument();
  });

  it("renders a labelled select (optionItems) showing names instead of raw ids, with a single None row for the bot's explicit empty option", () => {
    const field: ConfigFieldType = {
      key: "managementGroupId",
      label: "Management group",
      value: "999@g.us",
      kind: "select",
      editable: true,
      optionItems: [
        { value: "", label: "None" },
        { value: "111@g.us", label: "Site A" },
        { value: "999@g.us", label: "Mgmt Group" },
      ],
    };
    render(<ConfigField field={field} action={noopAction} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    // Selected value is still the raw JID (that's what gets submitted)...
    expect(select.value).toBe("999@g.us");
    // ...but every visible row is the readable label, never a raw @g.us id in the group rows.
    expect(screen.getByRole("option", { name: "Site A" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Mgmt Group" })).toBeInTheDocument();
    // Exactly one blank-value option (the bot's own "None"), not a second, unlabelled one
    // stacked on top of it.
    const blankOptions = select.querySelectorAll('option[value=""]');
    expect(blankOptions).toHaveLength(1);
    expect(blankOptions[0]).toHaveTextContent("None");
  });

  it("never drops the currently-set group from the dropdown when it isn't in the registry", () => {
    const field: ConfigFieldType = {
      key: "managementGroupId",
      label: "Management group",
      value: "envmgmt@g.us",
      kind: "select",
      editable: true,
      optionItems: [
        { value: "", label: "None" },
        { value: "111@g.us", label: "Site A" },
        { value: "envmgmt@g.us", label: "envmgmt@g.us (not in registry)" },
      ],
    };
    render(<ConfigField field={field} action={noopAction} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("envmgmt@g.us");
    expect(screen.getByRole("option", { name: "envmgmt@g.us (not in registry)" })).toBeInTheDocument();
  });

  it("falls back to a plain text control (no options at all) when the registry is empty, keeping the current value editable", () => {
    const field: ConfigFieldType = {
      key: "managementGroupId",
      label: "Management group",
      value: "envmgmt@g.us",
      kind: "text",
      editable: true,
    };
    render(<ConfigField field={field} action={noopAction} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("envmgmt@g.us");
  });
});
