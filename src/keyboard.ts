import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// Frame escape sequences before handing them to Node's key decoder. Complete
// keys decode immediately; a lone Esc uses our short timeout, not Node's 500 ms.
export class Keyboard {
  private readonly keys = new PassThrough();
  private readonly utf8 = new StringDecoder('utf8');
  private readonly escapeMs = process.env.SSH_CONNECTION || process.env.SSH_TTY ? 100 : 10;
  private pending = '';
  private timer: NodeJS.Timeout | undefined;
  private active = false;
  private readonly onData = (chunk: Buffer | string): void => {
    const parts = (typeof chunk === 'string' ? chunk : this.utf8.write(chunk)).split('\x03');
    for (let i = 0; i < parts.length; i++) {
      this.pending += parts[i]!;
      this.dispatch();
      if (i < parts.length - 1) {
        // Even a broken/unfinished escape sequence must not delay Ctrl+C.
        this.pending = ''; clearTimeout(this.timer);
        this.keys.write('\x03');
      }
    }
  };
  constructor(readonly onKey: (text: string, key: Key) => void, readonly onScroll: (delta: number) => void = () => {}) {}
  start(): void {
    this.active = true;
    emitKeypressEvents(this.keys);
    this.keys.on('keypress', this.onKey);
    process.stdin.on('data', this.onData);
  }
  private dispatch(): void {
    clearTimeout(this.timer);
    while (this.active && this.pending) {
      const escape = this.pending.indexOf('\x1b');
      if (escape !== 0) {
        const length = escape < 0 ? this.pending.length : escape;
        const plain = this.pending.slice(0, length);
        this.pending = this.pending.slice(length);
        this.keys.write(plain);
        continue;
      }
      if (this.pending[1] === '\x1b') {
        this.pending = this.pending.slice(1);
        this.escape();
        continue;
      }
      let sequence: string | undefined;
      if (this.pending.startsWith('\x1b[M')) {
        // Consume legacy mouse reports too, so coordinates cannot become keys
        // on a terminal that supports mouse tracking but ignores SGR mode.
        if (this.pending.length >= 6) sequence = this.pending.slice(0, 6);
      } else if (this.pending.startsWith('\x1b[[')) {
        // Linux console F-keys use the older ESC [[ A form.
        if (this.pending.length >= 4) sequence = this.pending.slice(0, 4);
      } else if (this.pending[1] === '[' || this.pending[1] === 'O') {
        sequence = this.pending.match(/^\x1b(?:\[|O)[0-?]*[ -/]*[@-~]/)?.[0];
      } else if (this.pending.length > 1) {
        sequence = '\x1b' + Array.from(this.pending.slice(1))[0]!;
      }
      if (sequence) {
        this.pending = this.pending.slice(sequence.length);
        const mouse = sequence.match(/^\x1b\[<(\d+);\d+;\d+([mM])$/);
        const button = mouse ? Number(mouse[1]) : sequence.startsWith('\x1b[M') ? sequence.charCodeAt(3) - 32 : null;
        if (button !== null) {
          const wheel = button & 0xc3;
          if (!mouse || mouse[2] === 'M') {
            if (wheel === 64) this.onScroll(-3);
            if (wheel === 65) this.onScroll(3);
          }
        } else this.keys.write(sequence);
        continue;
      }
      if (this.pending.length > 4096) { this.pending = ''; return; }
      this.timer = setTimeout(() => {
        const loneEscape = this.pending === '\x1b';
        this.pending = '';
        if (this.active && loneEscape) this.escape();
        // Do not feed truncated CSI/SS3 into Node: its decoder would keep
        // waiting, potentially swallowing later keys or treating them as Alt.
      }, this.pending === '\x1b' ? this.escapeMs : Math.max(50, this.escapeMs));
      this.timer.unref();
      return;
    }
  }
  private escape(): void {
    this.onKey('\x1b', { sequence: '\x1b', name: 'escape', ctrl: false, meta: false, shift: false });
  }
  stop(): void {
    this.active = false;
    clearTimeout(this.timer); this.pending = '';
    process.stdin.off('data', this.onData);
    this.keys.off('keypress', this.onKey);
    this.keys.destroy();
  }
}
