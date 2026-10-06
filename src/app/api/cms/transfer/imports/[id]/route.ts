/** Site transfer (Export / Import) — see `src/cms/core/transfer`. */
import { transferImportDeleteRoute, transferImportGetRoute } from '@/cms/core/transfer/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = transferImportGetRoute();
export const DELETE = transferImportDeleteRoute();
