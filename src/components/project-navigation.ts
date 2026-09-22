import {
  matchProjectRoute,
  projectPrimaryHref,
  PROJECT_PRIMARY_ROUTES,
  type ProjectPrimaryRouteKey,
} from "@/app/projects/route-contract";

export const PROJECT_PRIMARY_NAVIGATION = PROJECT_PRIMARY_ROUTES;
export type ProjectNavKey = ProjectPrimaryRouteKey;

export type ProjectNavItem = {
  key: ProjectNavKey;
  label: string;
  href: string;
};

function normalizePathname(pathname: string) {
  const pathOnly = pathname.split(/[?#]/, 1)[0] || "/";
  if (pathOnly.length > 1) return pathOnly.replace(/\/+$/, "");
  return pathOnly;
}

export function getProjectNavItems(projectId: string): ProjectNavItem[] {
  return PROJECT_PRIMARY_NAVIGATION.map((item) => ({
    key: item.key,
    label: item.label,
    href: projectPrimaryHref(projectId, item.key),
  }));
}

export function getActiveProjectNavKey(
  pathname: string,
  items: readonly ProjectNavItem[],
): ProjectNavKey | null {
  return matchProjectRoute(normalizePathname(pathname), items[0]?.href.split("/")[2] ?? "")?.key ?? null;
}
