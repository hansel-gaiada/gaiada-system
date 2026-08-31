import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_SCOPE_KEY } from "./scope.decorator";
import type { ApiKeyScope } from "../api-keys/api-keys.service";
import type { WebdeskRequest } from "./webdesk-request";

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<ApiKeyScope | undefined>(REQUIRE_SCOPE_KEY, context.getHandler());
    if (!required) return true; // route declared no scope requirement — nothing to enforce here

    const request = context.switchToHttp().getRequest<WebdeskRequest>();
    const granted = request.webdesk?.scope;
    if (!granted) {
      // ApiKeyAuthGuard must run first; if it did not, fail closed rather than assume anything.
      throw new ForbiddenException("no resolved key scope for this request");
    }

    // write implies read (see scope.decorator.ts); read never implies write.
    const satisfied = granted === "write" || granted === required;
    if (!satisfied) {
      throw new ForbiddenException(`key scope '${granted}' does not satisfy required scope '${required}'`);
    }
    return true;
  }
}
