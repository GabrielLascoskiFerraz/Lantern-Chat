import { useMemo, useState } from 'react';
import { Button, Input, Text } from '@fluentui/react-components';
import {
  AnimalCat20Regular,
  Briefcase20Regular,
  Checkmark20Regular,
  Emoji20Regular,
  Food20Regular,
  Games20Regular,
  History20Regular,
  Search20Regular
} from '@fluentui/react-icons';
import {
  isProfileColor,
  PROFILE_COLOR_OPTIONS,
  PROFILE_EMOJI_CATEGORIES,
  PROFILE_EMOJI_OPTIONS,
  ProfileEmojiOption
} from './profileIdentityOptions';

const RECENT_EMOJIS_KEY = 'lantern.profile.recent-emojis.v1';
const MAX_RECENT_EMOJIS = 16;

type CategoryId = 'recent' | (typeof PROFILE_EMOJI_CATEGORIES)[number]['id'];

const CATEGORY_PRESENTATION = {
  recent: { shortLabel: 'Recentes', icon: History20Regular },
  expressions: { shortLabel: 'Rostos', icon: Emoji20Regular },
  people: { shortLabel: 'Trabalho', icon: Briefcase20Regular },
  nature: { shortLabel: 'Animais', icon: AnimalCat20Regular },
  food: { shortLabel: 'Comidas', icon: Food20Regular },
  activities: { shortLabel: 'Atividades', icon: Games20Regular }
};

interface ProfileIdentityEditorProps {
  emoji: string;
  color: string;
  onEmojiChange: (emoji: string) => void;
  onColorChange: (color: string) => void;
  compact?: boolean;
  section?: 'all' | 'emoji' | 'color';
}

const normalizeSearch = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR');

const splitGraphemes = (value: string): string[] => {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), (item) => item.segment);
  }
  return Array.from(value);
};

const validCustomEmoji = (value: string): string | null => {
  const trimmed = value.trim();
  const graphemes = splitGraphemes(trimmed);
  if (graphemes.length !== 1) return null;
  return /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(graphemes[0])
    ? graphemes[0]
    : null;
};

const readRecentEmojis = (): string[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_EMOJIS_KEY) || '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT_EMOJIS)
      : [];
  } catch {
    return [];
  }
};

