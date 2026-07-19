const EMOJI_GRAPHEME_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u;

export const emojiAssetName = (emoji: string): string =>
  `${Array.from(emoji, (character) => character.codePointAt(0)?.toString(16) || '').join('-')}.webp`;

export const emojiAssetCandidates = (emoji: string): string[] => {
  const exact = emojiAssetName(emoji);
  const withoutVariationSelector = emojiAssetName(emoji.replace(/\uFE0F/gu, ''));
  return exact === withoutVariationSelector ? [exact] : [exact, withoutVariationSelector];
};

export const isEmojiGrapheme = (value: string): boolean => EMOJI_GRAPHEME_PATTERN.test(value);

export const splitGraphemes = (value: string): string[] => {
  if (!value) return [];

  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: 'grapheme' }
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;

  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value), ({ segment }) => segment);
  }

  return Array.from(value);
};

export const shouldUseFluentEmoji = (): boolean => {
  if (typeof document !== 'undefined' && document.documentElement.dataset.platform === 'win32') {
    return true;
  }

  if (typeof window === 'undefined' || !window.lantern) return false;
  return window.lantern.getPlatform() === 'win32';
};
