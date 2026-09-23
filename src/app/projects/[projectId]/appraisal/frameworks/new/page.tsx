import Link from "next/link";
import { createAppraisalFrameworkAction } from "@/app/actions";
import { AccessibleValidation } from "@/components/AccessibleValidation";
import { CustomFrameworkBadge } from "@/components/CustomFrameworkBadge";
import { FocusedErrorSummary } from "@/components/FocusedErrorSummary";

export default async function NewAppraisalFrameworkPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ error?: string }> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  return <AccessibleValidation><div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Critical appraisal</p><h1>Create a custom framework</h1><p>Framework content is researcher-authored and versioned before it can be used.</p></div><CustomFrameworkBadge /></div>
    {query.error && <FocusedErrorSummary message={query.error} />}
    <section className="card narrow-card"><h2>Framework identity</h2><p className="hint">The name is project-local and remains historically unique, including after archival. The initial version opens as a mutable draft.</p><form action={createAppraisalFrameworkAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="framework-name">Name</label><input id="framework-name" name="name" required maxLength={200} placeholder="e.g. Custom cohort appraisal" /></div><div className="form-actions"><button className="button" type="submit">Create framework</button><Link className="button secondary" href={`/projects/${projectId}/appraisal/frameworks`}>Cancel</Link></div></form></section>
  </div></div></AccessibleValidation>;
}
