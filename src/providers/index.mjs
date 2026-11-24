import { AntigravityProvider } from './antigravity/index.mjs';
import { ProviderRegistry } from './registry.mjs';
import { HookProvider } from './webhook-provider.mjs';

/**
 * Builds and populates a ProviderRegistry from loaded daemon configuration.
 */
export async function createProviderRegistry(config, ctx = {}) {
  const registry = new ProviderRegistry();
  const provCfg = config?.providers || {};

  let antigravityProvider = null;
  if (provCfg.antigravity?.enabled !== false) {
    antigravityProvider = new AntigravityProvider(provCfg.antigravity || {});
    registry.register(antigravityProvider);
  }

  let hookProvider = null;
  if (provCfg.hooks?.enabled !== false) {
    hookProvider = new HookProvider(provCfg.hooks || {});
    registry.register(hookProvider);
  }

  if (Array.isArray(provCfg.customModules) && provCfg.customModules.length > 0) {
    await registry.loadCustomModules(provCfg.customModules, config, ctx);
  }

  return { registry, antigravityProvider, hookProvider };
}
