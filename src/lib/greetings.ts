/**
 * Time-aware greetings for the Home screen.
 *
 * The same hero line all day reads like a splash screen; a short line that
 * matches the hour (and rotates every minute) makes Home feel like a desk that
 * is ready, not a poster. Pure and dependency-free so it can be unit-tested.
 */
export type GreetLang = 'en' | 'id';
export type DaySlot = 'morning' | 'afternoon' | 'evening' | 'night';

export function slotOf(hour: number): DaySlot {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

const SALUTATION: Record<DaySlot, Record<GreetLang, string>> = {
  morning: { en: 'Good morning', id: 'Selamat pagi' },
  afternoon: { en: 'Good afternoon', id: 'Selamat siang' },
  evening: { en: 'Good evening', id: 'Selamat malam' },
  night: { en: 'Late night', id: 'Malam larut' }
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
  ]
};

export function greetingFor(lang: GreetLang, now: Date = new Date()): string {
  return SALUTATION[slotOf(now.getHours())][lang];
}

/** Deterministic rotation: the line changes each minute, not on every pill. */
export function openingFor(lang: GreetLang, now: Date = new Date()): string {
  const list = OPENERS[lang];
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  return list[minuteOfDay % list.length];
}
