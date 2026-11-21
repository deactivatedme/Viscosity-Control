import { describe, expect, it } from 'vitest';
import { splitArgs } from '../src/components/projects/types';

describe('splitArgs', () => {
  it('splits on whitespace and honours quotes and escapes without expanding anything', () => {
    expect(splitArgs('npm run   test')).toEqual(['npm', 'run', 'test']);
    expect(splitArgs(`node -e "console.log('a b')" $HOME`)).toEqual(['node', '-e', "console.log('a b')", '$HOME']);
    expect(splitArgs(`echo 'it''s' "a \\" b" c\\ d ""`)).toEqual(['echo', 'its', 'a " b', 'c d', '']);
    expect(splitArgs('  ')).toEqual([]);
    expect(splitArgs('a; rm -rf / | b')).toEqual(['a;', 'rm', '-rf', '/', '|', 'b']); // operators are just words
  });
  it('rejects an unterminated quote', () => {
    expect(() => splitArgs('echo "oops')).toThrow(/unterminated/);
  });
});
