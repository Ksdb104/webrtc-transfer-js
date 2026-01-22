// 全局变量
let socket = null;
let currentRoom = null;
let isHost = false;
let peerConnections = new Map();
let dataChannels = new Map();
let localFiles = new Map();
let receivedFiles = new Map();
let compressionEnabled = true;
let transferStatusPanel = null;

// ICE 服务器配置
const ICE_SERVERS = [
    { urls: 'stun:stun.cloudflare.com:3478' }, // Cloudflare STUN（更稳定）
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'stun:holu.huan-yue.org:3478',
      username: 'yang',
      credential: '7691cc4d6cfd4bde8d367aed4706177d',
    },
    {
      urls: 'turn:holu.huan-yue.org:3478',
      username: 'yang',
      credential: '7691cc4d6cfd4bde8d367aed4706177d',
    },
];

// 压缩/解压缩工具
class CompressionUtil {
  static async compress(data) {
    if (!compressionEnabled) return data;

    try {
      const stream = new Response(data).body.pipeThrough(
        new CompressionStream("gzip")
      );
      return await new Response(stream).arrayBuffer();
    } catch (error) {
      console.warn("压缩失败，使用原始数据:", error);
      return data;
    }
  }

  static async decompress(data) {
    if (!compressionEnabled) return data;

    try {
      const stream = new Response(data).body.pipeThrough(
        new DecompressionStream("gzip")
      );
      return await new Response(stream).arrayBuffer();
    } catch (error) {
      console.warn("解压缩失败，使用原始数据:", error);
      return data;
    }
  }
}

// 文件传输管理器
class FileTransferManager {
  constructor() {
    this.activeTransfers = new Map();
    this.chunkSize = 16 * 1024;
    this.chunkAcks = new Map(); // 存储已确认的分块：transferId → Set(chunkIndex)
    this.retryQueue = new Map(); // 重传队列：transferId → [chunkIndex]

    this.maxBufferSize = 1024 * 1024; // 最大缓冲阈值（1MB）
  }

  async sendFile(file, targetUserId, fileId) {
    const transferId = `${Date.now()}-${file.name}`;
    const chunkSize = this.chunkSize;
    // 使用 file.size 而非读取 arrayBuffer
    const totalChunks = Math.ceil(file.size / chunkSize);

    // 初始化传输信息
    this.activeTransfers.set(transferId, {
      file,
      targetUserId,
      totalChunks,
      startTime: Date.now(),
      bytesSent: 0,
      completedChunks: 0,
      currentChunkIndex: 0,
      paused: false,
    });

    this.showNotification(`开始传输 "${file.name}"`);

    // 发送文件信息
    this.sendMessage(targetUserId, {
      type: "file-info",
      payload: {
        id: transferId,
        name: file.name,
        size: file.size,
        type: file.type,
        fileId: fileId,
        totalChunks,
        chunkSize: this.chunkSize,
      },
    });

    // 启动流式发送
    this.sendNextChunk(transferId);
  }

  async sendNextChunk(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer || transfer.paused) return;

    // 检查通道状态
    const dataChannel = dataChannels.get(transfer.targetUserId);
    if (!dataChannel || dataChannel.readyState !== "open") {
      // 如果通道未打开，等待
      setTimeout(() => this.sendNextChunk(transferId), 100);
      return;
    }

    // 检查背压 (Backpressure)
    if (dataChannel.bufferedAmount > this.maxBufferSize) {
      setTimeout(() => this.sendNextChunk(transferId), 10);
      return;
    }

