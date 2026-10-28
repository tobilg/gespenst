import { describe, expect, it, vi } from 'vitest';
import { ParserApi } from '../../xterm/src/parser';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function processed(parser: ParserApi, value: string): Promise<string> {
  return decoder.decode(await parser.process(encoder.encode(value)));
}

describe('xterm parser compatibility', () => {
  it('handles split CSI sequences and suppresses handled input', async () => {
    const parser = new ParserApi();
    const handler = vi.fn(() => true);
    parser.registerCsiHandler({ final: 'm' }, handler);

    expect(await processed(parser, 'before\x1b[31')).toBe('before');
    expect(await processed(parser, 'mafter')).toBe('after');
    expect(handler).toHaveBeenCalledWith([31]);
  });

  it('tries custom handlers in reverse registration order', async () => {
    const parser = new ParserApi();
    const calls: string[] = [];
    parser.registerOscHandler(9, () => {
      calls.push('first');
      return true;
    });
    parser.registerOscHandler(9, () => {
      calls.push('second');
      return false;
    });

    expect(await processed(parser, '\x1b]9;notice\x07')).toBe('');
    expect(calls).toEqual(['second', 'first']);
  });
});
