import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hashPassword, hashToken, makeSecretBox, safeEqualHex, totp, verifyPassword, verifyTotp } from '../src/crypto';

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('correct-horse');
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-batterx', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('tokens', () => {
  it('compares hashes in constant time and by value', () => {
    expect(safeEqualHex(hashToken('a'), hashToken('a'))).toBe(true);
    expect(safeEqualHex(hashToken('a'), hashToken('b'))).toBe(false);
    expect(safeEqualHex(hashToken('a'), 'abcd')).toBe(false);
  });
});

describe('secret box', () => {
  const box = makeSecretBox('k'.repeat(32));
  it('round-trips and never contains the plaintext', () => {
    const boxed = box.encrypt('sk-ant-secret-value');
    expect(boxed).not.toContain('sk-ant');
    expect(box.decrypt(boxed)).toBe('sk-ant-secret-value');
    expect(box.encrypt('sk-ant-secret-value')).not.toBe(boxed); // fresh IV every time
  });
  it('rejects tampered ciphertext and the wrong key', () => {
    const boxed = box.encrypt('value');
    const parts = boxed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
    expect(() => makeSecretBox('z'.repeat(32)).decrypt(boxed)).toThrow();
  });
});

describe('TOTP (RFC 6238 SHA-1 vectors, truncated to 6 digits)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the reference values', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1111111109_000)).toBe('081804');
    expect(totp(secret, 1234567890_000)).toBe('005924');
  });
  it('accepts ±1 step and nothing further', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, '000000', now)).toBe(totp(secret, now) === '000000');
  });
});

describe('configuration', () => {
  it('treats empty optional variables (as docker compose passes them) as unset', async () => {
    const { loadConfig } = await import('../src/config');
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x/y', VISCOSITY_SECRET_KEY: 'k'.repeat(32), PUBLIC_ORIGIN: 'https://control.example', WORKER_URL: '', WORKER_BUNDLE: '' } as NodeJS.ProcessEnv);
    expect(cfg.workerUrl).toBe('https://control.example');
    expect(cfg.cookieSecure).toBe(true);
  });
});
