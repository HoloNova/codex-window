import { currentVersion } from './runtime.js';

export const RELEASES_URL = 'https://github.com/HoloNova/codex-window/releases';
const LATEST_RELEASE_API = 'https://api.github.com/repos/HoloNova/codex-window/releases/latest';
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion { main: [number, number, number]; pre: string[] }

export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION.exec(value);
  if (!match) return null;
  const main = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (main.some(part => !Number.isSafeInteger(part))) return null;
  return { main, pre: match[4] ? match[4].split('.') : [] };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < a.length; i++) {
    if (i >= b.length) return 1;
    const left = a[i]!, right = b[i]!, leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) - Number(right);
    } else if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    else if (left !== right) return left < right ? -1 : 1;
  }
  return a.length === b.length ? 0 : -1;
}

export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left.main[i] !== right.main[i]) return left.main[i]! - right.main[i]!;
  return comparePre(left.pre, right.pre);
}

export function isNewerVersion(latest: string, current: string): boolean {
  const compared = compareVersions(latest, current);
  return compared !== null && compared > 0;
}

// This is an optional, read-only check. It never downloads or executes a
// release and returns null for any malformed or unavailable response so the
// TUI can stay silent when offline or rate-limited.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => { cleanup(); reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export async function fetchLatestTag(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<string | null> {
  const timeout = AbortSignal.timeout(5000);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let response: Response;
  try {
    response = await fetcher(LATEST_RELEASE_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `codex-window/${currentVersion()}` },
      credentials: 'omit',
      redirect: 'error',
      signal: combined,
    });
  } catch { return null; }
  if (!response.ok) return null;
  let value: unknown;
  try { value = await abortable(response.json(), combined); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const release = value as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (release.draft === true || release.prerelease === true) return null;
  return typeof release.tag_name === 'string' && parseVersion(release.tag_name) ? release.tag_name : null;
}
