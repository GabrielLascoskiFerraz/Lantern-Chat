# Lantern

Mensageiro para desktop e navegador com um Relay central responsável por contas, conversas, grupos, anúncios e anexos. O cliente mantém somente um cache reconstruível; a cópia durável dos dados fica no Relay.

## Compilar os executáveis

Todos os comandos devem ser executados na raiz do projeto. Prepare o ambiente uma vez:

```bash
npm ci
```

### Comandos por produto e sistema operacional

Estes são os comandos que realmente geram aplicativos, instaladores ou executáveis distribuíveis:

| Produto | macOS | Windows | Linux |
| --- | --- | --- | --- |
| **Lantern (cliente)** | Universal `.app` + `.dmg`: `npm run build:mac` | Instalador + unpacked: `npm run build:win` | `npm run build:linux` |
| **Lantern Relay UI** | Universal `.app` + `.dmg`: `npm run relay-ui:build:mac` | Instalador + unpacked: `npm run relay-ui:build:win` | `npm run relay-ui:build:linux` |
| **Lantern Relay headless** | Universal: `npm run relay:dist:mac:universal` | `npm run relay:dist:win` | `npm run relay:dist:linux` |
| **Lantern Migration** | Universal `.app` + `.dmg`: `npm run migration-ui:build:mac` | Instalador + unpacked: `npm run migration-ui:build:win` | `npm run migration-ui:build:linux` |

### Arquivos gerados

| Produto | Sistema | Formato | Diretório de saída |
| --- | --- | --- | --- |
| Lantern | macOS universal | `mac-universal/Lantern.app` e `Lantern-<versão>-universal.dmg` | `dist-installers/` |
| Lantern | Windows x64 | `Lantern-Setup-<versão>.exe` e `win-unpacked/` | `dist-installers/` |
| Lantern | Linux | `.AppImage` | `dist-installers/` |
| Lantern Relay UI | macOS universal | `mac-universal/Lantern Relay.app` e `LanternRelay-<versão>-universal.dmg` | `dist-relay-ui-installers/` |
| Lantern Relay UI | Windows x64 | `LanternRelay-Setup-<versão>.exe` e `win-unpacked/` | `dist-relay-ui-installers/` |
| Lantern Relay UI | Linux x64 | `.AppImage` | `dist-relay-ui-installers/` |
| Lantern Relay headless | macOS universal | `LanternRelay-mac-universal` | `dist-relay/` |
| Lantern Relay headless | Windows x64 | `LanternRelay.exe` | `dist-relay/` |
| Lantern Relay headless | Linux x64 | `LanternRelay-linux-x64` | `dist-relay/` |

### macOS: universal, Apple Silicon e Intel

O comando padrão do cliente gera um aplicativo universal, compatível com Apple Silicon e Intel, mantendo o `.app` e criando o DMG:

```bash
npm run build:mac
```

Saídas:

```text
dist-installers/Lantern-<versão>-universal.dmg
dist-installers/mac-universal/Lantern.app
```

Se precisar de uma única arquitetura:

```bash
# Apple Silicon
npm run build:mac:arm64

# Intel
npm run build:mac:x64
```

O Relay com interface também mantém o `.app` universal e gera o DMG:

```bash
npm run relay-ui:build:mac
```

Saídas:

```text
dist-relay-ui-installers/LanternRelay-<versão>-universal.dmg
dist-relay-ui-installers/mac-universal/Lantern Relay.app
```

O Relay headless não é empacotado em DMG, pois é um executável de servidor sem interface. No macOS, `npm run relay:dist:mac` e `npm run relay:dist:mac:universal` geram um único binário compatível com Apple Silicon e Intel. Os comandos `relay:dist:mac:arm64` e `relay:dist:mac:x64` continuam disponíveis para builds específicos.

O Relay headless também pode ser gerado automaticamente para a plataforma e arquitetura da máquina atual:

```bash
npm run relay:dist
```

### Build conjunto a partir do macOS

Para gerar, em um único comando, o Lantern e o Relay UI para macOS universal, Windows x64 e Linux x64:

```bash
npm run build:all:from-mac
```

Opções úteis:

```bash
npm run build:all:from-mac -- --dry-run
npm run build:all:from-mac -- --skip-native-repair
npm run build:all:from-mac -- --win-skip-rcedit
```

Para gerar o cliente Lantern universal para macOS, o cliente Windows e os binários headless do Relay para macOS e Windows:

```bash
npm run build:mac-win:from-mac
```

Saídas principais:

```text
dist-installers/Lantern-<versão>-universal.dmg
dist-installers/mac-universal/Lantern.app
dist-installers/Lantern-Setup-<versão>.exe
dist-relay/LanternRelay-mac-universal
dist-relay/LanternRelay.exe
```

