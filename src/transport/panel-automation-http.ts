/**
 * Internal HTTP transport for automation-owned panel projections.
 *
 * Routes and client implement the same kernel port so api can replace the
 * monolith-local reader without opening an automation database connection.
 */
import type {
  PanelAutomationReader,
  PanelActionTotal,
  PanelAccountActionTotal,
  PanelLikeViewTotal,
  PanelRiskStateProjection,
  PanelAlertProjection,
  PanelInteractionProjection,
} from '../kernel/panel-automation-types.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

type P<M extends keyof PanelAutomationReader> = Parameters<PanelAutomationReader[M]>;

export const PANEL_AUTOMATION_ROUTES = {
  todayActionTotals: 'panel-automation/today-action-totals',
  todayActionTotalsByAccount: 'panel-automation/today-action-totals-by-account',
  todayLikeViewTotal: 'panel-automation/today-like-view-total',
  riskStateProjection: 'panel-automation/risk-state-projection',
  listAlerts: 'panel-automation/list-alerts',
  listInteractions: 'panel-automation/list-interactions',
} as const;

/** Register all six read methods against the automation-owned implementation. */
export function registerPanelAutomationRoutes(
  server: InternalHttpServer,
  local: PanelAutomationReader,
): void {
  server.register(PANEL_AUTOMATION_ROUTES.todayActionTotals, () => local.todayActionTotals());
  server.register(PANEL_AUTOMATION_ROUTES.todayActionTotalsByAccount, () =>
    local.todayActionTotalsByAccount(),
  );
  server.register(PANEL_AUTOMATION_ROUTES.todayLikeViewTotal, () => local.todayLikeViewTotal());
  server.register(PANEL_AUTOMATION_ROUTES.riskStateProjection, (args) => {
    const a = args as { accountIds?: P<'riskStateProjection'>[0] };
    return local.riskStateProjection(a.accountIds);
  });
  server.register(PANEL_AUTOMATION_ROUTES.listAlerts, (args) => {
    const a = args as { options?: P<'listAlerts'>[0] };
    return local.listAlerts(a.options);
  });
  server.register(PANEL_AUTOMATION_ROUTES.listInteractions, (args) => {
    const a = args as { options?: P<'listInteractions'>[0] };
    return local.listInteractions(a.options);
  });
}

/** HTTP implementation of the complete panel automation read port. */
export class PanelAutomationHttpClient implements PanelAutomationReader {
  constructor(private readonly http: InternalHttpClient) {}

  todayActionTotals(): Promise<PanelActionTotal[]> {
    return this.http.call<PanelActionTotal[]>(PANEL_AUTOMATION_ROUTES.todayActionTotals, {});
  }

  todayActionTotalsByAccount(): Promise<PanelAccountActionTotal[]> {
    return this.http.call<PanelAccountActionTotal[]>(
      PANEL_AUTOMATION_ROUTES.todayActionTotalsByAccount,
      {},
    );
  }

  todayLikeViewTotal(): Promise<PanelLikeViewTotal> {
    return this.http.call<PanelLikeViewTotal>(PANEL_AUTOMATION_ROUTES.todayLikeViewTotal, {});
  }

  riskStateProjection(accountIds?: string[]): Promise<PanelRiskStateProjection[]> {
    return this.http.call<PanelRiskStateProjection[]>(
      PANEL_AUTOMATION_ROUTES.riskStateProjection,
      { accountIds },
    );
  }

  listAlerts(options?: P<'listAlerts'>[0]): Promise<PanelAlertProjection[]> {
    return this.http.call<PanelAlertProjection[]>(
      PANEL_AUTOMATION_ROUTES.listAlerts,
      { options },
    );
  }

  listInteractions(options?: P<'listInteractions'>[0]): Promise<PanelInteractionProjection[]> {
    return this.http.call<PanelInteractionProjection[]>(
      PANEL_AUTOMATION_ROUTES.listInteractions,
      { options },
    );
  }
}
