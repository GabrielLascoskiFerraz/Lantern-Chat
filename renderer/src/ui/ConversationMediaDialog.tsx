import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Spinner,
  Tab,
  TabList,
  Text
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular,
  Dismiss20Regular,
  Document20Regular,
  Eye20Regular,
  FolderOpen20Regular,
  Image20Regular,
  Location20Regular
} from '@fluentui/react-icons';
import {
  ConversationMediaCursor,
  ConversationMediaItem,
  ConversationMediaKind,
  ipcClient,
  MessageRow
} from '../api/ipcClient';
import {
  canPreviewDocumentName,
  DocumentPreviewDialog,
  documentExtensionLabel,
  DocumentTypeIcon
} from './DocumentPreviewDialog';
import { ImagePreviewDialog } from './ImagePreviewDialog';

interface ConversationMediaDialogProps {
  open: boolean;
  conversationId: string;
  conversationTitle: string;
  senderNamesById: Record<string, string>;
  onClose: () => void;
  onOpenFile: (filePath: string) => Promise<void>;
  onSaveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
  onLocateMessage: (messageId: string) => Promise<void>;
}

const PAGE_SIZE = 36;

const formatBytes = (value: number): string => {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
};

const monthKey = (createdAt: number): string => {
  const date = new Date(createdAt);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (createdAt: number): string => new Intl.DateTimeFormat('pt-BR', {
  month: 'long', year: 'numeric'
}).format(new Date(createdAt));

interface ItemCardProps {
  item: ConversationMediaItem;
  senderName: string;
  onOpenFile: (filePath: string) => Promise<void>;
  onSaveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
  onLocateMessage: (messageId: string) => Promise<void>;
  onPreview: (item: ConversationMediaItem, src: string, filePath: string) => void;
}

const ConversationMediaCard = ({
  item,
  senderName,
  onOpenFile,
  onSaveFileAs,
  onLocateMessage,
  onPreview
}: ItemCardProps) => {
  const rootRef = useRef<HTMLElement | null>(null);
  const operationRef = useRef<Promise<MessageRow | null> | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [documentPreviewPath, setDocumentPreviewPath] = useState<string | null>(null);

  const resolveMessage = useCallback(async (): Promise<MessageRow | null> => {
    if (operationRef.current) return operationRef.current;
    const operation = ipcClient.getMessagesByIds([item.messageId])
      .then((rows) => rows.find((row) => row.messageId === item.messageId) || null)
      .finally(() => { operationRef.current = null; });
    operationRef.current = operation;
    return operation;
  }, [item.messageId]);

  const hydratePreview = useCallback(async (showViewer = false): Promise<void> => {
    if (preview) {
      if (showViewer) {
        const message = previewFilePath ? null : await resolveMessage();
        const filePath = previewFilePath || message?.filePath;
        if (!filePath) throw new Error('O arquivo ainda não está disponível.');
        onPreview(item, preview, filePath);
      }
      return;
    }
    setBusy(true); setError('');
    try {
      const message = await resolveMessage();
      if (!message?.filePath) throw new Error('O arquivo ainda não está disponível.');
      const dataUrl = await ipcClient.getFilePreview(message.filePath);
      if (!dataUrl) throw new Error('Não foi possível gerar a prévia desta imagem.');
      setPreview(dataUrl);
      setPreviewFilePath(message.filePath);
      if (showViewer) onPreview(item, dataUrl, message.filePath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao carregar a mídia.');
    } finally { setBusy(false); }
  }, [item, onPreview, preview, previewFilePath, resolveMessage]);

  useEffect(() => {
    if (item.kind !== 'media') return;
    const node = rootRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      void hydratePreview();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void hydratePreview();
    }, { rootMargin: '180px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hydratePreview, item.kind]);

  const withFile = async (action: (message: MessageRow) => Promise<void>): Promise<void> => {
    setBusy(true); setError('');
    try {
      const message = await resolveMessage();
      if (!message?.filePath) throw new Error('O arquivo ainda não está disponível.');
      await action(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao abrir o arquivo.');
    } finally { setBusy(false); }
  };

  if (item.kind === 'media') {
    return <article ref={rootRef} className="conversation-media-card">
      <button className="conversation-media-thumbnail" type="button" onClick={() => void hydratePreview(true)} aria-label={`Visualizar ${item.fileName}`}>
        {preview ? <img src={preview} alt={item.fileName} /> : <span>{busy ? <Spinner size="tiny" /> : <Image20Regular />}</span>}
      </button>
      <div className="conversation-media-card-copy">
        <Text weight="semibold" truncate>{item.fileName}</Text>
        <Caption1>{senderName} · {new Date(item.createdAt).toLocaleDateString('pt-BR')}</Caption1>
      </div>
      <div className="conversation-media-card-actions">
        <Button appearance="subtle" size="small" icon={<Eye20Regular />} aria-label="Prévia da imagem" title="Visualizar" disabled={busy || !preview} onClick={() => void hydratePreview(true)} />
        <Button appearance="subtle" size="small" icon={<FolderOpen20Regular />} aria-label="Abrir arquivo" title="Abrir" disabled={busy} onClick={() => void withFile((message) => onOpenFile(message.filePath!))} />
        <Button appearance="subtle" size="small" icon={<ArrowDownload20Regular />} aria-label="Salvar arquivo" title="Salvar como" disabled={busy} onClick={() => void withFile((message) => onSaveFileAs(message.filePath!, item.fileName))} />
        <Button appearance="subtle" size="small" icon={<Location20Regular />} aria-label="Ver na conversa" title="Ver na conversa" onClick={() => void onLocateMessage(item.messageId)} />
      </div>
      {error && <Caption1 className="conversation-media-error" role="alert">{error}</Caption1>}
    </article>;
  }

  return <>
    <article ref={rootRef} className="conversation-document-row">
      <div className="conversation-document-icon"><DocumentTypeIcon fileName={item.fileName} /><span>{documentExtensionLabel(item.fileName)}</span></div>
      <div className="conversation-document-copy">
        <Text weight="semibold" truncate>{item.fileName}</Text>
        <Caption1>{formatBytes(item.fileSize)} · {senderName} · {new Date(item.createdAt).toLocaleDateString('pt-BR')}</Caption1>
        {error && <Caption1 className="conversation-media-error" role="alert">{error}</Caption1>}
      </div>
      <div className="conversation-document-actions">
        {canPreviewDocumentName(item.fileName) && <Button appearance="secondary" size="small" icon={<Eye20Regular />} disabled={busy} onClick={() => void withFile(async (message) => setDocumentPreviewPath(message.filePath!))}>Prévia</Button>}
        <Button appearance="secondary" size="small" icon={<FolderOpen20Regular />} disabled={busy} onClick={() => void withFile((message) => onOpenFile(message.filePath!))}>Abrir</Button>
        <Button appearance="subtle" size="small" icon={<ArrowDownload20Regular />} aria-label="Salvar arquivo" disabled={busy} onClick={() => void withFile((message) => onSaveFileAs(message.filePath!, item.fileName))} />
        <Button appearance="subtle" size="small" icon={<Location20Regular />} aria-label="Ver na conversa" onClick={() => void onLocateMessage(item.messageId)} />
      </div>
    </article>
    <DocumentPreviewDialog
      open={Boolean(documentPreviewPath)}
      filePath={documentPreviewPath}
      fileName={item.fileName}
      onClose={() => setDocumentPreviewPath(null)}
      onOpenFile={onOpenFile}
      onSaveFileAs={onSaveFileAs}
    />
  </>;
};

export const ConversationMediaDialog = ({
  open,
  conversationId,
  conversationTitle,
  senderNamesById,
  onClose,
  onOpenFile,
  onSaveFileAs,
  onLocateMessage
}: ConversationMediaDialogProps) => {
  const [kind, setKind] = useState<ConversationMediaKind>('media');
  const [items, setItems] = useState<ConversationMediaItem[]>([]);
  const [cursor, setCursor] = useState<ConversationMediaCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [viewer, setViewer] = useState<{ item: ConversationMediaItem; src: string; filePath: string } | null>(null);

  const load = useCallback(async (append: boolean) => {
    if (!open || loading) return;
    setLoading(true); setError('');
    try {
      const page = await ipcClient.listConversationMedia(
        conversationId,
        kind,
        append ? cursor : null,
        PAGE_SIZE
      );
      setItems((current) => {
        const combined = append ? [...current, ...page.items] : page.items;
        return Array.from(new Map(combined.map((item) => [item.messageId, item])).values());
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível consultar os arquivos.');
      if (!append) setItems([]);
    } finally { setLoading(false); }
  }, [conversationId, cursor, kind, loading, open]);

  useEffect(() => {
    if (!open) return;
    setItems([]); setCursor(null); setHasMore(false); setError(''); setViewer(null);
    setLoading(true);
    void ipcClient.listConversationMedia(conversationId, kind, null, PAGE_SIZE)
      .then((page) => { setItems(page.items); setCursor(page.nextCursor); setHasMore(page.hasMore); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Não foi possível consultar os arquivos.'))
      .finally(() => setLoading(false));
  }, [conversationId, kind, open, refreshRevision]);

  useEffect(() => ipcClient.onEvent((event) => {
    if (!open) return;
    if (event.type === 'message:received' &&
        event.message.conversationId === conversationId && event.message.type === 'file') {
      setRefreshRevision((current) => current + 1);
    }
    if (event.type === 'message:removed' && event.conversationId === conversationId) {
      setItems((current) => current.filter((item) => item.messageId !== event.messageId));
    }
  }), [conversationId, open]);

  const groups = useMemo(() => {
    const grouped = new Map<string, ConversationMediaItem[]>();
    for (const item of items) {
      const key = monthKey(item.createdAt);
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    return Array.from(grouped.entries());
  }, [items]);

  const locate = async (messageId: string): Promise<void> => {
    setViewer(null);
    onClose();
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
    await onLocateMessage(messageId);
  };

  return <>
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface className="conversation-media-dialog">
        <DialogBody>
          <DialogTitle action={<DialogTrigger action="close" disableButtonEnhancement><Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Fechar mídias e arquivos" /></DialogTrigger>}>
            Mídias e arquivos
          </DialogTitle>
          <DialogContent className="conversation-media-content">
            <div className="conversation-media-subtitle"><Caption1>{conversationTitle}</Caption1></div>
            <TabList selectedValue={kind} onTabSelect={(_, data) => setKind(data.value as ConversationMediaKind)} aria-label="Tipos de arquivo">
              <Tab value="media" icon={<Image20Regular />}>Mídia</Tab>
              <Tab value="document" icon={<Document20Regular />}>Documentos</Tab>
            </TabList>
            <div className="conversation-media-scroll">
              {error && <div className="conversation-media-state error" role="alert"><Text weight="semibold">Falha ao carregar</Text><Caption1>{error}</Caption1><Button size="small" onClick={() => setRefreshRevision((current) => current + 1)}>Tentar novamente</Button></div>}
              {!error && loading && items.length === 0 && <div className="conversation-media-state"><Spinner /><Caption1>Consultando o Relay…</Caption1></div>}
              {!error && !loading && items.length === 0 && <div className="conversation-media-state"><span className="conversation-media-empty-icon">{kind === 'media' ? <Image20Regular /> : <Document20Regular />}</span><Text weight="semibold">Nenhum {kind === 'media' ? 'arquivo de mídia' : 'documento'} nesta conversa</Text><Caption1>Os itens enviados aparecerão aqui.</Caption1></div>}
              {groups.map(([key, groupItems]) => <section key={key} className="conversation-media-month">
                <Text weight="semibold" className="conversation-media-month-title">{monthLabel(groupItems[0].createdAt)}</Text>
                <div className={kind === 'media' ? 'conversation-media-grid' : 'conversation-document-list'}>
                  {groupItems.map((item) => <ConversationMediaCard
                    key={item.messageId}
                    item={item}
                    senderName={senderNamesById[item.senderUserId] || 'Participante'}
                    onOpenFile={onOpenFile}
                    onSaveFileAs={onSaveFileAs}
                    onLocateMessage={locate}
                    onPreview={(previewItem, src, filePath) => setViewer({ item: previewItem, src, filePath })}
                  />)}
                </div>
              </section>)}
              {hasMore && <div className="conversation-media-load-more"><Button appearance="secondary" disabled={loading} onClick={() => void load(true)}>{loading ? <><Spinner size="tiny" /> Carregando…</> : 'Carregar mais'}</Button></div>}
            </div>
          </DialogContent>
          <DialogActions><Button appearance="secondary" onClick={onClose}>Fechar</Button></DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>

    <ImagePreviewDialog
      open={Boolean(viewer)}
      src={viewer?.src}
      filePath={viewer?.filePath}
      fileName={viewer?.item.fileName}
      onClose={() => setViewer(null)}
      onOpenFile={onOpenFile}
      onSaveFileAs={onSaveFileAs}
      extraActions={<Button appearance="secondary" icon={<Location20Regular />} onClick={() => viewer && void locate(viewer.item.messageId)}>Ver na conversa</Button>}
    />
  </>;
};