Para compilar e publicar esses artefatos em uma GitHub Release:

```bash
npm run release:mac-win:from-mac
```

> Builds Electron são mais confiáveis quando executados no sistema operacional de destino. O build Windows a partir do macOS pode exigir Wine. O comando conjunto acima já contém o fluxo de cross-build usado pelo projeto.

### Comandos que não geram executáveis

Os comandos abaixo são etapas internas de transpilação. Eles não criam `.dmg`, `.exe`, `.AppImage` nem executável standalone:

| Comando | Resultado |
| --- | --- |
| `npm run build:renderer` | cliente Web em `dist-renderer/` |
| `npm run build:electron` | processo Electron do cliente em `dist-electron/` |
| `npm run build:relay-ui` | JavaScript do Relay UI em `dist-relay-ui/` |
| `npm run build:relay` | JavaScript do Relay headless em `dist-relay/` |
| `npm run build:migration-ui` | JavaScript da ferramenta de migração em `dist-migration-ui/` |

Em especial, `npm run build:relay` não gera o executável do Relay. Para isso, use `npm run relay:dist` ou um dos comandos `relay:dist:*` da tabela principal.

## Executar em desenvolvimento

| Objetivo | Comando |
| --- | --- |
| Cliente, renderer e Relay local | `npm run dev` |
| Duas instâncias isoladas do cliente | `npm run dev:dual` |
| Três instâncias isoladas do cliente | `npm run dev:triple` |
| Relay UI | `npm run relay-ui:dev` |
| Relay headless | `npm run relay:start` |
| Somente o renderer Web | `npm run dev:renderer` |
| Ferramenta Lantern Migration | `npm run migration-ui:dev` |

O cliente Web usa o mesmo renderer do desktop e é servido pelo Relay em `/app/`. O build do Relay e do Relay UI inclui o conteúdo de `dist-renderer/` quando necessário.

## Ferramenta Lantern Migration

Gerar seus instaladores:

| Plataforma | Comando | Saída |
| --- | --- | --- |
| macOS universal | `npm run migration-ui:build:mac` | `.app` em `mac-universal/` e `.dmg` |
| Windows x64 | `npm run migration-ui:build:win` | instalador e `win-unpacked/` |
| Linux x64 | `npm run migration-ui:build:linux` | `.AppImage` |

Executar a conversão por linha de comando:

```bash
npm run migrate:local-backups -- \
  --backups "/pasta/com/LanternBackup-*" \
  --output "/pasta/de/saida" \
  --convert
```

## Testes e manutenção

| Objetivo | Comando |
| --- | --- |
| Lint | `npm run lint` |
| Verificação de tipos | `npm run typecheck` |
| Testes automatizados | `npm test` |
| Verificação completa | `npm run verify` |
| Reconstruir `better-sqlite3` para o Electron | `npm run rebuild:native` |

## Navegação

