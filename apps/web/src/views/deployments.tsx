'use client';
import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/ui/bits';

// placeholder replaced during the build-out
export default function Placeholder(_: { id?: string }) {
  return <EmptyState icon={Construction} title="deployments">This view is being built.</EmptyState>;
}
