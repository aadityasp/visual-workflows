import { afterEach, describe, expect, it } from 'vitest';
import { isAutoManaged } from '../src/app/AutoManage';

afterEach(() => {
  window.location.hash = '';
});

describe('isAutoManaged', () => {
  it('is true when the URL carries the #vw=auto marker', () => {
    window.location.hash = '#vw=auto';
    expect(isAutoManaged()).toBe(true);
  });

  it('is false for a plain URL', () => {
    window.location.hash = '';
    expect(isAutoManaged()).toBe(false);
  });

  it('is false for an unrelated hash', () => {
    window.location.hash = '#some-other-thing';
    expect(isAutoManaged()).toBe(false);
  });
});
