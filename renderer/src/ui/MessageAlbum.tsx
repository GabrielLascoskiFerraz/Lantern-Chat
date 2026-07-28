import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { ArrowLeft20Regular, ArrowRight20Regular, Save20Regular } from '@fluentui/react-icons';
import { ipcClient, MessageRow } from '../api/ipcClient';
import { AlbumGalleryDialog } from './AlbumGalleryDialog';
import { ImagePreviewDialog } from './ImagePreviewDialog';

export interface AlbumItem {
  message: MessageRow;
  previewDataUrl?: string | null;
  previewVisible?: boolean;
}

interface MessageAlbumProps {
  items: AlbumItem[];
  onOpenFile: (filePath: string) => Promise<void>;
  onSaveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
}

export const MessageAlbum = ({ items, onOpenFile, onSaveFileAs }: MessageAlbumProps) => {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [galleryPreviewsByMessageId, setGalleryPreviewsByMessageId] = useState<Record<string, string>>({});
  const requestedIdsRef = useRef(new Set<string>());
  const selected = selectedIndex === null ? null : items[selectedIndex] || null;
  const selectedPreview = selected
    ? galleryPreviewsByMessageId[selected.message.messageId] || selected.previewDataUrl
    : null;
  const ready = useMemo(() => items.filter((item) => item.message.filePath), [items]);

  useEffect(() => {
    const missing = items
      .filter((item) => !item.message.filePath && !requestedIdsRef.current.has(item.message.messageId))
      .map((item) => item.message.messageId);
    missing.forEach((id) => requestedIdsRef.current.add(id));
    if (missing.length) void ipcClient.getMessagesByIds(missing).catch(() => undefined);
  }, [items]);

  useEffect(() => {
    if (!galleryOpen) return;
    let cancelled = false;
    const pending = items.filter((item) =>
      Boolean(item.message.filePath) &&
      !item.previewDataUrl &&
      !galleryPreviewsByMessageId[item.message.messageId]
    );
    if (pending.length === 0) return;
    void Promise.allSettled(pending.map(async (item) => {
      const preview = await ipcClient.getFilePreview(item.message.filePath!);
      return { messageId: item.message.messageId, preview };
    })).then((results) => {
      if (cancelled) return;
      setGalleryPreviewsByMessageId((current) => {
        const next = { ...current };
        let changed = false;
        for (const result of results) {
          if (result.status !== 'fulfilled' || !result.value.preview) continue;
          if (!next[result.value.messageId]) {
            next[result.value.messageId] = result.value.preview;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [galleryOpen, galleryPreviewsByMessageId, items]);

  const saveAll = async () => {
    if (saving || !ready.length) return;
    setSaving(true);
    try {
      await ipcClient.saveAlbumToDirectory(ready.map(({ message }) => ({
        filePath: message.filePath!, fileName: message.fileName || 'imagem'
      })));
    } finally {
      setSaving(false);
    }
  };

  const changeSelected = (delta: number) => {
    if (selectedIndex === null || !items.length) return;
    setSelectedIndex((selectedIndex + delta + items.length) % items.length);
  };

  return <>
    <div
      className={`message-album message-album-${Math.min(items.length, 4)}`}
      aria-label={`Álbum com ${items.length} imagens`}
    >
      {items.slice(0, 4).map((item, index) => {
        const remaining = items.length - 4;
        return <button
          key={item.message.messageId}
          type="button"
          className="message-album-tile"
          onClick={() => setGalleryOpen(true)}
          aria-label={`Abrir álbum com ${items.length} imagens`}
        >
          {item.previewDataUrl && item.previewVisible ? <img src={item.previewDataUrl} alt={item.message.fileName || `Imagem ${index + 1}`} /> : <span className="message-album-loading"><Spinner size="tiny" /></span>}
          {index === 3 && remaining > 0 && <span className="message-album-more">+{remaining}</span>}
        </button>;
      })}
    </div>
    <div className="message-album-summary">
      {items.length} imagens{ready.length < items.length ? ` · baixando ${ready.length}/${items.length}` : ''}
      <Button size="small" appearance="secondary" icon={<Save20Regular />} disabled={saving || ready.length !== items.length} onClick={() => void saveAll()}>{saving ? 'Salvando...' : ready.length === items.length ? 'Salvar todas' : 'Preparando álbum...'}</Button>
    </div>
    <AlbumGalleryDialog
      open={galleryOpen}
      items={items.map((item) => ({
        id: item.message.messageId,
        fileName: item.message.fileName,
        previewDataUrl: galleryPreviewsByMessageId[item.message.messageId] || item.previewDataUrl,
        previewVisible: Boolean(
          galleryPreviewsByMessageId[item.message.messageId] ||
          (item.previewDataUrl && item.previewVisible)
        )
      }))}
      readyCount={ready.length}
      saving={saving}
      onClose={() => setGalleryOpen(false)}
      onSelect={(index) => {
        setGalleryOpen(false);
        setSelectedIndex(index);
      }}
      onSaveAll={saveAll}
    />
    <ImagePreviewDialog
      open={Boolean(selectedPreview && selectedIndex !== null)}
      src={selectedPreview}
      filePath={selected?.message.filePath}
      fileName={selected?.message.fileName}
      onClose={() => {
        setSelectedIndex(null);
        setGalleryOpen(true);
      }}
      onOpenFile={onOpenFile}
      onSaveFileAs={onSaveFileAs}
      extraActions={selectedIndex !== null && items.length > 1 ? (
        <div className="album-preview-navigation" role="group" aria-label="Navegação do álbum">
          <Button appearance="secondary" icon={<ArrowLeft20Regular />} onClick={() => changeSelected(-1)} aria-label="Imagem anterior" />
          <span className="image-preview-position" aria-live="polite">{selectedIndex + 1} de {items.length}</span>
          <Button appearance="secondary" icon={<ArrowRight20Regular />} onClick={() => changeSelected(1)} aria-label="Próxima imagem" />
        </div>
      ) : undefined}
    />
  </>;
};
