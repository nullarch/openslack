import type { Kernel } from '../app.ts';
import type { MethodDef } from '../api/registry.ts';
import { ApiError } from '../core/errors.ts';
import { mailEnabled } from '../core/mail.ts';
import { getUser } from '../core/users.ts';
import { expireGuests, guestExpired } from './guests.ts';
import { registerInvites } from './invites.ts';
import { allowedTo, teamPrefs } from './prefs.ts';
import { registerSignIn, TWO_FACTOR_SETUP_METHODS, twoFactorPending } from './signin.ts';

type Loose = Record<string, unknown>;

/** Replace a registered method with one that post-processes its result. */
function wrap(kernel: Kernel, name: string, after: (result: Loose, call: Parameters<MethodDef['handler']>[0]) => Loose | Promise<Loose>): void {
  const original = kernel.registry.get(name);
  if (!original) throw new Error(`cannot wrap missing method ${name}`);
  const handler: MethodDef['handler'] = async (call) => after(((await original.handler(call)) ?? {}) as Loose, call);
  if (original.auth === 'none') kernel.registry.addPublic(name, handler as never);
  else kernel.registry.add(name, { auth: original.auth, scopes: original.scopes }, handler);
}

/**
 * Accounts and workspace administration: mail sign-in, two-factor sign-in,
 * invitations and invite requests, guests, approved domains and the
 * workspace's permission settings.
 */
export function installAccounts(kernel: Kernel): void {
  const { ctx, registry } = kernel;
  registerSignIn(registry);
  registerInvites(registry);

  // Expired guests lose access the moment they next call, and in a sweep every minute.
  registry.guards.push((name, actor) => {
    const user = getUser(ctx, actor.userId);
    if (user && guestExpired(user)) {
      expireGuests(ctx);
      throw new ApiError('account_inactive');
    }
    if (actor.kind === 'session' && !TWO_FACTOR_SETUP_METHODS.has(name) && twoFactorPending(ctx, actor.userId)) {
      throw new ApiError('two_factor_setup_required');
    }
  });
  const sweep = setInterval(() => {
    if (ctx.team()) expireGuests(ctx);
  }, 60_000);
  sweep.unref();
  kernel.onClose.push(() => clearInterval(sweep));

  wrap(kernel, 'client.status', (result, { actor }) => ({
    ...result,
    mail_enabled: mailEnabled(ctx),
    identity_providers: (ctx.config.identityProviders ?? []).map((provider) => ({ id: provider.id, label: provider.label })),
    two_factor_setup_required: actor?.kind === 'session' ? twoFactorPending(ctx, actor.userId) : false,
  }));

  wrap(kernel, 'client.boot', (result, { actor }) => {
    const prefs = teamPrefs(ctx);
    const self = getUser(ctx, actor.userId);
    return {
      ...result,
      mail_enabled: mailEnabled(ctx),
      permissions: {
        create_channels: allowedTo(ctx, actor.userId, 'who_can_create_channels'),
        invite: allowedTo(ctx, actor.userId, 'who_can_invite'),
        manage_emoji: allowedTo(ctx, actor.userId, 'who_can_manage_emoji'),
        at_channel: allowedTo(ctx, actor.userId, 'who_can_at_channel'),
        manage_usergroups: allowedTo(ctx, actor.userId, 'who_can_manage_usergroups'),
        browse_channels: self?.guest === '',
      },
      signup_domains: prefs.signup_domains ?? [],
    };
  });
}
