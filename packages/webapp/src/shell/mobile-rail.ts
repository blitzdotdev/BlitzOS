import type { AppRoute } from '../sessions-page-state';

/** On a phone the rail is the workspace's screen, so picking a session must
 * read as a page change. */
export function routeShowsMobileRail(route: AppRoute): boolean {
  return route.page === 'webApp' && route.chat === 'landing';
}
