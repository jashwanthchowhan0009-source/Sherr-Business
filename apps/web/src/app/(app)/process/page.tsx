import { PageHeader } from '@/components/shell/PageHeader';
import { PhaseTwo } from '../_guard';

export const dynamic = 'force-dynamic';

export default function ProcessPage() {
  return (
    <>
      <PageHeader
        title="Process"
        subtitle="Normalize, connect, validate, reconcile, calculate."
      />
      <PhaseTwo title="Reconciliation is not built yet">
        The matching cascade, three-way match and exception queue need transactions to work on.
        They arrive with the ledger.
      </PhaseTwo>
    </>
  );
}
