export const DEPLOYMENT_TARGETS = ['dev', 'ol'] as const;

export type DeploymentTarget = (typeof DEPLOYMENT_TARGETS)[number];

/** Cloud-local deployment fact. Callers must fail closed when parsing returns null. */
export function parseDeploymentTarget(value: unknown): DeploymentTarget | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized === 'dev' || normalized === 'ol' ? normalized : null;
}
