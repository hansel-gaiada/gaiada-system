import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Field } from "./Field";

// DW-10h. The control sits in a wrapping <label> that also holds the hint and the error; the control
// is named from the label TEXT alone (aria-labelledby) and the hint/error are its description.
describe("Field accessible name and description", () => {
  it("text input: the name is exactly the label, the hint is the description", () => {
    render(<Field name="code" label="Code" hint="Letters and digits only" />);
    const el = screen.getByRole("textbox", { name: "Code" });
    expect(el).toHaveAccessibleName("Code");
    expect(el).toHaveAccessibleDescription("Letters and digits only");
    expect(screen.getByLabelText("Code", { exact: true })).toBe(el);
  });

  it("textarea: the name is exactly the label, the hint is the description", () => {
    render(<Field name="bodyMd" label="Terms" type="textarea" defaultValue="Some long body" hint="Markdown. The client reads this in their portal." />);
    const el = screen.getByRole("textbox", { name: "Terms" });
    expect(el.tagName).toBe("TEXTAREA");
    expect(el).toHaveAccessibleName("Terms");
    expect(el).toHaveAccessibleDescription("Markdown. The client reads this in their portal.");
    expect(screen.getByLabelText("Terms", { exact: true })).toBe(el);
  });

  it("select: the options and the hint are not part of the name", () => {
    render(<Field name="cur" label="Currency" type="select" options={["USD", "EUR"]} defaultValue="EUR" hint="Invoices are issued in this currency" />);
    const el = screen.getByRole("combobox", { name: "Currency" });
    expect(el).toHaveAccessibleName("Currency");
    expect(el).toHaveAccessibleDescription("Invoices are issued in this currency");
  });

  it("select with optionItems keeps the exact name", () => {
    render(<Field name="dept" label="Department" type="select" optionItems={[{ value: "1", label: "Design" }]} hint="Pick one" />);
    expect(screen.getByRole("combobox")).toHaveAccessibleName("Department");
  });

  it("checkbox: the name is exactly the label, the hint is the description", () => {
    render(<Field name="notify" label="Notify the client" type="boolean" hint="Sends an email on save" />);
    const el = screen.getByRole("checkbox", { name: "Notify the client" });
    expect(el).toHaveAccessibleName("Notify the client");
    expect(el).toHaveAccessibleDescription("Sends an email on save");
  });

  it("number and date controls are named from the label alone too", () => {
    render(
      <>
        <Field name="qty" label="Quantity" type="number" hint="Whole units" />
        <Field name="due" label="Due date" type="date" hint="YYYY-MM-DD" />
      </>,
    );
    expect(screen.getByRole("spinbutton")).toHaveAccessibleName("Quantity");
    expect(screen.getByLabelText("Due date", { exact: true })).toHaveAccessibleDescription("YYYY-MM-DD");
  });

  it("an error is part of the description, not the name, and sets aria-invalid", () => {
    render(<Field name="code" label="Code" hint="Letters and digits only" error="Code is required" required />);
    const el = screen.getByRole("textbox", { name: "Code" });
    expect(el).toHaveAccessibleName("Code");
    expect(el).toHaveAccessibleDescription(expect.stringContaining("Code is required"));
    expect(el).toHaveAttribute("aria-invalid", "true");
    expect(el).toBeRequired();
  });

  it("a textarea and a checkbox with an error keep the exact name and aria-invalid on the textarea", () => {
    render(
      <>
        <Field name="a" label="Notes" type="textarea" error="Too long" />
        <Field name="b" label="Agree" type="boolean" error="You must agree" />
      </>,
    );
    const ta = screen.getByRole("textbox", { name: "Notes" });
    expect(ta).toHaveAccessibleDescription("Too long");
    expect(ta).toHaveAttribute("aria-invalid", "true");
    const cb = screen.getByRole("checkbox", { name: "Agree" });
    expect(cb).toHaveAccessibleDescription("You must agree");
  });

  it("two fields on one page do not share label ids", () => {
    render(
      <>
        <Field name="a" label="First" />
        <Field name="b" label="Second" />
      </>,
    );
    expect(screen.getByLabelText("First", { exact: true })).toHaveAttribute("name", "a");
    expect(screen.getByLabelText("Second", { exact: true })).toHaveAttribute("name", "b");
  });
});
