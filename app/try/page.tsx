import type { Metadata } from 'next';
import { TryApp } from '@/components/try/TryApp';

export const metadata: Metadata = {
  title: 'See your pendant — True Tribute',
  robots: { index: false, follow: false },
};

/** The shop customer's page, shown in the "Upload your photo" window on shoptruetribute.com (shopify/). */
export default function TryPage() {
  return <TryApp />;
}
