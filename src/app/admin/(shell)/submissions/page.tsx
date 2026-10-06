import { SubmissionsTable } from '@/cms/admin';
import { getFormsPolicy } from '@/cms/core/forms/attachment-runtime';
import { redactSubmission } from '@/cms/core/forms/policy';
import { listSubmissions } from '@/cms/core/forms/service';
import { hasPerm, PERMISSIONS, requirePerm } from '@/cms/modules/auth';

export default async function SubmissionsPage() {
  const user = await requirePerm(PERMISSIONS.formsRead);
  const [initial, policy] = await Promise.all([listSubmissions({}), getFormsPolicy()]);
  // The same redaction as the API: a sensitive row without its file name for
  // anyone lacking the permission to read sensitive submissions.
  const canReadSensitive = hasPerm(user.permissions, PERMISSIONS.formsSensitive);
  const visible = {
    ...initial,
    items: initial.items.map((i) => redactSubmission(i, policy, canReadSensitive)),
  };
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-neutral-900">Submissions</h1>
      <SubmissionsTable
        initial={JSON.parse(JSON.stringify(visible))}
        canDelete={hasPerm(user.permissions, PERMISSIONS.formsDelete)}
      />
    </div>
  );
}
