import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNetworkGuard, isPrivateAddress } from '../src/browser/guard';
import { assertSecureUrl } from '../src/config';
import { EventLog } from '../src/eventlog';
import { parseContainer, parseSize } from '../src/handlers/docker';
import { createPathGuard } from '../src/paths';

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'vc-worker-')));

describe('path guard', () => {
  const root = tmp();
  const outside = tmp();
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'file.txt'), 'x');
  writeFileSync(join(outside, 'secret'), 'x');
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(outside, 'not-yet'), join(root, 'dangling'));
  symlinkSync(join(root, 'sub'), join(root, 'inner'));
  const guard = createPathGuard([root]);

  it('allows paths inside the root, existing or not', async () => {
    expect(await guard(root)).toBe(root);
    expect(await guard(join(root, 'sub', 'file.txt'))).toBe(join(root, 'sub', 'file.txt'));
    expect(await guard(join(root, 'sub', 'new', 'deep.txt'))).toBe(join(root, 'sub', 'new', 'deep.txt'));
    expect(await guard(join(root, 'inner', 'file.txt'))).toBe(join(root, 'sub', 'file.txt'));
  });
  it('rejects traversal, siblings and relative paths', async () => {
    await expect(guard(join(root, '..', 'etc'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(guard(`${root}/sub/../../etc/passwd`)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(guard('/etc/passwd')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(guard(`${root}-sibling`)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(guard('sub/file.txt')).rejects.toMatchObject({ code: 'invalid' });
  });
  it('rejects symlink escapes, including new files under a symlinked dir and dangling links', async () => {
    await expect(guard(join(root, 'escape', 'secret'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(guard(join(root, 'escape', 'new-file'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(guard(join(root, 'dangling'))).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('network guard', () => {
  it('classifies addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00:ec2::254', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  it('blocks internal URLs and bad schemes, honours allowHosts', async () => {
    const guard = createNetworkGuard(['127.0.0.1:8080', 'intranet.test']);
    expect(await guard('http://169.254.169.254/latest/meta-data/')).toMatch(/private/);
    expect(await guard('http://localhost:3000/')).toMatch(/private/);
    expect(await guard('http://[::1]/')).toMatch(/private/);
    expect(await guard('http://127.0.0.1:9999/')).toMatch(/private/);
    expect(await guard('file:///etc/passwd')).toMatch(/scheme/);
    expect(await guard('ftp://example.com/')).toMatch(/scheme/);
    expect(await guard('http://127.0.0.1:8080/x')).toBeNull();
    expect(await guard('https://intranet.test/x')).toBeNull();
    expect(await guard('https://8.8.8.8/')).toBeNull();
    expect(await guard('data:text/plain,hi')).toBeNull();
  });
});

describe('event log', () => {
  it('numbers events monotonically across instances and replays after a seq', async () => {
    const dir = tmp();
    const id = 'a2f1c1de-0000-4000-8000-000000000001';
    const log = new EventLog<{ n: number }>(dir);
    expect(log.append(id, { n: 1 }).seq).toBe(1);
    expect(log.append(id, { n: 2 }).seq).toBe(2);
    // A fresh instance (worker restart) continues the sequence from disk.
    const reopened = new EventLog<{ n: number }>(dir);
    expect(reopened.lastSeq(id)).toBe(2);
    expect(reopened.append(id, { n: 3 }).seq).toBe(3);
    const seen: number[] = [];
    expect(await reopened.replay(id, 1, (e) => seen.push(e.seq))).toBe(2);
    expect(seen).toEqual([2, 3]);
    expect(reopened.known(60_000)).toEqual([{ id, lastSeq: 3 }]);
    expect(await reopened.replay('missing', 0, () => undefined)).toBe(0);
  });
});

describe('misc parsing', () => {
  it('parses docker sizes and container rows', () => {
    expect(parseSize('12.5MiB')).toBe(13107200);
    expect(parseSize('1.5GB')).toBe(1_500_000_000);
    expect(parseSize('500kB')).toBe(500_000);
    expect(parseSize('0B')).toBe(0);
    const c = parseContainer({ ID: 'abc', Names: 'web', Image: 'nginx', State: 'running', Status: 'Up 2 hours (healthy)', Ports: '', CreatedAt: 'x', Labels: 'com.docker.compose.project=shop,a=b' });
    expect(c).toMatchObject({ id: 'abc', composeProject: 'shop', health: 'healthy' });
  });
  it('only accepts unencrypted control URLs on loopback', () => {
    expect(() => assertSecureUrl('https://control.example.com')).not.toThrow();
    expect(() => assertSecureUrl('http://127.0.0.1:4000')).not.toThrow();
    expect(() => assertSecureUrl('http://control.example.com')).toThrow(/unencrypted/);
    expect(() => assertSecureUrl('http://control.example.com', true)).not.toThrow();
  });
});
