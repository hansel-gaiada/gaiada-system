import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ClientForm, EditClientForm } from "./ClientWorkForms";
import { registry } from "@/lib/clientCentre";

// PV3-04 (PV-D1): the business type is a REQUIRED choice on New client, and on Edit for a client that has
// none yet. "Refuses to submit" is the browser's own constraint validation on a required <select> whose
// selected option is the empty placeholder; the server action refuses it again (clientWorkActions.test.ts).

const action = vi.fn(async () => ({}));
const typeSelect = (c: HTMLElement) => c.querySelector('select[name="businessType"]') as HTMLSelectElement;
const groupSelect = (c: HTMLElement) => c.querySelector('select[name="groupCompanyId"]') as HTMLSelectElement | null;

describe("ClientForm · business type", () => {
  it("offers every registry type plus an unselectable placeholder, and starts on the placeholder", () => {
    const { container } = render(<ClientForm action={action} />);
    const select = typeSelect(container);
    expect(select).not.toBeNull();
    expect(select.required).toBe(true);
    expect(select.value).toBe("");
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["", ...registry.businessTypes.map((b) => b.id)]);
    expect(select.options[0].disabled).toBe(true);
    // "Other" is a real, explicit choice, not hidden behind the placeholder.
    expect(values).toContain("other");
  });

  it("🔴 will not submit until a type is chosen", () => {
    const { container } = render(<ClientForm action={action} />);
    const select = typeSelect(container);
    expect(select.validity.valueMissing).toBe(true);
    expect(select.checkValidity()).toBe(false);
    fireEvent.change(select, { target: { value: "hotel" } });
    expect(select.validity.valueMissing).toBe(false);
    expect(select.checkValidity()).toBe(true);
    fireEvent.change(select, { target: { value: "other" } });
    expect(select.checkValidity()).toBe(true);
  });

  it("shows no group-company picker unless the page offered one", () => {
    expect(groupSelect(render(<ClientForm action={action} />).container)).toBeNull();
    const { container } = render(<ClientForm action={action} groupCompanies={[{ id: "co-sib", name: "Sibling Co" }]} />);
    const g = groupSelect(container)!;
    expect(g).not.toBeNull();
    expect([...g.options].map((o) => o.value)).toEqual(["", "co-sib"]);
    expect(g.required).toBe(false);
  });
});

describe("EditClientForm · business type", () => {
  const base = { action, name: "Acme", status: "active", statusOptions: ["active", "prospect", "archived"], contact: {}, ownerUserId: null, owners: [] };

  it("🔴 a client with no profile row has NOTHING preselected, and the form will not submit until one is chosen", () => {
    const { container } = render(<EditClientForm {...base} businessType={null} />);
    const select = typeSelect(container);
    expect(select.value).toBe("");
    expect(select.validity.valueMissing).toBe(true);
    fireEvent.change(select, { target: { value: "other" } });
    expect(select.checkValidity()).toBe(true);
  });

  it("a client with a type preselects it (including an explicit 'other')", () => {
    expect(typeSelect(render(<EditClientForm {...base} businessType="spa" />).container).value).toBe("spa");
    const other = typeSelect(render(<EditClientForm {...base} businessType="other" />).container);
    expect(other.value).toBe("other");
    expect(other.checkValidity()).toBe(true);
  });

  it("the group-company picker appears only for an operator and preselects the current link", () => {
    expect(groupSelect(render(<EditClientForm {...base} businessType="spa" />).container)).toBeNull();
    const { container } = render(
      <EditClientForm {...base} businessType="spa" groupCompanies={[{ id: "co-sib", name: "Sibling Co" }]} groupCompanyId="co-sib" />,
    );
    expect(groupSelect(container)!.value).toBe("co-sib");
  });
});
