'use strict';
const AppState = {
  ws: null,
  connected: false,
  currentPage: 'home',
  chatMessages: [],
  unreadCount: 0,
  codeExpiresAt: null,
  timerInterval: null,
  fileTransfers: new Map(),
  typingTimeout: null,
  lastTypingTime: 0,
  pendingOffer: null
};
let rtcPeerConnection = null;
let localStream = null;
let remoteStream = null;
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};
let isAudioMuted = false;
let isVideoMuted = false;

const $ = id => document.getElementById(id);
const dom = {
  navItems: document.querySelectorAll('.nav-item[data-page]'),
  statusDot: $('statusDot'),
  statusLabel: $('statusLabel'),
  disconnectBtn: $('disconnectBtn'),
  chatBadge: $('chatBadge'),
  codeText: $('codeText'),
  copyCodeBtn: $('copyCodeBtn'),
  timerBarFill: $('timerBarFill'),
  timerText: $('timerText'),
  networkLocal: $('networkInfoLocal'),
  networkExt: $('networkInfoExternal'),
  codeInput: $('codeInput'),
  connectBtn: $('connectBtn'),
  connectHint: $('connectHint'),
  connectedOverlay: $('connectedOverlay'),
  connectedInfo: $('connectedInfo'),
  chatMessages: $('chatMessages'),
  chatEmpty: $('chatEmpty'),
  chatInput: $('chatInput'),
  chatSendBtn: $('chatSendBtn'),
  pingIndicator: $('pingIndicator'),
  pingText: $('pingText'),
  startCallBtn: $('startCallBtn'),
  callOverlay: $('callOverlay'),
  localVideo: $('localVideo'),
  remoteVideo: $('remoteVideo'),
  callStatusText: $('callStatusText'),
  activeCallControls: $('activeCallControls'),
  incomingCallControls: $('incomingCallControls'),
  toggleMicBtn: $('toggleMicBtn'),
  toggleVideoBtn: $('toggleVideoBtn'),
  endCallBtn: $('endCallBtn'),
  acceptCallBtn: $('acceptCallBtn'),
  rejectCallBtn: $('rejectCallBtn'),
  dropZone: $('dropZone'),
  fileInput: $('fileInput'),
  browseFilesBtn: $('browseFilesBtn'),
  fileTransfers: $('fileTransfers'),
  incomingFiles: $('incomingFiles'),
  toastContainer: $('toastContainer'),
  pageHome: $('pageHome'),
  pageChat: $('pageChat'),
  pageFiles: $('pageFiles')
};
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  AppState.ws = new WebSocket(`${protocol}//${location.host}`);
  AppState.ws.onopen = () => {
    send('get-status');
  };
  AppState.ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    handleServerMessage(msg);
  };
  AppState.ws.onclose = () => {
    setTimeout(connectWebSocket, 2000);
  };
  AppState.ws.onerror = () => {};
}
function send(type, data) {
  if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN) {
    AppState.ws.send(JSON.stringify({
      type,
      ...data
    }));
  }
}
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'status':
      updateCodeDisplay(msg.data);
      if (msg.data.connected) {
        setConnected(msg.data.remoteAddress);
      }
      break;
    case 'code-update':
      updateCodeDisplay(msg.data);
      break;
    case 'connecting':
      setStatus('connecting', `Connecting to ${msg.data.ip}...`);
      dom.connectHint.textContent = 'Establishing secure connection...';
      dom.connectHint.className = 'connect-hint';
      break;
    case 'connected':
      setConnected(msg.data.remoteAddress);
      showToast('Secure connection established!', 'success');
      break;
    case 'connect-error':
      setStatus('offline', 'Offline');
      dom.connectHint.textContent = msg.data.message;
      dom.connectHint.className = 'connect-hint error';
      showToast(msg.data.message, 'error');
      break;
    case 'disconnected':
      setDisconnected(msg.data.reason);
      break;
    case 'chat-message':
      addChatMessage(msg.data);
      break;
    case 'peer-typing':
      showTypingIndicator();
      break;
    case 'file-offer':
      showIncomingFile(msg.data);
      break;
    case 'file-offered':
      addFileTransfer(msg.data.fileId, msg.data.fileName, msg.data.fileSize, 'sending', 'Waiting for peer...');
      break;
    case 'file-accepted':
      updateFileStatus(msg.data.fileId, 'Sending...');
      break;
    case 'file-rejected':
      updateFileStatus(msg.data.fileId, 'Rejected');
      showToast('File transfer rejected by peer', 'error');
      break;
    case 'file-progress':
      updateFileProgress(msg.data.fileId, msg.data.percent);
      break;
    case 'file-send-complete':
      updateFileComplete(msg.data.fileId, 'Sent ✓');
      showToast('File sent successfully!', 'success');
      break;
    case 'file-receive-complete':
      updateFileComplete(msg.data.fileId, msg.data.verified ? 'Received ✓' : 'Received (unverified)');
      showToast(`File received: ${msg.data.fileName}`, 'success');
      if (isImage(msg.data.fileName)) {
        addChatImage({
          from: 'peer',
          src: `/api/downloads/${encodeURIComponent(msg.data.fileName)}`,
          timestamp: Date.now()
        });
      }
      break;
    case 'rtc-signal':
      handleRtcSignal(msg.data);
      break;
    case 'ping-update':
      updatePing(msg.data.ms);
      break;
    case 'peer-error':
      showToast(`Error: ${msg.data.message}`, 'error');
      break;
    default:
      break;
  }
}
function setStatus(state, label) {
  dom.statusDot.className = `status-dot ${state}`;
  dom.statusLabel.textContent = label;
}
function setConnected(remoteAddress) {
  AppState.connected = true;
  setStatus('online', 'Connected');
  dom.disconnectBtn.classList.remove('hidden');
  dom.connectedOverlay.classList.remove('hidden');
  dom.connectedInfo.textContent = `Connected to ${remoteAddress || 'peer'}`;
  dom.chatInput.disabled = false;
  dom.chatSendBtn.disabled = false;
  dom.startCallBtn.disabled = false;
  setTimeout(() => {
    dom.connectedOverlay.classList.add('hidden');
  }, 3000);
}
function setDisconnected(reason) {
  AppState.connected = false;
  setStatus('offline', 'Offline');
  dom.disconnectBtn.classList.add('hidden');
  dom.connectedOverlay.classList.add('hidden');
  dom.chatInput.disabled = true;
  dom.chatSendBtn.disabled = true;
  dom.startCallBtn.disabled = true;
  if (dom.pingIndicator) dom.pingIndicator.classList.add('hidden');
  endCall(false);
  showToast(reason || 'Disconnected', 'info');
}

