'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
  WebSocketServer
} = require('ws');
const cryptoHelper = require('./crypto-helper');
const {
  SafeBoxHost,
  connectToHost
} = require('./network');
const {
  UPnPMapper
} = require('./upnp');
const WEB_PORT = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT, 10) : 3847;
const P2P_PORT = process.env.P2P_PORT ? parseInt(process.env.P2P_PORT, 10) : 3848;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'SafeBox');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, {
  recursive: true
});
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
const state = {
  keyPair: null,
  connectionCode: null,
  codeExpiresAt: null,
  localIP: null,
  externalIP: null,
  p2pHost: null,
  peer: null,
  upnp: new UPnPMapper(),
  wsClients: new Set(),
  activeFileTransfers: new Map(),
  pendingFileOffers: new Map()
};
function broadcast(type, data) {
  const msg = JSON.stringify({
    type,
    data
  });
  for (const ws of state.wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}
function refreshConnectionCode() {
  const ip = state.externalIP || state.localIP;
  state.connectionCode = cryptoHelper.generateConnectionCode(ip, P2P_PORT, state.keyPair.publicKey);
  state.codeExpiresAt = Date.now() + cryptoHelper.getSlotRemainingMs();
  broadcast('code-update', {
    code: state.connectionCode,
    expiresAt: state.codeExpiresAt,
    localIP: state.localIP,
    externalIP: state.externalIP
  });
  const remaining = cryptoHelper.getSlotRemainingMs();
  setTimeout(refreshConnectionCode, remaining + 500);
}
function setupPeerEvents(peer) {
  state.peer = peer;
  peer.on('connected', () => {
    console.log(`[SafeBox] ✔ Secure connection established with ${peer.remoteAddress}`);
    broadcast('connected', {
      remoteAddress: peer.remoteAddress,
      remotePort: peer.remotePort,
      isHost: peer.isHost
    });
  });
  peer.on('chat', msg => {
    broadcast('chat-message', {
      from: 'peer',
      text: msg.text,
      timestamp: msg.timestamp
    });
  });
  peer.on('file-offer', offer => {
    state.pendingFileOffers.set(offer.fileId, offer);
    broadcast('file-offer', offer);
  });
  peer.on('file-accept', data => {
    broadcast('file-accepted', data);
    const transfer = state.activeFileTransfers.get(data.fileId);
    if (transfer && transfer.filePath) {
      transfer.readStream = fs.createReadStream(transfer.filePath, {
        highWaterMark: 64 * 1024
      });
      transfer.hash = crypto.createHash('sha256');
      transfer.readStream.on('data', chunk => {
        transfer.hash.update(chunk);
        const fileIdBuf = Buffer.alloc(36);
        fileIdBuf.write(data.fileId);
        peer.sendFileChunk(Buffer.concat([fileIdBuf, chunk]));
      });
      transfer.readStream.on('end', () => {
        const hash = transfer.hash.digest('hex');
        peer.sendFileComplete(data.fileId, hash);
        broadcast('file-send-complete', {
          fileId: data.fileId,
          hash
        });
        state.activeFileTransfers.delete(data.fileId);
      });
    } else if (transfer && transfer.buffer) {
      handleFileAcceptForBuffer(data.fileId);
    }
  });
  peer.on('file-reject', data => {
    broadcast('file-rejected', data);
    state.activeFileTransfers.delete(data.fileId);
  });
  peer.on('file-chunk', payload => {
    const fileId = payload.slice(0, 36).toString().replace(/\0/g, '');
    const chunkData = payload.slice(36);
    const transfer = state.activeFileTransfers.get(fileId);
    if (transfer && transfer.writeStream) {
      transfer.writeStream.write(chunkData);
      transfer.received += chunkData.length;
      transfer.hash.update(chunkData);
      broadcast('file-progress', {
        fileId,
        received: transfer.received,
        total: transfer.fileSize,
        percent: Math.round(transfer.received / transfer.fileSize * 100)
      });
    }
  });
  peer.on('file-complete', data => {
    const transfer = state.activeFileTransfers.get(data.fileId);
    if (transfer && transfer.writeStream) {
      transfer.writeStream.end();
      const localHash = transfer.hash.digest('hex');
      const verified = localHash === data.hash;
      broadcast('file-receive-complete', {
        fileId: data.fileId,
        fileName: transfer.fileName,
        verified,
        path: transfer.filePath
      });
      state.activeFileTransfers.delete(data.fileId);
    }
  });
  peer.on('disconnected', () => {
    console.log('[SafeBox] ✖ Peer disconnected');
    state.peer = null;
    broadcast('disconnected', {
      reason: 'Peer disconnected'
    });
  });
  peer.on('peer-disconnect', () => {
    console.log('[SafeBox] ✖ Peer sent disconnect signal');
    state.peer = null;
    broadcast('disconnected', {
      reason: 'Peer disconnected'
    });
  });
  peer.on('heartbeat-timeout', () => {
    console.log('[SafeBox] ✖ Heartbeat timeout — connection lost');
    broadcast('disconnected', {
      reason: 'Connection lost (heartbeat timeout)'
    });
  });
  peer.on('error', err => {
    console.error('[SafeBox] Peer error:', err.message);
    broadcast('peer-error', {
      message: err.message
    });
  });
}
function handleWSMessage(ws, message) {
  let msg;
  try {
    msg = JSON.parse(message);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'get-status':
      {
        ws.send(JSON.stringify({
          type: 'status',
          data: {
            code: state.connectionCode,
            expiresAt: state.codeExpiresAt,
            localIP: state.localIP,
            externalIP: state.externalIP,
            connected: !!(state.peer && state.peer.connected),
            remoteAddress: state.peer ? state.peer.remoteAddress : null
          }
        }));
        break;
      }
    case 'connect':
      {
        const decoded = cryptoHelper.decodeConnectionCode(msg.code);
        if (!decoded) {
          ws.send(JSON.stringify({
            type: 'connect-error',
            data: {
              message: 'Invalid or expired connection code'
            }
          }));
          return;
        }
        broadcast('connecting', {
          ip: decoded.ip,
          port: decoded.port
        });
        const clientKeyPair = cryptoHelper.generateKeyPair();
        connectToHost(decoded.ip, decoded.port, clientKeyPair, decoded.pubKeyHash).then(peer => {
          setupPeerEvents(peer);
        }).catch(err => {
          broadcast('connect-error', {
            message: err.message
          });
        });
        break;
      }
    case 'send-chat':
      {
        if (state.peer && state.peer.connected) {
          state.peer.sendChat(msg.text);
          broadcast('chat-message', {
            from: 'me',
            text: msg.text,
            timestamp: Date.now()
          });
        }
        break;
      }
    case 'send-file':
      {
        if (state.peer && state.peer.connected && msg.fileName && msg.filePath) {
          const filePath = msg.filePath;
          if (!fs.existsSync(filePath)) {
            ws.send(JSON.stringify({
              type: 'file-error',
              data: {
                message: 'File not found'
              }
            }));
            return;
          }
          const stats = fs.statSync(filePath);
          const fileId = crypto.randomUUID();
          const readStream = fs.createReadStream(filePath, {
            highWaterMark: 64 * 1024
          });
          const hash = crypto.createHash('sha256');
          readStream.on('data', chunk => hash.update(chunk));
          readStream.destroy();
          state.activeFileTransfers.set(fileId, {
            readStream: null,
            fileName: msg.fileName,
            fileSize: stats.size,
            filePath,
            hash: crypto.createHash('sha256')
          });
          state.peer.sendFileOffer(fileId, msg.fileName, stats.size);
          broadcast('file-offered', {
            fileId,
            fileName: msg.fileName,
            fileSize: stats.size
          });
        }
        break;
      }
    case 'send-file-data':
      {
        if (state.peer && state.peer.connected && msg.fileName && msg.fileData) {
          const fileId = crypto.randomUUID();
          const fileBuffer = Buffer.from(msg.fileData, 'base64');
          const fileSize = fileBuffer.length;
          state.peer.sendFileOffer(fileId, msg.fileName, fileSize);
          broadcast('file-offered', {
            fileId,
            fileName: msg.fileName,
            fileSize
          });
          state.activeFileTransfers.set(fileId, {
            buffer: fileBuffer,
            fileName: msg.fileName,
            fileSize,
            hash: crypto.createHash('sha256')
          });
        }
        break;
      }
    case 'accept-file':
      {
        const offer = state.pendingFileOffers.get(msg.fileId);
        if (offer && state.peer && state.peer.connected) {
          const safeFileName = offer.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(DOWNLOADS_DIR, safeFileName);
          const writeStream = fs.createWriteStream(filePath);
          state.activeFileTransfers.set(msg.fileId, {
            writeStream,
            fileName: offer.fileName,
            fileSize: offer.fileSize,
            filePath,
            received: 0,
            hash: crypto.createHash('sha256')
          });
          state.peer.sendFileAccept(msg.fileId);
          state.pendingFileOffers.delete(msg.fileId);
        }
        break;
      }
    case 'reject-file':
      {
        if (state.peer && state.peer.connected) {
          state.peer.sendFileReject(msg.fileId);
          state.pendingFileOffers.delete(msg.fileId);
        }
        break;
      }
    case 'disconnect':
      {
        if (state.peer) {
          state.peer.disconnect();
          state.peer = null;
          broadcast('disconnected', {
            reason: 'You disconnected'
          });
        }
        break;
      }
    default:
      break;
  }
}
function handleFileAcceptForBuffer(fileId) {
  const transfer = state.activeFileTransfers.get(fileId);
  if (transfer && transfer.buffer && state.peer) {
    const chunkSize = 64 * 1024;
    let offset = 0;
    const hash = crypto.createHash('sha256');
    const sendNext = () => {
      if (offset >= transfer.buffer.length) {
        const hashHex = hash.digest('hex');
        state.peer.sendFileComplete(fileId, hashHex);
        broadcast('file-send-complete', {
          fileId,
          hash: hashHex
        });
        state.activeFileTransfers.delete(fileId);
        return;
      }
      const chunk = transfer.buffer.slice(offset, offset + chunkSize);
      hash.update(chunk);
      const fileIdBuf = Buffer.alloc(36);
      fileIdBuf.write(fileId);
      state.peer.sendFileChunk(Buffer.concat([fileIdBuf, chunk]));
      offset += chunkSize;
      broadcast('file-progress', {
        fileId,
        received: offset,
        total: transfer.fileSize,
        percent: Math.round(offset / transfer.fileSize * 100)
      });
      setImmediate(sendNext);
    };
    sendNext();
  }
}
const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(FRONTEND_DIR, filePath);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType
    });
    res.end(data);
  });
});
const wss = new WebSocketServer({
  server: httpServer
});
wss.on('connection', ws => {
  state.wsClients.add(ws);
  ws.on('message', data => handleWSMessage(ws, data.toString()));
  ws.on('close', () => state.wsClients.delete(ws));
});
async function start() {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║          SafeBox — Secure P2P Link        ║');
  console.log('  ╠═══════════════════════════════════════════╣');
  state.keyPair = cryptoHelper.generateKeyPair();
  state.localIP = getLocalIP();
  try {
    await state.upnp.discover();
    state.externalIP = await state.upnp.getExternalIP();
    await state.upnp.addMapping(P2P_PORT, state.localIP, P2P_PORT, 'SafeBox', 10800);
    console.log(`  ║  UPnP:   ✔ External ${state.externalIP}:${P2P_PORT}     `);
  } catch (err) {
    console.log(`  ║  UPnP:   ✖ ${err.message.slice(0, 30).padEnd(30)}  ║`);
    console.log('  ║  Mode:   LAN only (manual port-fwd for WAN) ║');
  }
  state.p2pHost = new SafeBoxHost(P2P_PORT, state.keyPair);
  state.p2pHost.on('peer-created', peer => {
    console.log(`[SafeBox] Incoming connection from ${peer.remoteAddress}`);
    setupPeerEvents(peer);
  });
  state.p2pHost.on('error', err => {
    console.error('[SafeBox] Host error:', err.message);
  });
  await state.p2pHost.start();
  refreshConnectionCode();
  await new Promise(resolve => {
    httpServer.listen(WEB_PORT, () => {
      console.log(`  ║  Local:  ${state.localIP.padEnd(33)} ║`);
      console.log(`  ║  P2P:    Listening on port ${String(P2P_PORT).padEnd(18)}║`);
      console.log(`  ║  Web UI: http://localhost:${WEB_PORT}                ║`);
      console.log('  ╚═══════════════════════════════════════════╝');
      console.log('');
      resolve();
    });
  });
  wss.on('connection', ws => {
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'accept-file') {
          const transfer = state.activeFileTransfers.get(msg.fileId);
          if (transfer && transfer.buffer) {
            handleFileAcceptForBuffer(msg.fileId);
          }
        }
      } catch (_) {}
    });
  });
  process.on('SIGINT', async () => {
    console.log('\n[SafeBox] Shutting down...');
    if (state.peer) state.peer.disconnect();
    state.p2pHost.stop();
    await state.upnp.removeMapping(P2P_PORT).catch(() => {});
    httpServer.close();
    process.exit(0);
  });
}
module.exports = {
  start,
  WEB_PORT
};
if (require.main === module) {
  start().catch(err => {
    console.error('[SafeBox] Fatal error:', err);
    process.exit(1);
  });
}