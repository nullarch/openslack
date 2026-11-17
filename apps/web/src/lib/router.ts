/** A tiny history-API router. The app has a handful of routes and no nesting. */

export type Route =
  | { name: 'home' }
  | { name: 'conversation'; id: string; ts?: string; thread?: string }
  | { name: 'search'; query: string }
  | { name: 'agents' }
  | { name: 'setup' }
  | { name: 'signin' }
  | { name: 'join'; code: string }
  | { name: 'view'; view: ViewName };

/** Workspace-wide views reached from the top of the sidebar. */
export type ViewName = 'activity' | 'threads' | 'unreads' | 'later' | 'drafts' | 'files';
export const VIEW_NAMES: ViewName[] = ['activity', 'threads', 'unreads', 'later', 'drafts', 'files'];

/** `p1700000000123456` → `1700000000.123456` */
function permalinkTs(value: string): string | undefined {
  const digits = value.replace(/^p/, '');
  if (!/^\d{16}$/.test(digits)) return undefined;
  return `${digits.slice(0, 10)}.${digits.slice(10)}`;
}

export function parseRoute(location: { pathname: string; search: string }): Route {
  const parts = location.pathname.split('/').filter(Boolean);
  const query = new URLSearchParams(location.search);
  if (parts[0] === 'setup') return { name: 'setup' };
  if (parts[0] === 'signin') return { name: 'signin' };
  if (parts[0] === 'join' && parts[1]) return { name: 'join', code: decodeURIComponent(parts[1]) };
  if (parts[0] === 'search') return { name: 'search', query: query.get('q') ?? '' };
  if (parts[0] && (VIEW_NAMES as string[]).includes(parts[0])) return { name: 'view', view: parts[0] as ViewName };
  if (parts[0] === 'agents') return { name: 'agents' };
  if (parts[0] === 'c' && parts[1]) {
    const route: Route = { name: 'conversation', id: parts[1] };
    const ts = query.get('ts');
    if (ts) route.ts = ts;
    return route;
  }
  if (parts[0] === 'archives' && parts[1]) {
    const route: Route = { name: 'conversation', id: parts[1] };
    const ts = parts[2] ? permalinkTs(parts[2]) : undefined;
    const thread = query.get('thread_ts') ?? undefined;
    if (ts) route.ts = ts;
    if (thread) route.thread = thread;
    return route;
  }
  return { name: 'home' };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'setup':
      return '/setup';
    case 'signin':
      return '/signin';
    case 'join':
      return `/join/${encodeURIComponent(route.code)}`;
    case 'search':
      return `/search?q=${encodeURIComponent(route.query)}`;
    case 'agents':
      return '/agents';
    case 'conversation':
      return `/c/${route.id}`;
    case 'view':
      return `/${route.view}`;
    case 'home':
      return '/';
  }
}

export function pushRoute(route: Route, replace = false): void {
  const path = routePath(route);
  if (path === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
}
