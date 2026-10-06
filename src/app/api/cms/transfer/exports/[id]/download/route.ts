/** Site transfer (Export / Import) — see `src/cms/core/transfer`. */
import config from '@/site.config';
import { transferExportDownloadRoute } from '@/cms/core/transfer/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = transferExportDownloadRoute(config);
