# Lantern + LanternRelay

![Client no Mac](https://i.imgur.com/l6W3uUU.png)

Lantern é um chat desktop para rede local com arquitetura **cliente + relay**.
No estado atual do projeto, **todo tráfego passa pelo LanternRelay**:

- presença online/offline
- mensagens 1:1
- anúncios
- reações
- sincronização de estado

## Arquitetura atual

- **Cliente:** Electron + React + Fluent UI
- **Relay:** Node.js + WebSocket + mDNS
- **Banco local do cliente:** SQLite (`better-sqlite3`)
- **Sem contas/login:** perfil local por dispositivo
- **Anúncios:** armazenados no relay e expiram automaticamente após 24h

## Requisitos

- Git
- Node.js **22 LTS** (recomendado: `22.14.x`)
- npm 10+

Importante:
- Não use Node 25 neste projeto.
- Para evitar problemas com binários nativos, use Node 22.
- Para o fluxo padrão de build deste projeto, **não é necessário** Visual Studio Build Tools 2022 nem Xcode Command Line Tools.

## Instalação

```bash
npm install
```

Se trocar versão do Node e precisar reconstruir dependências nativas:

```bash
npm run rebuild:native
```

## Execução em desenvolvimento

### 1) Subir app + relay local

```bash
npm run dev
```

Esse comando sobe:
- renderer (Vite)
- watch do Electron
- relay local
- app Electron

### 2) Teste multi-instância local

Duas instâncias:

```bash
npm run dev:dual
```

Três instâncias:

```bash
npm run dev:triple
```

## Execução do Relay

### Via Node (source)

```bash
npm run relay:start
```

Padrão: `ws://0.0.0.0:43190`

Healthcheck HTTP:

```text
http://<IP_DO_RELAY>:43190/health
```

## Build do cliente (instalador)

### Build para SO atual

```bash
npm run build
```

### Build completo no macOS (cliente + relay para macOS e Windows)

Se você estiver no macOS e quiser gerar tudo em um comando (app + relay para as duas plataformas):

```bash
npm run build:mac-win:from-mac
```

Esse script executa:
- build do renderer e Electron
- instalador do cliente macOS
- instalador do cliente Windows x64
- binário do Relay para macOS
- binário do Relay para Windows x64
- `npm run rebuild:native` no final (para manter o ambiente de desenvolvimento no Mac funcionando)

Opções úteis:
- `npm run build:mac-win:from-mac -- --dry-run`
- `npm run build:mac-win:from-mac -- --skip-install`
- `npm run build:mac-win:from-mac -- --skip-native-repair`
- `npm run build:mac-win:from-mac -- --win-skip-rcedit` (use apenas se houver falha de Wine/rcedit no build Windows)

Saídas esperadas:
- `dist-installers/Lantern-<versão>-universal.dmg`
- `dist-installers/Lantern-<versão>-universal.zip`
- `dist-installers/Lantern-Setup-<versão>.exe`
- `dist-relay/LanternRelay-mac-<arch>`
- `dist-relay/LanternRelay.exe`

Observação:
- Durante o build do Relay, mensagens como `No available node version satisfies 'node20'` podem aparecer. O script tenta fallback automático (ex.: `node18`) e segue normalmente se houver target compatível.

### Build + publicação automática no GitHub Release (macOS)

Se quiser compilar e publicar tudo em uma release do GitHub no mesmo fluxo:

```bash
npm run release:mac-win:from-mac -- --tag v1.0.0 --repo GabrielLascoskiFerraz/Lantern-Chat
```

Pré-requisitos:

```bash
brew install gh
gh auth login
```

Esse comando:
- roda o build completo macOS + Windows + Relay
- prepara artefatos nomeados para release:
  - `client-lantern-windows-setup.exe`
  - `server-relay-windows.zip`
  - `client-lantern-mac-universal.dmg`
  - `server-relay-mac.zip`
- cria/atualiza a release no GitHub
- faz upload dos arquivos automaticamente

Opções úteis:
- simular sem executar:  
  `npm run release:mac-win:from-mac -- --tag v1.0.0 --repo GabrielLascoskiFerraz/Lantern-Chat --dry-run`
- publicar com artefatos já gerados:  
  `npm run release:mac-win:from-mac -- --tag v1.0.0 --repo GabrielLascoskiFerraz/Lantern-Chat --skip-build`
- usar notas customizadas:  
  `npm run release:mac-win:from-mac -- --tag v1.0.0 --repo GabrielLascoskiFerraz/Lantern-Chat --notes-file ./RELEASE_NOTES.md`

Se o `gh` não estiver no PATH, force o binário manualmente:

```bash
GH_BIN=/opt/homebrew/bin/gh npm run release:mac-win:from-mac -- --tag v1.0.0 --repo GabrielLascoskiFerraz/Lantern-Chat
```

### Build explícito por plataforma

- Windows: `npm run build:win`
- macOS: `npm run build:mac`
- Linux: `npm run build:linux`

### Comandos granulares

- `npm run build:renderer`
- `npm run build:electron`
- `npm run build:dist`
- `npm run build:dist:win`
- `npm run build:dist:mac`
- `npm run build:dist:linux`

Saída do cliente:
- `dist-installers/`

## Build do Relay

### Compilar TypeScript do relay

```bash
npm run build:relay
```

Saída:
- `dist-relay/main.js`

### Gerar binário do relay

- Windows: `npm run relay:dist:win`
- macOS (auto): `npm run relay:dist:mac`
- macOS x64: `npm run relay:dist:mac:x64`
- macOS arm64: `npm run relay:dist:mac:arm64`
- Linux: `npm run relay:dist:linux`

Saída esperada no Windows:
- `dist-relay/LanternRelay.exe`

## Deploy em rede real (recomendado)

1. Escolha uma máquina para rodar **um único LanternRelay**.
2. Suba o relay (`LanternRelay.exe` ou `npm run relay:start`).
3. Abra o cliente Lantern nas máquinas da rede.
4. O cliente tenta descoberta automática via mDNS.
5. Se necessário, configure relay manualmente em Configurações (host/porta).

## Variáveis de ambiente do Relay

- `LANTERN_RELAY_HOST` (default: `0.0.0.0`)
- `LANTERN_RELAY_PORT` (default: `43190`)
- `LANTERN_RELAY_LOG_LEVEL` (`debug`, `info`, `warn`, `error`)
- `LANTERN_RELAY_PING_INTERVAL_MS`
- `LANTERN_RELAY_PEER_TIMEOUT_MS`
- `LANTERN_RELAY_PRESENCE_BROADCAST_INTERVAL_MS`
- `LANTERN_RELAY_MAX_PAYLOAD_BYTES`
- `LANTERN_RELAY_ANNOUNCEMENTS_FILE`

## Variáveis úteis do cliente

- `LANTERN_RELAY_URL` (força um endpoint específico)
- `LANTERN_RELAY_PORT` (porta fallback)
- `LANTERN_INSTANCE` (`A`, `B`, `C`) para testes multi-instância locais

## Dados locais

No cliente (`app.getPath("userData")`):
- `lantern.db`

Anexos baixados (default):
- `Documentos/Lantern Attachments`

## Comportamento do app

- Fechar no `X` minimiza para tray (não encerra).
- Notificações nativas para mensagens/anúncios fora de foco.
- Presença online/offline é controlada pelo relay.

## Rede e firewall

- Liberar porta do relay (padrão `43190`) na rede local.
- mDNS precisa estar permitido para descoberta automática.
- Se descoberta falhar, use configuração manual do relay no cliente.

## Troubleshooting

### `vite` não reconhecido

```bash
npm install
```

### macOS mostra "app danificado" / "mover para o lixo"

Isso normalmente é bloqueio do Gatekeeper em app não notarizado baixado da internet (ex.: GitHub Release).

Opção rápida (máquina de teste/local):

```bash
xattr -dr com.apple.quarantine "/Applications/Lantern.app"
```

Para distribuição pública sem alerta no macOS, é necessário assinar e notarizar com certificado Apple.

### Erros de dependência nativa (`better-sqlite3`)

- Verifique se está usando Node 22.
- Remova `node_modules` + `package-lock.json` e reinstale:

```bash
npm install
npm run rebuild:native
```

### Windows com múltiplos Nodes no PATH

Se `node -v` não mudar após `nvm use`, ajuste o PATH para priorizar o Node do NVM.

### Relay não encontrado pelo cliente

- Confirme relay ativo em `http://IP:43190/health`
- Teste com relay manual nas configurações do cliente (IP + porta)
