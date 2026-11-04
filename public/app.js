document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');

      if (targetId === 'services-tab') {
        loadServices();
        loadProcesses();
      }
    });
  });

  // Formatting helpers
  function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  function formatUptime(seconds) {
    if (!seconds) return 'N/A';
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    let res = '';
    if (days > 0) res += `${days}d `;
    if (hours > 0 || days > 0) res += `${hours}h `;
    res += `${minutes}m`;
    return res;
  }

  // Update UI with metrics data
  function updateDashboard(data) {
    if (!data || !data.success) return;

    // Header badges
    document.getElementById('hostname-val').textContent = data.os.hostname || 'Linux Server';
    document.getElementById('os-val').textContent = `${data.os.distro} ${data.os.release}`;
    document.getElementById('uptime-val').textContent = formatUptime(data.os.uptime);

    // CPU Card
    document.getElementById('cpu-brand').textContent = `${data.cpu.manufacturer} ${data.cpu.brand}`;
    document.getElementById('cpu-load-val').textContent = `${data.cpu.load}%`;
    document.getElementById('cpu-load-bar').style.width = `${data.cpu.load}%`;
    
    const tempVal = data.cpu.temperature ? `${data.cpu.temperature}°C` : 'N/A';
    document.getElementById('cpu-temp').textContent = tempVal;
    document.getElementById('cpu-cores').textContent = `${data.cpu.physicalCores} Cores / ${data.cpu.cores} Threads`;
    document.getElementById('cpu-speed').textContent = `${data.cpu.speed} GHz`;

    // Per-core load bars
    const coreBarsContainer = document.getElementById('core-bars');
    if (data.cpu.loadPerCore && data.cpu.loadPerCore.length > 0) {
      coreBarsContainer.innerHTML = data.cpu.loadPerCore.map((load, idx) => `
        <div class="core-bar-row">
          <span>Core ${idx}</span>
          <div class="progress-bar-container" style="margin: 0; flex: 1;">
            <div class="progress-bar ${load > 80 ? 'red' : load > 50 ? 'yellow' : 'cyan'}" style="width: ${load}%"></div>
          </div>
          <span style="width: 40px; text-align: right;">${load}%</span>
        </div>
      `).join('');
    }

    // Memory Card
    const mem = data.mem;
    document.getElementById('mem-usage-val').textContent = `${mem.usagePercent}%`;
    document.getElementById('mem-bar').style.width = `${mem.usagePercent}%`;
    document.getElementById('mem-used').textContent = formatBytes(mem.used);
    document.getElementById('mem-total').textContent = formatBytes(mem.total);
    document.getElementById('mem-avail').textContent = formatBytes(mem.available);
    document.getElementById('swap-usage').textContent = `${formatBytes(mem.swapused)} / ${formatBytes(mem.swaptotal)}`;

    // Disks Cards
    const disksContainer = document.getElementById('disks-container');
    if (data.disks && data.disks.length > 0) {
      disksContainer.innerHTML = data.disks.map(disk => {
        const usePct = disk.use || Math.round((disk.used / disk.size) * 100);
        return `
          <div class="card">
            <div class="card-header">
              <h2>💾 ${disk.mount}</h2>
              <span class="badge">${disk.fs} (${disk.type})</span>
            </div>
            <div class="metric-value">${usePct}% <span style="font-size: 0.9rem; color: var(--text-muted);">usado</span></div>
            <div class="progress-bar-container">
              <div class="progress-bar ${usePct > 90 ? 'red' : usePct > 75 ? 'yellow' : 'blue'}" style="width: ${usePct}%"></div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: var(--text-muted); margin-top: 0.5rem;">
              <span>Usado: ${formatBytes(disk.used)}</span>
              <span>Disponível: ${formatBytes(disk.available)}</span>
              <span>Total: ${formatBytes(disk.size)}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Initial fetch and SSE stream
  fetch('/api/status')
    .then(res => res.json())
    .then(data => updateDashboard(data))
    .catch(err => console.error('Error fetching initial status:', err));

  const evtSource = new EventSource('/api/stream');
  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      updateDashboard(data);
    } catch (e) {
      console.error('Error parsing SSE event:', e);
    }
  };

  // Services & Processes logic
  let allServices = [];
  let allProcesses = [];
  let serviceSortCol = 'name';
  let serviceSortAsc = true;
  let processSortCol = 'cpu';
  let processSortAsc = false;

  window.sortServices = function(col) {
    if (serviceSortCol === col) {
      serviceSortAsc = !serviceSortAsc;
    } else {
      serviceSortCol = col;
      serviceSortAsc = true;
    }
    renderServices(allServices);
  };

  window.sortProcesses = function(col) {
    if (processSortCol === col) {
      processSortAsc = !processSortAsc;
    } else {
      processSortCol = col;
      processSortAsc = (col === 'name' || col === 'pid' || col === 'user');
    }
    renderProcesses(allProcesses);
  };

  window.loadServices = async function() {
    try {
      const res = await fetch('/api/services');
      const data = await res.json();
      if (data.success) {
        allServices = data.services;
        renderServices(allServices);
      }
    } catch (err) {
      console.error('Error loading services:', err);
    }
  };

  window.loadProcesses = async function() {
    try {
      const res = await fetch('/api/processes');
      const data = await res.json();
      if (data.success) {
        allProcesses = data.list;
        renderProcesses(allProcesses);
      }
    } catch (err) {
      console.error('Error loading processes:', err);
    }
  };

  function renderServices(services) {
    const tbody = document.getElementById('services-tbody');
    const search = document.getElementById('services-search').value.toLowerCase();
    
    const filtered = services.filter(s => s.name.toLowerCase().includes(search) || s.description.toLowerCase().includes(search));

    filtered.sort((a, b) => {
      let valA = a[serviceSortCol];
      let valB = b[serviceSortCol];
      if (typeof valA === 'string') {
        valA = (valA || '').toLowerCase();
        valB = (valB || '').toLowerCase();
        return serviceSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return serviceSortAsc ? (valA || 0) - (valB || 0) : (valB || 0) - (valA || 0);
    });

    tbody.innerHTML = filtered.map(s => {
      const memMB = s.memory ? (s.memory / (1024 * 1024)).toFixed(2) : '0.00';
      return `
        <tr>
          <td><strong>${s.name}</strong></td>
          <td>${s.description || '-'}</td>
          <td><span class="badge-status ${s.active}">${s.active}</span></td>
          <td>${s.sub}</td>
          <td>${memMB} MB</td>
          <td>
            <button class="btn" onclick="serviceAction('${s.name}', 'restart')">Reiniciar</button>
            <button class="btn danger" onclick="serviceAction('${s.name}', 'stop')">Parar</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderProcesses(processes) {
    const tbody = document.getElementById('processes-tbody');
    const search = document.getElementById('processes-search').value.toLowerCase();

    const filtered = processes.filter(p => p.name.toLowerCase().includes(search) || String(p.pid).includes(search));

    filtered.sort((a, b) => {
      let valA = a[processSortCol];
      let valB = b[processSortCol];
      if (typeof valA === 'string') {
        valA = (valA || '').toLowerCase();
        valB = (valB || '').toLowerCase();
        return processSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return processSortAsc ? (valA || 0) - (valB || 0) : (valB || 0) - (valA || 0);
    });

    tbody.innerHTML = filtered.slice(0, 100).map(p => `
      <tr>
        <td>${p.pid}</td>
        <td>${p.user || '-'}</td>
        <td><strong>${p.name}</strong></td>
        <td><span style="color: ${p.cpu > 20 ? 'var(--accent-red)' : 'var(--text-main)'};">${p.cpu}%</span></td>
        <td>${p.mem}% (${p.memRss} MB)</td>
        <td><span class="badge-status running">${p.state}</span></td>
        <td>
          <button class="btn danger" onclick="killProcess(${p.pid})">Matar (Kill)</button>
        </td>
      </tr>
    `).join('');
  }

  // Filter handlers
  document.getElementById('services-search').addEventListener('input', () => renderServices(allServices));
  document.getElementById('processes-search').addEventListener('input', () => renderProcesses(allProcesses));

  window.filterServicesByStatus = function(status) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    if (status === 'all') {
      renderServices(allServices);
    } else {
      const filtered = allServices.filter(s => s.active === status);
      renderServices(filtered);
    }
  };

  window.serviceAction = async function(service, action) {
    if (!confirm(`Deseja realmente ${action} o serviço ${service}?`)) return;
    try {
      const res = await fetch('/api/service/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, action })
      });
      const data = await res.json();
      alert(data.message || data.error);
      loadServices();
    } catch (err) {
      alert('Erro ao executar ação no serviço: ' + err.message);
    }
  };

  window.killProcess = async function(pid) {
    if (!confirm(`Deseja realmente finalizar o processo PID ${pid}?`)) return;
    try {
      const res = await fetch('/api/process/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, signal: 'SIGKILL' })
      });
      const data = await res.json();
      alert(data.message || data.error);
      loadProcesses();
    } catch (err) {
      alert('Erro ao finalizar processo: ' + err.message);
    }
  };

  // Periodic refresh for processes tab if active
  setInterval(() => {
    if (document.getElementById('services-tab').classList.contains('active')) {
      loadProcesses();
    }
  }, 5000);
});
