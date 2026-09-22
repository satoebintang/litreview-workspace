import { cache } from "react";
import { reviewServices } from "@/app/server";

// The project layout and a page may both need the ownership/title row during
// one render. React request memoization keeps that read to one lookup.
export const getProjectForRoute = cache(async (projectId: string) => reviewServices.getProject(projectId));
