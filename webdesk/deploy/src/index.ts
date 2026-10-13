// RETIRED (M6-P6j, WSK-D29 / WSK-D79). This package used to be the control plane's ssh+rsync
// deployer for `delphi` / `helios`. The control plane (the ERP, the hub, the agents) now holds no
// SSH key and deploys nothing. Delivery is per site: the SITE'S OWN CI ships the build over SFTP,
// with the scripts in `webdesk/templates/_deploy/` (deploy.sh), using the per-site secret the ERP
// binds with `POST sites/:id/delivery-binding`. `delphi` and `helios` stay valid per-site delivery
// targets under WSK-D79; they are simply never reached from here.
//
// Nothing in this repo imports this package. The only exports left fail closed and name the
// replacement, so a stray caller gets a clear refusal instead of a connection attempt.

export const RETIRED_MESSAGE =
  "webdesk/deploy is retired (M6-P6j, WSK-D29): the control plane no longer reaches or deploys to " +
  "delivery hosts. Delivery is per site, run by the site's own CI with webdesk/templates/_deploy/" +
  "deploy.sh over SFTP (WSK-D79). Bind the site's delivery with POST sites/:id/delivery-binding.";

export class DeployRetiredError extends Error {
  constructor() {
    super(RETIRED_MESSAGE);
    this.name = "DeployRetiredError";
  }
}

/** Always rejects. No process is spawned and no connection is attempted. */
export async function deploy(..._args: unknown[]): Promise<never> {
  throw new DeployRetiredError();
}

/** Always rejects. The control plane no longer probes delivery hosts. */
export async function probe(..._args: unknown[]): Promise<never> {
  throw new DeployRetiredError();
}

/** Kept so an old `getDriver().deploy(...)` call fails closed rather than failing to compile. */
export function getDriver(): { deploy: typeof deploy; probe: typeof probe } {
  return { deploy, probe };
}
