/** Site transfer (Export / Import) — see `src/cms/core/transfer`. */
import { transferJobsRoute } from '@/cms/core/transfer/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = transferJobsRoute();
