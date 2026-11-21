// Self-host Monaco: the editor is served from /monaco/vs instead of a CDN.
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const src = path.resolve(import.meta.dirname, '../node_modules/monaco-editor/min/vs');
const dest = path.resolve(import.meta.dirname, '../public/monaco/vs');
if (!existsSync(path.join(src, 'loader.js'))) throw new Error(`monaco-editor AMD build not found at ${src}`);
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`monaco copied to ${dest}`);
