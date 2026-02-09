import { ClipboardEvent, useEffect, useRef, useState } from 'react';
import {
  Button,
  Textarea
} from '@fluentui/react-components';
import { Attach20Regular, Send20Filled, Emoji20Regular } from '@fluentui/react-icons';
import { ipcClient } from '../api/ipcClient';

interface MessageComposerProps {
  disabled?: boolean;
  autoFocusKey?: string;
  onSend: (text: string) => Promise<void>;
  onTypingChange?: (isTyping: boolean) => Promise<void>;
  onSendFile?: (filePath: string) => Promise<void>;
  placeholder: string;
}

interface PendingAttachmentInfo {
  name: string;
  size: number;
  ext: string;
  isImage: boolean;
}

export const MessageComposer = ({
  disabled,
  autoFocusKey,
  onSend,
  onTypingChange,
  onSendFile,
  placeholder
}: MessageComposerProps) => {
  const [text, setText] = useState('');
  const [pendingFilePaths, setPendingFilePaths] = useState<string[]>([]);
  const [pendingAttachmentByPath, setPendingAttachmentByPath] = useState<
    Record<string, PendingAttachmentInfo | null>
  >({});
  const [pendingAttachmentPreviewByPath, setPendingAttachmentPreviewByPath] = useState<
    Record<string, string | null>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState<
    'rostos' | 'gestos' | 'animais' | 'comida' | 'objetos' | 'simbolos'
  >('rostos');
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const composerRootRef = useRef<HTMLDivElement | null>(null);
  const typingStateRef = useRef(false);
  const typingTimeoutRef = useRef<number | null>(null);
  const emojiCategories: Record<
    'rostos' | 'gestos' | 'animais' | 'comida' | 'objetos' | 'simbolos',
    { label: string; emojis: string[] }
  > = {
    rostos: {
      label: 'Rostos',
      emojis: [
        '🙂', '😀', '😄', '😁', '😂', '🤣', '😊', '😉', '😎', '🤓', '🥳', '🤩',
        '😍', '😘', '😌', '😇', '🤔', '🫠', '🫡', '😴', '🥹', '😭', '😤', '😅',
        '😆', '😋', '😏', '😬', '🤭', '🤫', '🫢', '🤗', '🫶', '😵‍💫', '🥶', '🥵',
        '🤠', '🥸', '😶‍🌫️', '🤯', '😮‍💨', '🤤', '😜', '😺', '😸', '😹', '🙃', '🫥'
      ]
    },
    gestos: {
      label: 'Gestos',
      emojis: [
        '👍', '👎', '👏', '🙌', '🤝', '🙏', '👌', '🤌', '✌️', '🤟', '🫶', '👋',
        '✍️', '💪', '🫵', '🤙', '🙋', '🙇', '🤦', '🙆', '🤷', '💯', '✅', '❗',
        '☝️', '👇', '👈', '👉', '🖖', '🫳', '🫴', '🤜', '🤛', '🦾', '🫱🏻‍🫲🏾', '🙌🏻',
        '🙌🏽', '🙌🏿', '🙏🏻', '🙏🏽', '🙏🏿', '👏🏻', '👏🏽', '👏🏿', '✊', '✊🏽', '🤘', '🧠'
      ]
    },
    animais: {
      label: 'Animais',
      emojis: [
        '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐷',
        '🐸', '🐵', '🐔', '🐧', '🐦', '🦄', '🐝', '🦋', '🐢', '🐬', '🦦', '🐙',
        '🐺', '🦝', '🦔', '🦉', '🦜', '🦩', '🦆', '🦢', '🐘', '🦒', '🦏', '🦛',
        '🐮', '🐴', '🐑', '🐐', '🦥', '🦭', '🦈', '🐳', '🐡', '🦀', '🐞', '🪲'
      ]
    },
    comida: {
      label: 'Comida',
      emojis: [
        '🍕', '🍔', '🍟', '🌮', '🌯', '🍣', '🍜', '🍛', '🥐', '🥖', '🍞', '🧀',
        '🍩', '🍪', '🍫', '🍰', '🧁', '🍓', '🍉', '🍍', '🍎', '🥑', '☕', '🧋',
        '🍗', '🍖', '🥩', '🥓', '🍤', '🍳', '🥞', '🧇', '🍝', '🍲', '🥗', '🍿',
        '🍱', '🍙', '🍘', '🍥', '🥟', '🫔', '🍠', '🍌', '🍇', '🍒', '🥭', '🧃'
      ]
    },
    objetos: {
      label: 'Objetos',
      emojis: [
        '💡', '📌', '📎', '📝', '📚', '🎧', '💻', '⌨️', '🖱️', '📱', '🔋', '🧠',
        '🎯', '🧰', '🔧', '🛠️', '🚀', '🎉', '✨', '🔥', '💬', '📢', '🔔', '🧭',
        '🖨️', '📷', '🎥', '📡', '🧲', '🧪', '🧫', '🧬', '⏱️', '⏰', '🗂️', '📦',
        '🧳', '🪄', '🪙', '💳', '🪫', '📶', '🧯', '🛎️', '🗝️', '🔐', '📍', '🪟'
      ]
    },
    simbolos: {
      label: 'Símbolos',
      emojis: [
        '❤️', '💙', '💚', '🧡', '💛', '💜', '🤍', '🖤', '💞', '💥', '⭐', '🌟',
        '⚡', '✔️', '❌', '➕', '➖', '⬆️', '⬇️', '➡️', '⬅️', '🔁', '🕒', '📍',
        '‼️', '⁉️', '❓', '❕', '⭕', '🔴', '🟢', '🟡', '🔵', '🟣', '⚪', '⚫',
        '🔺', '🔻', '🔸', '🔹', '🔶', '🔷', '♻️', '☑️', '🔘', '🌀', '♾️', '🆗'
      ]
    }
  };

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!emojiPickerRef.current) return;
      if (!emojiPickerRef.current.contains(event.target as Node)) {
        setEmojiOpen(false);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, []);

  useEffect(() => {
    if (disabled) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      const isEditingElsewhere =
        Boolean(active) &&
        (active!.tagName === 'INPUT' ||
          active!.tagName === 'TEXTAREA' ||
          active!.isContentEditable) &&
        !composerRootRef.current?.contains(active);

      if (isEditingElsewhere) {
        return;
      }

      const textarea = composerRootRef.current?.querySelector('textarea');
      if (textarea instanceof HTMLTextAreaElement) {
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusKey, disabled]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (typingStateRef.current && onTypingChange) {
        void onTypingChange(false);
      }
    };
  }, [onTypingChange]);

  useEffect(() => {
    let cancelled = false;

    const loadPendingAttachments = async () => {
      if (pendingFilePaths.length === 0) {
        setPendingAttachmentByPath({});
        setPendingAttachmentPreviewByPath({});
        return;
      }

      const results = await Promise.all(
        pendingFilePaths.map(async (filePath) => {
          const [info, preview] = await Promise.all([
            ipcClient.getFileInfo(filePath),
            ipcClient.getFilePreview(filePath)
          ]);
          return { filePath, info, preview };
        })
      );

      if (cancelled) return;
      const nextInfo: Record<string, PendingAttachmentInfo | null> = {};
      const nextPreview: Record<string, string | null> = {};
      for (const result of results) {
        nextInfo[result.filePath] = result.info;
        nextPreview[result.filePath] = result.preview;
      }
      setPendingAttachmentByPath(nextInfo);
      setPendingAttachmentPreviewByPath(nextPreview);
    };

    void loadPendingAttachments();
    return () => {
      cancelled = true;
    };
  }, [pendingFilePaths]);

  const getFileName = (filePath: string): string => {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
  };

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    if ((!trimmed && pendingFilePaths.length === 0) || disabled || isSubmitting) return;
    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (typingStateRef.current && onTypingChange) {
      typingStateRef.current = false;
      void onTypingChange(false);
    }
    setIsSubmitting(true);
    try {
      setText('');
      if (trimmed) {
        await onSend(trimmed);
      }
      if (pendingFilePaths.length > 0 && onSendFile) {
        const filePathsToSend = [...pendingFilePaths];
        setPendingFilePaths([]);
        for (const filePath of filePathsToSend) {
          await onSendFile(filePath);
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const pickAttachment = async (): Promise<void> => {
    if (!onSendFile || disabled || isSubmitting) return;
    const filePaths = await ipcClient.pickFiles();
    if (!filePaths || filePaths.length === 0) return;
    setPendingFilePaths((current) => {
      const existing = new Set(current);
      const merged = [...current];
      for (const filePath of filePaths) {
        if (!existing.has(filePath)) {
          merged.push(filePath);
          existing.add(filePath);
        }
      }
      return merged;
    });
  };

  const formatFileSize = (size: number): string => {
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const handlePasteImage = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!onSendFile || disabled || isSubmitting) return;
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;

    event.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null;
      if (!dataUrl) return;
      const ext = (file.type.split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '') || 'png';
      void ipcClient
        .saveClipboardImage(dataUrl, ext)
        .then((savedPath) => {
          if (savedPath) {
            setPendingFilePaths((current) =>
              current.includes(savedPath) ? current : [...current, savedPath]
            );
          }
        })
        .catch(() => undefined);
    };
    reader.readAsDataURL(file);
  };

  const setTyping = (isTyping: boolean): void => {
    if (!onTypingChange) return;
    if (typingStateRef.current === isTyping) return;
    typingStateRef.current = isTyping;
    void onTypingChange(isTyping);
  };

  return (
    <div className="composer" ref={composerRootRef}>
      {pendingFilePaths.length > 0 && (
        <div className={`composer-attachment-pending ${isSubmitting ? 'sending' : ''}`}>
          <div className="composer-attachments-list">
            {pendingFilePaths.map((pendingFilePath) => {
              const pendingAttachment = pendingAttachmentByPath[pendingFilePath] || null;
              const pendingAttachmentPreview = pendingAttachmentPreviewByPath[pendingFilePath] || null;
              const pendingAttachmentLabel = pendingAttachment?.name || getFileName(pendingFilePath) || 'Anexo';
              return (
                <div key={pendingFilePath} className="composer-attachment-item">
                  <div className="composer-attachment-main">
                    {pendingAttachmentPreview && (
                      <img
                        src={pendingAttachmentPreview}
                        alt={pendingAttachmentLabel}
                        className="composer-attachment-preview"
                      />
                    )}
                    <div className="composer-attachment-meta">
                      <span className="composer-attachment-name">📎 {pendingAttachmentLabel}</span>
                      <span className="composer-attachment-sub">
                        {pendingAttachment ? formatFileSize(pendingAttachment.size) : 'Arquivo selecionado'}
                        {pendingAttachment?.isImage ? ' · imagem' : ''}
                        {isSubmitting ? ' · enviando...' : ''}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    onClick={() =>
                      setPendingFilePaths((current) => current.filter((filePath) => filePath !== pendingFilePath))
                    }
                    disabled={isSubmitting}
                  >
                    remover
                  </button>
                </div>
              );
            })}
            <div className="composer-attachment-sub composer-attachment-total">
              {pendingFilePaths.length} arquivo(s) pronto(s) para envio
            </div>
          </div>
        </div>
      )}
      <div className="composer-row">
        <div className="emoji-picker-wrapper" ref={emojiPickerRef}>
          <Button
            appearance="subtle"
            icon={<Emoji20Regular />}
            disabled={disabled}
            onClick={() => setEmojiOpen((open) => !open)}
          />
          {emojiOpen && (
            <div className="emoji-picker">
              <div className="emoji-picker-categories">
                {(Object.keys(emojiCategories) as Array<keyof typeof emojiCategories>).map((category) => (
                  <button
                    key={category}
                    type="button"
                    className={`emoji-cat-btn ${emojiCategory === category ? 'active' : ''}`}
                    onClick={() => setEmojiCategory(category)}
                  >
                    {emojiCategories[category].label}
                  </button>
                ))}
              </div>
              <div className="emoji-picker-grid">
                {emojiCategories[emojiCategory].emojis.map((emoji) => (
                  <button
                    type="button"
                    key={emoji}
                    className="emoji-btn"
                    onClick={() => {
                      setText((current) => `${current}${emoji}`);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <Textarea
          className="composer-input"
          value={text}
          disabled={disabled}
          onChange={(_, data) => {
            const next = data.value;
            setText(next);
            if (disabled || !onTypingChange) return;

            if (next.trim().length > 0) {
              setTyping(true);
              if (typingTimeoutRef.current) {
                window.clearTimeout(typingTimeoutRef.current);
              }
              typingTimeoutRef.current = window.setTimeout(() => {
                typingTimeoutRef.current = null;
                setTyping(false);
              }, 1200);
            } else {
              if (typingTimeoutRef.current) {
                window.clearTimeout(typingTimeoutRef.current);
                typingTimeoutRef.current = null;
              }
              setTyping(false);
            }
          }}
          placeholder={placeholder}
          resize="none"
          rows={1}
          onBlur={() => {
            if (!onTypingChange) return;
            if (typingTimeoutRef.current) {
              window.clearTimeout(typingTimeoutRef.current);
              typingTimeoutRef.current = null;
            }
            setTyping(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          onPaste={handlePasteImage}
        />
        <div className="composer-actions">
          {onSendFile && (
            <Button
              icon={<Attach20Regular />}
              onClick={() => void pickAttachment()}
              appearance="secondary"
              disabled={disabled || isSubmitting}
            >
              Anexar
            </Button>
          )}
          <Button
            icon={<Send20Filled />}
            onClick={() => void submit()}
            appearance="primary"
            disabled={disabled || isSubmitting || (!text.trim() && pendingFilePaths.length === 0)}
          >
            Enviar
          </Button>
        </div>
      </div>
    </div>
  );
};
