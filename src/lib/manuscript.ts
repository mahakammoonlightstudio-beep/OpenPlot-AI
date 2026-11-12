/**
 * Manuscript check (pure, offline).
 *
 * Novelists revise at the sentence level, but the app only reported totals.
 * This turns chapter text into concrete revision questions — repeated sentence
 * openings, filter words, overused words, long sentences, dialogue balance —
 * with no AI call and no network. Every number is a heuristic, so the UI
 * presents them as hints, never as verdicts.
 */

export interface ManuscriptChapter {
  id?: string | null;
  title: string;
  content: string;
}

export interface WordHit {
  word: string;
  count: number;
  /** Occurrences per 1,000 words, so short and long novels compare fairly. */
  per1000: number;
}

export interface OpeningHit {
  word: string;
  count: number;
}

export interface LongSentence {
  chapter: string;
  words: number;
  text: string;
}

export interface ChapterCheck {
  id: string | null;
  title: string;
  words: number;
  sentences: number;
  avgSentence: number;
  dialogueShare: number;
  longSentences: number;
  filterHits: number;
}

export interface ManuscriptReport {
  words: number;
  sentences: number;
  paragraphs: number;
  readingMinutes: number;
  avgSentence: number;
  dialogueShare: number;
  longSentenceCount: number;
  filterWords: WordHit[];
  overused: WordHit[];
  openings: OpeningHit[];
  adverbs: WordHit[];
  longSentences: LongSentence[];
  chapters: ChapterCheck[];
}

// Words that put a camera between the reader and the scene. Kept bilingual so
// the check works on an English or Indonesian draft without a setting.
const FILTER_WORDS = new Set([
  'felt', 'feel', 'feels', 'saw', 'see', 'sees', 'heard', 'hear', 'noticed', 'realized',
  'realised', 'seemed', 'thought', 'looked', 'watched', 'wondered', 'decided', 'knew',
  'smelled', 'tasted', 'touched',
  'merasa', 'terasa', 'melihat', 'lihat', 'mendengar', 'dengar', 'menyadari', 'sadar',
  'tampak', 'terlihat', 'sepertinya', 'memutuskan', 'berpikir', 'menatap', 'memperhatikan',
  'merasakan'
]);

// Ordinary glue words: frequent by nature, so counting them says nothing.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'into', 'onto', 'over',
  'under', 'about', 'after', 'before', 'between', 'through', 'during', 'without', 'again',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has',
  'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'not', 'no',
  'yes', 'so', 'just', 'very', 'too', 'only', 'also', 'even', 'still', 'ever', 'never',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'there', 'here', 'who', 'what', 'when', 'where',
  'why', 'how', 'all', 'any', 'some', 'more', 'most', 'other', 'one', 'two', 'up', 'down',
  'out', 'off', 'now', 'like', 'said', 'says', 'say',
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'pada', 'itu', 'ini', 'adalah',
  'tidak', 'tak', 'bukan', 'ada', 'akan', 'sudah', 'telah', 'masih', 'juga', 'saja',
  'karena', 'kalau', 'jika', 'saat', 'ketika', 'setelah', 'sebelum', 'sambil', 'dalam',
  'atas', 'bawah', 'antara', 'tentang', 'seperti', 'bagai', 'oleh', 'bagi', 'kepada',
  'aku', 'saya', 'kamu', 'kau', 'dia', 'ia', 'kami', 'kita', 'mereka', 'mu', 'nya',
  'the', 'sebuah', 'para', 'sang', 'si', 'pun', 'lah', 'kah', 'nya', 'nya'
]);

// -ly words that are not adverbs (or are too common to be useful as a hint).
const ADVERB_EXCEPTIONS = new Set([
  'only', 'family', 'reply', 'apply', 'supply', 'rely', 'holy', 'ugly', 'silly', 'friendly',
  'lonely', 'lovely', 'early', 'daily', 'likely', 'ally', 'belly', 'jelly', 'rally', 'tally',
  'fully', 'really', 'finally', 'usually', 'probably', 'actually', 'especially', 'suddenly'
]);

const LONG_SENTENCE_WORDS = 35;
const MIN_OPENING_REPEATS = 3;
const MIN_OVERUSE = 6;
const MIN_OVERUSE_PER_1000 = 3;
const MIN_ADVERB_COUNT = 2;
const MAX_LIST = 8;

const countWords = (text: string): number => (text.trim().match(/\S+/g) || []).length;

const tokens = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}'’\-]+/gu) || [];

const sentencesOf = (text: string): string[] =>
  (text.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*/g) || [])
    .map((s) => s.trim())
    .filter((s) => countWords(s) > 0);

const round1 = (n: number): number => Math.round(n * 10) / 10;

const byCount = <T extends { count: number }>(a: T, b: T): number =>
  b.count - a.count || 0;

/**
 * Analyse every chapter of one novel and return one report. Empty input is a
 * valid draft (a new project), so it returns zeros instead of throwing.
 */
