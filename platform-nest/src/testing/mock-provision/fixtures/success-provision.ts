// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-08-08; superseded by PRV-02 live recordings
//
// Successful POST /api/provision response (PRV seam §04). Shape: a Payload REST envelope with the
// created project's id, status, and URLs. The provision service returns HTTP 202 with this shape,
// and subsequent GETs mirror the same fields. Mark as fixture (never vendor-observed shapes).
export interface ProvisionSuccessParams {
  projectId: string;
  name: string;
  repoUrl: string;
  stagingUrl: string;
}

export function successProvisionResponse({ projectId, name, repoUrl, stagingUrl }: ProvisionSuccessParams) {
  return {
    id: projectId,
    name,
    status: "pending",
    repoUrl,
    serverPath: `/var/www/${name}`,
    stagingUrl,
    devName: "ERP Service",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
