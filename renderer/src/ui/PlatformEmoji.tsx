import { CSSProperties, ReactNode, useEffect, useMemo, useState } from 'react';
import {
  emojiAssetCandidates,
  isEmojiGrapheme,
  shouldUseFluentEmoji,
  splitGraphemes
} from './platformEmojiUtils';

interface PlatformEmojiProps {
  emoji: string;
  className?: string;
  size?: number | string;
  decorative?: boolean;
}

interface PlatformEmojiTextProps {
  children: string;
  className?: string;
}

const failedAssets = new Set<string>();

const assetUrl = (fileName: string): string =>
  new URL(`./fluent-emoji-3d/${fileName}`, document.baseURI).href;

export const PlatformEmoji = ({
  emoji,
  className = '',
  size = '1em',
  decorative = false
}: PlatformEmojiProps) => {
  const candidates = useMemo(() => emojiAssetCandidates(emoji), [emoji]);
  const firstAvailableCandidate = (): number => {
    const index = candidates.findIndex((candidate) => !failedAssets.has(candidate));
    return index < 0 ? candidates.length : index;
  };
  const [candidateIndex, setCandidateIndex] = useState(firstAvailableCandidate);
  const [nativeFallback, setNativeFallback] = useState(false);

  useEffect(() => {
    setCandidateIndex(firstAvailableCandidate());
    setNativeFallback(false);
  }, [candidates]);

  if (!shouldUseFluentEmoji() || nativeFallback || !candidates[candidateIndex]) {
    return (
      <span className={`platform-emoji-native ${className}`.trim()} aria-hidden={decorative || undefined}>
        {emoji}
      </span>
    );
  }

  const fileName = candidates[candidateIndex];
  const style: CSSProperties = { width: size, height: size };

  return (
    <img
      className={`platform-emoji-fluent ${className}`.trim()}
      src={assetUrl(fileName)}
      alt={decorative ? '' : emoji}
      aria-hidden={decorative || undefined}
      draggable={false}
      style={style}
      onError={() => {
        failedAssets.add(fileName);
        const nextCandidate = candidates.findIndex(
          (candidate, index) => index > candidateIndex && !failedAssets.has(candidate)
        );
        if (nextCandidate >= 0) {
          setCandidateIndex(nextCandidate);
        } else {
          setNativeFallback(true);
        }
      }}
    />
  );
};

export const PlatformEmojiText = ({ children, className = '' }: PlatformEmojiTextProps): ReactNode => {
  if (!shouldUseFluentEmoji()) return children;

  const segments: Array<{ value: string; emoji: boolean }> = [];
  for (const grapheme of splitGraphemes(children)) {
    if (isEmojiGrapheme(grapheme)) {
      segments.push({ value: grapheme, emoji: true });
      continue;
    }

    const previous = segments[segments.length - 1];
    if (previous && !previous.emoji) {
      previous.value += grapheme;
    } else {
      segments.push({ value: grapheme, emoji: false });
    }
  }

  return (
    <span className={className || undefined}>
      {segments.map((segment, index) =>
        segment.emoji ? (
          <PlatformEmoji key={`${segment.value}-${index}`} emoji={segment.value} />
        ) : (
          segment.value
        )
      )}
    </span>
  );
};