    if (transfer.currentChunkIndex < transfer.totalChunks) {
      try {
        await this.readAndSendChunk(transferId, transfer.currentChunkIndex);

        // 更新状态
        transfer.currentChunkIndex++;
        transfer.completedChunks++;
        this.updateTransferProgress(
          transferId,
          "sending",
          transfer.targetUserId
        );

        // 继续发送下一块 (使用 setTimeout 0 让出主线程)
        setTimeout(() => this.sendNextChunk(transferId), 0);
      } catch (error) {
        console.error("发送分块错误:", error);
        // 这里可以添加重试逻辑，或者等待 ACK 机制里的 NACK 来触发重传
        // 简单起见，如果读取失败，我们可能需要暂停或重试当前块
      }
    } else {
      // 发送完毕，等待确认
      this.checkCompletion(transferId);
    }
  }

  async readAndSendChunk(transferId, chunkIndex) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return;

    const start = chunkIndex * this.chunkSize;
    const end = Math.min(start + this.chunkSize, transfer.file.size);

    // 关键：只读取当前分块
    const blob = transfer.file.slice(start, end);
    const arrayBuffer = await blob.arrayBuffer();

    let transferChunk = arrayBuffer;
    if (compressionEnabled) {
      transferChunk = await CompressionUtil.compress(arrayBuffer);
    }
    const base64Data = arrayBufferToBase64(transferChunk);

    this.sendMessage(transfer.targetUserId, {
      type: "file-chunk",
      payload: {
        transferId,
        chunkIndex,
        data: base64Data,
        isLast: chunkIndex === transfer.totalChunks - 1,
      },
    });
    // 增加已发送字节数
    transfer.bytesSent += arrayBuffer.byteLength;
  }

  // 重新实现 sendNextChunk 调用 readAndSendChunkWithId

  async checkCompletion(transferId) {
    const checkAllAcked = () => {
      const acks = this.chunkAcks.get(transferId);
      const transfer = this.activeTransfers.get(transferId);
      if (!acks || !transfer) return false;
      return acks.size === transfer.totalChunks;
    };

    const maxWaitTime = 30000; // 30s 触发一次重传检查
    const checkInterval = 1000;
    let waited = 0;
    let retryCount = 0;

    const checkTimer = setInterval(() => {
      const transfer = this.activeTransfers.get(transferId);
      if (!transfer) {
          clearInterval(checkTimer);
          return;
      }

      if (checkAllAcked()) {
        clearInterval(checkTimer);
        this.activeTransfers.delete(transferId);
        this.chunkAcks.delete(transferId);
        this.showNotification("文件发送完成");
      } else {
        waited += checkInterval;

        // 每 5 秒重发最后一块作为 Keep-Alive / 催促信号
        if (waited % 5000 === 0 && transfer.totalChunks > 0) {
            this.readAndSendChunk(transferId, transfer.totalChunks - 1)
                .catch(e => console.error("Keep-alive 重发失败", e));
        }

        if (waited >= maxWaitTime) {
            console.warn(`发送超时 (重试 ${retryCount + 1}/3)，执行主动重传检查`);
            this.retryUnackedChunks(transferId);
            
            waited = 0;
            retryCount++;
            
            if (retryCount >= 3) {
                clearInterval(checkTimer);
                this.showNotification("传输最终超时，部分分块未确认", "error");
                this.activeTransfers.delete(transferId);
                this.chunkAcks.delete(transferId);
            }
        }
      }
    }, checkInterval);
  }

  retryUnackedChunks(transferId) {
      const transfer = this.activeTransfers.get(transferId);
      const acks = this.chunkAcks.get(transferId) || new Set();
      if (!transfer) return;
      
      let missingCount = 0;
      for (let i = 0; i < transfer.totalChunks; i++) {
          if (!acks.has(i)) {
              if (!this.retryQueue.has(transferId)) {
                  this.retryQueue.set(transferId, []);
              }
              const queue = this.retryQueue.get(transferId);
              if (!queue.includes(i)) {
                   queue.push(i);
                   missingCount++;
              }
          }
      }
      
      if (missingCount > 0) {
          console.log(`主动触发重传: ${missingCount} 个分块`);
          this.retryChunks(transferId, transfer.targetUserId);
      }
  }

  async handleFileInfo(info, senderId) {
    const transferId = info.id;

    // 尝试使用 File System Access API
    let fileHandle = null;
    let writableStream = null;
    let useFileSystem = false;

    console.log(window.showSaveFilePicker)
    if (window.showSaveFilePicker) {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: info.name,
        });
        writableStream = await fileHandle.createWritable();
        useFileSystem = true;
        this.showNotification("使用流式写入模式接收文件");
      } catch (err) {
        console.warn("用户取消或不支持文件保存对话框，回退到内存模式:", err);
      }
    }

    receivedFiles.set(transferId, {
      info,
      chunks: useFileSystem ? [] : new Array(info.totalChunks), // 如果用 FS，就不存 chunks 了
      receivedChunks: 0,
      startTime: Date.now(),
      bytesReceived: 0,
      senderId: senderId,
      useFileSystem,
      writableStream,
      fileHandle,
      writtenChunks: new Set(), // 记录已写入的 chunkIndex，防止重复写入
    });

    console.log(info);
    const fileElement = document.getElementById(`file-${info.fileId}`);
    if (fileElement) {
      const downbtn = fileElement.querySelector(".btn-primary");
      const preparbtn = fileElement.querySelector(".btn-back");
      if (preparbtn) preparbtn.style.display = "none";
      if (downbtn) downbtn.style.display = "block";
    }
    this.updateTransferProgress(transferId, "receiving", senderId, info.name);
  }

  async handleFileChunk(chunkData, senderId) {
    const { transferId, chunkIndex, data, isLast } = chunkData;
    const fileData = receivedFiles.get(transferId);

    if (!fileData) {
      // 可能是之前的传输残留，发送 NACK
      this.sendMessage(senderId, {
        type: "chunk-ack",
        payload: { transferId, chunkIndex, success: false },
      });
      return;
    }

    try {
      const chunkBuffer = base64ToArrayBuffer(data);
      let decompressedData = chunkBuffer;
      if (compressionEnabled) {
        decompressedData = await CompressionUtil.decompress(chunkBuffer);
      }

      // console.log(fileData.useFileSystem)
      // console.log(fileData.writableStream)
      if (fileData.useFileSystem && fileData.writableStream) {
        // 直接写入文件流
        // 注意：WebRTC 保证有序，但重传可能乱序。FileSystemWritableFileStream 支持 seek。
        // 实际上 createWritable() 返回的是 FileSystemWritableFileStream
        // 我们可以用 write({ type: 'write', position: offset, data: buffer })

        console.log('数据流模式')
        const offset = chunkIndex * fileData.info.chunkSize;
        await fileData.writableStream.write({
          type: "write",
          position: offset,
          data: decompressedData,
        });

        // 释放内存
        fileData.writtenChunks.add(chunkIndex);
      } else {
        // 内存模式
        fileData.chunks[chunkIndex] = decompressedData;
      }

      fileData.receivedChunks++;
      fileData.bytesReceived += decompressedData.byteLength;

      // 发送确认
      this.sendMessage(senderId, {
        type: "chunk-ack",
        payload: { transferId, chunkIndex, success: true },
      });

      this.updateTransferProgress(transferId, "receiving", senderId);

        if (isLast || fileData.receivedChunks === fileData.info.totalChunks) {
             // 收到最后一块或数量够了，触发组装（内部会检查完整性）
             await this.assembleFile(transferId);
        }
    } catch (err) {
      console.error("处理分块失败:", err);
      this.sendMessage(senderId, {
        type: "chunk-ack",
        payload: { transferId, chunkIndex, success: false },
      });
    }
  }

  handleChunkAck(ackData, senderId) {
    const { transferId, chunkIndex, success } = ackData;
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return;

    if (success) {
      if (!this.chunkAcks.has(transferId)) {
        this.chunkAcks.set(transferId, new Set());
      }
      this.chunkAcks.get(transferId).add(chunkIndex);
    } else {
      // NACK 收到，加入重传
      if (!this.retryQueue.has(transferId)) {
        this.retryQueue.set(transferId, []);
      }
      this.retryQueue.get(transferId).push(chunkIndex);
      this.retryChunks(transferId, senderId);
    }
  }

  async retryChunks(transferId, targetUserId) {
    const transfer = this.activeTransfers.get(transferId);
    const retryChunks = this.retryQueue.get(transferId) || [];
    if (!transfer || retryChunks.length === 0) return;

    const dataChannel = dataChannels.get(targetUserId);
    if (!dataChannel || dataChannel.readyState !== "open") {
      setTimeout(() => this.retryChunks(transferId, targetUserId), 100);
      return;
    }

    if (dataChannel.bufferedAmount > this.maxBufferSize) {
      setTimeout(() => this.retryChunks(transferId, targetUserId), 10);
      return;
    }

    const chunkIndex = retryChunks.shift();
    // 使用新的流式发送逻辑进行重传
    try {
      await this.readAndSendChunk(transferId, chunkIndex);
    } catch (err) {
      console.error("重传失败:", err);
      retryChunks.unshift(chunkIndex);
    }

    if (retryChunks.length > 0) {
      setTimeout(() => this.retryChunks(transferId, targetUserId), 10);
    }
  }

  async assembleFile(transferId) {
    const fileData = receivedFiles.get(transferId);
    if (!fileData) return;

    // 检查缺失
    const missingChunks = [];
    for (let i = 0; i < fileData.info.totalChunks; i++) {
      if (fileData.useFileSystem) {
        if (!fileData.writtenChunks.has(i)) missingChunks.push(i);
      } else {
        if (!fileData.chunks[i]) missingChunks.push(i);
      }
    }

    if (missingChunks.length > 0) {
      this.showNotification(`发现${missingChunks.length}个缺失分块，请求重传`);
      this.sendMessage(fileData.senderId, {
        type: "request-retransmit",
        payload: { transferId, missingChunks },
      });
      setTimeout(() => this.assembleFile(transferId), 3000);
      return;
    }

    // 完成
    if (fileData.useFileSystem) {
      try {
        await fileData.writableStream.close();
        this.showNotification(`文件 "${fileData.info.name}" 已保存！`);
      } catch (err) {
        console.error("关闭文件流失败:", err);
        this.showNotification("文件保存出错", "error");
      }
    } else {
      // 内存模式组装 (旧逻辑，但加上 try-catch)
      try {
        const blob = new Blob(fileData.chunks, { type: fileData.info.type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileData.info.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.showNotification(`文件 "${fileData.info.name}" 下载完成！`);
      } catch (err) {
        console.error("内存组装失败:", err);
        this.showNotification("文件过大，内存组装失败", "error");
      }
    }

    receivedFiles.delete(transferId);
  }

  updateTransferProgress(transferId, type, senderId, fileName = "") {
    const transfer =
      this.activeTransfers.get(transferId) || receivedFiles.get(transferId);
    if (!transfer) return;

    let progress;
    if (type === "preparing") {
      // 预处理进度
      progress = (transfer.processedChunks / transfer.totalChunks) * 100;
    } else if (type == "stopped") {
      progress = 100;
    } else {
      // 原有传输进度逻辑
      progress =
        type === "sending"
          ? (transfer.completedChunks / transfer.totalChunks) * 100
          : (transfer.receivedChunks / transfer.info.totalChunks) * 100;
    }

    const elapsedTime = (Date.now() - transfer.startTime) / 1000;
    const bytesProcessed =
      type === "sending" ? transfer.bytesSent : transfer.bytesReceived;
    const speed =
      elapsedTime > 0 ? bytesProcessed / elapsedTime / 1024 / 1024 : 0;

    this.updateTransferStatusPanel(
      fileName || transfer.file?.name || transfer.info?.name,
      progress,
      speed,
      type,
      senderId
    );
  }

  updateTransferStatusPanel(fileName, progress, speed, type, senderId) {
    if (!transferStatusPanel) return;

    // 显示传输面板
    transferStatusPanel.style.display = "block";

    // 生成唯一的传输项ID
    const transferItemId = `transfer-${type}-${fileName.replace(
      /\s+/g,
      "-"
    )}-${senderId}`;

    // 创建或更新传输项
    let transferItem = document.getElementById(transferItemId);
    if (!transferItem) {
      transferItem = document.createElement("div");
      transferItem.className = "transfer-item";
      transferItem.id = transferItemId;
      transferStatusPanel.appendChild(transferItem);
    }

    let showType = "";

    if (type == "sending") {
      showType = "发送中";
    } else if (type == "preparing") {
      showType = "准备中";
    } else if (type == "stopped") {
      showType = "传输失败";
    } else {
      showType = "接收中";
    }

    // 更新传输项内容
    transferItem.innerHTML = `
      <div class="transfer-item-header">
        <div class="transfer-item-name" title="${fileName}">${fileName}</div>
        <div class="transfer-item-status">${showType}</div>
      </div>
      <div class="transfer-item-progress">
        <div class="transfer-item-progress-fill" style="width: ${progress}%"></div>
      </div>
      ${
        type == "preparing" || type == "stopped"
          ? ""
          : `<div class="transfer-item-speed">${speed.toFixed(
              2
            )} MB/s (${progress.toFixed(1)}%)</div>`
      }
    `;

    // 如果传输完成，更新状态并稍后移除
    if (progress >= 100) {
      setTimeout(() => {
        const statusEl = transferItem.querySelector(".transfer-item-status");
        if (statusEl && type != "stopped") statusEl.textContent = "已完成";

        // 3秒后移除传输项
        setTimeout(() => {
          if (transferItem && transferItem.parentNode) {
            transferItem.parentNode.removeChild(transferItem);

            // 如果没有其他传输项，隐藏传输面板
            if (transferStatusPanel.children.length === 0) {
              transferStatusPanel.style.display = "none";
            }
          }
        }, 3000);
      }, 10);
    }
  }

  showNotification(message, type = "success") {
    // 简单的通知实现
    const notification = document.createElement("div");
    notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 1rem 2rem;
            background: ${type === "success" ? "#4CAF50" : "#F44336"};
            color: white;
            border-radius: 10px;
            z-index: 1001;
            animation: slideIn 0.3s ease;
        `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }

  sendMessage(targetUserId, message) {
    const dataChannel = dataChannels.get(targetUserId);
    if (dataChannel && dataChannel.readyState === "open") {
      dataChannel.send(JSON.stringify(message));
    } else if (!dataChannel) {
      //通道意外关闭
      console.log(message);
      this.updateTransferProgress(
        message.payload.transferId,
        "stopped",
        targetUserId
      );
    } else {
      console.warn("Data channel 未就绪，消息未发送:", targetUserId);
      // 可以在这里添加消息队列机制
    }
  }

  handleRetransmitRequest(request, senderId) {
    const { transferId, missingChunks } = request;
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) {
      console.error("传输记录不存在，无法重传:", transferId);
      return;
    }

    // 将缺失分块加入重传队列
    if (!this.retryQueue.has(transferId)) {
      this.retryQueue.set(transferId, []);
    }
    this.retryQueue.get(transferId).push(...missingChunks);

    // 立即触发重传
    this.retryChunks(transferId, senderId);
  }
}

// 初始化文件传输管理器
const fileTransferManager = new FileTransferManager();

// 修正后的 ArrayBuffer ↔ Base64 工具函数（避免边界错误）
function arrayBufferToBase64(buffer) {
  if (!buffer || buffer.byteLength === 0) return "";
  const bytes = new Uint8Array(buffer);
  return btoa(String.fromCharCode(...bytes)); // 扩展运算符更简洁，避免循环错误
}

function base64ToArrayBuffer(base64) {
  if (!base64) return new ArrayBuffer(0);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch (e) {
    console.error("Base64 解码失败:", e);
    return new ArrayBuffer(0);
  }
}

// 初始化 Socket.IO 连接
function initSocket() {
  socket = io();

  socket.on("connect", () => {
    console.log("连接到服务器:", socket.id);
  });

  socket.on("room-created", (data) => {
    if (data.success) {
      currentRoom = data.roomCode;
      isHost = data.isHost;
      showRoomPage();
      updateRoomInfo();
    } else {
      alert("创建房间失败: " + data.error);
    }
  });

  socket.on("room-joined", (data) => {
    console.log("joined", data);
    if (data.success) {
      currentRoom = data.roomCode;
      isHost = data.isHost;
      showRoomPage();
      updateRoomInfo();
      createPeerConnection(data.host.id);
      // 构建完整的用户列表（包括主持人）
      const allUsers = [];
      if (data.host) {
        allUsers.push(data.host);
      }
      if (data.users) {
        allUsers.push(...data.users);
      }
      updateUserList(allUsers);

      updateFileList(data.files || []);
    } else {
      alert("加入房间失败: " + data.error);
    }
  });

  socket.on("user-joined", (user) => {
    console.log("join");
    addUserToList(user);
    // 如果是主持人，向新用户建立 WebRTC 连接
    if (isHost) {
      // setTimeout(() => {
      createPeerConnection(user.id);
      // }, 1000);
    }
  });

  socket.on("user-left", (data) => {
    removeUserFromList(data.userId);
    cleanupPeerConnection(data.userId);
  });

  socket.on("host-disconnected", () => {
    alert("主持人已离开房间，房间已关闭");
    showHome();
  });

  socket.on("file-added", (fileInfo) => {
    addFileToList(fileInfo);
  });

  socket.on("file-removed", (data) => {
    removeFileFromList(data.fileId);
  });

  socket.on("webrtc-signal", (data) => {
    console.log("接到信令通信", data);
    handleWebRTCSignal(data);
  });

  socket.on("file-request", (data) => {
    // 延迟处理文件请求，确保data channel就绪
    setTimeout(() => {
      handleFileRequest(data);
    }, 500);
  });

  socket.on("disconnect", () => {
    console.log("与服务器断开连接");
  });

  // 初始化传输状态面板
  initializeTransferStatusPanel();
}

// WebRTC 相关函数
function createPeerConnection(targetUserId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(targetUserId, pc);

  if (isHost) {
    // 创建数据通道
    const dataChannel = pc.createDataChannel("fileTransfer", {
      ordered: true, // 确保分块顺序
      maxRetransmitTime: 3000, // 最大重传时间
      maxRetransmits: 5, // 最大重传次数
    });

    setupDataChannel(dataChannel, targetUserId);
  } else {
    // 应答方：监听发起方创建的 DataChannel
    pc.ondatachannel = (event) => {
      const dataChannel = event.channel;
      console.log("应答方接收 DataChannel:", dataChannel.label);
      setupDataChannel(dataChannel, targetUserId);
    };
  }

  // ICE 候选处理
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-signal", {
        target: targetUserId,
        signal: { ice: event.candidate },
        roomCode: currentRoom,
      });
    } else {
      console.log("ICE 候选收集完成");
    }
  };

  // 连接状态监控
  pc.onconnectionstatechange = () => {
    console.log(`连接状态 (${targetUserId}):`, pc.connectionState);
    console.log(
      "连接状态:",
      pc.connectionState,
      "SDP 状态:",
      pc.signalingState
    );
  };
  pc.oniceconnectionstatechange = () => {
    console.log("ICE 状态:", pc.iceConnectionState);
    // 目标状态：connected/completed
  };

  // 如果是主持人，创建 offer
  if (isHost) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit("webrtc-signal", {
          target: targetUserId,
          signal: { sdp: pc.localDescription },
          roomCode: currentRoom,
        });
      })
      .catch((error) => console.error("创建 offer 失败:", error));
  }

  return pc;
}

function setupDataChannel(dataChannel, userId) {
  dataChannels.set(userId, dataChannel);

  dataChannel.onopen = () => {
    console.log(`Data channel 已打开 (${userId})`);
    console.log("Data channel", dataChannel);
    updateConnectionStatus(userId, "connected");
  };

  dataChannel.onclose = () => {
    console.log(`Data channel 已关闭 (${userId})`);
    console.log("Data channel", dataChannel);
    dataChannels.delete(userId);
    updateConnectionStatus(userId, "disconnected");

    //通道意外关闭则停止通讯
    fileTransferManager.showNotification("通道意外关闭，传输失败", "error");
    // 1. 筛选所有ID包含keyword的元素（返回NodeList）
    const targetElements = document.querySelectorAll(`[id*="${userId}"]`);

    // 2. 遍历删除（forEach支持NodeList）
    targetElements.forEach((element) => {
      element.remove();
    });

    if (transferStatusPanel.children.length === 0) {
      transferStatusPanel.style.display = "none";
    }
  };

  dataChannel.onerror = (error) => {
    console.error(`Data channel 错误 (${userId}):`, error);
    updateConnectionStatus(userId, "error");
  };

  dataChannel.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleDataChannelMessage(message, userId);
    } catch (error) {
      console.error("消息解析失败:", error);
    }
  };
}

function handleWebRTCSignal(data) {
  const { sender, signal } = data;
  let pc = peerConnections.get(sender);

  if (signal.sdp) {
    //接收到offer返回answer
    pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
      .then(() => {
        if (signal.sdp.type === "offer") {
          return pc
            .createAnswer()
            .then((answer) => pc.setLocalDescription(answer))
            .then(() => {
              socket.emit("webrtc-signal", {
                target: sender,
                signal: { sdp: pc.localDescription },
                roomCode: currentRoom,
              });
            });
        }
      })
      .catch((error) => console.error("处理 SDP 失败:", error));
  } else if (signal.ice) {
    //发射端添加返回的candidate
    pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch((error) =>
      console.error("添加 ICE 候选失败:", error)
    );
  }
}

function handleDataChannelMessage(message, senderId) {
  switch (message.type) {
    case "file-info":
      fileTransferManager.handleFileInfo(message.payload, senderId);
      break;
    case "file-chunk":
      fileTransferManager.handleFileChunk(message.payload, senderId);
      break;
    case "chunk-ack": // 新增：处理分块确认
      fileTransferManager.handleChunkAck(message.payload, senderId);
      break;
    case "request-retransmit": //重传机制
      fileTransferManager.handleRetransmitRequest(message.payload, senderId);
      break;
    default:
      console.warn("未知消息类型:", message.type);
  }
}

function handleFileRequest(data) {
  const { requester, fileId, fileName } = data;
  const file = localFiles.get(fileId);

  if (file) {
    // if (confirm(`用户请求下载文件: ${fileName}\n是否允许？`)) {
    fileTransferManager.sendFile(file, requester, fileId);
    // }
  } else {
    socket.emit("file-request-result", {
      success: false,
      error: "文件不存在",
    });
  }
}

function cleanupPeerConnection(userId) {
  const pc = peerConnections.get(userId);
  if (pc) {
    pc.close();
    peerConnections.delete(userId);
  }

  const dc = dataChannels.get(userId);
  if (dc) {
    dc.close();
    dataChannels.delete(userId);
  }
}

// UI 相关函数
function showHome() {
  hideAllPages();
  document.getElementById("homePage").classList.add("active");
  currentRoom = null;
  isHost = false;
  document.getElementById("roomInfo").style.display = "none";
}

function showCreateRoom() {
  hideAllPages();
  document.getElementById("createRoomPage").classList.add("active");
}

function showJoinRoom() {
  hideAllPages();
  document.getElementById("joinRoomPage").classList.add("active");
}

function showRoomPage() {
  hideAllPages();
  document.getElementById("roomPage").classList.add("active");

  // 显示/隐藏上传区域
  const uploadSection = document.getElementById("uploadSection");
  uploadSection.style.display = isHost ? "block" : "none";
}

function hideAllPages() {
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.remove("active");
  });
}

function createRoom() {
  const hostName = document.getElementById("hostName").value.trim();
  if (!hostName) {
    alert("请输入昵称");
    return;
  }

  socket.emit("create-room", { hostName });
}

function joinRoom() {
  const roomCode = document
    .getElementById("joinRoomCode")
    .value.trim()
    .toUpperCase();
  const participantName = document
    .getElementById("participantName")
    .value.trim();

  if (!roomCode || !participantName) {
    alert("请填写房间代码和昵称");
    return;
  }

  socket.emit("join-room", { roomCode, participantName });
}

function copyRoomCode() {
  const roomCode = document.getElementById("roomCode").textContent;
  navigator.clipboard.writeText(roomCode).then(() => {
    alert("房间代码已复制到剪贴板");
  });
}

function copyShareCode() {
  const roomCode =
    window.location.href + document.getElementById("roomCode").textContent;
  navigator.clipboard.writeText(roomCode).then(() => {
    alert("分享链接已复制到剪贴板");
  });
}

function updateRoomInfo() {
  document.getElementById("roomInfo").style.display = "flex";
  document.getElementById("roomCode").textContent = currentRoom;
}

function updateUserList(users) {
  const userList = document.getElementById("userList");
  userList.innerHTML = "";

  users.forEach((user) => {
    addUserToList(user);
  });
}

function addUserToList(user) {
  const userList = document.getElementById("userList");
  const userItem = document.createElement("div");
  userItem.className = `user-item ${user.isHost ? "host" : ""}`;
  userItem.textContent = user.name;
  userItem.id = `user-${user.id}`;
  if(isHost) { //主持人
    // 添加新的状态指示器
    const statusIndicator = document.createElement("div");
    statusIndicator.className = `connection-status disconnected`;//默认未连接
    userItem.appendChild(statusIndicator);
  } else if(user.isHost) { //接收端
    const statusIndicator = document.createElement("div");
    statusIndicator.className = `connection-status disconnected`;
    userItem.appendChild(statusIndicator);
  }
  userList.appendChild(userItem);
}

function removeUserFromList(userId) {
  const userItem = document.getElementById(`user-${userId}`);
  if (userItem) {
    userItem.remove();
  }
}

function updateFileList(files) {
  const fileList = document.getElementById("fileList");
  fileList.innerHTML = "";

  files.forEach((file) => {
    addFileToList(file);
  });
}

function addFileToList(fileInfo) {
  const fileList = document.getElementById("fileList");
  const fileItem = document.createElement("div");
  fileItem.className = "file-item";
  fileItem.id = `file-${fileInfo.id}`;

  const fileSize = formatFileSize(fileInfo.size);

  fileItem.innerHTML = `
        <div class="file-info">
            <div class="file-name">${fileInfo.name}</div>
            <div class="file-size">${fileSize}</div>
        </div>
        <div class="file-actions">
            ${
              isHost
                ? `<button class="btn-secondary" onclick="deleteFile('${fileInfo.id}')">删除</button>`
                : ""
            }
            ${
              !isHost
                ? `<button class="btn-primary" onclick="downloadFile('${fileInfo.id}')">下载</button><div id="preparing" class="btn-back" style="display:none;width:145px" >传输准备中</div>`
                : ""
            }
            
        </div>
    `;

  fileList.appendChild(fileItem);
}

function removeFileFromList(fileId) {
  const fileItem = document.getElementById(`file-${fileId}`);
  if (fileItem) {
    fileItem.remove();
  }
}

function deleteFile(fileId) {
  if (confirm("确定要删除这个文件吗？")) {
    socket.emit("file-delete", { roomCode: currentRoom, fileId });
  }
}

function downloadFile(fileId) {
  // 如果是主持人，直接从本地获取文件
  if (isHost) {
    const file = localFiles.get(fileId);
    if (file) {
      fileTransferManager.sendFile(file, socket.id);
    } else {
      alert("文件不存在");
    }
    return;
  }

  // 参与者：找到主持人ID
  const roomParticipants = Array.from(document.querySelectorAll(".user-item"));
  const hostItem = roomParticipants.find((item) =>
    item.classList.contains("host")
  );

  if (hostItem) {
    const hostId = hostItem.id.replace("user-", "");

    // 检查是否已建立WebRTC连接
    if (!peerConnections.has(hostId)) {
      // 如果没有连接，先创建连接
      createPeerConnection(hostId);

      // 等待连接建立后再请求文件
      setTimeout(() => {
        requestFileFromHost(fileId, hostId);
      }, 2000);
    } else {
      requestFileFromHost(fileId, hostId);
    }
  } else {
    alert("未找到主持人");
  }
}

function requestFileFromHost(fileId, hostId) {
  const fileElement = document.getElementById(`file-${fileId}`);
  const fileName = fileElement.querySelector(".file-name").textContent;
  const downbtn = fileElement.querySelector(".btn-primary");
  const preparbtn = fileElement.querySelector(".btn-back");
  preparbtn.style.display = "block";
  downbtn.style.display = "none";

  socket.emit("request-file", {
    roomCode: currentRoom,
    fileId,
    fileName: fileName,
    target: hostId,
  });
}

function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// 文件上传处理
function setupFileUpload() {
  const fileInput = document.getElementById("fileInput");
  const uploadArea = document.getElementById("uploadArea");

  // 点击上传
  fileInput.addEventListener("change", handleFileSelect);

  // 为移动端添加额外的触摸事件支持
  uploadArea.addEventListener("touchstart", (e) => {
    uploadArea.style.background = "var(--light-orange)";
  });

  uploadArea.addEventListener("touchend", (e) => {
    uploadArea.style.background = "";
  });

  // 拖拽上传
  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.style.background = "var(--light-orange)";
  });

  uploadArea.addEventListener("dragleave", () => {
    uploadArea.style.background = "";
  });

  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.style.background = "";
    handleFileSelect({ target: { files: e.dataTransfer.files } });
  });
}

function handleFileSelect(event) {
  // 防止事件冒泡导致的重复处理
  event.preventDefault();
  event.stopPropagation();

  // 获取文件列表（兼容不同设备的文件对象格式）
  const files =
    event.target.files || (event.dataTransfer ? event.dataTransfer.files : []);
  if (!files || files.length === 0) {
    console.warn("未选中任何文件或文件格式不支持");
    return;
  }

  // 处理每个文件
  Array.from(files).forEach((file) => {
    try {
      // 验证文件有效性
      if (!file.name || !file.size) {
        throw new Error("无效的文件对象");
      }

      // 生成唯一文件ID（兼容特殊文件名）
      const safeFileName = file.name.replace(/[^\w\-.]/g, "_");
      const fileId = `${Date.now()}-${safeFileName}`;

      // 存储文件并通知服务器
      localFiles.set(fileId, file);
      socket.emit("file-upload", {
        roomCode: currentRoom,
        fileInfo: {
          id: fileId,
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream", // 兼容未知类型
        },
      });
      console.log("文件已添加到列表:", file.name);
    } catch (error) {
      console.error("处理文件失败:", error, "文件信息:", file);
      fileTransferManager.showNotification(
        `无法添加文件: ${file.name || "未知文件"}`,
        "error"
      );
    }
  });

  // 清空输入框（避免重复选择同一文件时不触发change事件）
  event.target.value = "";
}

// 页面加载完成后初始化
document.addEventListener("DOMContentLoaded", () => {
  initSocket();
  setupFileUpload();

  // 检查 URL 中是否有房间代码
  const path = window.location.pathname;
  if (path.length > 1 && path !== "/index.html") {
    const roomCode = path.substring(1).toUpperCase();
    document.getElementById("joinRoomCode").value = roomCode;
    showJoinRoom();
  }
});

// 初始化传输状态面板
function initializeTransferStatusPanel() {
  transferStatusPanel = document.createElement("div");
  transferStatusPanel.className = "transfer-panel";
  transferStatusPanel.id = "transferPanel";
  transferStatusPanel.style.display = "none";
  document.body.appendChild(transferStatusPanel);
}

// 添加连接状态管理相关函数

// 更新连接状态显示
function updateConnectionStatus(userId, status) {
  // 更新用户列表中的状态指示器
  const userItem = document.getElementById(`user-${userId}`);
  if (userItem) {
    // 移除旧的状态指示器
    const oldStatusIndicator = userItem.querySelector(".connection-status");
    if (oldStatusIndicator) {
      oldStatusIndicator.remove();
    }

    // 添加新的状态指示器
    const statusIndicator = document.createElement("div");
    statusIndicator.className = `connection-status ${status}`;
    userItem.appendChild(statusIndicator);
  }
}

// 全局函数暴露
window.showHome = showHome;
window.showCreateRoom = showCreateRoom;
window.showJoinRoom = showJoinRoom;
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.copyRoomCode = copyRoomCode;
window.deleteFile = deleteFile;
window.downloadFile = downloadFile;
