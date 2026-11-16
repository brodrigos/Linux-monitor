// === REMOTE ACCESS - WebSocket SSH Terminal ===
const WebSocket = require('ws');
const pty = require('node-pty');

function initSSHWebSocket(server) {
  const wss = new WebSocket.Server({ server: server, path: '/ws/ssh' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const host = url.searchParams.get('host');
    const port = url.searchParams.get('port') || '22';
    const username = url.searchParams.get('username');
    const password = url.searchParams.get('password') || '';
    const cols = parseInt(url.searchParams.get('cols')) || 80;
    const rows = parseInt(url.searchParams.get('rows')) || 24;

    if (!host || !username) {
      ws.send(JSON.stringify({ type: 'error', message: 'Host e username sao obrigatorios' }));
      ws.close();
      return;
    }

    let shell;
    try {
      const sshArgs = [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-p', port,
        username + '@' + host,
        '--'
      ];

      let spawnCmd = 'ssh';
      let spawnArgs = sshArgs;
      let env = { ...process.env, DISPLAY: '' };

      if (password) {
        spawnCmd = 'sshpass';
        spawnArgs = ['-p', password, 'ssh'].concat(sshArgs);
      }

      shell = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols: cols,
        rows: rows,
        cwd: process.env.HOME || '/tmp',
        env: env
      });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
      ws.close();
      return;
    }

    shell.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    shell.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        ws.close();
      }
    });

    ws.on('message', (msg) => {
      const data = msg.toString();
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'resize') {
          shell.resize(parsed.cols, parsed.rows);
          return;
        }
      } catch (e) {}
      shell.write(data);
    });

    ws.on('close', () => { try { shell.kill(); } catch(e) {} });
    ws.on('error', () => { try { shell.kill(); } catch(e) {} });
  });

  return wss;
}

module.exports = initSSHWebSocket;
// === END REMOTE ACCESS ===
