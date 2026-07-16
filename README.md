# Lantern

Mensageiro desktop para redes locais ou ambientes externos, com um **Relay canônico** responsável por contas, sessões, presença, conversas, grupos, anúncios e anexos. Os clientes Electron mantêm apenas um cache local reconstruível; a fonte durável dos dados é o servidor.

## Arquitetura atual

```text
┌──────────────────┐        WS/WSS         ┌──────────────────────────┐
│ Clientes Lantern │ ◀──────────────────▶  │ Lantern Relay canônico  │
│ macOS/Win/Web    │                       │ SQLite + anexos cifrados │
└──────────────────┘                       └──────────────────────────┘
                                                   ▲
                                                   │ localhost
                                    ┌──────────────┴──────────────┐
                                    │ Dashboard web / Relay UI   │
                                    └─────────────────────────────┘
```

- O Relay valida e persiste todas as operações duráveis.
- O banco SQLite do cliente é cache de interface, não uma fonte concorrente de verdade.
- Envios só são confirmados localmente depois da confirmação do Relay.
- Limpar uma conversa é persistido por usuário no servidor. Contatos só deixam o diretório quando a conta é desativada ou excluída pela administração.
- Mensagens de chats e grupos são carregadas em páginas sob demanda.
- A pesquisa de mensagens consulta o histórico canônico no Relay; o cache local é usado apenas quando o servidor está offline.
- No login, o cliente recebe apenas um índice leve: o último item de cada chat e o estado atual/última mensagem de cada grupo.
- Anexos são baixados somente para as páginas abertas. Se uma cópia local desaparecer, ela é recuperada novamente do Relay quando a mensagem voltar a ficar visível.
- Downloads interrompidos têm retomada e novas tentativas automáticas, com validação de tamanho e SHA-256.

## Funcionalidades

- Contas centralizadas administradas pelo Relay.
- Múltiplos dispositivos podem permanecer conectados à mesma conta; cada sessão recebe as entregas sem duplicar a confirmação lógica do usuário.
- Login automático nas próximas aberturas usando token protegido pelo `safeStorage` do Electron.
- Conversas diretas, respostas, encaminhamento, edição, exclusão, reações e favoritos locais.
- Grupos com membros, administradores, transferência de propriedade, mensagens fixadas e anexos.
- Anúncios com expiração, leitura, reações, GIFs e anexos carregados sob demanda.
- Presença e diretório canônicos, inclusive para usuários offline.
- Descoberta automática do Relay por mDNS e UDP, além de endereço manual.
- Figurinhas distribuídas pelo Relay.
- Inicialização automática opcional do cliente com o sistema.
- Interface em português, inglês e espanhol.
- O mesmo cliente Lantern é servido pelo próprio Relay em `/app`. Desktop e navegador compartilham o renderer, a linguagem visual e as operações canônicas; somente integrações exclusivas do sistema operacional são adaptadas pela ponte web.
- Política de retenção permanente, 1 mês, 6 meses ou 1 ano.
- Backup consistente do SQLite e trilha administrativa cifrada.

## Segurança

- Senhas derivadas com `scrypt`; nenhuma senha é armazenada em texto puro.
- Tokens de sessão aleatórios, armazenados no Relay somente como hash.
- Token do cliente cifrado pelo armazenamento seguro do sistema operacional.
- Mensagens e metadados sensíveis cifrados em repouso com AES-256-GCM.
- Anexos persistidos em partes cifradas e validados por SHA-256.
- Dashboard administrativa limitada à interface loopback.
- Administração protegida por cookie `HttpOnly`, `SameSite=Strict` e token CSRF.
- Limitação de tentativas de autenticação por endereço.
- Modo externo exige HTTPS/WSS e recusa a inicialização sem certificado e chave.

> Preserve uma cópia segura de `<dados-do-relay>/central/master.key`. Sem essa chave, os dados cifrados do Relay não podem ser recuperados.

## Transporte seguro e rede local

Para acesso externo, use um domínio e certificado emitido por uma autoridade confiável. Certificados TLS públicos não podem cobrir automaticamente todos os IPs variáveis de qualquer rede local.

Por isso, o comportamento é:

- **Externo:** HTTPS/WSS obrigatório.
- **Local com certificado confiável:** WSS.
- **Local sem certificado confiável:** WS permitido somente na LAN.

O cliente respeita o protocolo anunciado pelo Relay e não converte silenciosamente um endpoint `ws://` local em `wss://`.

## Requisitos

- Node.js 22 LTS
- npm 10+
- Git

