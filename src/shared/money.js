// All monetary amounts are integer cents. No floating point ever touches money.

export function roundHalfUp(centsNumerator, denominator) {
  if (denominator <= 0) throw new Error('denominator must be positive');
  const q = Math.trunc(centsNumerator / denominator);
  const r = Math.abs(centsNumerator % denominator);
  if (r * 2 >= denominator) return centsNumerator >= 0 ? q + 1 : q - 1;
  return q;
}

/**
 * Allocate `totalCents` across `weights` (e.g. day counts) so that the sum of
 * the parts equals the total exactly. The last non-zero bucket absorbs the
 * rounding remainder; earlier buckets use largest-remainder style rounding.
 */
export function allocate(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const result = weights.map((w) => (w === 0 ? 0 : roundHalfUp(totalCents * w, sum)));
  let allocated = result.reduce((a, b) => a + b, 0);
  // Push the remainder onto the last non-zero weight bucket.
  for (let i = result.length - 1; i >= 0; i--) {
    if (weights[i] > 0) {
      result[i] += totalCents - allocated;
      break;
    }
  }
  return result;
}

export function formatCents(cents, currency = 'USD') {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(abs / 100)}`;
}
