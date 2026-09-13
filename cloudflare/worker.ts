/**
 * Cloudflare entry point. The whole Next.js app runs inside a container
 * (see ../Dockerfile); this Worker only forwards each request to it.
 *
 * Secrets are set on the Worker (`wrangler secret put`) and handed to the
 * container as ordinary environment variables at start-up, so lib/gemini.ts
 * and lib/remove-bg.ts read them from `process.env` exactly as they do
 * locally. They never reach the browser.
 */

import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  APP: DurableObjectNamespace<AppContainer>;
  GEMINI_API_KEY: string;
  REMOVE_BG_API_KEY?: string;
}

export class AppContainer extends Container<Env> {
  defaultPort = 3000;
  // A design session involves long pauses (reviewing the sketch, waiting on
  // a mockup), so keep the instance warm well past a single request.
  sleepAfter = '20m';

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    this.envVars = {
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      ...(env.REMOVE_BG_API_KEY ? { REMOVE_BG_API_KEY: env.REMOVE_BG_API_KEY } : {}),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // All state lives in the browser, so one shared instance serves everyone;
    // Node handles the concurrency of a small internal tool comfortably.
    return getContainer(env.APP).fetch(request);
  },
} satisfies ExportedHandler<Env>;
