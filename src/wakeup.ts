import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';

// Directory notifications survive atomic file replacement. A bounded timeout
// is still required: fs.watch can lose events or a watched directory can move.
export class Wakeup {
  private pending = false;
  private finish: (() => void) | undefined;
  private readonly watchers: FSWatcher[] = [];
  notify(): void { this.pending = true; this.finish?.(); }
  watch(directory: string, names: string[], changed: () => void = () => {}): void {
    try {
      const watcher = watch(directory, (_event, filename) => {
        if (!filename || names.includes(filename.toString())) { this.notify(); changed(); }
      });
      watcher.on('error', () => { watcher.close(); this.notify(); });
      this.watchers.push(watcher);
    } catch { /* The low-frequency timeout remains active. */ }
  }
  async wait(milliseconds: number): Promise<void> {
    if (this.pending) { this.pending = false; return; }
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>(resolve => {
        this.finish = resolve;
        timer = setTimeout(resolve, Math.max(1, Math.min(30_000, milliseconds)));
      });
    } finally { clearTimeout(timer); this.finish = undefined; this.pending = false; }
  }
  close(): void { for (const watcher of this.watchers) watcher.close(); this.notify(); }
}
