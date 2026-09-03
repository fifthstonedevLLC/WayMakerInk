/* Money, dates, and the one rule that matters about both: a missing value is
   not a zero and not an epoch. */

export function money(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/* "Quote on request" rather than "$0". The custom-piercing and no-price-yet
   paths both arrive here as null, and every caller has to say something. */
export function priceLabel(n: number | null | undefined): string {
  return money(n) ?? 'Quote on request';
}

export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

export function dateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/* How long a request has been sitting. The queue's real question is not "when
   did this arrive" but "how long has this person been waiting", and a relative
   answer is the one that reads at a glance. */
export function waitingFor(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
