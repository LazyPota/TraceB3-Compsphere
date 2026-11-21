import { WastePassportView } from '@/components/pages/waste-passport-view';

export default async function PublicPassportPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  return <WastePassportView mode="public" publicId={publicId} />;
}
