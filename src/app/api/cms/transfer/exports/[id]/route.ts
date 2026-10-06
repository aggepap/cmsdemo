/** Site transfer (Export / Import) — see `src/cms/core/transfer`. */
import { transferExportDeleteRoute, transferExportStatusRoute } from '@/cms/core/transfer/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = transferExportStatusRoute();
export const DELETE = transferExportDeleteRoute();