export function analyzeManuscript(chapters: ManuscriptChapter[]): ManuscriptReport {
  const texts = chapters.map((c) => ({
    id: c.id ?? null,
    title: c.title,
    content: c.content || ''
  }));
  const all = texts.map((c) => c.content).join('\n\n');
  const words = countWords(all);
  const sentences = sentencesOf(all);
  const paragraphCount = all.split(/\n{2,}/).filter((p) => p.trim()).length;

  // Dialogue: words inside a quoted span. Matches straight and typographic
  // quotes, including the low-high pair some Indonesian drafts use.
  const quoted = all.match(/["“«][^"”»]*["”»]/g) || [];
  const dialogueWords = quoted.reduce((sum, span) => sum + countWords(span), 0);
  const dialogueShare = words ? round1((dialogueWords / words) * 100) : 0;

  const sentenceWordCounts = sentences.map(countWords);
  const avgSentence = sentences.length ? round1(words / sentences.length) : 0;

  const filterCounts = new Map<string, number>();
  const wordCounts = new Map<string, number>();
  const openingCounts = new Map<string, number>();
  const adverbCounts = new Map<string, number>();

  for (const token of tokens(all)) {
    wordCounts.set(token, (wordCounts.get(token) || 0) + 1);
    if (FILTER_WORDS.has(token)) filterCounts.set(token, (filterCounts.get(token) || 0) + 1);
    if (token.length > 4 && token.endsWith('ly') && !ADVERB_EXCEPTIONS.has(token)) {
      adverbCounts.set(token, (adverbCounts.get(token) || 0) + 1);
    }
  }

  for (const sentence of sentences) {
    const first = tokens(sentence)[0];
    if (first) openingCounts.set(first, (openingCounts.get(first) || 0) + 1);
  }

  const per1000 = (count: number): number => (words ? round1((count / words) * 1000) : 0);

  const filterWords: WordHit[] = [...filterCounts.entries()]
    .map(([word, count]) => ({ word, count, per1000: per1000(count) }))
    .sort(byCount)
    .slice(0, MAX_LIST);

  const overused: WordHit[] = [...wordCounts.entries()]
    .filter(([word, count]) => word.length >= 3 && !STOPWORDS.has(word)
      && count >= MIN_OVERUSE && per1000(count) >= MIN_OVERUSE_PER_1000)
    .map(([word, count]) => ({ word, count, per1000: per1000(count) }))
    .sort(byCount)
    .slice(0, MAX_LIST);

  const adverbs: WordHit[] = [...adverbCounts.entries()]
    .filter(([, count]) => count >= MIN_ADVERB_COUNT)
    .map(([word, count]) => ({ word, count, per1000: per1000(count) }))
    .sort(byCount)
    .slice(0, 5);

  const openings: OpeningHit[] = [...openingCounts.entries()]
    .filter(([, count]) => count >= MIN_OPENING_REPEATS)
    .map(([word, count]) => ({ word, count }))
    .sort(byCount)
    .slice(0, 6);

  // Per-chapter rows, plus the long sentences the writer can actually open.
  const longSentences: LongSentence[] = [];
  const chapterChecks: ChapterCheck[] = texts.map((chapter) => {
    const chapterSentences = sentencesOf(chapter.content);
    const chapterWords = countWords(chapter.content);
    const long = chapterSentences.filter((s) => countWords(s) >= LONG_SENTENCE_WORDS);
    for (const sentence of long) {
      longSentences.push({
        chapter: chapter.title,
        words: countWords(sentence),
        text: sentence.length > 220 ? sentence.slice(0, 217) + '…' : sentence
      });
    }
    const chapterTokens = tokens(chapter.content);
    const filterHits = chapterTokens.filter((t) => FILTER_WORDS.has(t)).length;
    const chapterQuoted = chapter.content.match(/["“«][^"”»]*["”»]/g) || [];
    const chapterDialogue = chapterQuoted.reduce((sum, span) => sum + countWords(span), 0);
    return {
      id: chapter.id,
      title: chapter.title,
      words: chapterWords,
      sentences: chapterSentences.length,
      avgSentence: chapterSentences.length ? round1(chapterWords / chapterSentences.length) : 0,
      dialogueShare: chapterWords ? round1((chapterDialogue / chapterWords) * 100) : 0,
      longSentences: long.length,
      filterHits
    };
  });

  longSentences.sort((a, b) => b.words - a.words);

  return {
    words,
    sentences: sentences.length,
    paragraphs: paragraphCount,
    readingMinutes: Math.max(1, Math.round(words / 225)),
    avgSentence,
    dialogueShare,
    longSentenceCount: sentenceWordCounts.filter((n) => n >= LONG_SENTENCE_WORDS).length,
    filterWords,
    overused,
    openings,
    adverbs,
    longSentences: longSentences.slice(0, 3),
    chapters: chapterChecks
  };
}
