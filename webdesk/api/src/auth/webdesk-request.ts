import type { FastifyRequest } from "fastify";
import type { ResolvedApiKey } from "../api-keys/api-keys.service";

export type WebdeskRequest = FastifyRequest & { webdesk?: ResolvedApiKey };
