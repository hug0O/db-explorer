import { FR } from './i18nFr';

/** Langue de l'interface : anglais par défaut, français si VS Code (donc l'OS) est en français. */
function language(): 'en' | 'fr' {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lang: string = require('vscode').env.language ?? 'en';
    return lang.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en'; // hors VS Code (tests)
  }
}

/** Traduit une clé anglaise ; {0}, {1}… sont remplacés par les arguments. */
export function t(key: string, ...args: (string | number)[]): string {
  let s = language() === 'fr' ? FR[key] ?? key : key;
  args.forEach((a, i) => {
    s = s.split('{' + i + '}').join(String(a));
  });
  return s;
}

export const isFrench = () => language() === 'fr';
