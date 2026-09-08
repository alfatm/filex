import { describe, expect, it } from 'vitest';
import { deviceLabel } from './userAgent';

describe('deviceLabel', () => {
  it('names the browser that actually sent the request', () => {
    // Every one of these carries "Safari" and the first two carry "Chrome"; order in the table is the whole test.
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0')).toBe('Edge · Windows');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36')).toBe('Chrome · macOS');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari · iPhone');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; rv:127.0) Gecko/20100101 Firefox/127.0')).toBe('Firefox · Windows');
  });

  it('says nothing rather than guessing', () => {
    expect(deviceLabel('filex-cli/1.0')).toBe('');
    expect(deviceLabel(undefined)).toBe('');
  });
});
