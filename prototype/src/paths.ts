// Locate prototype assets (policy.yml, templates/, hooks/) regardless of which layout we run from:
//   prototype/dist/*.js                → prototype/<rel>
//   <pkg>/out/prototype/src/*.js       → repo/prototype/<rel> (extension/desktop dev)
//   resources/app.asar/out/prototype/src → resources/prototype/<rel> (desktop packaged, extraResources)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function protoAsset(rel: string, fromFile = fileURLToPath(import.meta.url)): string | undefined {
  const dir = path.dirname(fromFile);
  return [path.resolve(dir, '..', rel), path.resolve(dir, '..', '..', '..', '..', 'prototype', rel)].find((p) => existsSync(p));
}