Instalação:

```bash
npm ci
```

Módulos nativos, como `better-sqlite3`, precisam usar o ABI do Electron. Os scripts do projeto já iniciam o Relay com `ELECTRON_RUN_AS_NODE=1`; se necessário, reconstrua-os com:

```bash
npm run rebuild:native
```

## Desenvolvimento

Cliente, renderer e Relay:

```bash
npm run dev
```

Dois ou três clientes isolados para testes locais:

```bash
npm run dev:dual
npm run dev:triple
```

O renderer fica disponível em `http://localhost:5173` e o Relay usa, por padrão, a porta `43190`.

Healthcheck:

```text
http://127.0.0.1:43190/health
```

Dashboard administrativa autenticada:

```text
http://<endereço-do-relay>:43190/
```

Cliente Lantern pelo navegador:

```text
http://<endereço-do-relay>:43190/app/
```

Em modo externo, use obrigatoriamente `https://` e um certificado confiável. O cliente web usa a mesma conta e o mesmo histórico canônico dos aplicativos desktop.

## Acesso administrativo

Quando o Relay é iniciado diretamente, sem a Lantern Relay UI, uma instalação vazia recebe uma conta administrativa temporária para permitir o primeiro acesso à dashboard:

- usuário: `admin`
- senha temporária: `lantern-admin`

Altere essa senha imediatamente pelo Lantern depois do primeiro acesso. A conta só é criada quando o banco ainda não possui nenhum usuário e nunca substitui contas existentes. É possível definir credenciais diferentes antes da primeira inicialização com `LANTERN_RELAY_ADMIN_USERNAME` e `LANTERN_RELAY_ADMIN_PASSWORD`.

Quando o Relay é iniciado pela Lantern Relay UI, nenhuma conta padrão é criada. Crie ou selecione uma conta na Relay UI e habilite **Acesso à dashboard**. Essa permissão não é exibida no cliente, no perfil, na lista de contatos ou nas conversas.

A dashboard pode ser acessada por outros computadores, mas exibe primeiro a autenticação e não entrega métricas nem operações sem uma sessão administrativa válida. Fora de uma rede confiável, configure HTTPS para não transmitir credenciais em texto simples.

## Executando o Relay

### Linha de comando

Rede local, com descoberta automática:

```bash
npm run relay:start
```

Host, porta e diretório de dados personalizados:

```bash
LANTERN_RELAY_DATA_DIR='/caminho/lantern-relay' \
LANTERN_RELAY_HOST='0.0.0.0' \
LANTERN_RELAY_PORT='43190' \
npm run relay:start
```

Modo externo com TLS obrigatório:

```bash
LANTERN_RELAY_EXTERNAL=1 \
LANTERN_RELAY_TLS_CERT='/caminho/fullchain.pem' \
LANTERN_RELAY_TLS_KEY='/caminho/privkey.pem' \
npm run relay:start
```

Variáveis úteis:

| Variável | Finalidade |
| --- | --- |
| `LANTERN_RELAY_DATA_DIR` | Diretório raiz dos dados do Relay |
| `LANTERN_RELAY_HOST` / `LANTERN_RELAY_PORT` | Interface e porta de escuta |
| `LANTERN_RELAY_TLS_CERT` / `LANTERN_RELAY_TLS_KEY` | Certificado e chave TLS |
| `LANTERN_RELAY_EXTERNAL=1` | Exige transporte seguro |
| `LANTERN_RELAY_MASTER_KEY` | Chave mestra fornecida externamente |
| `LANTERN_RELAY_LOG_LEVEL` | `debug`, `info`, `warn` ou `error` |
| `LANTERN_RELAY_STICKERS_DIR` | Catálogo de figurinhas servido pelo Relay |

### Lantern Relay UI

O projeto também inclui um aplicativo desktop dedicado para operar o servidor:

```bash
npm run relay-ui:dev
```

A Relay UI permite:

- iniciar, parar e reiniciar o Relay;
- iniciar a Relay UI com o sistema e ligar o servidor automaticamente ao abrir;
- configurar porta, certificado e chave;
- copiar endereços locais disponíveis;
- acompanhar usuários, sessões, armazenamento, transferências, anúncios, frames e tempo ativo;
- criar e gerenciar contas, conceder acesso administrativo e aprovar solicitações de redefinição de senha;
- criar contas de primeiro acesso sem senha: o usuário entra apenas com o nome de usuário e define uma senha obrigatória no assistente inicial;
- definir a expiração padrão ou individual dos anúncios;
- publicar automaticamente, nos anúncios, os eventos de um calendário ICS no horário escolhido;
- abrir a dashboard autenticada no navegador, inclusive por outro computador da rede;
- criar um backup restaurável sem interromper o Relay;
- importar backups convertidos da edição antiga, com verificação SHA-256 e rollback automático.

