import { ReviseBatchView } from '@/components/pages/revise-batch-view';

export default async function ReviseBatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReviseBatchView batchId={id} />;
}
