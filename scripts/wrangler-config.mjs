export function buildWranglerConfig({
  baseConfig,
  instanceConfig,
  namespaceId,
  releaseFingerprint,
}) {
  return {
    ...baseConfig,
    name: instanceConfig.deployment.workerName,
    kv_namespaces: [{ binding: 'POLLS', id: namespaceId }],
    vars: { RALLY_RELEASE_FINGERPRINT: releaseFingerprint },
  }
}