- [Compilar os executáveis](#compilar-os-executáveis)
- [Executar em desenvolvimento](#executar-em-desenvolvimento)
- [Ferramenta Lantern Migration](#ferramenta-lantern-migration)
- [Testes e manutenção](#testes-e-manutenção)
- [Arquitetura](#arquitetura)
- [Recursos](#recursos)
- [Requisitos e ambiente](#requisitos-e-ambiente)
- [Endereços locais](#endereços-locais)
- [Relay e Relay UI](#relay-e-relay-ui)
- [Administração](#administração)
- [Atualizações dos clientes](#atualizações-dos-clientes)
- [Rede e segurança](#rede-e-segurança)
- [Persistência e backup](#persistência-e-backup)
- [Migração de dados locais](#migração-de-dados-locais)
- [Compatibilidade](#compatibilidade)

## Arquitetura

```text
┌──────────────────────────┐       WS/WSS       ┌──────────────────────────┐
│ Lantern                  │ ◀────────────────▶ │ Lantern Relay            │
│ macOS / Windows / Linux  │                    │ SQLite + anexos cifrados │
│ navegador em /app        │                    │ fonte canônica dos dados │
└──────────────────────────┘                    └─────────────┬────────────┘
                                                             │
                                               ┌─────────────┴────────────┐
                                               │ Relay UI / Dashboard web │
                                               └──────────────────────────┘
```

- O Relay valida e persiste todas as operações duráveis.
- O SQLite do cliente é apenas cache de interface.
- Mensagens de chats e grupos são carregadas em páginas sob demanda.
- No login, o cliente recebe um índice leve das conversas.
- Anexos são baixados quando ficam visíveis e recuperados novamente se a cópia local desaparecer.
- Downloads interrompidos têm retomada e validação de tamanho e SHA-256.
- O navegador e o desktop compartilham o mesmo renderer e as mesmas operações canônicas; funções dependentes do sistema operacional são adaptadas ou ocultadas na Web.

## Recursos

- Contas e sessões centralizadas.
- Vários dispositivos conectados à mesma conta.
- Login automático com token protegido pelo `safeStorage` do Electron.
- Conversas diretas com respostas, encaminhamento, edição, exclusão, reações e favoritos.
- Grupos com membros, administradores, propriedade, mensagens fixadas e anexos.
- Anúncios com expiração, leitura, reações, GIFs, anexos e publicação por calendário ICS.
- Presença e diretório de usuários online e offline.
- Descoberta do Relay por mDNS e UDP, além de endereço manual.
- Galeria de mídias e documentos, prévias e exportação de conversas.
- Figurinhas e GIFs administrados pelo Relay.
- Retenção permanente, por 1 mês, 6 meses ou 1 ano.
- Inicialização opcional do Lantern e do Relay UI com o sistema.
- Interface em português, inglês e espanhol.
- Cliente Web completo em `/app/`.
- Atualizações obrigatórias distribuídas pelo Relay.
- Backup consistente e trilha administrativa cifrada.

## Requisitos e ambiente

- Node.js 22 LTS
- npm 10 ou mais recente
- Git

Módulos nativos como `better-sqlite3` precisam usar o ABI do Electron. Se houver erro de `NODE_MODULE_VERSION`, execute:

```bash
npm run rebuild:native
```

Durante `npm run dev`, o renderer usa `http://localhost:5173` e o Relay usa a porta `43190`.

## Endereços locais

| Serviço | Endereço padrão |
| --- | --- |
| Healthcheck | `http://127.0.0.1:43190/health` |
| Dashboard administrativa | `http://<endereço-do-relay>:43190/` |
| Lantern Web | `http://<endereço-do-relay>:43190/app/` |

Quando TLS estiver configurado, use `https://` e `wss://`.

## Relay e Relay UI

### Relay sem interface

Iniciar na rede local:

```bash
npm run relay:start
```

Usar diretório, host e porta personalizados:

```bash
LANTERN_RELAY_DATA_DIR='/caminho/lantern-relay' \
LANTERN_RELAY_HOST='0.0.0.0' \
LANTERN_RELAY_PORT='43190' \
npm run relay:start
```

Expor externamente com TLS obrigatório:

```bash
LANTERN_RELAY_EXTERNAL=1 \
LANTERN_RELAY_TLS_CERT='/caminho/fullchain.pem' \
LANTERN_RELAY_TLS_KEY='/caminho/privkey.pem' \
npm run relay:start
```

Variáveis disponíveis:

| Variável | Finalidade |
| --- | --- |
| `LANTERN_RELAY_DATA_DIR` | Diretório dos dados do Relay |
| `LANTERN_RELAY_HOST` / `LANTERN_RELAY_PORT` | Interface e porta de escuta |
| `LANTERN_RELAY_TLS_CERT` / `LANTERN_RELAY_TLS_KEY` | Certificado e chave TLS |
| `LANTERN_RELAY_EXTERNAL=1` | Ativa o modo externo e exige TLS |
| `LANTERN_RELAY_MASTER_KEY` | Fornece uma chave mestra externamente |
| `LANTERN_RELAY_LOG_LEVEL` | `debug`, `info`, `warn` ou `error` |
| `LANTERN_RELAY_STICKERS_DIR` | Diretório do catálogo de GIFs |
| `LANTERN_RELAY_ADMIN_USERNAME` | Usuário administrativo inicial do Relay headless |
| `LANTERN_RELAY_ADMIN_PASSWORD` | Senha administrativa inicial do Relay headless |

### Relay UI

```bash
npm run relay-ui:dev
```

A Relay UI permite:

- iniciar, parar e reiniciar o servidor;
- iniciar com o sistema e ligar o Relay automaticamente;
- configurar porta, certificado e chave;
- gerenciar contas, permissões e redefinições de senha;
- administrar anúncios, calendário e GIFs;
- selecionar os instaladores distribuídos aos clientes;
- criar backups e importar backups convertidos;
- abrir a dashboard no navegador.

## Administração

### Primeiro acesso do Relay sem UI

Quando o Relay headless encontra um banco vazio, cria a conta inicial:

```text
usuário: admin
senha: deixe vazia no primeiro acesso
```

Entre pelo cliente Lantern somente com o usuário `admin`. O assistente exigirá a criação de uma senha antes de liberar conversas ou acesso à dashboard. A conta só é criada quando ainda não existe nenhum usuário e nunca substitui contas existentes. O usuário pode ser alterado por `LANTERN_RELAY_ADMIN_USERNAME`; se `LANTERN_RELAY_ADMIN_PASSWORD` for definida explicitamente, essa senha já será usada como definitiva.

O mesmo comportamento vale para qualquer conta criada pelo Relay UI ou pela dashboard: no primeiro acesso, informe o usuário, deixe a senha vazia e crie uma senha pessoal no assistente. O Relay UI não cria uma conta padrão; nele, atribua a qualquer conta a permissão de acesso à dashboard.

### Dashboard Web

A dashboard exige autenticação antes de mostrar métricas ou operações e pode ser acessada por outros computadores. Ela permite:

- criar, editar, desativar e excluir contas;
- conceder acesso administrativo;
- redefinir senhas e revogar sessões;
- acompanhar conexões, transferências e armazenamento;
- administrar retenção e backups;
- enviar ou remover instaladores de atualização.

Fora de uma rede confiável, configure HTTPS para proteger as credenciais em trânsito.

## Atualizações dos clientes

Lantern, Relay e Relay UI usam o número de versão definido em `package.json`.

O Relay UI e a dashboard aceitam:

| Sistema | Instalador |
| --- | --- |
| Windows | `.exe` |
| macOS | `.dmg` universal |
| Linux | `.AppImage` |

Quando a versão do Lantern desktop é diferente da versão do Relay:

1. Se houver instalador compatível, o download autenticado começa automaticamente.
2. A interface fica bloqueada durante a atualização obrigatória.
3. Tamanho e SHA-256 são verificados.
4. O botão **Iniciar instalação** abre o instalador e fecha o Lantern.
5. Uma instrução curta informa o procedimento da plataforma.

Se não houver instalador para o sistema do cliente, a diferença é ignorada e o Lantern continua funcionando. Em **Configurações → Aplicativo**, **Forçar atualização** baixa novamente a versão do Relay mesmo quando os números já são iguais.

O cliente Web não executa instaladores porque já é servido pelo próprio Relay.

## Rede e segurança

### Transporte

- Rede externa: HTTPS/WSS obrigatório.
- Rede local com certificado confiável: WSS.
- Rede local sem certificado confiável: WS permitido somente na LAN.

Certificados públicos não cobrem automaticamente IPs variáveis de todas as redes locais. O cliente respeita o protocolo anunciado pelo Relay e não converte silenciosamente `ws://` em `wss://`.

### Proteções aplicadas

- Senhas derivadas com `scrypt`.
- Tokens de sessão aleatórios armazenados no Relay somente como hash.
- Token local protegido pelo armazenamento seguro do sistema operacional.
- Mensagens e metadados sensíveis cifrados com AES-256-GCM.
- Anexos persistidos em partes cifradas e validados por SHA-256.
- Dashboard protegida por cookie `HttpOnly`, `SameSite=Strict` e token CSRF.
- Limitação de tentativas de autenticação por endereço.
- Modo externo impedido de iniciar sem certificado e chave.

> Guarde uma cópia segura de `<dados-do-relay>/central/master.key`. Sem essa chave, os dados cifrados não podem ser recuperados.

## Persistência e backup

Diretórios principais:

```text
<dados-do-relay>/
├── central/
│   ├── lantern-relay.db
│   ├── master.key
│   ├── attachments/
│   └── backups/
├── group-attachments/
├── stickers/
└── updates/
    ├── manifest.json
    └── instaladores por plataforma
```

Contas, sessões, mensagens, anúncios, grupos, eventos e metadados ficam em tabelas relacionais cifradas. A pesquisa usa índices cegos HMAC. Arquivos legados `groups.json` e `announcements.json` são importados automaticamente uma vez e deixam de ser fontes ativas.

Backups criados pelo Relay UI ou pela dashboard incluem SQLite, chave mestra, anexos, stickers, instaladores e manifesto SHA-256. O cache dos clientes não substitui esse backup.

## Migração de dados locais

O aplicativo **Lantern Migration** consolida backups da antiga edição peer-to-peer, deduplica mensagens, reconstrói as relações entre usuários e verifica anexos por SHA-256.

```bash
npm run migration-ui:dev
```

Na interface, **Gerar backup convertido** cria uma pasta `Lantern-Backup-Convertido-*`, que pode ser importada pelo Relay UI.

Automação por linha de comando:

```bash
npm run migrate:local-backups -- \
  --backups "/pasta/com/LanternBackup-*" \
  --output "/pasta/de/saida" \
  --convert
```

Consulte [docs/local-backup-migration.md](docs/local-backup-migration.md) para o procedimento completo e o mapeamento opcional de contas.

## Compatibilidade

Esta edição usa o Relay como autoridade única e não é compatível diretamente com o antigo funcionamento peer-to-peer. Use a ferramenta de migração para trazer os backups locais.

O identificador técnico continua sendo `com.lantern.central` para preservar instalações existentes, mas o nome exibido do produto é somente **Lantern**.
