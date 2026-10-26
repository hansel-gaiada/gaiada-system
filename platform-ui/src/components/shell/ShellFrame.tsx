"use client";
import { useEffect, type ReactNode } from "react";
import type { Density, Width } from "@/lib/prefs";
import type { SkinKey } from "@/lib/skins";
import { useWorkspaceShell } from "./WorkspaceShellContext";

// SCP-Ka (DW-D51): the shell's frame, `.erp-app`, with the skin of the workspace being drawn. The skin follows the workspace, which the
// shell resolves from the URL on the client (`WorkspaceShellContext`), so the frame is a client component inside the provider; the server
// render resolves the same area from the same pathname, so the first byte already carries the skin.
//
// The Standard skin sets NO attribute: the frame is exactly the one the shell drew before skins existed (Shell.test proves it). Any other
// skin sets `data-skin` here and on <html>, because dialogs, the task drawer and other overlays render outside `.erp-app` and must wear
// the same tokens. Company and Admin belong to no department and are always Standard.

const ROOT_ATTR = "data-skin";

export function ShellFrame({ density, width, children }: { density: Density; width: Width; children: ReactNode }) {
  const shell = useWorkspaceShell();
  const skin: SkinKey = shell?.view.kind === "workspace" ? shell.view.ws.skin : "standard";

  useEffect(() => {
    const root = document.documentElement;
    if (skin === "standard") root.removeAttribute(ROOT_ATTR);
    else root.setAttribute(ROOT_ATTR, skin);
    return () => root.removeAttribute(ROOT_ATTR);
  }, [skin]);

  return (
    <div className="erp-app" data-density={density} data-width={width} {...(skin === "standard" ? {} : { [ROOT_ATTR]: skin })}>
      {children}
    </div>
  );
}
