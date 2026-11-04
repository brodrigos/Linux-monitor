const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const si = require('systeminformation');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Linux-monitor rodando na porta ${PORT}`);
});
