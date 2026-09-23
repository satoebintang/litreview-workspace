export const PROJECT_PRIMARY_ROUTES = [
  { key: "overview", label: "Overview", segment: "" },
  { key: "plan", label: "Plan", segment: "protocol" },
  { key: "papers", label: "Papers", segment: "papers" },
  { key: "screen", label: "Screen", segment: "screening" },
  { key: "extract", label: "Extract", segment: "extraction" },
  { key: "synthesize", label: "Synthesize", segment: "synthesis" },
  { key: "write", label: "Write", segment: "manuscript" },
  { key: "reports", label: "Reports", segment: "review-flow" },
] as const;

export type ProjectPrimaryRouteKey = (typeof PROJECT_PRIMARY_ROUTES)[number]["key"];

export type ProjectRouteMatch = {
  key: ProjectPrimaryRouteKey;
  label: string;
  href: string;
  relativePath: string;
};

export type ProjectBreadcrumb = {
  label: string;
  href?: string;
  current?: boolean;
};

function projectBaseHref(projectId: string): string {
  return `/projects/${projectId}`;
}

export function projectPrimaryHref(projectId: string, key: ProjectPrimaryRouteKey): string {
  const route = PROJECT_PRIMARY_ROUTES.find((candidate) => candidate.key === key);
  if (!route || route.segment === "") return projectBaseHref(projectId);
  return `${projectBaseHref(projectId)}/${route.segment}`;
}

export const getProjectPrimaryHref = projectPrimaryHref;

function relativeSegments(pathname: string, projectId: string): string[] | null {
  const pathOnly = pathname.split(/[?#]/, 1)[0] ?? "";
  const segments = pathOnly
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  if (segments[0] !== "projects" || segments[1] !== projectId) return null;
  return segments.slice(2);
}

type RouteRule = {
  key: ProjectPrimaryRouteKey;
  matches: (segments: string[]) => boolean;
};

// Keep the narrow rules first. This is the route contract's most-specific
// matching order for nested workflows that intentionally surface under a
// different primary workspace.
const ROUTE_RULES: readonly RouteRule[] = [
  {
    key: "write",
    matches: (segments) =>
      segments[0] === "research-questions" &&
      segments[2] === "answers" &&
      segments[4] === "manuscript",
  },
  {
    key: "synthesize",
    matches: (segments) =>
      segments[0] === "research-questions" &&
      segments[2] === "answers" &&
      Boolean(segments[3]),
  },
  {
    key: "plan",
    matches: (segments) => segments[0] === "research-questions",
  },
  {
    key: "extract",
    matches: (segments) =>
      segments[0] === "papers" &&
      Boolean(segments[1]) &&
      segments[2] === "documents",
  },
  { key: "extract", matches: (segments) => segments[0] === "appraisal" },
  {
    key: "papers",
    matches: (segments) =>
      segments[0] === "papers" &&
      ["doi-intake", "imports", "pdf-intake"].includes(segments[1] ?? ""),
  },
  { key: "papers", matches: (segments) => segments[0] === "papers" },
  { key: "screen", matches: (segments) => segments[0] === "screening" || segments[0] === "deduplication" },
  { key: "extract", matches: (segments) => segments[0] === "extraction" || segments[0] === "evidence" },
  { key: "synthesize", matches: (segments) => segments[0] === "synthesis" || segments[0] === "evidence-sets" || segments[0] === "claims" },
  { key: "write", matches: (segments) => segments[0] === "manuscript" },
  { key: "reports", matches: (segments) => segments[0] === "review-flow" || segments[0] === "review-report" },
  { key: "plan", matches: (segments) => segments[0] === "protocol" },
];

export function matchProjectRoute(pathname: string, projectId: string): ProjectRouteMatch | null {
  const segments = relativeSegments(pathname, projectId);
  if (!segments) return null;

  const key = segments.length === 0
    ? "overview"
    : ROUTE_RULES.find((rule) => rule.matches(segments))?.key ?? "overview";

  const route = PROJECT_PRIMARY_ROUTES.find((candidate) => candidate.key === key)!;
  return {
    key,
    label: route.label,
    href: projectPrimaryHref(projectId, key),
    relativePath: segments.join("/"),
  };
}

export function getProjectBreadcrumbs(
  projectId: string,
  pathname: string,
  projectTitle: string,
): ProjectBreadcrumb[] {
  const match = matchProjectRoute(pathname, projectId);
  if (!match) return [];

  const projectCrumb: ProjectBreadcrumb = {
    label: projectTitle,
    href: projectPrimaryHref(projectId, "overview"),
  };

  const pathSegments = relativeSegments(pathname, projectId) ?? [];
  const crumbs: ProjectBreadcrumb[] = [
    { label: "Projects", href: "/" },
    projectCrumb,
    { label: match.label, href: match.href },
  ];

  if (match.key === "overview") return crumbs;

  if (pathSegments[0] === "papers" && pathSegments[2] === "documents") {
    crumbs.push({ label: "Paper", href: match.href });
    if (pathSegments.includes("extractions")) crumbs.push({ label: "Text extraction" });
    else if (pathSegments.includes("suggestions")) crumbs.push({ label: "AI suggestion" });
    else if (pathSegments.length > 3) crumbs.push({ label: "Document" });
  } else if (pathSegments[0] === "extraction" && pathSegments.includes("suggestions")) {
    crumbs.push({ label: "Paper", href: match.href }, { label: "AI suggestion" });
  } else if (pathSegments[0] === "synthesis" && pathSegments[1] === "preparations") {
    crumbs.push({ label: "Preparation" });
  } else if (pathSegments[0] === "extraction" && pathSegments[1] === "batches") {
    crumbs.push({ label: "AI batch" });
  } else if (pathSegments[0] === "appraisal") {
    crumbs.push({ label: "Critical appraisal" });
  } else if (pathSegments[0] === "research-questions" && pathSegments[2] === "answers") {
    crumbs.push({ label: "Answer" });
    if (pathSegments[4] === "manuscript") crumbs.push({ label: "Manuscript drafting" });
  } else if ((pathSegments[0] === "screening" || pathSegments[0] === "deduplication") && pathSegments.length > 1) {
    crumbs.push({ label: "Paper" });
  }

  return crumbs.map((crumb, index) => ({
    ...crumb,
    current: index === crumbs.length - 1,
    href: index === crumbs.length - 1 ? undefined : crumb.href,
  }));
}
