import { ReactNode, useCallback, useEffect, useRef, useState, type WheelEvent } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger
} from '@fluentui/react-components';
import {
  ArrowReset20Regular,
  Dismiss20Regular,
  FolderOpen20Regular,
  Save20Regular,
  ZoomIn20Regular,
  ZoomOut20Regular
} from '@fluentui/react-icons';

interface ImagePreviewDialogProps {
  open: boolean;
  src: string | null | undefined;
  fileName: string | null | undefined;
  filePath?: string | null;
  onClose: () => void;
  onOpenFile?: (filePath: string) => Promise<void>;
  onSaveFileAs?: (filePath: string, fileName?: string | null) => Promise<void>;
  extraActions?: ReactNode;
  showFileActions?: boolean;
}

const MIN_ZOOM = 50;
const MAX_ZOOM = 400;
const ZOOM_STEP = 25;

const clampZoom = (value: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

export const ImagePreviewDialog = ({
  open,
  src,
  fileName,
  filePath,
  onClose,
  onOpenFile,
  onSaveFileAs,
  extraActions,
  showFileActions = true
}: ImagePreviewDialogProps) => {
  const [zoom, setZoom] = useState(100);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const changeZoom = useCallback((delta: number) => setZoom((current) => clampZoom(current + delta)), []);

  useEffect(() => {
    if (open) {
      setZoom(100);
      setImageSize({ width: 0, height: 0 });
    }
  }, [open, src]);

  useEffect(() => {
    if (!open || !viewportRef.current) return;
    const viewport = viewportRef.current;
    const updateViewportSize = () => setViewportSize({
      width: viewport.clientWidth,
      height: viewport.clientHeight
    });
    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault(); changeZoom(ZOOM_STEP);
      } else if (event.key === '-') {
        event.preventDefault(); changeZoom(-ZOOM_STEP);
      } else if (event.key === '0') {
        event.preventDefault(); setZoom(100);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [changeZoom, open]);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  };

  const fitScale = imageSize.width > 0 && imageSize.height > 0 && viewportSize.width > 0 && viewportSize.height > 0
    ? Math.min(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
    : 1;
  const renderedWidth = imageSize.width * fitScale * (zoom / 100);
  const renderedHeight = imageSize.height * fitScale * (zoom / 100);
  const stageStyle = imageSize.width > 0
    ? {
        width: `${Math.max(viewportSize.width, renderedWidth)}px`,
        height: `${Math.max(viewportSize.height, renderedHeight)}px`
      }
    : undefined;
  const imageStyle = imageSize.width > 0
    ? { width: `${renderedWidth}px`, height: `${renderedHeight}px` }
    : { width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%' };

  return <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface className="conversation-media-viewer image-preview-viewer">
        <DialogBody>
          <DialogTitle action={<DialogTrigger action="close" disableButtonEnhancement>
            <Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Fechar prévia da imagem" />
          </DialogTrigger>}>
            <span className="image-preview-title" title={fileName || 'Prévia da imagem'}>{fileName || 'Prévia da imagem'}</span>
          </DialogTitle>
          <DialogContent className="image-preview-content">
            <div className="image-preview-toolbar" role="toolbar" aria-label="Controles de zoom">
              <Button appearance="subtle" size="small" icon={<ZoomOut20Regular />} aria-label="Diminuir zoom" title="Diminuir zoom (-)" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(-ZOOM_STEP)} />
              <span className="image-preview-zoom" aria-live="polite">{zoom}%</span>
              <Button appearance="subtle" size="small" icon={<ZoomIn20Regular />} aria-label="Aumentar zoom" title="Aumentar zoom (+)" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(ZOOM_STEP)} />
              <Button appearance="subtle" size="small" icon={<ArrowReset20Regular />} aria-label="Ajustar à janela" title="Ajustar à janela (0)" disabled={zoom === 100} onClick={() => setZoom(100)} />
            </div>
            <div ref={viewportRef} className="image-preview-viewport" onWheel={handleWheel}>
              <div className="image-preview-stage" style={stageStyle}>
                {src && (
                  <img
                    src={src}
                    alt={fileName || 'Imagem ampliada'}
                    draggable={false}
                    style={imageStyle}
                    onLoad={(event) => setImageSize({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight
                    })}
                  />
                )}
              </div>
            </div>
          </DialogContent>
          <DialogActions className="image-preview-actions">
            {extraActions}
            {showFileActions && filePath && onSaveFileAs && (
              <Button appearance="secondary" icon={<Save20Regular />} onClick={() => void onSaveFileAs(filePath, fileName)}>Salvar como</Button>
            )}
            {showFileActions && filePath && onOpenFile && (
              <Button appearance="secondary" icon={<FolderOpen20Regular />} onClick={() => void onOpenFile(filePath)}>Abrir</Button>
            )}
            <Button appearance="primary" onClick={onClose}>Fechar</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>;
};
