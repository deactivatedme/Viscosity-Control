import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context';
import type { AgentService } from '../services/agents';

/** Docker Compose deployments. Implemented in this file (and services/deployments.ts). */
export function deploymentRoutes(_app: FastifyInstance, _ctx: Ctx, _agents: AgentService) {}
