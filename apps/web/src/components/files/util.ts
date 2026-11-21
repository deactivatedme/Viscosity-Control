export const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);
export const parentPath = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/';
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const fsUrl = (serverId: string, op: string, params: Record<string, string>) =>
  `/api/servers/${serverId}/fs/${op}?${new URLSearchParams(params)}`;

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
export const imageType = (name: string) => IMAGE_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];

/** Browser download through the authenticated API (Content-Disposition: attachment keeps the page in place). */
export function download(serverId: string, path: string) {
  const a = document.createElement('a');
  a.href = fsUrl(serverId, 'download', { path });
  a.download = baseName(path);
  a.click();
}
