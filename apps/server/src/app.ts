import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createHttpServer, DEFAULT_API_RATE_LIMIT, Router, type UpgradeHandler } from './api/http.ts';
import { registerChat } from './api/methods/chat.ts';
import { registerClient } from './api/methods/client.ts';
import { registerConversations } from './api/methods/conversations.ts';
import { registerEmoji } from './api/methods/emoji.ts';
import { registerFileRoutes, registerFiles } from './api/methods/files.ts';
import { registerLegacyFiles } from './api/methods/legacy-files.ts';
import { registerPublicFileRoutes, registerPublicFiles } from './api/methods/public-files.ts';
import { registerSearch } from './api/methods/search.ts';
import { registerSearchFiles } from './api/methods/search-files.ts';
import { registerUsers } from './api/methods/users.ts';
import { Registry } from './api/registry.ts';
import { Bus } from './core/bus.ts';
import { Clock } from './core/clock.ts';
import { fail } from './core/errors.ts';
import { createStorage } from './core/storage.ts';
import type { Config, Ctx, TeamRow } from './ctx.ts';
import { Db } from './db/db.ts';
import { installHuddles } from './huddles/index.ts';
import { installAi } from './ai/index.ts';
import { installWorkflows } from './workflows/index.ts';
import { installScim } from './scim/index.ts';
import { installRetention } from './retention/index.ts';
import { installStats } from './stats/index.ts';
import { installModeration } from './moderation/index.ts';
import { installAccounts } from './accounts/index.ts';
import { installAudit } from './audit/index.ts';
import { installFileText } from './core/file-text.ts';
import { installEmailNotifications } from './attention/email.ts';
import { installCalls } from './calls/index.ts';
import { installSessions } from './sessions/index.ts';
import { installInboundEmail } from './inbound/email.ts';
import { installAttention } from './attention/index.ts';
import { installDocs } from './docs/index.ts';
import { installMcp } from './mcp/index.ts';
import { installPlatform } from './platform/index.ts';
import { Gateway } from './realtime/gateway.ts';

/** What extension modules (the app platform, importers) get to plug into. */
export interface Kernel {
  ctx: Ctx;
  registry: Registry;
  router: Router;
  upgrades: UpgradeHandler[];
  /** Callbacks run on shutdown, before the database closes. */
  onClose: (() => void | Promise<void>)[];
}

export interface App extends Kernel {
  server: Server;
  /** Start listening; resolves with the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(join(config.dataDir, 'app.db'));
  const gateway = new Gateway();
  let team: TeamRow | undefined;
  let teamLoaded = false;

  const ctx: Ctx = {
    config,
    db,
    bus: new Bus(),
    clock: new Clock(db),
    storage: createStorage(config.dataDir, config.s3),
    presence: gateway,
    team() {
      if (!teamLoaded) {
        team = db.get<TeamRow>('SELECT * FROM team LIMIT 1');
        teamLoaded = true;
      }
      return team;
    },
    requireTeam() {
      return this.team() ?? fail('team_not_set_up');
    },
    invalidateTeam() {
      teamLoaded = false;
    },
  };

  const registry = new Registry();
  const router = new Router();
  const upgrades: UpgradeHandler[] = [gateway.handleUpgrade];
  const onClose: (() => void | Promise<void>)[] = [];
  const kernel: Kernel = { ctx, registry, router, upgrades, onClose };

  registerClient(registry);
  registerUsers(registry);
  registerConversations(registry);
  registerChat(registry);
  registerFiles(registry);
  registerLegacyFiles(registry);
  registerPublicFiles(registry);
  registerEmoji(registry);
  registerSearch(registry);
  registerSearchFiles(registry);
  registerFileRoutes(ctx, router);
  registerPublicFileRoutes(ctx, router);
  installPlatform(kernel);
  installAttention(kernel);
  installMcp(kernel);
  installHuddles(kernel);
  installAi(kernel);
  installDocs(kernel);
  installWorkflows(kernel);
  installScim(kernel);
  installRetention(kernel);
  installStats(kernel);
  installModeration(kernel);
  installFileText(kernel);
  installEmailNotifications(kernel);
  installCalls(kernel);
  installSessions(kernel);
  installInboundEmail(kernel);
  installAccounts(kernel);
  // Keep last: the audit log wraps the methods every module above registered.
  installAudit(kernel);
  gateway.start(ctx);

  const server = createHttpServer(ctx, { registry, router, upgrades, rateLimitPerMinute: DEFAULT_API_RATE_LIMIT });
  const explicitPublicUrl = config.publicUrl !== '';

  return {
    ...kernel,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const port = (server.address() as AddressInfo).port;
          if (!explicitPublicUrl) config.publicUrl = `http://localhost:${port}`;
          resolve(port);
        });
      });
    },
    async close() {
      for (const hook of onClose) await hook();
      gateway.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      db.close();
    },
  };
}
