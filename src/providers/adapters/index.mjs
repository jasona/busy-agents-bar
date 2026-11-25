import { claudeCodeHookAdapter } from './claude-code.mjs';
import { codexHookAdapter } from './codex.mjs';
import { genericHookAdapter } from './generic.mjs';
import { phoenixHookAdapter } from './phoenix.mjs';

export { claudeCodeHookAdapter, codexHookAdapter, genericHookAdapter, phoenixHookAdapter };

/**
 * Registers all built-in provider hook adapters into an adapter map or registerHookAdapter function.
 */
export function registerBuiltinHookAdapters(registerFn) {
  registerFn('generic', genericHookAdapter);
  registerFn('claude-code', claudeCodeHookAdapter);
  registerFn('claude', claudeCodeHookAdapter);
  registerFn('codex', codexHookAdapter);
  registerFn('chatgpt', codexHookAdapter);
  registerFn('phoenix', phoenixHookAdapter);
  registerFn('phoenix-code', phoenixHookAdapter);
  registerFn('t3', phoenixHookAdapter);
}
