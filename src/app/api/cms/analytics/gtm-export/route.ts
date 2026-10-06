import { gtmExportRoute } from '@/cms/core/routes/gtm-export';
import config from '@/site.config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = gtmExportRoute(config);
