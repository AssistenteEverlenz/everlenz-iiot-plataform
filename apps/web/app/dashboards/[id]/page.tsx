'use client';
import { use } from 'react';
import { DashboardCanvas } from '../../../components/DashboardCanvas';

export default function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  return <DashboardCanvas id={use(params).id} />;
}
