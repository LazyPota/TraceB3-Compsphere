import { WastePassportView } from '@/components/pages/waste-passport-view';

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WastePassportView mode="authenticated" batchId={id} />;
}
