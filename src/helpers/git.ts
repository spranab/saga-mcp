import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

let cached: string | null | undefined;

function repoDir(): string {
  const dbPath = process.env.DB_PATH;
  return dbPath ? dirname(dbPath) : process.cwd();
}

export function getCurrentBranch(): string | null {
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cached = out && out !== 'HEAD' ? out : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function resolveBranch(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === '') return null;
  if (typeof input !== 'string') return undefined;
  if (input === 'current') return getCurrentBranch();
  return input;
}
