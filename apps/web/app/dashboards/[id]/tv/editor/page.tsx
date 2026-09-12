'use client';
import { use } from 'react';
import { TvEditor } from '../../../../../components/TvEditor';

export default function TvEditorPage({ params }: { params: Promise<{ id: string }> }) {
  return <TvEditor id={use(params).id} />;
}
