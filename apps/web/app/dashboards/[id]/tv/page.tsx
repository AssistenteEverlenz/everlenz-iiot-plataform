'use client';
import { use } from 'react';
import { ProductionBoard } from '../../../../components/ProductionBoard';

export default function ProductionTvPage({ params }: { params: Promise<{ id: string }> }) {
  return <ProductionBoard id={use(params).id} />;
}
