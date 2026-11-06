# 🐧 Linux-monitor

Um painel moderno, leve e em tempo real para monitorar recursos de hardware e serviços do sistema em **qualquer distribuição Linux** (Ubuntu, Debian, Fedora, Arch, CentOS, Alpine, etc.).

---

## 🚀 Funcionalidades

- **📊 Visão Geral do Hardware (Painel 1)**:
  - **Processador (CPU)**: Modelo, arquitetura, contagem de núcleos/threads, frequência atual (GHz), temperatura (°C) e medidor de carga geral + individual por núcleo.
  - **Memória RAM & Swap**: Uso total, livre, disponível, percentual em tempo real e uso de Swap.
  - **Discos & Armazenamento**: Listagem completa de partições montadas (`/`, `/boot`, etc.), sistema de arquivos, espaço total, usado, disponível e barra de porcentagem de uso.
- **⚙️ Serviços & Processos (Painel 2)**:
  - **Serviços do Sistema (Systemd)**: Listagem de todos os serviços systemd com status (Ativo, Parado, Falha), descrição e botões de ação rápida (**Reiniciar**, **Parar**).
  - **Processos em Execução**: Tabela interativa dos processos ordenados por consumo de CPU/Memória, com busca por nome/PID e botão para finalizar processos (`Kill`).
- **⚡ Tempo Real (Live Stream)**:
  - Atualização automática via Server-Sent Events (SSE) sem sobrecarregar o servidor.

---

## 📋 Pré-requisitos

- **Node.js** v18+ instalado
- **PM2** (opcional, recomendado para gerenciar o processo em segundo plano)

---

## 🛠️ Instalação Rápida (Script Automático)

Clone o repositório e execute o script de instalação (configurado por padrão para a porta `3032`):

```bash
git clone https://github.com/brodrigos/Linux-monitor.git
cd Linux-monitor
chmod +x install.sh
./install.sh
```

---

## 🔧 Instalação Manual

1. **Instalar dependências**:
   ```bash
   npm install --production
   ```

2. **Iniciar o servidor**:
   ```bash
   PORT=3032 node server.js
   ```

3. **Gerenciar com PM2**:
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

---

## 🌐 Acesso

Abra no navegador:
`http://<IP-DO-SERVIDOR>:3032` (ex: `http://192.168.1.101:3032`)

---

## 📂 Endpoints da API

- `GET /api/status` — Retorna dados consolidados de CPU, Memória, Discos e Sistema.
- `GET /api/stream` — Stream SSE com atualizações de hardware em tempo real a cada 2 segundos.
- `GET /api/services` — Lista todos os serviços do sistema (`systemd`).
- `POST /api/service/action` — Executa ação (`start`, `stop`, `restart`) em um serviço.
- `GET /api/processes` — Lista os processos em execução ordenados por uso de recursos.
- `POST /api/process/action` — Finaliza um processo (`PID`).

---

## 📄 Licença

Distribuído sob a licença MIT. Desenvolvido por [Brodrigos](https://github.com/brodrigos).

---

## 📋 Changelog & Histórico de Versões

### 🚀 v1.1.0 — Sistema Completo de Backup & Recuperação (NAS)
- **Montagem Automática e Persistente do NAS**: Função `ensureNasMounted` em `server.js` verificando e montando o share CIFS (`//192.168.1.130/backup`) com permissões adequadas (`uid=rodrigo,gid=rodrigo`) para evitar erros de permissão (`EACCES`).
- **Backup Estilo Imagem de Disco**: Compactação e empacotamento com padrão de nomenclatura cross-distro: `[hostname]-[distro]-[versao]-[timestamp].tar.gz`.
- **Trava de Concorrência (Mutex Lock)**: Variável `backupRunning` para impedir execuções simultâneas via `tar` (retorna HTTP 409 Conflict ou pula execuções automáticas se ocupado).
- **Agendamento Automático**: Interface e rotinas configuráveis de backup salvas em `backup-schedule.json`.
- **Nova Aba no Frontend**: Aba dedicada *"Backup & Recuperação (NAS)"* em `public/index.html` e gerenciada por `public/app.js`.

### 🛠️ Versões Anteriores / Melhorias Recentes
- **Gerenciador de Aplicativos Dedicado**: Migração do gerenciador de apps para uma aba própria e sincronização de deployment em `server.js`.
- **Sugestões de Limpeza de Disco**: Adição de limpeza segura para logs do `journal`, pacotes `snap` antigos, cache `apt` e arquivos temporários `/tmp` com confirmação.
- **Limpeza de Cache de RAM (`drop_caches`)**: Mecanismo seguro de liberação de cache de memória sem impactar processos ativos.
- **Scanner de Diretórios de Armazenamento**: Modal interativo de escopo de diretórios com navegação em árvore (*drill-down*) e migalhas de pão (*breadcrumbs*).
- **Ordenação Interativa de Tabelas**: Suporte a ordenação ascendente e descendente nos cabeçalhos das tabelas de serviços e processos.
- **Monitoramento de Memória para Serviços**: Acompanhamento detalhado do consumo de RAM por serviço do sistema.
