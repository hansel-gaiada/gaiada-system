// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-08-08; superseded by PRV-02 live recordings
//
// GET /api/projects/:id response shape (PRV seam §04). Returns the project's current status,
// URLs, and metadata. Status field values: "pending" | "provisioned" | "live" (provision docs §01).
export interface ProjectStatusParams {
  projectId: string;
  name: string;
  status: "pending" | "provisioned" | "live" | "failed";
  repoUrl: string;
  stagingUrl: string;
}

export function projectStatusResponse({ projectId, name, status, repoUrl, stagingUrl }: ProjectStatusParams) {
  return {
    id: projectId,
    name,
    status,
    repoUrl,
    serverPath: `/var/www/${name}`,
    stagingUrl,
    devName: "ERP Service",
    framework: "vite",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
