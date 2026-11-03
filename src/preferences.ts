import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, lock, object } from './state.js';
import { setLanguage, validLanguage } from './i18n.js';
import type { Language } from './i18n.js';

export class Preferences {
  readonly path: string;
  constructor(home: string) { this.path = join(home, 'preferences.json'); }
  read(): Language {
    try {
      let stat;
      try { stat = lstatSync(this.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'en'; throw error; }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error();
      const value = object(JSON.parse(readFileSync(this.path, 'utf8')));
      if (value.app !== 'codex-window-preferences' || value.version !== 1 || !validLanguage(value.language) || Object.keys(value).some(key => !['app', 'version', 'language'].includes(key))) throw new Error();
      return value.language;
    } catch { throw new Error('Invalid preferences.json; expected language en or zh-CN. The file was not overwritten.'); }
  }
  load(): Language { const value = this.read(); setLanguage(value); return value; }
  async save(value: Language): Promise<void> {
    if (!validLanguage(value)) throw new Error('Language must be en or zh-CN');
    const release = await lock(`${this.path}.lock`);
    try {
      this.read();
      atomicJson(this.path, { app: 'codex-window-preferences', version: 1, language: value });
      setLanguage(value);
    } finally { release(); }
  }
}