Certificado e chave são opcionais juntos no modo local. Para rede externa, use o Relay em modo externo com TLS obrigatório.

## Administração

Na dashboard web local é possível:

- criar, editar, desativar, reativar e excluir contas;
- definir nome, setor, idioma e função;
- redefinir senhas e revogar sessões;
- acompanhar usuários conectados e métricas do Relay;
- administrar anúncios;
- configurar a política de retenção;
- criar backups consistentes e consultar a trilha de auditoria.

## Persistência e backup

Quando executado pelos scripts de desenvolvimento, o diretório padrão é `dist-relay`. Em binários standalone, os dados ficam ao lado do executável. A Relay UI usa a pasta de dados da própria aplicação em `relay-data`.

Estrutura principal:

```text
<dados-do-relay>/
├── central/
│   ├── lantern-relay.db
│   ├── master.key
│   ├── attachments/
│   └── backups/
│       └── lantern-relay-<data>/
│           ├── manifest.json
│           ├── central/
│           ├── group-attachments/
│           └── stickers/
├── group-attachments/
└── stickers/
```

Contas, sessões, mensagens diretas, anúncios, grupos, eventos e metadados de anexos são persistidos em tabelas relacionais cifradas de `central/lantern-relay.db`. A busca usa índices cegos HMAC: o Relay pesquisa sem manter o texto em claro no índice. Os arquivos `groups.json` e `announcements.json` de instalações anteriores são importados automaticamente uma única vez e deixam de ser fontes ativas.

Use a Relay UI ou a dashboard administrativa para criar um pacote em `central/backups`. Cada pacote contém uma cópia consistente do SQLite, a chave mestra, anexos diretos, anexos de grupos, stickers e um manifesto SHA-256. Ele pode ser restaurado copiando seu conteúdo de volta para o diretório de dados com o Relay parado. O cache SQLite dos clientes não substitui esse backup e pode ser reconstruído sob demanda a partir do Relay.

## Migração da edição com dados locais

Backups exportados pela antiga edição peer-to-peer podem ser consolidados em um Relay novo. O aplicativo **Lantern Migration** analisa e deduplica as cópias locais, reconstrói as relações entre usuários, verifica os anexos por SHA-256 e gera uma pasta portátil `Lantern-Backup-Convertido-*`.

```bash
npm run migration-ui:dev
```

Na interface, **Gerar backup convertido** só é liberado depois de uma análise bem-sucedida. O pacote resultante é importado pelo botão **Importar backup convertido** no Relay UI, com validação de integridade, rollback automático e retomada do servidor quando ele já estava em execução. Para automação, o mesmo motor permanece disponível por linha de comando:

```bash
npm run migrate:local-backups -- \
  --backups "/pasta/com/LanternBackup-*" \
  --output "/pasta/de/saida" \
  --convert
```

O procedimento completo, a importação pelo Relay UI e o mapeamento opcional de contas estão em [docs/local-backup-migration.md](docs/local-backup-migration.md).

## Verificação

```bash
npm run verify
```

O comando executa lint, typecheck dos cinco processos, testes de migração, calendário, persistência cifrada, cursor canônico, busca indexada, backup/restauração, transferência imediata de anexos diretos e de grupo e sessões multi-device, além de todos os builds de desenvolvimento. A mesma verificação roda no CI da branch.

## Builds

Cliente Lantern:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

Relay standalone:

```bash
npm run relay:dist:mac
npm run relay:dist:win
npm run relay:dist:linux
```

Lantern Relay UI:

```bash
npm run relay-ui:build:mac
npm run relay-ui:build:win
```

Artefatos são gravados nos diretórios configurados pelos builders, principalmente `dist-installers`, `dist-relay` e `dist-relay-ui-installers`.

## Observações de compatibilidade

Esta edição usa o Relay como autoridade única e não é compatível com o antigo modelo em que cada cliente mantinha sua própria fonte de dados e sincronizava diretamente com outros peers. Módulos de servidor WebSocket local, sincronização peer-to-peer, operações pendentes por contato e backup/restauração do banco do cliente foram removidos intencionalmente.

O identificador técnico do aplicativo permanece `com.lantern.central` para preservar a continuidade de instalações existentes, mas o nome exibido do produto é somente **Lantern**.
