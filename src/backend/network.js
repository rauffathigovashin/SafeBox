'use strict';

const net = require('net');
const crypto = require('crypto');
const cryptoHelper = require('./crypto-helper');
const EventEmitter = require('events');
const MSG = {
  HANDSHAKE_INIT: 0x01,
  HANDSHAKE_ACCEPT: 0x02,
  HANDSHAKE_VERIFY: 0x03,
  HANDSHAKE_COMPLETE: 0x04,
  CHAT_MESSAGE: 0x10,
  FILE_OFFER: 0x20,
  FILE_ACCEPT: 0x21,
  FILE_REJECT: 0x22,
  FILE_CHUNK: 0x23,
  FILE_COMPLETE: 0x24,
  HEARTBEAT_PING: 0x30,
  HEARTBEAT_PONG: 0x31,
  DISCONNECT: 0xF0
};
const MAX_FRAME_SIZE = 50 * 1024 * 1024;
function buildFrame(type, payload) {
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const frame = Buffer.alloc(4 + 1 + payloadBuf.length);
  frame.writeUInt32BE(1 + payloadBuf.length, 0);
  frame[4] = type;
  payloadBuf.copy(frame, 5);
  return frame;
}
class SafeBoxPeer extends EventEmitter {
  constructor(socket, isHost, myKeyPair, expectedPubKeyHash) {
    super();
    this.socket = socket;
    this.isHost = isHost;
    this.myKeyPair = myKeyPair;
    this.expectedPubKeyHash = expectedPubKeyHash;
    this.sessionKey = null;
    this.peerPublicKey = null;
    this.connected = false;
    this.remoteAddress = socket.remoteAddress;
    this.remotePort = socket.remotePort;
    this._recvBuf = Buffer.alloc(0);
    this._heartbeatInterval = null;
    this._heartbeatTimeout = null;
    socket.setKeepAlive(true, 10000);
    socket.setNoDelay(true);
    socket.on('data', data => this._onData(data));
    socket.on('close', () => this._onClose());
    socket.on('error', err => this._onError(err));
  }
  _sendRaw(type, payload) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(buildFrame(type, payload));
    }
  }
  sendEncrypted(type, payload) {
    if (!this.sessionKey) return;
    const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    const typeBuf = Buffer.alloc(1);
    typeBuf[0] = type;
    const combined = Buffer.concat([typeBuf, plaintext]);
    const encrypted = cryptoHelper.encrypt(this.sessionKey, combined);
    this._sendRaw(0xFF, encrypted);
  }
  _onData(data) {
    this._recvBuf = Buffer.concat([this._recvBuf, data]);
    while (this._recvBuf.length >= 4) {
      const frameLen = this._recvBuf.readUInt32BE(0);
      if (frameLen > MAX_FRAME_SIZE) {
        this.emit('error', new Error(`Frame length ${frameLen} exceeds MAX_FRAME_SIZE ${MAX_FRAME_SIZE}`));
        this.disconnect();
        return;
      }
      if (this._recvBuf.length < 4 + frameLen) break;
      const type = this._recvBuf[4];
      const payload = this._recvBuf.slice(5, 4 + frameLen);
      this._recvBuf = this._recvBuf.slice(4 + frameLen);
      this._handleFrame(type, payload);
    }
  }
  _handleFrame(type, payload) {
    try {
      if (type === 0xFF && this.sessionKey) {
        const decrypted = cryptoHelper.decrypt(this.sessionKey, payload);
        const innerType = decrypted[0];
        const innerPayload = decrypted.slice(1);
        this._handleDecryptedMessage(innerType, innerPayload);
        return;
      }
      switch (type) {
        case MSG.HANDSHAKE_INIT:
          this._onHandshakeInit(payload);
          break;
        case MSG.HANDSHAKE_ACCEPT:
          this._onHandshakeAccept(payload);
          break;
        default:
          break;
      }
    } catch (err) {
      this.emit('error', err);
      this.disconnect();
    }
  }
  _handleDecryptedMessage(type, payload) {
    switch (type) {
      case MSG.HANDSHAKE_VERIFY:
        this._onHandshakeVerify(payload);
        break;
      case MSG.HANDSHAKE_COMPLETE:
        this._onHandshakeComplete(payload);
        break;
      case MSG.CHAT_MESSAGE:
        this.emit('chat', JSON.parse(payload.toString()));
        break;
      case MSG.FILE_OFFER:
        this.emit('file-offer', JSON.parse(payload.toString()));
        break;
      case MSG.FILE_ACCEPT:
        this.emit('file-accept', JSON.parse(payload.toString()));
        break;
      case MSG.FILE_REJECT:
        this.emit('file-reject', JSON.parse(payload.toString()));
        break;
      case MSG.FILE_CHUNK:
        this.emit('file-chunk', payload);
        break;
      case MSG.FILE_COMPLETE:
        this.emit('file-complete', JSON.parse(payload.toString()));
        break;
      case MSG.HEARTBEAT_PING:
        this.sendEncrypted(MSG.HEARTBEAT_PONG, Buffer.alloc(0));
        break;
      case MSG.HEARTBEAT_PONG:
        this._onHeartbeatPong();
        break;
      case MSG.DISCONNECT:
        this.emit('peer-disconnect');
        this._cleanup();
        break;
      default:
        break;
    }
  }
  initiateHandshake() {
    this._sendRaw(MSG.HANDSHAKE_INIT, this.myKeyPair.publicKey);
  }
  _onHandshakeInit(clientPubKey) {
    this.peerPublicKey = clientPubKey;
    this._sendRaw(MSG.HANDSHAKE_ACCEPT, this.myKeyPair.publicKey);
    const shared = cryptoHelper.computeSharedSecret(this.myKeyPair.privateKey, clientPubKey);
    this.sessionKey = cryptoHelper.deriveSessionKey(shared);
  }
  _onHandshakeAccept(hostPubKey) {
    this.peerPublicKey = hostPubKey;
    if (this.expectedPubKeyHash) {
      const actualHash = crypto.createHash('sha256').update(hostPubKey).digest().slice(0, 4);
      if (!actualHash.equals(this.expectedPubKeyHash)) {
        this.emit('error', new Error('MITM DETECTED: Host public key does not match connection code'));
        this.disconnect();
        return;
      }
    }
    const shared = cryptoHelper.computeSharedSecret(this.myKeyPair.privateKey, hostPubKey);
    this.sessionKey = cryptoHelper.deriveSessionKey(shared);
    const token = crypto.randomBytes(32);
    this._verifyToken = token;
    this.sendEncrypted(MSG.HANDSHAKE_VERIFY, token);
  }
  _onHandshakeVerify(payload) {
    this.sendEncrypted(MSG.HANDSHAKE_COMPLETE, payload);
    this.connected = true;
    this._startHeartbeat();
    this.emit('connected');
  }
  _onHandshakeComplete(payload) {
    this.connected = true;
    this._startHeartbeat();
    this.emit('connected');
  }
  _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      if (!this.connected) return;
      this.sendEncrypted(MSG.HEARTBEAT_PING, Buffer.alloc(0));
      this._heartbeatTimeout = setTimeout(() => {
        this.emit('heartbeat-timeout');
        this.disconnect();
      }, 15000);
    }, 30000);
  }
  _onHeartbeatPong() {
    if (this._heartbeatTimeout) {
      clearTimeout(this._heartbeatTimeout);
      this._heartbeatTimeout = null;
    }
  }
  sendChat(text) {
    this.sendEncrypted(MSG.CHAT_MESSAGE, {
      text,
      timestamp: Date.now()
    });
  }
  sendFileOffer(fileId, fileName, fileSize) {
    this.sendEncrypted(MSG.FILE_OFFER, {
      fileId,
      fileName,
      fileSize
    });
  }
  sendFileAccept(fileId) {
    this.sendEncrypted(MSG.FILE_ACCEPT, {
      fileId
    });
  }
  sendFileReject(fileId) {
    this.sendEncrypted(MSG.FILE_REJECT, {
      fileId
    });
  }
  sendFileChunk(data) {
    this.sendEncrypted(MSG.FILE_CHUNK, data);
  }
  sendFileComplete(fileId, hash) {
    this.sendEncrypted(MSG.FILE_COMPLETE, {
      fileId,
      hash
    });
  }
  disconnect() {
    if (this.sessionKey && this.connected) {
      try {
        this.sendEncrypted(MSG.DISCONNECT, Buffer.alloc(0));
      } catch (_) {}
    }
    this._cleanup();
  }
  _cleanup() {
    this.connected = false;
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this._heartbeatTimeout) clearTimeout(this._heartbeatTimeout);
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.emit('disconnected');
  }
  _onClose() {
    if (this.connected) {
      this.connected = false;
      if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
      if (this._heartbeatTimeout) clearTimeout(this._heartbeatTimeout);
      this.emit('disconnected');
    }
  }
  _onError(err) {
    this.emit('error', err);
    this._cleanup();
  }
}
class SafeBoxHost extends EventEmitter {
  constructor(port, keyPair) {
    super();
    this.port = port;
    this.keyPair = keyPair;
    this.server = null;
    this.peer = null;
  }
  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(socket => {
        if (this.peer && this.peer.connected) {
          socket.destroy();
          return;
        }
        this.peer = new SafeBoxPeer(socket, true, this.keyPair, null);
        this.emit('peer-created', this.peer);
      });
      this.server.on('error', err => {
        this.emit('error', err);
        reject(err);
      });
      this.server.listen(this.port, '0.0.0.0', () => {
        this.emit('listening', this.port);
        resolve(this.port);
      });
    });
  }
  stop() {
    if (this.peer) this.peer.disconnect();
    if (this.server) this.server.close();
  }
}
function connectToHost(ip, port, myKeyPair, expectedPubKeyHash) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: ip,
      port
    }, () => {
      socket.setTimeout(0);
      const peer = new SafeBoxPeer(socket, false, myKeyPair, expectedPubKeyHash);
      peer.initiateHandshake();
      resolve(peer);
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}
module.exports = {
  SafeBoxPeer,
  SafeBoxHost,
  connectToHost,
  MSG
};