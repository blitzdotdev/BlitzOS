import { createApp } from "./app.js";
import { runInvariantSweep, runOrphanDestroy } from "./janitors.js";
import { createOperatorPrincipalSource } from "./principals.js";
import { HetznerProvider } from "./providers/hetzner.js";

type StandaloneEnv = Env & {
  HETZNER_API_TOKEN: string;
  OPERATOR_API_KEY: string;
};

function dependencies(env: StandaloneEnv) {
  const provider = new HetznerProvider(env.HETZNER_API_TOKEN);
  return {
    vmProvider: provider,
    volumeProvider: provider,
    principalSource: createOperatorPrincipalSource(env.OPERATOR_API_KEY),
  };
}

export default {
  async fetch(request, env, executionContext): Promise<Response> {
    return createApp(dependencies(env)).fetch(request, env, executionContext);
  },
  async scheduled(_controller, env): Promise<void> {
    const deps = dependencies(env);
    await runInvariantSweep(env.DB);
    await runOrphanDestroy(env.DB, deps.vmProvider, deps.volumeProvider);
  },
} satisfies ExportedHandler<StandaloneEnv>;
