import { ClipboardEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Textarea
} from '@fluentui/react-components';
import {
  Attach20Regular,
  ClipboardPaste20Regular,
  Copy20Regular,
  Cut20Regular,
  Dismiss12Regular,
  Delete16Regular,
  Emoji20Regular,
  Send20Filled
} from '@fluentui/react-icons';
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

type PasteProgressStage = 'reading' | 'saving' | 'done' | 'error';

interface PasteProgressItem {
  id: string;
  name: string;
  progress: number;
  stage: PasteProgressStage;
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
  const [removingFilePaths, setRemovingFilePaths] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPastingFiles, setIsPastingFiles] = useState(false);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);
  const [pasteFeedback, setPasteFeedback] = useState<string | null>(null);
  const [pasteProgressItems, setPasteProgressItems] = useState<PasteProgressItem[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [textContextMenu, setTextContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
  const [emojiCategory, setEmojiCategory] = useState<
    'rostos' | 'gestos' | 'animais' | 'comida' | 'objetos' | 'simbolos'
  >('rostos');
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const composerRootRef = useRef<HTMLDivElement | null>(null);
  const typingStateRef = useRef(false);
  const typingTimeoutRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragDepthRef = useRef(0);
  const dragOverlayVisibleRef = useRef(false);
  const appendPendingFiles = useCallback((filePaths: string[]) => {
    if (filePaths.length === 0) return;
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
  }, []);
  const removePasteProgressItem = useCallback((id: string) => {
    setPasteProgressItems((current) => current.filter((item) => item.id !== id));
  }, []);
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
    if (!textContextMenu) return;
    const close = () => setTextContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [textContextMenu]);

  useEffect(() => {
    if (!pasteFeedback) return;
    const timer = window.setTimeout(() => setPasteFeedback(null), 1800);
    return () => window.clearTimeout(timer);
  }, [pasteFeedback]);

  useEffect(() => {
    if (!onSendFile || disabled || isSubmitting) {
      setIsDragOverFiles(false);
      dragDepthRef.current = 0;
      dragOverlayVisibleRef.current = false;
      return;
    }

    const hasFiles = (event: DragEvent): boolean => {
      const filesLen = event.dataTransfer?.files?.length || 0;
      if (filesLen > 0) return true;
      const types = event.dataTransfer?.types;
      if (!types) return false;
      const normalized = Array.from(types).map((type) => type.toLowerCase());
      return normalized.some((type) => type === 'files' || type.includes('file') || type.includes('uri'));
    };

    const decodeFileUri = (uri: string): string | null => {
      const value = uri.trim();
      if (!value.toLowerCase().startsWith('file://')) {
        return null;
      }
      try {
        const parsed = decodeURI(value.replace(/^file:\/\//i, ''));
        if (!parsed) return null;
        if (/^\/[A-Za-z]:\//.test(parsed)) {
          return parsed.slice(1);
        }
        return parsed;
      } catch {
        return null;
      }
    };

    const collectDroppedFilePaths = (event: DragEvent): string[] => {
      const files = Array.from(event.dataTransfer?.files || []);
      const paths: string[] = [];
      for (const file of files) {
        const filePath = (file as File & { path?: string }).path;
        if (typeof filePath === 'string' && filePath.trim()) {
          paths.push(filePath);
        }
      }
      if (paths.length > 0) {
        return paths;
      }

      const uriListRaw = event.dataTransfer?.getData('text/uri-list') || '';
      if (uriListRaw.trim()) {
        for (const line of uriListRaw.split(/\r?\n/)) {
          const entry = line.trim();
          if (!entry || entry.startsWith('#')) continue;
          const decoded = decodeFileUri(entry);
          if (decoded) {
            paths.push(decoded);
          }
        }
      }

      if (paths.length > 0) {
        return paths;
      }

      const plainText = event.dataTransfer?.getData('text/plain') || '';
      if (plainText.trim()) {
        for (const line of plainText.split(/\r?\n/)) {
          const decoded = decodeFileUri(line);
          if (decoded) {
            paths.push(decoded);
          }
        }
      }
      return paths;
    };

    const addDroppedPaths = (paths: string[]) => {
      if (paths.length === 0) return;
      const uniquePathSet = new Set(paths);
      setPendingFilePaths((current) => {
        const existing = new Set(current);
        const merged = [...current];
        for (const filePath of uniquePathSet) {
          if (!existing.has(filePath)) {
            merged.push(filePath);
            existing.add(filePath);
          }
        }
        return merged;
      });
      setPasteFeedback(
        `${uniquePathSet.size} arquivo${uniquePathSet.size > 1 ? 's' : ''} anexado${uniquePathSet.size > 1 ? 's' : ''}`
      );
    };

    const processDroppedFileBlobs = (files: File[]) => {
      if (files.length === 0) return;
      setIsPastingFiles(true);
      setPasteFeedback(null);
      let pending = files.length;
      let addedCount = 0;

      const updatePasteItem = (id: string, patch: Partial<PasteProgressItem>) => {
        setPasteProgressItems((current) =>
          current.map((item) => (item.id === id ? { ...item, ...patch } : item))
        );
      };

      const finishOne = () => {
        pending -= 1;
        if (pending <= 0) {
          setIsPastingFiles(false);
          if (addedCount > 0) {
            setPasteFeedback(
              `${addedCount} arquivo${addedCount > 1 ? 's' : ''} anexado${addedCount > 1 ? 's' : ''}`
            );
          }
        }
      };

      for (const file of files) {
        const itemName = file.name || 'arquivo';
        const pasteId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${itemName}`;
        setPasteProgressItems((current) => [
          ...current,
          {
            id: pasteId,
            name: itemName,
            progress: 2,
            stage: 'reading'
          }
        ]);

        const reader = new FileReader();
        reader.onprogress = (progressEvent) => {
          const total = progressEvent.total || file.size || 0;
          if (!total) return;
          const fraction = Math.max(0, Math.min(1, progressEvent.loaded / total));
          const progress = Math.max(4, Math.min(86, Math.round(fraction * 86)));
          updatePasteItem(pasteId, { progress, stage: 'reading' });
        };
        reader.onload = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : null;
          if (!dataUrl) {
            updatePasteItem(pasteId, { progress: 100, stage: 'error' });
            finishOne();
            return;
          }
          updatePasteItem(pasteId, { progress: 92, stage: 'saving' });
          void ipcClient
            .saveClipboardFileData(dataUrl, itemName)
            .then((savedPath) => {
              if (savedPath) {
                addedCount += 1;
                removePasteProgressItem(pasteId);
                appendPendingFiles([savedPath]);
              } else {
                updatePasteItem(pasteId, { progress: 100, stage: 'error' });
              }
            })
            .catch(() => {
              updatePasteItem(pasteId, { progress: 100, stage: 'error' });
            })
            .finally(() => finishOne());
        };
        reader.onerror = () => {
          updatePasteItem(pasteId, { progress: 100, stage: 'error' });
          finishOne();
        };
        reader.readAsDataURL(file);
      }
    };

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      if (!dragOverlayVisibleRef.current) {
        dragOverlayVisibleRef.current = true;
        setIsDragOverFiles(true);
      }
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      if (!dragOverlayVisibleRef.current) {
        dragOverlayVisibleRef.current = true;
        setIsDragOverFiles(true);
      }
    };

    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0 && dragOverlayVisibleRef.current) {
        dragOverlayVisibleRef.current = false;
        setIsDragOverFiles(false);
      }
    };

    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      dragOverlayVisibleRef.current = false;
      setIsDragOverFiles(false);
      const droppedFiles = Array.from(event.dataTransfer?.files || []);
      const filePaths = collectDroppedFilePaths(event);
      if (filePaths.length > 0) {
        addDroppedPaths(filePaths);
        return;
      }
      if (droppedFiles.length > 0) {
        processDroppedFileBlobs(droppedFiles);
        return;
      }
      setPasteFeedback('Não foi possível anexar os arquivos soltos.');
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      dragDepthRef.current = 0;
      dragOverlayVisibleRef.current = false;
    };
  }, [appendPendingFiles, disabled, isSubmitting, onSendFile, removePasteProgressItem]);

  useEffect(() => {
    if (pasteProgressItems.length === 0) return;
    const hasDisposableItems = pasteProgressItems.some(
      (item) => item.stage === 'done' || item.stage === 'error'
    );
    if (!hasDisposableItems) return;
    const timer = window.setTimeout(() => {
      setPasteProgressItems((current) =>
        current.filter((item) => item.stage !== 'done' && item.stage !== 'error')
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [pasteProgressItems]);

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
    appendPendingFiles(filePaths);
  };

  const formatFileSize = (size: number): string => {
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const removePendingAttachment = (filePathToRemove: string): void => {
    if (isSubmitting) return;
    setRemovingFilePaths((current) => {
      if (current.includes(filePathToRemove)) return current;
      return [...current, filePathToRemove];
    });

    window.setTimeout(() => {
      setPendingFilePaths((current) => current.filter((filePath) => filePath !== filePathToRemove));
      setRemovingFilePaths((current) => current.filter((filePath) => filePath !== filePathToRemove));
    }, 170);
  };

  const removeAllPendingAttachments = (): void => {
    if (isSubmitting || pendingFilePaths.length <= 1) return;
    setRemovingFilePaths((current) => {
      const merged = new Set(current);
      for (const filePath of pendingFilePaths) {
        merged.add(filePath);
      }
      return Array.from(merged);
    });
    window.setTimeout(() => {
      setPendingFilePaths([]);
      setRemovingFilePaths([]);
    }, 170);
  };

  const handlePasteAttachment = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!onSendFile || disabled || isSubmitting) return;
    const items = Array.from(event.clipboardData?.items || []);
    const fileItems = items.filter((item) => item.kind === 'file');
    if (fileItems.length > 0) {
      event.preventDefault();
      setIsPastingFiles(true);
      setPasteFeedback(null);
      let pending = fileItems.length;
      let addedCount = 0;
      const updatePasteItem = (id: string, patch: Partial<PasteProgressItem>) => {
        setPasteProgressItems((current) =>
          current.map((item) => (item.id === id ? { ...item, ...patch } : item))
        );
      };
      const finishOne = () => {
        pending -= 1;
        if (pending <= 0) {
          setIsPastingFiles(false);
          if (addedCount > 0) {
            setPasteFeedback(
              `${addedCount} arquivo${addedCount > 1 ? 's' : ''} colado${addedCount > 1 ? 's' : ''}`
            );
          }
        }
      };
      for (const item of fileItems) {
        const file = item.getAsFile();
        if (!file) {
          finishOne();
          continue;
        }
        const pasteId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${file.name}`;
        setPasteProgressItems((current) => [
          ...current,
          {
            id: pasteId,
            name: file.name || 'arquivo',
            progress: 2,
            stage: 'reading'
          }
        ]);
        const reader = new FileReader();
        reader.onprogress = (progressEvent) => {
          const total = progressEvent.total || file.size || 0;
          if (!total) return;
          const fraction = Math.max(0, Math.min(1, progressEvent.loaded / total));
          const progress = Math.max(4, Math.min(86, Math.round(fraction * 86)));
          updatePasteItem(pasteId, { progress, stage: 'reading' });
        };
        reader.onload = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : null;
          if (!dataUrl) {
            updatePasteItem(pasteId, { progress: 100, stage: 'error' });
            finishOne();
            return;
          }
          updatePasteItem(pasteId, { progress: 92, stage: 'saving' });
          const isImage = file.type.startsWith('image/');
          const extension =
            (file.type.split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '') || 'png';
          const fileName = file.name && file.name.trim() ? file.name.trim() : undefined;
          const savePromise = isImage
            ? ipcClient.saveClipboardImage(dataUrl, extension)
            : ipcClient.saveClipboardFileData(dataUrl, fileName);
          void savePromise
            .then((savedPath) => {
              if (savedPath) {
                addedCount += 1;
                removePasteProgressItem(pasteId);
                appendPendingFiles([savedPath]);
              } else {
                updatePasteItem(pasteId, { progress: 100, stage: 'error' });
              }
              finishOne();
            })
            .catch(() => {
              updatePasteItem(pasteId, { progress: 100, stage: 'error' });
              finishOne();
            });
        };
        reader.onerror = () => {
          updatePasteItem(pasteId, { progress: 100, stage: 'error' });
          finishOne();
        };
        reader.readAsDataURL(file);
      }
      return;
    }

    // Fallback para macOS/Windows quando Finder/Explorer copia como file-url.
    const plainText = event.clipboardData?.getData('text/plain') || '';
    if (!/(^|\n)\s*file:\/\//i.test(plainText)) {
      return;
    }
    event.preventDefault();
    setIsPastingFiles(true);
    setPasteFeedback(null);
    void ipcClient
      .getClipboardFilePaths()
      .then((paths) => {
        if (!paths || paths.length === 0) return;
        setPasteFeedback(
          `${paths.length} arquivo${paths.length > 1 ? 's' : ''} colado${paths.length > 1 ? 's' : ''}`
        );
        appendPendingFiles(paths);
      })
      .catch(() => undefined)
      .finally(() => setIsPastingFiles(false));
  };

  const setTyping = (isTyping: boolean): void => {
    if (!onTypingChange) return;
    if (typingStateRef.current === isTyping) return;
    typingStateRef.current = isTyping;
    void onTypingChange(isTyping);
  };

  const getComposerTextarea = (): HTMLTextAreaElement | null => {
    const found = composerRootRef.current?.querySelector('textarea');
    if (found instanceof HTMLTextAreaElement) {
      textareaRef.current = found;
      return found;
    }
    return textareaRef.current;
  };

  const copyToClipboard = async (value: string): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // fallback legado
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  };

  const handleComposerContextMenu = (event: ReactMouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const editable = target?.closest('textarea');
    if (!editable) {
      setTextContextMenu(null);
      return;
    }

    const textarea = getComposerTextarea();
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const hasSelection = end > start;

    event.preventDefault();
    const menuWidth = 188;
    const menuHeight = hasSelection ? 96 : 52;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 12);
    setTextContextMenu({ x, y, hasSelection });
  };

  const handleCopySelection = async (): Promise<void> => {
    const textarea = getComposerTextarea();
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (end <= start) return;
    const selected = textarea.value.slice(start, end);
    await copyToClipboard(selected);
  };

  const handleCutSelection = async (): Promise<void> => {
    const textarea = getComposerTextarea();
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (end <= start) return;
    const selected = textarea.value.slice(start, end);
    await copyToClipboard(selected);
    const nextValue = `${textarea.value.slice(0, start)}${textarea.value.slice(end)}`;
    setText(nextValue);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start, start);
    });
  };

  const handlePasteAtCursor = async (): Promise<void> => {
    const textarea = getComposerTextarea();
    if (!textarea) return;

    // Prioriza arquivo copiado no Finder/Explorer (menu de contexto "Colar").
    if (onSendFile && !disabled && !isSubmitting) {
      try {
        const hasFileLikeData = await ipcClient.clipboardHasFileLikeData();
        const paths = await ipcClient.getClipboardFilePaths();
        if (paths && paths.length > 0) {
          appendPendingFiles(paths);
          setPasteFeedback(
            `${paths.length} arquivo${paths.length > 1 ? 's' : ''} colado${paths.length > 1 ? 's' : ''}`
          );
          return;
        }
        if (hasFileLikeData) {
          setPasteFeedback('Arquivo detectado no clipboard, mas não foi possível anexar.');
          return;
        }
      } catch {
        // fallback para texto
      }
    }

    let clipboardText = '';
    try {
      clipboardText = await navigator.clipboard.readText();
    } catch {
      clipboardText = '';
    }
    if (!clipboardText) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const nextValue = `${textarea.value.slice(0, start)}${clipboardText}${textarea.value.slice(end)}`;
    const nextCursor = start + clipboardText.length;
    setText(nextValue);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const showAttachmentPanel =
    pendingFilePaths.length > 0 ||
    pasteProgressItems.length > 0 ||
    isPastingFiles ||
    Boolean(pasteFeedback);

  return (
    <div className={`composer ${isDragOverFiles ? 'drag-over' : ''}`} ref={composerRootRef}>
      {showAttachmentPanel && (
        <div
          className={`composer-attachment-pending ${isSubmitting ? 'sending' : ''} ${
            isPastingFiles || pasteProgressItems.length > 0 ? 'attaching' : ''
          }`}
        >
          <div className="composer-attachments-list">
            {(isPastingFiles || pasteProgressItems.length > 0 || pasteFeedback) && (
              <div className="composer-paste-progress-list" aria-live="polite">
                {isPastingFiles && pasteProgressItems.length === 0 && (
                  <div className="composer-paste-progress-item reading">
                    <div className="composer-paste-progress-top">
                      <span className="composer-paste-progress-name">Lendo clipboard…</span>
                      <span className="composer-paste-progress-state">lendo</span>
                    </div>
                    <div className="composer-paste-progress-bar">
                      <span style={{ width: '24%' }} />
                    </div>
                  </div>
                )}
                {pasteProgressItems.map((item) => (
                  <div key={item.id} className={`composer-paste-progress-item ${item.stage}`}>
                    <div className="composer-paste-progress-top">
                      <span className="composer-paste-progress-name">{item.name}</span>
                      <span className="composer-paste-progress-state">
                        {item.stage === 'reading' ? 'lendo' : ''}
                        {item.stage === 'saving' ? 'salvando' : ''}
                        {item.stage === 'done' ? 'pronto' : ''}
                        {item.stage === 'error' ? 'falha' : ''}
                      </span>
                    </div>
                    <div className="composer-paste-progress-bar">
                      <span style={{ width: `${item.progress}%` }} />
                    </div>
                  </div>
                ))}
                {pasteFeedback && !isPastingFiles && (
                  <div className="composer-attachment-sub composer-attachment-total">
                    {pasteFeedback}
                  </div>
                )}
              </div>
            )}
            {pendingFilePaths.map((pendingFilePath) => {
              const pendingAttachment = pendingAttachmentByPath[pendingFilePath] || null;
              const pendingAttachmentPreview = pendingAttachmentPreviewByPath[pendingFilePath] || null;
              const pendingAttachmentLabel = pendingAttachment?.name || getFileName(pendingFilePath) || 'Anexo';
              const isRemoving = removingFilePaths.includes(pendingFilePath);
              return (
                <div
                  key={pendingFilePath}
                  className={`composer-attachment-item ${isRemoving ? 'removing' : ''}`}
                >
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
                    onClick={() => removePendingAttachment(pendingFilePath)}
                    disabled={isSubmitting || isRemoving}
                  >
                    <span className="composer-attachment-remove-icon">
                      <Dismiss12Regular />
                    </span>
                    <span>Remover</span>
                  </button>
                </div>
              );
            })}
            {pendingFilePaths.length > 0 && (
              <div className="composer-attachment-sub composer-attachment-total">
                {pendingFilePaths.length} arquivo(s) pronto(s) para envio
              </div>
            )}
            {pendingFilePaths.length > 1 && (
              <div className="composer-attachment-bulk-actions">
                <button
                  type="button"
                  className="composer-attachment-remove-all"
                  onClick={removeAllPendingAttachments}
                  disabled={isSubmitting}
                >
                  <span className="composer-attachment-remove-icon">
                    <Delete16Regular />
                  </span>
                  <span>Remover todos</span>
                </button>
              </div>
            )}
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
          onPaste={handlePasteAttachment}
          onContextMenu={handleComposerContextMenu}
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
      {isDragOverFiles && (
        <div className="composer-drop-overlay" aria-hidden>
          <div className="composer-drop-overlay-card">
            <span className="composer-drop-overlay-icon">📎</span>
            <span>Solte os arquivos para anexar</span>
          </div>
        </div>
      )}

      {textContextMenu && (
        <div
          className="chat-context-menu"
          style={{ left: textContextMenu.x, top: textContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {textContextMenu.hasSelection ? (
            <>
              <button
                type="button"
                className="chat-context-item"
                onClick={() => {
                  void handleCopySelection();
                  setTextContextMenu(null);
                }}
              >
                <span className="menu-item-icon">
                  <Copy20Regular />
                </span>
                <span>Copiar</span>
              </button>
              <button
                type="button"
                className="chat-context-item"
                onClick={() => {
                  void handleCutSelection();
                  setTextContextMenu(null);
                }}
              >
                <span className="menu-item-icon">
                  <Cut20Regular />
                </span>
                <span>Recortar</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                void handlePasteAtCursor();
                setTextContextMenu(null);
              }}
            >
              <span className="menu-item-icon">
                <ClipboardPaste20Regular />
              </span>
              <span>Colar</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