function updatePing(ms) {
  if (!dom.pingIndicator) return;
  dom.pingIndicator.classList.remove('hidden');
  dom.pingText.textContent = `${ms} ms`;
  dom.pingIndicator.className = 'ping-indicator';
  if (ms < 100) dom.pingIndicator.classList.add('ping-good');
  else if (ms < 300) dom.pingIndicator.classList.add('ping-warn');
  else dom.pingIndicator.classList.add('ping-bad');
}

function updateCodeDisplay(data) {
  if (data.code) {
    dom.codeText.textContent = data.code;
  }
  if (data.localIP) {
    dom.networkLocal.textContent = `Local IP: ${data.localIP}`;
  }
  if (data.externalIP) {
    dom.networkExt.textContent = `External: ${data.externalIP}`;
  }
  if (data.expiresAt) {
    AppState.codeExpiresAt = data.expiresAt;
    startTimer();
  }
}
function startTimer() {
  if (AppState.timerInterval) clearInterval(AppState.timerInterval);
  AppState.timerInterval = setInterval(() => {
    if (!AppState.codeExpiresAt) return;
    const remaining = AppState.codeExpiresAt - Date.now();
    if (remaining <= 0) {
      dom.timerText.textContent = 'Code resetting...';
      dom.timerBarFill.style.width = '0%';
      return;
    }
    const totalSlot = 3 * 60 * 60 * 1000;
    const percent = remaining / totalSlot * 100;
    dom.timerBarFill.style.width = `${Math.min(100, percent)}%`;
    const hrs = Math.floor(remaining / 3600000);
    const mins = Math.floor(remaining % 3600000 / 60000);
    const secs = Math.floor(remaining % 60000 / 1000);
    dom.timerText.textContent = `Code resets in ${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }, 1000);
}
function pad(n) {
  return String(n).padStart(2, '0');
}
function navigateTo(page) {
  AppState.currentPage = page;
  dom.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === `page${capitalize(page)}`);
  });
  if (page === 'chat') {
    AppState.unreadCount = 0;
    dom.chatBadge.classList.add('hidden');
    scrollChatToBottom();
  }
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function addChatMessage(data) {
  dom.chatEmpty.style.display = 'none';
  const typingEl = document.getElementById('typingIndicator');
  if (typingEl) typingEl.remove();

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${data.from === 'me' ? 'me' : 'peer'}`;
  const time = new Date(data.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  bubble.innerHTML = `${escapeHtml(data.text)}<span class="timestamp">${time}</span>`;
  dom.chatMessages.appendChild(bubble);
  scrollChatToBottom();
  if (AppState.currentPage !== 'chat' && data.from === 'peer') {
    AppState.unreadCount++;
    dom.chatBadge.textContent = AppState.unreadCount;
    dom.chatBadge.classList.remove('hidden');
    showToast(`New message: ${data.text.slice(0, 50)}`, 'info');
  }
}

function isImage(fileName) {
  if (!fileName) return false;
  const ext = fileName.split('.').pop().toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
}

function addChatImage(data) {
  dom.chatEmpty.style.display = 'none';
  const typingEl = document.getElementById('typingIndicator');
  if (typingEl) typingEl.remove();

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${data.from === 'me' ? 'me' : 'peer'}`;
  const time = new Date(data.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  bubble.innerHTML = `
    <div class="chat-image-container">
      <img src="${data.src}" class="chat-image" alt="Image preview" onload="scrollChatToBottom()">
    </div>
    <span class="timestamp">${time}</span>
  `;
  dom.chatMessages.appendChild(bubble);
  scrollChatToBottom();
  
  if (AppState.currentPage !== 'chat' && data.from === 'peer') {
    AppState.unreadCount++;
    dom.chatBadge.textContent = AppState.unreadCount;
    dom.chatBadge.classList.remove('hidden');
    showToast('New image received', 'info');
  }
}
function sendChatMessage() {
  const text = dom.chatInput.value.trim();
  if (!text || !AppState.connected) return;
  send('send-chat', {
    text
  });
  dom.chatInput.value = '';
  dom.chatInput.focus();
}

function showTypingIndicator() {
  let el = document.getElementById('typingIndicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'typingIndicator';
    el.className = 'typing-indicator chat-bubble peer';
    el.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    dom.chatMessages.appendChild(el);
  }
  scrollChatToBottom();
  
  if (AppState.typingTimeout) clearTimeout(AppState.typingTimeout);
  AppState.typingTimeout = setTimeout(() => {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
  }, 3000);
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  });
}
function handleFileDrop(files) {
  if (!AppState.connected) {
    showToast('Connect to a peer first', 'error');
    return;
  }
  for (const file of files) {
    if (isImage(file.name)) {
      addChatImage({
        from: 'me',
        src: URL.createObjectURL(file),
        timestamp: Date.now()
      });
    }

    if (file.path) {
      send('send-file', {
        fileName: file.name,
        filePath: file.path
      });
    } else {
      const reader = new FileReader();
      const fileName = file.name;
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        send('send-file-data', {
          fileName,
          fileData: base64
        });
      };
      reader.onerror = () => {
        showToast(`Failed to read ${fileName}`, 'error');
      };
      reader.readAsDataURL(file);
    }
  }
}
function addFileTransfer(fileId, fileName, fileSize, direction, status) {
  const item = document.createElement('div');
  item.className = 'file-item';
  item.id = `file-${fileId}`;
  item.innerHTML = `
    <div class="file-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    </div>
    <div class="file-info">
      <div class="file-name">${escapeHtml(fileName)}</div>
      <div class="file-size">${formatFileSize(fileSize)}</div>
      <div class="file-progress"><div class="file-progress-fill" style="width:0%"></div></div>
    </div>
    <span class="file-status">${status}</span>
  `;
  dom.fileTransfers.prepend(item);
  AppState.fileTransfers.set(fileId, {
    fileName,
    fileSize,
    direction
  });
}
function showIncomingFile(offer) {
  const item = document.createElement('div');
  item.className = 'file-item';
  item.id = `incoming-${offer.fileId}`;
  item.innerHTML = `
    <div class="file-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </div>
    <div class="file-info">
      <div class="file-name">${escapeHtml(offer.fileName)}</div>
      <div class="file-size">${formatFileSize(offer.fileSize)}</div>
    </div>
    <div class="file-actions">
      <button class="btn btn-sm btn-accept">Accept</button>
      <button class="btn btn-sm btn-reject">Reject</button>
    </div>
  `;
  item.querySelector('.btn-accept').addEventListener('click', () => acceptFile(offer.fileId));
  item.querySelector('.btn-reject').addEventListener('click', () => rejectFile(offer.fileId));
  dom.incomingFiles.prepend(item);
  showToast(`Incoming file: ${offer.fileName}`, 'info');
  if (AppState.currentPage !== 'files') {
    navigateTo('files');
  }
}
function acceptFile(fileId) {
  send('accept-file', {
    fileId
  });
  const el = document.getElementById(`incoming-${fileId}`);
  if (el) el.remove();
  addFileTransfer(fileId, 'Incoming file', 0, 'receiving', 'Receiving...');
}
function rejectFile(fileId) {
  send('reject-file', {
    fileId
  });
  const el = document.getElementById(`incoming-${fileId}`);
  if (el) el.remove();
}
function updateFileProgress(fileId, percent) {
  const el = document.getElementById(`file-${fileId}`);
  if (el) {
    const fill = el.querySelector('.file-progress-fill');
    const status = el.querySelector('.file-status');
    if (fill) fill.style.width = `${percent}%`;
    if (status) status.textContent = `${percent}%`;
  }
}
function updateFileStatus(fileId, status) {
  const el = document.getElementById(`file-${fileId}`);
  if (el) {
    const statusEl = el.querySelector('.file-status');
    if (statusEl) statusEl.textContent = status;
  }
}
function updateFileComplete(fileId, status) {
  const el = document.getElementById(`file-${fileId}`);
  if (el) {
    const statusEl = el.querySelector('.file-status');
    const progressFill = el.querySelector('.file-progress-fill');
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className = 'file-status complete';
    }
    if (progressFill) progressFill.style.width = '100%';
  }
}
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4500);
}
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// --- WebRTC Logic ---
async function startCall() {
  if (!AppState.connected) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    showCallUI('Calling...', true);
    
    rtcPeerConnection = new RTCPeerConnection(rtcConfig);
    
    localStream.getTracks().forEach(track => {
      rtcPeerConnection.addTrack(track, localStream);
    });

    rtcPeerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        send('send-rtc-signal', { type: 'candidate', candidate: event.candidate });
      }
    };

    rtcPeerConnection.ontrack = (event) => {
      remoteStream = event.streams[0];
      dom.remoteVideo.srcObject = remoteStream;
    };

    const offer = await rtcPeerConnection.createOffer();
    await rtcPeerConnection.setLocalDescription(offer);
    send('send-rtc-signal', { type: 'offer', offer });
    
  } catch (err) {
    showToast('Failed to access camera/mic: ' + err.message, 'error');
  }
}

async function handleRtcSignal(data) {
  if (data.type === 'offer') {
    showIncomingCallUI();
    try {
      rtcPeerConnection = new RTCPeerConnection(rtcConfig);
      rtcPeerConnection.onicecandidate = (event) => {
        if (event.candidate) send('send-rtc-signal', { type: 'candidate', candidate: event.candidate });
      };
      rtcPeerConnection.ontrack = (event) => {
        remoteStream = event.streams[0];
        dom.remoteVideo.srcObject = remoteStream;
      };
      await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
      AppState.pendingOffer = data.offer;
    } catch (err) {
      console.error('Error handling offer:', err);
    }
  } else if (data.type === 'answer') {
    if (rtcPeerConnection) {
      await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
      dom.callStatusText.textContent = 'Connected';
    }
  } else if (data.type === 'candidate') {
    if (rtcPeerConnection) {
      try {
        await rtcPeerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Error adding candidate:', err);
      }
    }
  } else if (data.type === 'end') {
    endCall(false);
  }
}

async function acceptCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream.getTracks().forEach(track => {
      rtcPeerConnection.addTrack(track, localStream);
    });

    const answer = await rtcPeerConnection.createAnswer();
    await rtcPeerConnection.setLocalDescription(answer);
    send('send-rtc-signal', { type: 'answer', answer });
    
    showActiveCallUI();
  } catch (err) {
    showToast('Failed to access camera/mic: ' + err.message, 'error');
    rejectCall();
  }
}

function rejectCall() {
  send('send-rtc-signal', { type: 'end' });
  endCall(false);
}

function endCall(sendSignal = true) {
  if (sendSignal && AppState.connected) {
    send('send-rtc-signal', { type: 'end' });
  }
  
  if (rtcPeerConnection) {
    rtcPeerConnection.close();
    rtcPeerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  dom.callOverlay.classList.add('hidden');
  dom.localVideo.srcObject = null;
  dom.remoteVideo.srcObject = null;
  AppState.pendingOffer = null;
}

function showCallUI(statusText, isInitiator) {
  dom.callOverlay.classList.remove('hidden');
  dom.callStatusText.textContent = statusText;
  
  if (localStream) {
    dom.localVideo.srcObject = localStream;
  }

  dom.activeCallControls.style.display = 'flex';
  dom.incomingCallControls.style.display = 'none';
  
  isVideoMuted = false;
  isAudioMuted = false;
  dom.toggleMicBtn.classList.remove('muted');
  dom.toggleVideoBtn.classList.remove('muted');
}

function showIncomingCallUI() {
  dom.callOverlay.classList.remove('hidden');
  dom.callStatusText.textContent = 'Incoming Call...';
  dom.activeCallControls.style.display = 'none';
  dom.incomingCallControls.style.display = 'flex';
  dom.localVideo.srcObject = null;
}

function showActiveCallUI() {
  dom.callStatusText.textContent = 'Connected';
  dom.activeCallControls.style.display = 'flex';
  dom.incomingCallControls.style.display = 'none';
  if (localStream) {
    dom.localVideo.srcObject = localStream;
  }
}

dom.startCallBtn.addEventListener('click', startCall);
dom.acceptCallBtn.addEventListener('click', acceptCall);
dom.rejectCallBtn.addEventListener('click', rejectCall);
dom.endCallBtn.addEventListener('click', () => endCall(true));

dom.toggleMicBtn.addEventListener('click', () => {
  if (localStream) {
    isAudioMuted = !isAudioMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
    dom.toggleMicBtn.classList.toggle('muted', isAudioMuted);
  }
});

dom.toggleVideoBtn.addEventListener('click', () => {
  if (localStream) {
    isVideoMuted = !isVideoMuted;
    localStream.getVideoTracks().forEach(t => t.enabled = !isVideoMuted);
    dom.toggleVideoBtn.classList.toggle('muted', isVideoMuted);
  }
});

dom.navItems.forEach(item => {
  item.addEventListener('click', () => navigateTo(item.dataset.page));
});
dom.copyCodeBtn.addEventListener('click', () => {
  const code = dom.codeText.textContent;
  navigator.clipboard.writeText(code).then(() => {
    dom.copyCodeBtn.classList.add('copied');
    showToast('Code copied to clipboard!', 'success');
    setTimeout(() => dom.copyCodeBtn.classList.remove('copied'), 1500);
  });
});
dom.connectBtn.addEventListener('click', () => {
  const code = dom.codeInput.value.trim();
  if (!code) {
    dom.connectHint.textContent = 'Please enter a connection code';
    dom.connectHint.className = 'connect-hint error';
    return;
  }
  send('connect', {
    code
  });
  dom.connectHint.textContent = '';
});
dom.codeInput.addEventListener('keypress', e => {
  if (e.key === 'Enter') dom.connectBtn.click();
});
dom.disconnectBtn.addEventListener('click', () => {
  send('disconnect');
});
dom.chatSendBtn.addEventListener('click', sendChatMessage);
dom.chatInput.addEventListener('keypress', e => {
  if (e.key === 'Enter') sendChatMessage();
});
dom.chatInput.addEventListener('input', () => {
  if (!AppState.connected) return;
  const now = Date.now();
  if (now - AppState.lastTypingTime > 2000) {
    send('send-typing');
    AppState.lastTypingTime = now;
  }
});
dom.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dom.dropZone.classList.add('dragover');
});
dom.dropZone.addEventListener('dragleave', () => {
  dom.dropZone.classList.remove('dragover');
});
dom.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dom.dropZone.classList.remove('dragover');
  handleFileDrop(e.dataTransfer.files);
});
dom.browseFilesBtn.addEventListener('click', () => {
  dom.fileInput.click();
});
dom.fileInput.addEventListener('change', e => {
  handleFileDrop(e.target.files);
  e.target.value = '';
});
dom.connectedOverlay.addEventListener('click', () => {
  dom.connectedOverlay.classList.add('hidden');
});
connectWebSocket();