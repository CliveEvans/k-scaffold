import { describe, it, expect, vi } from 'vitest';
import kErrorHead from './../../lib/render/errorHead';
import '../mocks';

describe('kErrorhead', () => {
  it('Should log the provided error', () => {
    kErrorHead('test');
    // kErrorHead routes through reporter.error() which calls console.error in console mode.
    expect(console.error.mock.calls[0][0]).toMatch('test');
  });
});
