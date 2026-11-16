/**
 * The only place the product name lives. Everything else imports from here,
 * so a rename is a change to this file plus the published package name.
 */
export const BRAND = {
  name: 'OpenSlack',
  slug: 'openslack',
  tagline: 'Open-source, self-hosted team chat that speaks the Slack API.',
  repo: 'https://github.com/nullarch/openslack',
} as const;
