/**
 * Time-aware greetings for the Home screen.
 *
 * The same hero line all day reads like a splash screen; a short line that
 * matches the hour (and rotates every minute) makes Home feel like a desk that
 * is ready, not a poster. Pure and dependency-free so it can be unit-tested.
 */
import type { Lang } from '../i18n';

export type GreetLang = 'en' | 'id' | 'es' | 'hi';
export type DaySlot = 'morning' | 'afternoon' | 'evening' | 'night';

export function slotOf(hour: number): DaySlot {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

const SALUTATION: Record<DaySlot, Record<GreetLang, string>> = {
  morning: { en: 'Good morning', id: 'Selamat pagi', es: 'Buenos días', hi: 'सुप्रभात' },
  afternoon: { en: 'Good afternoon', id: 'Selamat siang', es: 'Buenas tardes', hi: 'नमस्कार' },
  evening: { en: 'Good evening', id: 'Selamat malam', es: 'Buenas noches', hi: 'शुभ संध्या' },
  night: { en: 'Late night', id: 'Malam larut', es: 'Madrugada', hi: 'देर रात' }
};

/** Short openers — one line, never instructions the user has to read twice. */
const OPENERS: Record<GreetLang, string[]> = {
  en: [
    'What are we writing today?',
    'A scene, a chapter, or a plan?',
    'The blank page is yours.',
    'Pick up a thread from yesterday.',
    'Ask canon before you invent.',
    'One idea is enough to start.'
  ],
  id: [
    'Hari ini mau menulis apa?',
    'Adegan, bab, atau rencana dulu?',
    'Halaman kosong itu milikmu.',
    'Lanjutkan benang dari kemarin.',
    'Tanya kanon sebelum mengarang.',
    'Satu ide cukup untuk mulai.'
  ],
  es: [
    '¿Qué escribimos hoy?',
    '¿Una escena, un capítulo o un plan?',
    'La página en blanco es tuya.',
    'Retoma un hilo de ayer.',
    'Pregunta al canon antes de inventar.',
    'Una idea basta para empezar.'
  ],
  hi: [
    'आज क्या लिखें?',
    'एक दृश्य, एक अध्याय, या योजना?',
    'खाली पन्ना आपका है।',
    'कल के धागे से आगे बढ़ें।',
    'कुछ गढ़ने से पहले कहानी से पूछें।',
    'शुरू करने के लिए एक विचार काफ़ी है।'
  ]
};

const greetLang = (lang: Lang): GreetLang =>
  lang === 'id' || lang === 'es' || lang === 'hi' ? lang : 'en';

export function greetingFor(lang: Lang, now: Date = new Date()): string {
  return SALUTATION[slotOf(now.getHours())][greetLang(lang)];
}

/** Deterministic rotation: the line changes each minute, not on every pill. */
export function openingFor(lang: Lang, now: Date = new Date()): string {
  const list = OPENERS[greetLang(lang)];
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  return list[minuteOfDay % list.length];
}
