// Prices as the paywall prints them, in the reader's language.

import type { DisplayPrice } from './types';

export function formatMoney(amount: number, currency: string, exp: number, locale: string): string {
  const value = amount / 10 ** exp;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: Number.isInteger(value) ? 0 : undefined,
    }).format(value);
  } catch {
    return `${value.toFixed(exp)} ${currency.toUpperCase()}`;
  }
}

export function formatPrice(price: DisplayPrice, locale: string): string {
  return formatMoney(price.amount, price.currency, price.exp, locale);
}

/** The yearly price as a monthly figure, in the same currency. */
export function monthlyEquivalent(price: DisplayPrice, locale: string): string {
  return formatMoney(Math.round(price.amount / 12), price.currency, price.exp, locale);
}

/** Percentage saved by paying yearly instead of twelve months, when both are in one currency. */
export function yearlySaving(year: DisplayPrice | undefined, month: DisplayPrice | undefined): number | null {
  if (!year || !month || year.currency !== month.currency || month.amount <= 0) return null;
  const saving = Math.round((1 - year.amount / (month.amount * 12)) * 100);
  return saving >= 5 ? saving : null;
}
