'use client';
import { use } from 'react';
import { ShiftTv } from '../../../../components/ShiftTv';

export default function ProductionTvPage({ params }: { params: Promise<{ id: string }> }) {
  return <ShiftTv id={use(params).id} />;
}
