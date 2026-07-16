import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, DialogBody, DialogContent, DialogSurface, DialogTitle, ProgressBar, Spinner, Text } from '@fluentui/react-components';
import { ArrowDownload24Regular } from '@fluentui/react-icons';
import { AppUpdateState, ipcClient } from '../api/ipcClient';

const instructions: Record<string, string> = {
  win32: 'No instalador, confirme a abertura e siga Avançar até concluir.',
  darwin: 'Na janela que abrir, arraste o Lantern para a pasta Aplicativos e substitua a versão anterior.',
  linux: 'Confirme a execução do arquivo. Se o sistema perguntar, permita que ele seja executado.'
};

const formatBytes = (value: number): string => {
  if (value < 1024 ** 2) return `${Math.max(0, value / 1024).toFixed(1)} KB`;
  return `${Math.max(0, value / 1024 ** 2).toFixed(1)} MB`;
};

export const UpdateGate = () => {
  const [state, setState] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    void ipcClient.getUpdateState().then(setState);
    return ipcClient.onEvent((event) => {
      if (event.type === 'update:state') setState(event.state);
    });
  }, []);

  const visible = Boolean(state?.supported && ['downloading', 'ready', 'installing', 'error'].includes(state.status));
  const progress = state?.total ? Math.min(1, state.downloaded / state.total) : 0;
  const platformInstruction = useMemo(
    () => state?.installer ? instructions[state.installer.platform] : '',
    [state?.installer]
  );
  if (!state) return null;

  return (
    <Dialog open={visible}>
      <DialogSurface className="update-gate" aria-describedby="update-gate-description">
        <DialogBody>
          <DialogTitle>
            <span className="update-gate-title"><ArrowDownload24Regular /> Atualização obrigatória</span>
          </DialogTitle>
          <DialogContent>
            <div className="update-gate-version">
              <span>Lantern {state.currentVersion}</span><strong>→</strong><span>Lantern {state.relayVersion || 'mais recente'}</span>
            </div>
            {state.status === 'downloading' && (
              <div className="update-gate-progress" id="update-gate-description">
                <Text>Uma nova versão está disponível e já está sendo baixada.</Text>
                <ProgressBar value={progress} thickness="large" />
                <Text size={200}>{formatBytes(state.downloaded)} de {formatBytes(state.total)} · {Math.round(progress * 100)}%</Text>
              </div>
            )}
            {state.status === 'ready' && (
              <div className="update-gate-ready" id="update-gate-description">
                <Text weight="semibold">Download concluído. O Lantern precisa ser atualizado para continuar.</Text>
                <Text>{platformInstruction}</Text>
                <Button appearance="primary" size="large" onClick={() => void ipcClient.installUpdate()}>
                  Iniciar instalação
                </Button>
              </div>
            )}
            {state.status === 'installing' && (
              <div className="update-gate-ready" id="update-gate-description"><Spinner /><Text>Abrindo o instalador e fechando o Lantern…</Text></div>
            )}
            {state.status === 'error' && (
              <div className="update-gate-ready" id="update-gate-description">
                <Text weight="semibold">Não foi possível concluir o download obrigatório.</Text>
                <Text>{state.error || 'Verifique a conexão com o Relay e tente novamente.'}</Text>
                <Button appearance="primary" onClick={() => void ipcClient.forceUpdate()}>Tentar novamente</Button>
              </div>
            )}
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
