# Lantern Central

Variante do Lantern orientada a servidor. O **LanternRelay é a fonte canônica** de contas, presença, mensagens, anúncios, grupos e anexos. O aplicativo Electron mantém somente cache local descartável para melhorar desempenho e uso offline da interface.

## Principais diferenças

- Login obrigatório com conta criada pelo administrador.
- Relay local com descoberta automática ou endereço manual.
- Relay externo exclusivamente por conexão segura `WSS/HTTPS`.
- Dashboard administrativa acessível somente por `localhost` do servidor.
- Contas com usuário, nome, setor, idioma, perfil e senha.
- Setor exibido junto ao contato na sidebar.
- Sessões revogáveis e logout com limpeza do cache local.
- Mensagens e anexos armazenados no Relay com criptografia em repouso.
- Política de retenção: permanente, 1 mês, 6 meses ou 1 ano.
- Interface de entrada em português, inglês e espanhol.
- Backup/restauração local removidos: o Relay é responsável pelos dados duráveis.

## Segurança

- Senhas são derivadas com `scrypt` e nunca armazenadas em texto puro.
- Tokens de sessão são aleatórios e persistidos no servidor apenas como hash.
- No cliente, o token é protegido pelo `safeStorage` do Electron.
- Mensagens e metadados sensíveis usam AES-256-GCM no armazenamento do Relay.
- Anexos são criptografados por partes com AES-256-GCM.
- Alterações administrativas exigem sessão por cookie `HttpOnly`, `SameSite=Strict` e token CSRF.
- Tentativas de login recebem limitação por endereço.
- O painel administrativo rejeita conexões que não venham da interface loopback.
- O modo externo recusa inicialização sem certificado e chave TLS.

> Guarde uma cópia segura de `<dados-do-relay>/central/master.key`. Sem essa chave, os dados criptografados não podem ser recuperados.

## Requisitos

- Node.js 22 LTS
- npm 10+
- Git

```bash
npm ci
```

## Desenvolvimento

```bash
npm run dev
```

O primeiro início do Relay cria a conta `admin`. Defina a senha inicial antes de iniciar:

```bash
LANTERN_RELAY_ADMIN_PASSWORD='uma-senha-forte' npm run relay:start
```

Sem essa variável, o Relay gera uma senha temporária e a imprime uma única vez no console.

Dashboard local:

```text
http://127.0.0.1:43190/
```

Healthcheck:

```text
http://127.0.0.1:43190/health
```

## Relay na rede local

```bash
LANTERN_RELAY_ADMIN_PASSWORD='uma-senha-forte' npm run relay:start
```

Os clientes podem usar **Local automático** ou informar IP e porta em **Local manual**.

## Relay externo

Use um domínio com certificado TLS válido. A terminação TLS pode ser feita diretamente pelo Relay:

```bash
LANTERN_RELAY_EXTERNAL=1 \
LANTERN_RELAY_TLS_CERT=/caminho/fullchain.pem \
LANTERN_RELAY_TLS_KEY=/caminho/privkey.pem \
LANTERN_RELAY_ADMIN_PASSWORD='uma-senha-forte' \
npm run relay:start
```

No cliente, selecione **Externo** e informe domínio e porta. Esse modo sempre usa `WSS/HTTPS`; conexões externas sem TLS são recusadas.

Recomendações de produção:

- Execute o Relay com usuário de sistema sem privilégios.
- Restrinja firewall à porta pública necessária.
- Não exponha a dashboard: ela só deve ser aberta localmente no servidor.
- Faça backup do diretório de dados do Relay, especialmente `central/master.key` e `central/lantern-relay.db`.
- Use certificado de uma autoridade confiável e rotação periódica de credenciais.

## Administração

Na dashboard local é possível:

- criar e excluir contas;
- definir nome, setor, idioma e função;
- ativar/desativar usuários;
- redefinir senhas e revogar sessões;
- consultar usuários conectados, anúncios e tempo de atividade;
- escolher retenção permanente, 1 mês, 6 meses ou 1 ano.

## Dados

O Relay armazena seus dados em um diretório `central` dentro da pasta de dados resolvida para o executável:

- `central/lantern-relay.db`: banco canônico;
- `central/master.key`: chave de criptografia;
- `central/attachments/`: partes criptografadas dos anexos.

O banco SQLite do Electron é cache. Ele pode ser reconstruído a partir do snapshot do Relay e é apagado ao sair da conta.

## Verificação e build

```bash
npm run build:renderer
npm run build:electron
npm run build:relay
```

Cliente:

```bash
npm run build:mac
npm run build:win
```

Relay:

```bash
npm run relay:dist:mac
npm run relay:dist:win
```

## Estado da arquitetura

Esta branch é uma bifurcação incompatível com os perfis locais da edição LAN original. Não há migração automática de bancos, identidades ou sessões antigas. Essa separação é intencional para manter o modelo centralizado simples, auditável e seguro.
