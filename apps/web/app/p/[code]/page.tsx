'use client';
import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';

// The short link of the WhatsApp summary (iotplataform.../p/<first 8 of the panel id>): a full
// panel address wrapped over three lines of a phone. It opens the panel; someone not logged in
// passes through the login first and lands here again.
export default function ShortPanelLink({ params }: { params: Promise<{ code: string }> }) {
  const code = use(params).code.toLowerCase();
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/dashboards', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : []))
      .then((dashboards: Array<{ id: string }>) => {
        if (cancelled) return;
        const found = Array.isArray(dashboards)
          ? dashboards.find((dashboard) => dashboard.id.startsWith(code))
          : null;
        router.replace(found ? `/dashboards/${found.id}` : '/dashboards');
      })
      .catch(() => router.replace('/dashboards'));
    return () => {
      cancelled = true;
    };
  }, [code, router]);
  return null;
}
