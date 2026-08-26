// See ../lifecycle/lifecycle.controller.ts's header — same loud warning applies. Deliberately NOT
// audited (see ../command-audit.service.ts's header): these are read-only polls of a job a real
// command already created and audited; auditing every poll would flood audit_entries with rows
// carrying no new information.
import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { JobsService } from "./jobs.service";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly tenants: TenantLookupService,
  ) {}

  @Get(":tenantSlug/jobs")
  @Command("job.list")
  async list(@Param("tenantSlug") tenantSlug: string) {
    await this.assertActiveTenant(tenantSlug);
    return { jobs: this.jobs.list(tenantSlug) };
  }

  @Get(":tenantSlug/jobs/:jobId")
  @Command("job.get")
  async get(@Param("tenantSlug") tenantSlug: string, @Param("jobId") jobId: string) {
    await this.assertActiveTenant(tenantSlug);
    return this.jobs.get(tenantSlug, jobId);
  }

  private async assertActiveTenant(tenantSlug: string): Promise<void> {
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
  }
}
