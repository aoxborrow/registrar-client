import { describe, it, expect } from 'vitest';
import { AuthenticationError, RateLimitError, RegistrarError, failedResult } from '../src/index';

describe('failedResult', () => {
  it("keeps a RegistrarError's status, with its message or the one given", () => {
    expect(failedResult(new AuthenticationError('Bad key'))).toEqual({
      success: false,
      message: 'Bad key',
      status: 401,
    });
    expect(failedResult(new RateLimitError('Too many requests', 30), 'Slow down')).toEqual({
      success: false,
      message: 'Slow down',
      status: 429,
    });
  });

  it('leaves status out when the error has none', () => {
    expect(failedResult(new Error('boom'))).toStrictEqual({ success: false, message: 'boom' });
    expect(failedResult(new RegistrarError('no status'))).toStrictEqual({
      success: false,
      message: 'no status',
    });
  });
});
