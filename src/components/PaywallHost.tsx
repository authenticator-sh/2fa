import { lazy, Suspense, useEffect, useState } from 'react';
import type { Language } from '@/utils/i18n';
import { subscribePaywall, type PaywallRequest } from '@/billing/bridge';

// The paywall is loaded when first asked for, not with the popup: most
// people never see it, and the popup's own load time is paid on every click.
const Paywall = lazy(() => import('./Paywall'));

export function PaywallHost({ language }: { language: Language }) {
  const [request, setRequest] = useState<PaywallRequest | null>(null);
  useEffect(() => subscribePaywall(setRequest), []);
  if (!request) return null;
  return (
    <Suspense fallback={<div className="fixed inset-0 z-[60] bg-gray-50 dark:bg-dark-800" />}>
      {/* Keyed by request: a new request is a fresh screen, not a re-render of the last. */}
      <Paywall key={request.id} language={language} request={request} />
    </Suspense>
  );
}
