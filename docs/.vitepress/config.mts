import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

// The product name lives in the brand module only.
const brand = readFileSync(new URL('../../packages/shared/src/brand.ts', import.meta.url), 'utf8');
const name = /name: '([^']+)'/.exec(brand)![1]!;
const tagline = /tagline: '([^']+)'/.exec(brand)![1]!;
const repo = /repo: '([^']+)'/.exec(brand)![1]!;

export default defineConfig({
  title: name,
  description: tagline,
  // Served from GitHub Pages at /<repository>/ unless DOCS_BASE says otherwise.
  base: process.env.DOCS_BASE ?? '/',
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ['**/node_modules/**'],
  // Links into the repository outside docs/ (examples, compat) go to GitHub.
  ignoreDeadLinks: [/^\.\.\//],
  themeConfig: {
    nav: [
      { text: 'Self-hosting', link: '/SELF_HOSTING' },
      { text: 'Moving from Slack', link: '/MIGRATING_FROM_SLACK' },
      { text: 'Compatibility', link: '/COMPATIBILITY' },
      { text: 'Architecture', link: '/ARCHITECTURE' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Self-hosting', link: '/SELF_HOSTING' },
          { text: 'Moving from Slack, Mattermost or Discord', link: '/MIGRATING_FROM_SLACK' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Slack API compatibility', link: '/COMPATIBILITY' },
          { text: 'Architecture', link: '/ARCHITECTURE' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page' },
    footer: { message: 'Apache-2.0', copyright: `Not affiliated with Slack Technologies or Salesforce.` },
  },
  markdown: {
    // Relative links that leave docs/ are rewritten to the repository on GitHub.
    config: (md) => {
      const original = md.renderer.rules.link_open;
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const href = tokens[index]!.attrGet('href');
        if (href?.startsWith('../')) tokens[index]!.attrSet('href', `${repo}/blob/main/${href.replace(/^(\.\.\/)+/, '')}`);
        return original ? original(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
      };
    },
  },
});
