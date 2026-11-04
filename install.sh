#!/usr/bin/env bash
# ==============================================================================
# Script de Instalação do Linux-monitor
# Compatível com qualquer distribuição Linux (Ubuntu, Debian, Fedora, Arch, etc.)
# Porta padrão: 3032
# ==============================================================================

set -e

INSTALL_DIR="/home/rodrigo/Linux-monitor"
PORT=3032

echo "=============================================================================="
echo "🐧 Instalando Linux-monitor..."
echo "=============================================================================="

# 1. Verificar se Node.js e npm estão instalados
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo "⚠️ Node.js não encontrado. Instalando Node.js LTS..."
    if command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v dnf &> /dev/null; then
        sudo dnf install -y nodejs npm
    elif command -v pacman &> /dev/null; then
        sudo pacman -S --noconfirm nodejs npm
    else
        echo "❌ Gerenciador de pacotes não suportado automaticamente para Node.js. Instale o Node.js v18+ manualmente."
        exit 1
    fi
fi

echo "✅ Node.js versão: $(node -v)"
echo "✅ NPM versão: $(npm -v)"

# 2. Criar diretório de instalação
if [ "$PWD" != "$INSTALL_DIR" ]; then
    echo "📁 Copiando arquivos para $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR"
    cp -r . "$INSTALL_DIR/"
fi

cd "$INSTALL_DIR"

# 3. Instalar dependências
echo "📦 Instalando dependências npm..."
npm install --production

# 4. Configurar e iniciar via PM2 (se disponível) ou Systemd
if command -v pm2 &> /dev/null; then
    echo "🚀 Configurando PM2..."
    pm2 delete linux-monitor 2>/dev/null || true
    pm2 start ecosystem.config.js
    pm2 save
    echo "✅ Linux-monitor iniciado via PM2 na porta $PORT."
else
    echo "⚙️ PM2 não encontrado. Instalando PM2 globalmente..."
    sudo npm install -g pm2
    pm2 start ecosystem.config.js
    pm2 save
    echo "✅ Linux-monitor iniciado via PM2 na porta $PORT."
fi

# Obter IP local para exibição
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo "=============================================================================="
echo "🎉 Instalação concluída com sucesso!"
echo "📡 Acesse o painel em: http://$LOCAL_IP:$PORT ou http://192.168.1.101:$PORT"
echo "=============================================================================="
