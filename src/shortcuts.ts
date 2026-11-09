import { t } from './i18n';
export type Keymap = 'standard' | 'alt' | 'toad';

export const KEYMAP_LABELS: Record<Keymap, string> = {
  standard: t('Standard (Ctrl+Alt) — no VS Code conflict'),
  alt: t('Alternative (Alt)'),
  toad: t('Classic Toad (F9, F5, F4…) — overrides VS Code shortcuts'),
};

export interface Shortcut {
  command: string;
  label: string;
  keys: Record<Keymap, string[]>;
}

export const SHORTCUTS: Shortcut[] = [
  { command: 'dbexplorer.newEditor', label: t('New SQL editor'), keys: { standard: ['Ctrl+Alt+N'], alt: ['Alt+Shift+N'], toad: ['Ctrl+Alt+N'] } },
  { command: 'dbexplorer.executeStatement', label: t('Execute statement at cursor'), keys: { standard: ['Ctrl+Alt+Enter'], alt: ['Alt+Enter'], toad: ['F9', 'Ctrl+Enter'] } },
  { command: 'dbexplorer.executeScript', label: t('Execute script (or selection)'), keys: { standard: ['Ctrl+Alt+S'], alt: ['Alt+Shift+Enter'], toad: ['F5'] } },
  { command: 'dbexplorer.explainPlan', label: 'Explain Plan', keys: { standard: ['Ctrl+Alt+X'], alt: ['Alt+Shift+E'], toad: ['Ctrl+E'] } },
  { command: 'dbexplorer.describe', label: t('Describe Objects (table) / open source (package, function, trigger…)'), keys: { standard: ['Ctrl+Alt+D'], alt: ['Alt+D'], toad: ['F4'] } },
  { command: 'dbexplorer.suggest', label: t('Trigger code completion'), keys: { standard: ['Ctrl+Alt+Space'], alt: ['Alt+Shift+Space'], toad: ['Ctrl+Space'] } },
  { command: 'dbexplorer.toggleComment', label: t('Comment / uncomment lines (--)'), keys: { standard: ['Ctrl+Alt+C'], alt: ['Alt+Shift+C'], toad: ['Ctrl+B'] } },
  { command: 'dbexplorer.optimize', label: t('Suggest query optimizations'), keys: { standard: ['Ctrl+Alt+O'], alt: ['Alt+Shift+O'], toad: ['Ctrl+Alt+O'] } },
  { command: 'dbexplorer.codeActions', label: t('Show actions at the cursor'), keys: { standard: ['Ctrl+Alt+A'], alt: ['Alt+Shift+A'], toad: ['Ctrl+Alt+A'] } },
  { command: 'dbexplorer.cancel', label: t('Cancel the running statement'), keys: { standard: ['Ctrl+Alt+Q'], alt: ['Alt+Shift+Q'], toad: ['Ctrl+Alt+Q'] } },
  { command: 'dbexplorer.describeQuery', label: t('Query column types'), keys: { standard: ['Ctrl+Alt+T'], alt: ['Alt+Shift+D'], toad: ['Ctrl+F9'] } },
];

/** Convertit « Ctrl+Alt+Enter » en notation package.json « ctrl+alt+enter ». */
export const toKeybinding = (k: string) => k.toLowerCase();
