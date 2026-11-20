import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roundHalfUp, allocate, formatCents } from '../src/shared/money.js';

describe('money — integer cents only', () => {
  test('half-up rounding for both signs', () => {
    assert.equal(roundHalfUp(10, 3), 3);   // 3.33
    assert.equal(roundHalfUp(5, 2), 3);    // exact half -> up
    assert.equal(roundHalfUp(-5, 2), -3);  // negative half away from zero
    assert.equal(roundHalfUp(0, 4), 0);
    assert.equal(roundHalfUp(9000 * 10, 28), 3214);
  });

  test('allocation sums exactly to total across any weights', () => {
    for (const [total, weights] of [
      [100, [1, 1, 1]],
      [100, [3, 7]],
      [9999, [28, 0, 31, 30]],
      [1, [1, 1, 1]],
      [0, [10, 20]],
    ]) {
      const parts = allocate(total, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0), total,
        `allocation(${total}, ${weights}) = ${parts}`);
      parts.forEach((p, i) => weights[i] === 0 && assert.equal(p, 0));
    }
  });

  test('formatting never uses float money', () => {
    assert.match(formatCents(123456), /\$1,234\.56/);
    assert.match(formatCents(-505), /-\$5\.05/);
  });
});
