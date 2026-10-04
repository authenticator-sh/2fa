// What a failed billing request says to the person. Kept apart from the
// paywall so the settings screen can use it without loading the paywall.

import type { createT } from '@/utils/i18n';
import { BillingApiError } from './api';

export function billingErrorMessage(error: unknown, t: ReturnType<typeof createT>): string {
  if (!(error instanceof BillingApiError)) return t('billing.error.generic');
  switch (error.code) {
    case 'network':
      return t('billing.error.network');
    case 'invalid_key':
      return t('billing.error.invalidKey');
    case 'license_inactive':
      return t('billing.error.inactive');
    case 'device_limit':
      return t('billing.error.deviceLimit');
    case 'payments_unavailable':
      return t('billing.error.payments');
    case 'rate_limited':
      return t('billing.error.rateLimited');
    default:
      return t('billing.error.generic');
  }
}
