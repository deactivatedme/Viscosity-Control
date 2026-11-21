import type { Container, HttpCheck } from '@viscosity/protocol';

export type DeploymentStatus = 'idle' | 'pending_approval' | 'deploying' | 'healthy' | 'unhealthy' | 'failed';
export interface Release {
  id: string; version: string | null; trigger: 'manual' | 'rollback' | 'agent'; status: 'pending_approval' | 'running' | 'succeeded' | 'failed' | 'rejected';
  sessionId: string | null; health: HttpCheck | null; detail: string | null; createdAt: string; finishedAt: string | null;
  requestedBy: string | null; approvedBy: string | null;
}
export interface Deployment {
  id: string; name: string; serverId: string; projectId: string | null; workdir: string; composeFile: string; environment: 'staging' | 'production';
  buildCommand: string[] | null; healthUrl: string | null; status: DeploymentStatus; currentReleaseId: string | null; createdAt: string;
  /** Names only — values are write-only. */
  envKeys: string[]; composeProject: string; serverOnline: boolean;
}
export interface DeploymentListItem extends Deployment { current: { version: string | null; finishedAt: string | null; status: string } | null }
export interface DeploymentDetail extends Deployment { releases: Release[]; containers: Container[]; containersError: string | null }
