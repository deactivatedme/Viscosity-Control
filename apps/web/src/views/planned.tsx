'use client';
import { Milestone } from 'lucide-react';
import { EmptyState, View } from '@/components/ui/bits';

/**
 * Workflows, Projects and Deployments are later roadmap phases. They are listed so the
 * navigation is stable, but nothing here is wired up yet — so there are no controls to click.
 */
export default function Planned() {
  return (
    <View title="Not in this build">
      <EmptyState icon={Milestone} title="Planned, not built yet">
        This area belongs to a later milestone (see docs/ROADMAP.md). Nothing here is simulated: until the backend exists,
        there are no controls. Agents, terminals, files, containers and browser sessions are fully functional today.
      </EmptyState>
    </View>
  );
}
