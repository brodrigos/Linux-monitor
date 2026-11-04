const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const si = require('systeminformation');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Linux-monitor rodando na porta ${PORT}`);
});
