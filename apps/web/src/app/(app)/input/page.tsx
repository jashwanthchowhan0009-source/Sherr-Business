import { PageHeader } from '@/components/shell/PageHeader';
import { PhaseTwo } from '../_guard';

export const dynamic = 'force-dynamic';

export default function InputPage() {
  return (
    <>
      <PageHeader
        title="Input"
        subtitle="Collect and extract — documents in, structured fields out."
      />
      <PhaseTwo title="Document capture is not built yet">
        Phase 1 covers tenancy, access and the audit trail. Upload, the AI document inbox and the
        source connectors arrive with the extraction pipeline.
      </PhaseTwo>
    </>
  );
}
