# Lantern

Mensageiro desktop para redes locais ou ambientes externos, com um **Relay canônico** responsável por contas, sessões, presença, conversas, grupos, anúncios e anexos. Os clientes Electron mantêm apenas um cache local reconstruível; a fonte durável dos dados é o servidor.

## Arquitetura atual

```text
┌──────────────────┐        WS/WSS         ┌──────────────────────────┐
│ Clientes Lantern │ ◀──────────────────▶  │ Lantern Relay canônico  │
│ macOS / Windows  │                       │ SQLite + anexos cifrados │
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
- Limpar ou esquecer uma conversa é persistido por usuário no servidor.
- Mensagens de chats e grupos são carregadas em páginas sob demanda.
- No login, o cliente recebe apenas um índice leve: o último item de cada chat e o estado atual/última mensagem de cada grupo.
- Anexos são baixados somente para as páginas abertas. Se uma cópia local desaparecer, ela é recuperada novamente do Relay quando a mensagem voltar a ficar visível.
- Downloads interrompidos têm retomada e novas tentativas automáticas, com validação de tamanho e SHA-256.

## Funcionalidades

- Contas centralizadas administradas pelo Relay.
- Login automático nas próximas aberturas usando token protegido pelo `safeStorage` do Electron.
- Conversas diretas, respostas, encaminhamento, edição, exclusão, reações e favoritos locais.
- Grupos com membros, administradores, transferência de propriedade, mensagens fixadas e anexos.
- Anúncios com expiração, leitura e reações.
- Presença e diretório canônicos, inclusive para usuários offline.
- Descoberta automática do Relay por mDNS e UDP, além de endereço manual.
- Figurinhas distribuídas pelo Relay.
- Inicialização automática opcional do cliente com o sistema.
- Interface em português, inglês e espanhol.
- Política de retenção permanente, 1 mês, 6 meses ou 1 ano.

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

Dashboard administrativa local:

```text
http://127.0.0.1:43190/
```

## Conta administrativa inicial

No primeiro início, o Relay cria a conta administrativa `admin`. Para desenvolvimento, a credencial padrão é:

```text
usuário: admin
senha: root
```

Defina uma senha inicial diferente antes da primeira execução:

```bash
LANTERN_RELAY_ADMIN_PASSWORD='uma-senha-forte' npm run relay:start
```

Troque a credencial padrão imediatamente fora de um ambiente de desenvolvimento.

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
LANTERN_RELAY_ADMIN_PASSWORD='uma-senha-forte' \
npm run relay:start
```

Variáveis úteis:

| Variável | Finalidade |
| --- | --- |
| `LANTERN_RELAY_DATA_DIR` | Diretório raiz dos dados do Relay |
| `LANTERN_RELAY_HOST` / `LANTERN_RELAY_PORT` | Interface e porta de escuta |
| `LANTERN_RELAY_TLS_CERT` / `LANTERN_RELAY_TLS_KEY` | Certificado e chave TLS |
| `LANTERN_RELAY_EXTERNAL=1` | Exige transporte seguro |
| `LANTERN_RELAY_ADMIN_PASSWORD` | Senha do administrador no primeiro início |
| `LANTERN_RELAY_MASTER_KEY` | Chave mestra fornecida externamente |
| `LANTERN_RELAY_DASHBOARD_TOKEN` | Proteção adicional opcional da dashboard |
| `LANTERN_RELAY_LOG_LEVEL` | `debug`, `info`, `warn` ou `error` |
| `LANTERN_RELAY_STICKERS_DIR` | Catálogo de figurinhas servido pelo Relay |

### Lantern Relay UI

O projeto também inclui um aplicativo desktop dedicado para operar o servidor:

```bash
npm run relay-ui:dev
```

A Relay UI permite:

- iniciar, parar e reiniciar o Relay;
- configurar porta, certificado e chave;
- copiar endereços locais disponíveis;
- acompanhar usuários conectados, anúncios, frames e tempo ativo.

Certificado e chave são opcionais juntos no modo local. Para rede externa, use o Relay em modo externo com TLS obrigatório.

## Administração

Na dashboard web local é possível:

- criar, editar, ativar e excluir contas;
- definir nome, setor, idioma e função;
- redefinir senhas e revogar sessões;
- acompanhar usuários conectados e métricas do Relay;
- administrar anúncios;
- configurar a política de retenção.

## Persistência e backup

Quando executado pelos scripts de desenvolvimento, o diretório padrão é `dist-relay`. Em binários standalone, os dados ficam ao lado do executável. A Relay UI usa a pasta de dados da própria aplicação em `relay-data`.

Estrutura principal:

```text
<dados-do-relay>/
├── central/
│   ├── lantern-relay.db
│   ├── master.key
│   └── attachments/
├── groups.json
├── group-attachments/
├── announcements.json
└── stickers/
```

Faça backup consistente do diretório inteiro, principalmente de `central/master.key`, `central/lantern-relay.db`, `groups.json` e dos diretórios de anexos. O cache SQLite dos clientes não substitui esse backup e pode ser reconstruído a partir do Relay.

## Verificação

```bash
npm run lint
npm run build:renderer
npm run build:electron
npm run build:relay
npm run build:relay-ui
```

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
