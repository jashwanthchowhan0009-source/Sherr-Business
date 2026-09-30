import { PageHeader } from '@/components/shell/PageHeader';
import { PhaseTwo } from '../_guard';

export const dynamic = 'force-dynamic';

export default function OutputPage() {
  return (
    <>
      <PageHeader title="Output" subtitle="Analyze, review, distribute." />
      <PhaseTwo title="Reports are not built yet">
        Accounts, Taxation, Financial reports, Profit analysis and Documentation are generated from
        verified accounting records, which Phase 1 does not yet produce.
      </PhaseTwo>
    </>
  );
}
