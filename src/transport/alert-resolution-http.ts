/**
 * Internal HTTP transport for resolving one automation-owned alert row.
 *
 * The transport exposes only AlertResolutionPort. It returns the owner's real
 * updated-row count and has no risk-state or Edge-resume capability.
 */
import type { AlertResolutionPort } from '../kernel/alert-resolution-port.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';

export const ALERT_RESOLUTION_ROUTES = {
  resolveById: 'alert-resolution/resolve-by-id',
} as const;

/** Register the single narrow owner operation. */
export function registerAlertResolutionRoutes(
  server: InternalHttpServer,
  local: AlertResolutionPort,
): void {
  server.register(ALERT_RESOLUTION_ROUTES.resolveById, (args) => {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new InternalHttpError('bad_request', 'alert-resolution args must be an object');
    }
    const a = args as Record<string, unknown>;
    if (!Number.isInteger(a.alertId) || (a.alertId as number) <= 0) {
      throw new InternalHttpError('bad_request', 'alertId must be a positive integer');
    }
    if (a.at !== undefined && (typeof a.at !== 'number' || !Number.isFinite(a.at))) {
      throw new InternalHttpError('bad_request', 'at must be a finite number when provided');
    }
    return local.resolveById(a.alertId as number, a.at as number | undefined);
  });
}

/** HTTP implementation of the kernel alert-resolution port. */
export class AlertResolutionHttpClient implements AlertResolutionPort {
  constructor(private readonly http: InternalHttpClient) {}

  resolveById(alertId: number, at?: number): Promise<number> {
    return this.http.call<number>(ALERT_RESOLUTION_ROUTES.resolveById, { alertId, at });
  }
}
