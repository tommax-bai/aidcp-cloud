/**
 * Internal HTTP transport for the automation-owned team-to-chat routing table.
 *
 * The api side resolves accountId to groupLabel locally, then uses this narrow
 * port. A missing route is the legitimate value `null`; transport and owner
 * failures remain exceptions for the existing fallback chain to diagnose.
 */
import type { GroupRoute, SetGroupRouteResult } from '../kernel/group-route-types.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';

export interface GroupRoutePort {
  getRoute(groupLabel: string): Promise<string | null>;
  listRoutes(): Promise<GroupRoute[]>;
  setRoute(
    groupLabel: string,
    chatId: string | null,
    updatedBy: string | null,
  ): Promise<SetGroupRouteResult>;
}

export const GROUP_ROUTE_ROUTES = {
  getRoute: 'group-route/get-route',
  listRoutes: 'group-route/list-routes',
  setRoute: 'group-route/set-route',
} as const;

function argsRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new InternalHttpError('bad_request', 'group-route args must be an object');
  }
  return args as Record<string, unknown>;
}

/** Register the owner store's exact read/list/write surface. */
export function registerGroupRouteRoutes(
  server: InternalHttpServer,
  local: GroupRoutePort,
): void {
  server.register(GROUP_ROUTE_ROUTES.getRoute, (args) => {
    const a = argsRecord(args);
    if (typeof a.groupLabel !== 'string') {
      throw new InternalHttpError('bad_request', 'groupLabel must be a string');
    }
    return local.getRoute(a.groupLabel);
  });
  server.register(GROUP_ROUTE_ROUTES.listRoutes, () => local.listRoutes());
  server.register(GROUP_ROUTE_ROUTES.setRoute, (args) => {
    const a = argsRecord(args);
    if (
      typeof a.groupLabel !== 'string'
      || (typeof a.chatId !== 'string' && a.chatId !== null)
      || (typeof a.updatedBy !== 'string' && a.updatedBy !== null)
    ) {
      throw new InternalHttpError(
        'bad_request',
        'setRoute requires string groupLabel, string|null chatId, and string|null updatedBy',
      );
    }
    return local.setRoute(a.groupLabel, a.chatId, a.updatedBy);
  });
}

/** HTTP implementation used by api without importing the owner store. */
export class GroupRouteHttpClient implements GroupRoutePort {
  constructor(private readonly http: InternalHttpClient) {}

  getRoute(groupLabel: string): Promise<string | null> {
    return this.http.call<string | null>(GROUP_ROUTE_ROUTES.getRoute, { groupLabel });
  }

  listRoutes(): Promise<GroupRoute[]> {
    return this.http.call<GroupRoute[]>(GROUP_ROUTE_ROUTES.listRoutes, {});
  }

  setRoute(
    groupLabel: string,
    chatId: string | null,
    updatedBy: string | null,
  ): Promise<SetGroupRouteResult> {
    return this.http.call<SetGroupRouteResult>(GROUP_ROUTE_ROUTES.setRoute, {
      groupLabel,
      chatId,
      updatedBy,
    });
  }
}