export const ProfileIdentityEditor = ({
  emoji,
  color,
  onEmojiChange,
  onColorChange,
  compact = false,
  section = 'all'
}: ProfileIdentityEditorProps) => {
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<CategoryId>('expressions');
  const [recentEmojis, setRecentEmojis] = useState<string[]>(readRecentEmojis);
  const [customEmoji, setCustomEmoji] = useState('');
  const [customEmojiError, setCustomEmojiError] = useState('');
  const [customColorOpen, setCustomColorOpen] = useState(false);
  const [customColor, setCustomColor] = useState(isProfileColor(color) ? color : '#147ad6');

  const recentOptions = useMemo<ProfileEmojiOption[]>(
    () =>
      recentEmojis.map((recentEmoji) => {
        const known = PROFILE_EMOJI_OPTIONS.find((option) => option.emoji === recentEmoji);
        return known || { emoji: recentEmoji, label: 'Emoji recente', keywords: [] };
      }),
    [recentEmojis]
  );

  const visibleOptions = useMemo(() => {
    const normalizedQuery = normalizeSearch(query);
    if (normalizedQuery) {
      return PROFILE_EMOJI_OPTIONS.filter((option) =>
        normalizeSearch([option.emoji, option.label, ...option.keywords].join(' ')).includes(normalizedQuery)
      );
    }
    if (selectedCategory === 'recent') return recentOptions;
    return PROFILE_EMOJI_CATEGORIES.find((category) => category.id === selectedCategory)?.options || [];
  }, [query, recentOptions, selectedCategory]);

  const chooseEmoji = (nextEmoji: string): void => {
    onEmojiChange(nextEmoji);
    setCustomEmojiError('');
    setRecentEmojis((current) => {
      const next = [nextEmoji, ...current.filter((item) => item !== nextEmoji)].slice(0, MAX_RECENT_EMOJIS);
      try {
        window.localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(next));
      } catch {
        // A escolha continua funcional quando o armazenamento local está indisponível.
      }
      return next;
    });
  };

  const applyCustomEmoji = (): void => {
    const nextEmoji = validCustomEmoji(customEmoji);
    if (!nextEmoji) {
      setCustomEmojiError('Informe somente um emoji.');
      return;
    }
    chooseEmoji(nextEmoji);
    setCustomEmoji('');
  };

  const applyCustomColor = (value: string): void => {
    setCustomColor(value);
    if (isProfileColor(value)) onColorChange(value);
  };

  const categories: Array<{ id: CategoryId; label: string }> = [
    ...(recentOptions.length > 0 ? [{ id: 'recent' as const, label: 'Recentes' }] : []),
    ...PROFILE_EMOJI_CATEGORIES.map(({ id, label }) => ({ id, label }))
  ];
  const selectedPresetColor = PROFILE_COLOR_OPTIONS.some(
    (option) => option.value.toLowerCase() === color.toLowerCase()
  );

  return (
    <section className={`profile-identity-editor${compact ? ' compact' : ''} ${section}-only`} aria-label="Identidade visual">
      {section !== 'color' && <div className="identity-editor-section identity-emoji-section">
        <header className="identity-section-header">
          <div>
            <h3>Emoji</h3>
            <Text size={200}>Escolha como você aparece nas conversas.</Text>
          </div>
        </header>

        <Input
          className="identity-emoji-search"
          contentBefore={<Search20Regular aria-hidden="true" />}
          value={query}
          onChange={(_, data) => setQuery(data.value)}
          placeholder="Buscar por gato, trabalho, festa..."
          aria-label="Buscar emoji"
        />

        {!query.trim() && (
          <div className="identity-category-tabs" role="tablist" aria-label="Categorias de emoji">
            {categories.map((category) => {
              const Icon = CATEGORY_PRESENTATION[category.id].icon;
              return (
                <button
                  key={category.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedCategory === category.id}
                  aria-controls="profile-emoji-options"
                  className={selectedCategory === category.id ? 'active' : ''}
                  onClick={() => setSelectedCategory(category.id)}
                  title={category.label}
                >
                  <Icon aria-hidden="true" />
                  <span>{CATEGORY_PRESENTATION[category.id].shortLabel}</span>
                </button>
              );
            })}
          </div>
        )}

        <div
          id="profile-emoji-options"
          className="identity-emoji-grid"
          role="listbox"
          aria-label={query.trim() ? 'Resultados da busca de emoji' : 'Emojis da categoria selecionada'}
        >
          {visibleOptions.map((option) => {
            const selected = emoji === option.emoji;
            return (
              <button
                key={`${option.emoji}-${option.label}`}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={`Usar ${option.label} ${option.emoji}`}
                title={option.label}
                className={selected ? 'selected' : ''}
                onClick={() => chooseEmoji(option.emoji)}
              >
                <span aria-hidden="true">{option.emoji}</span>
                {selected && <Checkmark20Regular aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        {visibleOptions.length === 0 && (
          <div className="identity-empty" role="status">Nenhum emoji encontrado para “{query.trim()}”.</div>
        )}

        <details className="identity-custom-emoji">
          <summary>Usar outro emoji</summary>
          <div className="identity-custom-row">
            <Input
              value={customEmoji}
              onChange={(_, data) => {
                setCustomEmoji(data.value);
                setCustomEmojiError('');
              }}
              placeholder="Cole um emoji"
              aria-label="Emoji personalizado"
              aria-invalid={Boolean(customEmojiError)}
            />
            <Button appearance="secondary" onClick={applyCustomEmoji}>Usar emoji</Button>
          </div>
          {customEmojiError && <Text className="identity-field-error" role="alert">{customEmojiError}</Text>}
        </details>
      </div>}

      {section !== 'emoji' && <div className="identity-editor-section identity-color-section">
        <header className="identity-section-header">
          <div>
            <h3>Cor de fundo</h3>
            <Text size={200}>A cor é aplicada ao fundo do seu avatar.</Text>
          </div>
        </header>
        <div className="identity-color-grid" role="listbox" aria-label="Cores do perfil">
          {PROFILE_COLOR_OPTIONS.map((option) => {
            const selected = color.toLowerCase() === option.value.toLowerCase();
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={`Usar ${option.label}`}
                title={`${option.label} (${option.value})`}
                className={selected ? 'selected' : ''}
                style={{ backgroundColor: option.value }}
                onClick={() => onColorChange(option.value)}
              >
                {selected && <Checkmark20Regular aria-hidden="true" />}
              </button>
            );
          })}
          {!selectedPresetColor && isProfileColor(color) && (
            <button
              type="button"
              role="option"
              aria-selected="true"
              aria-label={`Cor personalizada ${color}`}
              title={`Cor personalizada (${color})`}
              className="selected"
              style={{ backgroundColor: color }}
              onClick={() => {
                setCustomColor(color);
                setCustomColorOpen(true);
              }}
            >
              <Checkmark20Regular aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className={`identity-custom-color-trigger${customColorOpen ? ' active' : ''}`}
            aria-expanded={customColorOpen}
            aria-controls="identity-custom-color-controls"
            onClick={() => setCustomColorOpen((current) => !current)}
            title="Escolher cor personalizada"
          >
            <span aria-hidden="true">+</span>
            <span className="sr-only">Cor personalizada</span>
          </button>
        </div>
        {customColorOpen && (
          <div id="identity-custom-color-controls" className="identity-custom-color-row">
            <input
              type="color"
              value={isProfileColor(customColor) ? customColor : '#147ad6'}
              onChange={(event) => applyCustomColor(event.target.value)}
              aria-label="Selecionar cor personalizada"
            />
            <Input
              value={customColor}
              onChange={(_, data) => applyCustomColor(data.value)}
              placeholder="#147ad6"
              aria-label="Código hexadecimal da cor"
              aria-invalid={!isProfileColor(customColor)}
            />
          </div>
        )}
      </div>}
    </section>
  );
};
