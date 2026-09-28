import { useSettings } from './store';
import { translate, Lang } from './i18n';

export function useT() {
  const lang = useSettings((s) => s.lang) as Lang;
  return (key: string) => translate(lang, key);
}

export { translate };
