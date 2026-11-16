const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const si = require('systeminformation');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const { initSSHWebSocket } = require('./ws-ssh');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3032;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to get comprehensive system metrics
async function getSystemMetrics() {
  try {
    const [
      cpu,
      cpuLoad,
      cpuTemp,
      mem,
      fsSize,
      osInfo,
      time
    ] = await Promise.all([
      si.cpu(),
      si.currentLoad(),
      si.cpuTemperature(),
      si.mem(),
      si.fsSize(),
      si.osInfo(),
      si.time()
    ]);

    // Format hard drives / filesystems
    const disks = fsSize.map(disk => ({
      fs: disk.fs,
      type: disk.type,
      size: disk.size,
      used: disk.used,
      available: disk.available,
      use: disk.use,
      mount: disk.mount
    }));

    return {
      success: true,
      timestamp: Date.now(),
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        release: osInfo.release,
        kernel: osInfo.kernel,
        hostname: osInfo.hostname,
        arch: osInfo.arch,
        uptime: time.uptime
      },
      cpu: {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        speed: cpu.speed,
        cores: cpu.cores,
        physicalCores: cpu.physicalCores,
        processors: cpu.processors,
        load: Math.round(cpuLoad.currentLoad * 10) / 10,
        loadPerCore: cpuLoad.cpus.map(c => Math.round(c.load * 10) / 10),
        temperature: cpuTemp.main || cpuTemp.cores?.[0] || null,
        maxSpeed: cpu.speedMax || null
      },
      mem: {
        total: mem.total,
        free: mem.free,
        used: mem.used,
        available: mem.available,
        swaptotal: mem.swaptotal,
        swapused: mem.swapused,
        swapfree: mem.swapfree,
        usagePercent: Math.round((mem.used / mem.total) * 1000) / 10
      },
      disks: disks
    };
  } catch (error) {
    console.error('Error fetching system metrics:', error);
    return { success: false, error: error.message };
  }
}

// API: Current status
app.get('/api/status', async (req, res) => {
  const metrics = await getSystemMetrics();
  res.json(metrics);
});

