import { withContext } from '../_guard';
import { DashboardView } from './DashboardView';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  return withContext((ctx) => <DashboardView ctx={ctx} />);
}
