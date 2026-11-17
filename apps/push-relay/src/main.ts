import { configFromEnv, createRelay } from './relay.ts';

const config = await configFromEnv(process.env);
if (!config.apns && !config.fcm) console.warn('[relay] neither APNS_* nor FCM_* is set: every notification will be refused as not_configured');
const relay = createRelay(config);
const port = Number(process.env.PORT ?? 8080);
relay.server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`push relay on :${port} (apns ${config.apns ? 'on' : 'off'}, fcm ${config.fcm ? 'on' : 'off'})`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void relay.close().then(() => process.exit(0)));
}