// API: Directory Scan (Disk usage breakdown for folders)
app.get('/api/dir-scan', async (req, res) => {
  try {
    let reqPath = req.query.path || '/';
    let targetPath = path.normalize(reqPath).trim();
    if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;

    const parentPath = targetPath === '/' ? null : path.dirname(targetPath);

    const { stdout } = await execPromise(`du -sk "${targetPath}"/* "${targetPath}"/.* 2>/dev/null | sort -nr | head -n 60 || true`);

    const lines = stdout.trim().split('\n').filter(Boolean);
    const items = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const sizeKB = parseInt(parts[0], 10);
      const itemPath = parts.slice(1).join(' ');

      if (!itemPath || itemPath.endsWith('/.') || itemPath.endsWith('/..')) continue;

      const itemName = path.basename(itemPath);
      let isDir = false;
      try {
        const stats = await fs.promises.stat(itemPath);
        isDir = stats.isDirectory();
      } catch (e) {
        // ignore errors on individual files/links
      }

      items.push({
        name: itemName,
        path: itemPath,
        sizeBytes: isNaN(sizeKB) ? 0 : sizeKB * 1024,
        isDir
      });
    }

    res.json({
      success: true,
      path: targetPath,
      parent: parentPath,
      items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// SSE Stream for live metrics
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const interval = setInterval(async () => {
    const metrics = await getSystemMetrics();
    res.write(`data: ${JSON.stringify(metrics)}\n\n`);
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// API: Services list using systemctl or fallback with RAM usage
app.get('/api/services', async (req, res) => {
  try {
    const [listRes, showRes, processes] = await Promise.all([
      execPromise('systemctl list-units --type=service --no-legend --plain 2>/dev/null || true'),
      execPromise('systemctl show *.service --property=Id,MemoryCurrent,MainPID 2>/dev/null || true'),
      si.processes()
    ]);

    const memMap = new Map();
    const pidMemMap = new Map();
    if (processes && processes.list) {
      processes.list.forEach(p => pidMemMap.set(p.pid, p.memRss || 0));
    }

    const blocks = (showRes.stdout || '').split('\n\n');
    blocks.forEach(block => {
      let id = '', memory = 0, pid = 0;
      block.split('\n').forEach(line => {
        if (line.startsWith('Id=')) id = line.split('=')[1].trim();
        if (line.startsWith('MemoryCurrent=')) {
          const val = line.split('=')[1].trim();
          if (val && val !== '[not set]') memory = Number(val) || 0;
        }
        if (line.startsWith('MainPID=')) pid = Number(line.split('=')[1].trim()) || 0;
      });
      if (id) {
        if (memory === 0 && pid > 0 && pidMemMap.has(pid)) {
          memory = pidMemMap.get(pid);
        }
        memMap.set(id, memory);
      }
    });

    const lines = (listRes.stdout || '').trim().split('\n').filter(Boolean);
    const services = lines.map(line => {
      const parts = line.trim().split(/\s+/);
      const unit = parts[0] || '';
      const load = parts[1] || '';
      const active = parts[2] || '';
      const sub = parts[3] || '';
      const description = parts.slice(4).join(' ') || '';
      const memory = memMap.get(unit) || 0;
      return {
        name: unit.replace('.service', ''),
        unit,
        load,
        active,
        sub,
        description,
        memory
      };
    });
    res.json({ success: true, services });
  } catch (error) {
    // Fallback using systeminformation
    try {
      const siServices = await si.services('*');
      const services = siServices.map(s => ({
        name: s.name,
        unit: s.name,
        load: 'loaded',
        active: s.running ? 'active' : 'inactive',
        sub: s.running ? 'running' : 'dead',
        description: s.name,
        memory: 0
      }));
      res.json({ success: true, services });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// API: Service Action (start, stop, restart)
app.post('/api/service/action', async (req, res) => {
  const { service, action } = req.body;
  if (!service || !['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Parâmetros inválidos (service e action requeridos)' });
  }
  try {
    // Requires sudo or permissions
    await execPromise(`systemctl ${action} ${service}`);
    res.json({ success: true, message: `Serviço ${service} ${action} com sucesso.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Processes list
app.get('/api/processes', async (req, res) => {
  try {
    const processes = await si.processes();
    // Sort by cpu or mem descending
    const list = processes.list.map(p => ({
      pid: p.pid,
      name: p.name,
      cpu: Math.round(p.cpu * 10) / 10,
      mem: Math.round(p.mem * 10) / 10,
      memRss: Math.round((p.memRss || 0) / 1024 / 1024 * 10) / 10, // MB
      cpuTime: p.cpuTime,
      started: p.started,
      state: p.state,
      user: p.user,
      command: p.command
    })).sort((a, b) => b.cpu - a.cpu);

    res.json({
      success: true,
      all: processes.all,
      running: processes.running,
      blocked: processes.blocked,
      sleeping: processes.sleeping,
      list: list
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Process Action (kill)
app.post('/api/process/action', async (req, res) => {
  const { pid, signal } = req.body;
  if (!pid) {
    return res.status(400).json({ success: false, error: 'PID inválido' });
  }
  const sig = signal || 'SIGTERM';
  try {
    process.kill(Number(pid), sig);
    res.json({ success: true, message: `Processo ${pid} finalizado com ${sig}.` });
  } catch (error) {
    // Fallback to kill command via exec
    try {
      await execPromise(`kill -9 ${pid}`);
      res.json({ success: true, message: `Processo ${pid} finalizado com kill -9.` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// API: Clear RAM Cache (Drop pagecache, dentries and inodes safely)
app.post('/api/memory/clear-cache', async (req, res) => {
  try {
    // Sync filesystem buffers to disk first
    await execPromise('sync');
    // Drop pagecache, dentries and inodes (drop_caches = 3)
    await execPromise('sudo sh -c "echo 3 > /proc/sys/vm/drop_caches"');
    
    // Get updated memory status
    const mem = await si.mem();
    res.json({
      success: true,
      message: 'Cache de RAM liberado com sucesso!',
      mem: {
        total: mem.total,
        free: mem.free,
        used: mem.used,
        available: mem.available,
        usagePercent: Math.round((mem.used / mem.total) * 1000) / 10
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Falha ao liberar cache de RAM: ' + error.message });
  }
});

// API: Disk Cleanup Suggestions
app.get('/api/disk-suggestions', async (req, res) => {
  try {
    let journalSize = 0, aptSize = 0, tmpSize = 0, snapCount = 0;
    try {
      const { stdout } = await execPromise('du -sb /var/log/journal /var/cache/apt/archives /tmp 2>/dev/null || true');
      const lines = stdout.trim().split('\n').filter(Boolean);
      lines.forEach(line => {
        const parts = line.split('\t');
        const bytes = parseInt(parts[0], 10) || 0;
        const p = parts[1] || '';
        if (p.includes('/var/log/journal')) journalSize = bytes;
        if (p.includes('/var/cache/apt/archives')) aptSize = bytes;
        if (p.includes('/tmp')) tmpSize = bytes;
      });
    } catch (e) {}

    try {
      const { stdout } = await execPromise("snap list --all | grep disabled | wc -l || echo 0");
      snapCount = parseInt(stdout.trim(), 10) || 0;
    } catch (e) {}

    const suggestions = [
      {
        id: 'journal',
        title: 'Logs Antigos do Systemd Journal',
        description: 'Logs acumulados do sistema. Seguro limpar mantendo os últimos 7 dias.',
        sizeBytes: journalSize,
        action: 'journalctl --vacuum-time=7d'
      },
      {
        id: 'snaps',
        title: `Versões Antigas de Snaps Desativadas (${snapCount} revisões)`,
        description: 'Versões antigas de pacotes Snap que continuam ocupando espaço após atualizações.',
        sizeBytes: snapCount * 50 * 1024 * 1024,
        action: 'snap-clean'
      },
      {
        id: 'apt',
        title: 'Cache de Instalação APT',
        description: 'Pacotes .deb baixados durante instalações e atualizações anteriores.',
        sizeBytes: aptSize,
        action: 'apt-get clean'
      },
      {
        id: 'tmp',
        title: 'Arquivos Temporários (/tmp)',
        description: 'Arquivos temporários órfãos que não estão sendo usados por nenhum processo ativo.',
        sizeBytes: tmpSize,
        action: 'rm -rf /tmp/*'
      }
    ];

    res.json({ success: true, suggestions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Execute Disk Cleanup
app.post('/api/disk-cleanup', async (req, res) => {
  const { target } = req.body;
  try {
    let messages = [];
    if (target === 'journal' || target === 'all') {
      await execPromise('sudo journalctl --vacuum-time=7d');
      messages.push('Journal vacuumed (mantido últimos 7 dias)');
    }
    if (target === 'apt' || target === 'all') {
      await execPromise('sudo apt-get clean');
      messages.push('Cache APT limpo');
    }
    if (target === 'tmp' || target === 'all') {
      await execPromise('sudo rm -rf /tmp/* 2>/dev/null || true');
      messages.push('Pasta /tmp limpa');
    }
    if (target === 'snaps' || target === 'all') {
      try {
        const { stdout } = await execPromise("snap list --all | awk '/disabled/{print $1, $3}'");
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const [name, rev] = line.trim().split(/\s+/);
          if (name && rev) {
            await execPromise(`sudo snap remove "${name}" --revision="${rev}"`).catch(() => {});
          }
        }
        messages.push('Revisões antigas de Snap removidas com sucesso');
      } catch (e) {}
    }

    res.json({
      success: true,
      message: 'Limpeza executada com sucesso! ' + messages.join(' | ')
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao executar limpeza: ' + error.message });
  }
});

// API: List Installed Apps (Snap & APT)
app.get('/api/apps', async (req, res) => {
  try {
    const apps = [];
    
    // 1. Get Snaps
    try {
      const { stdout } = await execPromise('snap list 2>/dev/null || true');
      const lines = stdout.trim().split('\n').slice(1);
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          apps.push({
            name: parts[0],
            version: parts[1],
            type: 'snap',
            publisher: parts[4] || 'local'
          });
        }
      });
    } catch (e) {}

    // 2. Get user-installed explicit APT packages (using apt-mark showmanual)
    try {
      const { stdout } = await execPromise('apt-mark showmanual 2>/dev/null || true');
      const manualPkgs = stdout.trim().split('\n').filter(Boolean);
      if (manualPkgs.length > 0) {
        // Query versions for manual packages
        const { stdout: dpkgOut } = await execPromise(`dpkg-query -W -f='\${Package}\\t\${Version}\\n' ${manualPkgs.join(' ')} 2>/dev/null || true`);
        const lines = dpkgOut.trim().split('\n').filter(Boolean);
        lines.forEach(line => {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            apps.push({
              name: parts[0],
              version: parts[1],
              type: 'apt',
              publisher: 'ubuntu/debian'
            });
          }
        });
      }
    } catch (e) {}

    res.json({ success: true, apps });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Remove Installed App
app.post('/api/app/remove', async (req, res) => {
  const { name, type } = req.body;
  if (!name || !['snap', 'apt'].includes(type)) {
    return res.status(400).json({ success: false, error: 'Parâmetros inválidos (name e type requeridos)' });
  }

  const criticalPkgs = ['systemd', 'snapd', 'bash', 'core', 'libc6', 'linux-base', 'ubuntu-keyring', 'linux-monitor'];
  if (criticalPkgs.includes(name)) {
    return res.status(403).json({ success: false, error: 'Remoção negada: Este é um pacote crítico do sistema.' });
  }

  try {
    if (type === 'snap') {
      await execPromise(`sudo snap remove "${name}"`);
    } else {
      await execPromise(`sudo apt-get remove -y "${name}"`);
    }
    res.json({ success: true, message: `Aplicativo ${name} (${type}) removido com sucesso!` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Falha ao remover aplicativo: ' + error.message });
  }
});

// ==================== BACKUP & NAS MODULE ====================
const SCHEDULE_PATH = path.join(__dirname, 'backup-schedule.json');
let backupSchedules = [];
let scheduleInterval = null;
let backupRunning = false;
let currentBackupPid = null;
let currentBackupFile = null;
let backupStartTime = null;
let currentBackupScheduleId = null;

function getBackupConfig() {
  const mountPoint = process.env.BACKUP_MOUNT || '/mnt/synology_backup';
  return {
    mount_point: mountPoint,
    nas_ip: '192.168.1.130'
  };
}

async function ensureNasMounted() {
  const cfg = getBackupConfig();
  if (!fs.existsSync(cfg.mount_point)) {
    try {
      fs.mkdirSync(cfg.mount_point, { recursive: true });
    } catch (e) {}
  }
}

// API: Listar Backups
app.get('/api/backup/list', async (req, res) => {
  try {
    const cfg = getBackupConfig();
    const backupDir = path.join(cfg.mount_point, 'linux-monitor-backups');
    
    let targetDir = backupDir;
    if (!fs.existsSync(backupDir)) {
      if (fs.existsSync(cfg.mount_point)) {
        targetDir = cfg.mount_point;
      } else {
        try {
          fs.mkdirSync(backupDir, { recursive: true });
          targetDir = backupDir;
        } catch (e) {
          targetDir = path.join(__dirname, 'backups');
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
        }
      }
    }

    const files = fs.readdirSync(targetDir);
    const backups = [];
    for (const file of files) {
      if (file.endsWith('.tar.gz') || file.endsWith('.tgz') || file.endsWith('.zip')) {
        const filePath = path.join(targetDir, file);
        try {
          const stats = fs.statSync(filePath);
          backups.push({
            name: file,
            size: stats.size,
            time: stats.mtime.toISOString(),
            path: filePath
          });
        } catch (e) {}
      }
    }

    backups.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json({ success: true, backups, mount_point: targetDir });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Listar destinos de backup disponíveis
app.get('/api/backup/destinations', async (req, res) => {
  try {
    const destinations = [];
    
    try {
      const { stdout } = await execPromise('df -h | grep -E "^/dev|^//|^192|^NAS" 2>/dev/null || true');
      const lines = stdout.trim().split('\n').filter(Boolean);
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          destinations.push({
            device: parts[0],
            mount: parts[5],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            use: parts[4]
          });
        }
      });
    } catch (e) {}

    const cfg = getBackupConfig();
    if (!destinations.some(d => d.mount === cfg.mount_point)) {
      destinations.push({
        device: 'CIFS/NAS',
        mount: cfg.mount_point,
        size: 'Configurado',
        used: '-',
        available: '-',
        use: '-'
      });
    }

    const localBackupDir = path.join(__dirname, 'backups');
    if (!destinations.some(d => d.mount === localBackupDir)) {
      destinations.push({
        device: 'Local',
        mount: localBackupDir,
        size: 'Local',
        used: '-',
        available: '-',
        use: '-'
      });
    }

    res.json({ success: true, destinations, current: cfg.mount_point });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Iniciar Backup Manual
app.post('/api/backup/start', async (req, res) => {
  if (backupRunning) {
    return res.status(409).json({ success: false, error: 'Um backup já está em andamento. Aguarde a conclusão.' });
  }

  try {
    backupRunning = true;
    backupStartTime = Date.now();
    
    const requestedDest = req.body?.destination || null;
    let targetDir = requestedDest ? path.join(requestedDest, 'linux-monitor-backups') : path.join(getBackupConfig().mount_point, 'linux-monitor-backups');
    
    if (!fs.existsSync(targetDir)) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (e) {
        targetDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
      }
    }

    const osInfo = await si.osInfo();
    
    let hostname = osInfo.hostname || 'linux-server';
    if (hostname === 'linux-server') {
        try { hostname = fs.readFileSync('/etc/hostname', 'utf8').trim(); } catch (e) {}
    }
    hostname = hostname.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'linux-server';
    
    let distro = (osInfo.distro || 'linux').toLowerCase().replace(/[^a-z0-9]/g, '-');
    let release = (osInfo.release || 'unknown').toLowerCase().replace(/[^a-z0-9.-]/g, '-');
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${hostname}-${distro}-${release}-${timestamp}.tar.gz`;
    const backupPath = path.join(targetDir, backupName);
    currentBackupFile = backupPath;

    const cmd = `tar --exclude='/dev/*' --exclude='/proc/*' --exclude='/sys/*' --exclude='/tmp/*' --exclude='/run/*' --exclude='/mnt/*' --exclude='/media/*' --exclude='/lost+found' -czpf "${backupPath}" / 2>/dev/null || true`;

    console.log(`[Backup Manual] Iniciando: ${backupName} em ${backupPath}`);

    const child = exec(cmd, (error, stdout, stderr) => {
      backupRunning = false;
      currentBackupPid = null;
      currentBackupFile = null;
      backupStartTime = null;
      currentBackupScheduleId = null;
      if (error) {
        console.error('[Backup Manual] Erro:', error);
      } else {
        console.log('[Backup Manual] Concluído com sucesso:', backupName);
      }
    });

    currentBackupPid = child.pid;
    backupStartTime = Date.now();
    currentBackupScheduleId = req.body?.scheduleId || null;

    res.json({ success: true, message: 'Backup iniciado com sucesso em segundo plano!', filename: backupName });
  } catch (error) {
    backupRunning = false;
    currentBackupPid = null;
    currentBackupFile = null;
    backupStartTime = null;
    currentBackupScheduleId = null;
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Status do Backup em Andamento
app.get('/api/backup/status', (req, res) => {
  let fileSize = 0;
  if (currentBackupFile && fs.existsSync(currentBackupFile)) {
    try {
      const stats = fs.statSync(currentBackupFile);
      fileSize = stats.size;
    } catch (e) {}
  }
  let elapsedSeconds = 0;
    let mbps = 0;
    if (backupStartTime) {
      elapsedSeconds = Math.max(1, Math.floor((Date.now() - backupStartTime) / 1000));
      mbps = (fileSize / (1024 * 1024)) / elapsedSeconds;
    }
    
    res.json({
      success: true,
      running: backupRunning,
      filename: currentBackupFile ? path.basename(currentBackupFile) : null,
      size: fileSize,
      elapsed_seconds: elapsedSeconds,
      mbps: Math.round(mbps * 100) / 100,
      scheduleId: currentBackupScheduleId
    });
});

// API: Cancelar Backup em Andamento
app.post('/api/backup/cancel', async (req, res) => {
  if (!backupRunning) {
    return res.status(400).json({ success: false, error: 'Nenhum backup em andamento para cancelar.' });
  }

  try {
    if (currentBackupPid) {
      try {
        process.kill(-currentBackupPid, 'SIGKILL');
      } catch (e) {
        try {
          process.kill(currentBackupPid, 'SIGKILL');
        } catch (err) {}
      }
    }

    // Remover arquivo parcial do NAS
    if (currentBackupFile && fs.existsSync(currentBackupFile)) {
      try {
        fs.unlinkSync(currentBackupFile);
        console.log(`[Backup Manual] Cancelado. Arquivo parcial removido: ${currentBackupFile}`);
      } catch (e) {
        console.error('[Backup Manual] Erro ao remover arquivo parcial:', e);
      }
    }

    backupRunning = false;
    currentBackupPid = null;
    currentBackupFile = null;

    res.json({ success: true, message: 'Backup cancelado e arquivo parcial removido com sucesso.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Download de Backup
app.get('/api/backup/download', (req, res) => {
  const fileName = req.query.file;
  if (!fileName || fileName.includes('..') || fileName.includes('/')) {
    return res.status(400).json({ success: false, error: 'Nome de arquivo inválido.' });
  }

  const cfg = getBackupConfig();
  const possibleDirs = [
    path.join(cfg.mount_point, 'linux-monitor-backups'),
    cfg.mount_point,
    path.join(__dirname, 'backups')
  ];

  let filePath = null;
  for (const dir of possibleDirs) {
    const p = path.join(dir, fileName);
    if (fs.existsSync(p)) {
      filePath = p;
      break;
    }
  }

  if (!filePath) {
    return res.status(404).json({ success: false, error: 'Arquivo de backup não encontrado.' });
  }

  res.download(filePath, fileName);
});

// API: Excluir Backup do NAS
app.delete('/api/backup/delete', (req, res) => {
  const fileName = req.query.file;
  if (!fileName || fileName.includes('..') || fileName.includes('/')) {
    return res.status(400).json({ success: false, error: 'Nome de arquivo inválido.' });
  }

  const cfg = getBackupConfig();
  const possibleDirs = [
    path.join(cfg.mount_point, 'linux-monitor-backups'),
    cfg.mount_point,
    path.join(__dirname, 'backups')
  ];

  let filePath = null;
  for (const dir of possibleDirs) {
    const p = path.join(dir, fileName);
    if (fs.existsSync(p)) {
      filePath = p;
      break;
    }
  }

  if (!filePath) {
    return res.status(404).json({ success: false, error: 'Arquivo de backup não encontrado.' });
  }

  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Backup ${fileName} excluído com sucesso do NAS.` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Falha ao excluir arquivo: ' + error.message });
  }
});

// ==================== BACKUP SCHEDULER ====================
function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULE_PATH)) {
      backupSchedules = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
    }
  } catch (e) {
    backupSchedules = [];
  }
}

function saveSchedules() {
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(backupSchedules, null, 2));
}

function parseCronSimple(expr) {
  const parts = expr.split(',');
  return {
    dayOfWeek: parts[0],
    hour: parseInt(parts[1], 10),
    minute: parseInt(parts[2], 10)
  };
}

function shouldRunSchedule(sched, now) {
  if (!sched.enabled) return false;
  const cron = parseCronSimple(sched.cronExpression);
  const nowDay = now.getDay();
  const nowHour = now.getHours();
  const nowMinute = now.getMinutes();
  const dayMatch = (cron.dayOfWeek === '*' || String(nowDay) === cron.dayOfWeek);
  const hourMatch = cron.hour === nowHour;
  const minuteMatch = cron.minute === nowMinute;
  return dayMatch && hourMatch && minuteMatch;
}

function runScheduledBackup(sched) {
  if (backupRunning) {
    console.log(`[Scheduled Backup] Ignorado (${sched.name}): outro backup em andamento.`);
    return;
  }
  backupRunning = true;
  currentBackupScheduleId = sched.id;
  backupStartTime = Date.now();

  const cfg = getBackupConfig();
  const backupDir = path.join(cfg.mount_point, 'linux-monitor-backups');
  let targetDir = backupDir;
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (e) {
      targetDir = path.join(__dirname, 'backups');
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    }
  }

  si.osInfo().then(osInfo => {
    let hostname = osInfo.hostname || 'linux-server';
    if (hostname === 'linux-server') {
        try { hostname = fs.readFileSync('/etc/hostname', 'utf8').trim(); } catch (e) {}
    }
    hostname = hostname.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'linux-server';
    
    let distro = (osInfo.distro || 'linux').toLowerCase().replace(/[^a-z0-9]/g, '-');
    if (!distro || distro === 'linux') {
        try {
            const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
            const idMatch = osRelease.match(/^ID=(.+)$/m);
            if (idMatch) distro = idMatch[1].replace(/["']/g, '').toLowerCase().replace(/[^a-z0-9]/g, '-');
        } catch (e) {}
    }
    
    let release = (osInfo.release || 'unknown').toLowerCase().replace(/[^a-z0-9.-]/g, '-');
    if (!release || release === 'unknown') {
        try {
            const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
            const versionMatch = osRelease.match(/^VERSION=(.+)$/m);
            if (versionMatch) release = versionMatch[1].replace(/["']/g, '').toLowerCase().replace(/[^a-z0-9.-]/g, '-');
        } catch (e) {}
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${hostname}-${distro}-${release}-${timestamp}.tar.gz`;
    const backupPath = path.join(targetDir, backupName);
    currentBackupFile = backupPath;
    const cmd = `tar --exclude='/dev/*' --exclude='/proc/*' --exclude='/sys/*' --exclude='/tmp/*' --exclude='/run/*' --exclude='/mnt/*' --exclude='/media/*' --exclude='/lost+found' -czpf "${backupPath}" / 2>/dev/null || true`;

    sched.lastRun = new Date().toISOString();
    saveSchedules();

    console.log(`[Scheduled Backup] Iniciando: ${sched.name} -> ${backupName}`);

    const child = exec(cmd, (error, stdout, stderr) => {
      backupRunning = false;
      currentBackupPid = null;
      currentBackupFile = null;
      backupStartTime = null;
      currentBackupScheduleId = null;
      if (error) {
        console.error(`[Scheduled Backup] Erro em ${sched.name}:`, error);
      } else {
        console.log(`[Scheduled Backup] Concluído: ${backupName}`);
      }
      sched.lastRun = new Date().toISOString();
      saveSchedules();
    });
    
    currentBackupPid = child.pid;
  }).catch(() => {
    backupRunning = false;
    currentBackupPid = null;
    currentBackupFile = null;
    backupStartTime = null;
    currentBackupScheduleId = null;
  });
}

function startScheduleChecker() {
  if (scheduleInterval) clearInterval(scheduleInterval);
  scheduleInterval = setInterval(() => {
    const now = new Date();
    if (now.getSeconds() === 0) {
      backupSchedules.forEach(sched => {
        if (shouldRunSchedule(sched, now)) {
          runScheduledBackup(sched);
        }
      });
    }
  }, 1000);
}

loadSchedules();
startScheduleChecker();

// API: Listar agendamentos
app.get('/api/backup/schedule', (req, res) => {
  res.json({ success: true, schedules: backupSchedules });
});

// API: Adicionar/editar agendamento
app.post('/api/backup/schedule', (req, res) => {
  try {
    const { id, name, cronExpression, enabled } = req.body;
    if (!name || !cronExpression) {
      return res.status(400).json({ success: false, error: 'Nome e expressão cron são obrigatórios' });
    }
    const scheduleObj = {
      id: id || Date.now().toString(),
      name,
      cronExpression,
      enabled: enabled !== false,
      createdAt: new Date().toISOString(),
      lastRun: null
    };
    const idx = backupSchedules.findIndex(s => s.id === scheduleObj.id);
    if (idx >= 0) {
      backupSchedules[idx] = scheduleObj;
    } else {
      backupSchedules.push(scheduleObj);
    }
    saveSchedules();
    startScheduleChecker();
    res.json({ success: true, schedules: backupSchedules });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Remover agendamento
app.delete('/api/backup/schedule/:id', (req, res) => {
  try {
    backupSchedules = backupSchedules.filter(s => s.id !== req.params.id);
    saveSchedules();
    startScheduleChecker();
    res.json({ success: true, schedules: backupSchedules });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Toggle habilitar/desabilitar agendamento
app.post('/api/backup/schedule/:id/toggle', (req, res) => {
  try {
    const sched = backupSchedules.find(s => s.id === req.params.id);
    if (!sched) return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });
    sched.enabled = !sched.enabled;
    saveSchedules();
    startScheduleChecker();
    res.json({ success: true, schedules: backupSchedules });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ==================== REMOTE ACCESS MODULE ====================

// Initialize WebSocket SSH terminal
initSSHWebSocket(server);

// API: Remote Access Status
app.get('/api/remote-access/status', async (req, res) => {
  try {
    const results = {};

    // Check SSH
    try {
      await execPromise('which ssh 2>/dev/null || echo ""');
      results.ssh = { installed: true };
    } catch (e) {
      results.ssh = { installed: false };
    }

    // Check XRDP service
    try {
      const { stdout } = await execPromise('systemctl is-active xrdp 2>/dev/null || echo inactive');
      results.xrdp = { running: stdout.trim() === 'active' };
    } catch (e) {
      results.xrdp = { running: false };
    }

    // Check x11vnc process
    try {
      await execPromise('pgrep x11vnc >/dev/null 2>&1 || echo ""');
      results.vnc = { running: true };
    } catch (e) {
      results.vnc = { running: false };
    }

    // Check websockify process
    try {
      await execPromise('pgrep websockify >/dev/null 2>&1 || echo ""');
      results.novnc = { running: true };
    } catch (e) {
      results.novnc = { running: false };
    }

    res.json({ success: true, services: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: XRDP Control (start/stop/restart)
app.post('/api/remote-access/xrdp', async (req, res) => {
  const { action } = req.body;
  if (!action || !['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Ação inválida (start, stop, restart)' });
  }
  try {
    await execPromise(`sudo systemctl ${action} xrdp`);
    res.json({ success: true, message: `XRDP ${action} com sucesso.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: VNC (x11vnc) Control
app.post('/api/remote-access/vnc', async (req, res) => {
  const { action } = req.body;
  if (!action || !['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Ação inválida (start, stop, restart)' });
  }
  try {
    if (action === 'stop' || action === 'restart') {
      await execPromise('pkill -f x11vnc 2>/dev/null || true');
      await new Promise(r => setTimeout(r, 1000));
    }
    if (action === 'start' || action === 'restart') {
      await execPromise('nohup x11vnc -forever -shared -noxdamage -nopw -display :0 -rfbport 5900 >/dev/null 2>&1 &');
    }
    res.json({ success: true, message: `x11vnc ${action} com sucesso.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: noVNC (websockify) Control
app.post('/api/remote-access/novnc', async (req, res) => {
  const { action } = req.body;
  if (!action || !['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Ação inválida (start, stop, restart)' });
  }
  try {
    const novncDir = '/usr/share/novnc';
    if (action === 'stop' || action === 'restart') {
      await execPromise('pkill -f "websockify 6080" 2>/dev/null || true');
      await new Promise(r => setTimeout(r, 1000));
    }
    if (action === 'start' || action === 'restart') {
      await execPromise(`nohup websockify --web ${novncDir} 6080 localhost:5900 >/dev/null 2>&1 &`);
    }
    res.json({ success: true, message: `noVNC/websockify ${action} com sucesso.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Linux-monitor rodando na porta ${PORT}`);
});
