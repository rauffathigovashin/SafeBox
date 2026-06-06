'use strict';

const crypto = require('crypto');
const SLOT_DURATION_MS = 3 * 60 * 60 * 1000;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_PAYLOAD_LEN = 12;
function getCurrentSlotIndex() {
  return Math.floor(Date.now() / SLOT_DURATION_MS);
}
function getSlotRemainingMs() {
  const now = Date.now();
  const slotEnd = (Math.floor(now / SLOT_DURATION_MS) + 1) * SLOT_DURATION_MS;
  return slotEnd - now;
}
function generateKeyPair() {
  const {
    publicKey,
    privateKey
  } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: {
      type: 'spki',
      format: 'der'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'der'
    }
  });
  return {
    publicKey,
    privateKey
  };
}
function computeSharedSecret(myPrivateKeyDer, theirPublicKeyDer) {
  const priv = crypto.createPrivateKey({
    key: myPrivateKeyDer,
    format: 'der',
    type: 'pkcs8'
  });
  const pub = crypto.createPublicKey({
    key: theirPublicKeyDer,
    format: 'der',
    type: 'spki'
  });
  return crypto.diffieHellman({
    privateKey: priv,
    publicKey: pub
  });
}
function deriveSessionKey(sharedSecret, salt, info = 'safebox-session-key') {
  if (!salt) salt = Buffer.alloc(32, 0);
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 32));
}
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}
function decrypt(key, packet) {
  const iv = packet.slice(0, 12);
  const tag = packet.slice(12, 28);
  const ct = packet.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
function generateConnectionCode(ip, port, publicKeyDer) {
  const slotIndex = getCurrentSlotIndex();
  const pubKeyHash = crypto.createHash('sha256').update(publicKeyDer).digest().slice(0, 4);
  const payload = Buffer.alloc(CODE_PAYLOAD_LEN);
  payload.writeUInt16BE(slotIndex & 0xFFFF, 0);
  const parts = ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) payload[2 + i] = parts[i] || 0;
  payload.writeUInt16BE(port, 6);
  pubKeyHash.copy(payload, 8);
  const slotKey = crypto.createHash('sha256').update(`SafeBox-Slot-${slotIndex}`).digest();
  const scrambled = Buffer.alloc(CODE_PAYLOAD_LEN);
  for (let i = 0; i < CODE_PAYLOAD_LEN; i++) {
    scrambled[i] = payload[i] ^ slotKey[i % slotKey.length];
  }
  return base32Encode(scrambled);
}
function decodeConnectionCode(code) {
  const scrambled = base32Decode(code);
  if (!scrambled || scrambled.length !== CODE_PAYLOAD_LEN) return null;
  const currentSlot = getCurrentSlotIndex();
  for (const slotIndex of [currentSlot, currentSlot - 1, currentSlot + 1]) {
    const slotKey = crypto.createHash('sha256').update(`SafeBox-Slot-${slotIndex}`).digest();
    const payload = Buffer.alloc(CODE_PAYLOAD_LEN);
    for (let i = 0; i < CODE_PAYLOAD_LEN; i++) {
      payload[i] = scrambled[i] ^ slotKey[i % slotKey.length];
    }
    if ((payload.readUInt16BE(0) & 0xFFFF) === (slotIndex & 0xFFFF)) {
      return {
        ip: `${payload[2]}.${payload[3]}.${payload[4]}.${payload[5]}`,
        port: payload.readUInt16BE(6),
        pubKeyHash: payload.slice(8, 12),
        slotIndex
      };
    }
  }
  return null;
}
function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  while (bits.length % 5 !== 0) bits += '0';
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out.match(/.{1,4}/g).join('-');
}
function base32Decode(str) {
  str = str.replace(/[-\s]/g, '').toUpperCase();
  let bits = '';
  for (const ch of str) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}
module.exports = {
  getCurrentSlotIndex,
  getSlotRemainingMs,
  generateKeyPair,
  computeSharedSecret,
  deriveSessionKey,
  encrypt,
  decrypt,
  generateConnectionCode,
  decodeConnectionCode
};