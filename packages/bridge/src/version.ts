/**
 * Server version, read from this package's package.json at startup.
 * Kept in its own module so the CLI can print --version without pulling
 * in the http/ws stack.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PkgJson {
  version?: string;
}

let version = '0.0.0';
try {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  version = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PkgJson).version ?? version;
} catch {
  /* fall back to 0.0.0 — version display must never crash the server */
}

export const SERVER_VERSION = version;
