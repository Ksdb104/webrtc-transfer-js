// 全局变量
let socket = null;
let currentRoom = null;
let isHost = false;
let hostId = null; // 存储主持人ID
let isRoomConnected = false; // 标记是否已与房间建立有效连接
let pendingUploads = []; // 待上传文件队列

// 获取或生成持久化 User ID
let userId = localStorage.getItem('userId');
if (!userId) {
    userId = self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('userId', userId);
}
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
      if (preparbtn) preparbtn.classList.add("hidden");
      if (downbtn) downbtn.classList.remove("hidden");
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
    transferStatusPanel.classList.remove("hidden");

    // 生成唯一的传输项ID
    const transferItemId = `transfer-${type}-${fileName.replace(
      /\s+/g,
      "-"
    )}-${senderId}`;

    // 获取或创建传输列表容器
    let transferList = document.getElementById("transferList");
    if (!transferList) {
      transferList = document.createElement("div");
      transferList.id = "transferList";
      transferList.className = "p-3 sm:p-4 space-y-2 sm:space-y-3";
      transferStatusPanel.appendChild(transferList);
    }

    // 创建或更新传输项
    let transferItem = document.getElementById(transferItemId);
    if (!transferItem) {
      transferItem = document.createElement("div");
      transferItem.className = "p-2.5 sm:p-3 bg-slate-50 rounded-lg sm:rounded-xl";
      transferItem.id = transferItemId;
      transferList.appendChild(transferItem);
    }

    let showType = "";
    let statusColor = "text-slate-600";

    if (type == "sending") {
      showType = "发送中";
      statusColor = "text-primary";
    } else if (type == "preparing") {
      showType = "准备中";
      statusColor = "text-yellow-600";
    } else if (type == "stopped") {
      showType = "传输失败";
      statusColor = "text-red-600";
    } else {
      showType = "接收中";
      statusColor = "text-blue-600";
    }

    // 更新传输项内容
    transferItem.innerHTML = `
      <div class="flex items-center justify-between mb-1.5 sm:mb-2 gap-2">
        <div class="font-medium text-slate-900 text-xs sm:text-sm truncate flex-1" title="${fileName}">${fileName}</div>
        <div class="text-[10px] sm:text-xs font-semibold ${statusColor} flex-shrink-0">${showType}</div>
      </div>
      <div class="w-full h-1 sm:h-1.5 bg-slate-200 rounded-full overflow-hidden mb-1 sm:mb-2">
        <div class="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-300" style="width: ${progress}%"></div>
      </div>
      ${
        type == "preparing" || type == "stopped"
          ? ""
          : `<div class="text-[10px] sm:text-xs text-slate-600">${speed.toFixed(
              2
            )} MB/s · ${progress.toFixed(1)}%</div>`
      }
    `;

    // 如果传输完成，更新状态并稍后移除
    if (progress >= 100) {
      setTimeout(() => {
        const statusEl = transferItem.querySelector(`.${statusColor.replace("text-", "")}`);
        if (statusEl && type != "stopped") {
          statusEl.textContent = "已完成";
          statusEl.classList.remove(statusColor);
          statusEl.classList.add("text-green-600");
        }

        // 3秒后移除传输项
        setTimeout(() => {
          if (transferItem && transferItem.parentNode) {
            transferItem.parentNode.removeChild(transferItem);

            // 如果没有其他传输项，隐藏传输面板
            if (transferList.children.length === 0) {
              transferStatusPanel.classList.add("hidden");
            }
          }
        }, 3000);
      }, 10);
    }
  }

  showNotification(message, type = "success") {
    const notification = document.createElement("div");
    notification.className = `fixed top-20 sm:top-24 right-3 sm:right-6 left-3 sm:left-auto sm:max-w-md px-4 sm:px-6 py-3 sm:py-4 rounded-xl shadow-2xl z-[1001] flex items-center gap-2 sm:gap-3 ${
      type === "success" 
        ? "bg-green-500 text-white" 
        : "bg-red-500 text-white"
    }`;
    notification.style.transition = "all 0.3s ease";
    
    const icon = type === "success"
      ? '<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
      : '<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
    
    notification.innerHTML = `${icon}<span class="font-medium text-sm sm:text-base">${message}</span>`;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.opacity = "0";
      notification.style.transform = "translateY(-10px)";
      setTimeout(() => notification.remove(), 300);
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
  // 更新连接状态为连接中
  updateConnectionStatus('connecting');
  
  socket = io();

  socket.on("connect", () => {
    console.log("连接到服务器:", socket.id);
    updateConnectionStatus('connected');
    
    // 如果处于房间中（断线重连的情况），尝试重新加入
    if (currentRoom) {
        console.log("尝试恢复房间连接:", currentRoom);
        socket.emit('rejoin-room', {
            roomCode: currentRoom,
            userId: userId
        });
    }
  });

  socket.on("rejoin-result", (data) => {
      if (data.success) {
          console.log("成功恢复房间连接");
          isHost = data.isHost;
          hostId = data.hostId;
          isRoomConnected = true;
          
          updateRoomInfo();
          if (data.files) updateFileList(data.files);
          
          if (data.users) {
              updateUserList(data.users);
              
              // 恢复 WebRTC 连接
              // 清理旧连接（如果有的话，虽然 socket id 变了 key 也对不上，但为了保险可以清空 map）
              // 实际上 peerConnections 的 key 是旧的 socketId，那些已经没用了
              // 我们保留它们直到收到 user-left，或者这里手动清理？
              // 简单起见，这里我们只负责发起新的连接
              
              if (isHost) {
                  // 我是主持人，重新连接所有参与者
                  data.users.forEach(user => {
                      if (user.id !== socket.id) {
                          createPeerConnection(user.id);
                      }
                  });
              } else {
                  // 我是普通用户，重新连接主持人
                  if (hostId) {
                      createPeerConnection(hostId);
                  }
              }
          }

      } else {
          console.warn("恢复房间失败:", data.error);
          isRoomConnected = false;
          showHome();
          alert("连接已过期，请重新加入房间");
      }
      
      // 处理待上传队列
      processPendingUploads();
  });

  socket.on("disconnect", () => {
    console.log("与服务器断开连接");
    isRoomConnected = false;
    updateConnectionStatus('disconnected');
  });

  socket.on("connect_error", (error) => {
    console.error("连接错误:", error);
    updateConnectionStatus('error');
  });

  socket.on("reconnecting", (attemptNumber) => {
    console.log("正在重连，尝试次数:", attemptNumber);
    updateConnectionStatus('reconnecting');
  });

  socket.on("reconnect", () => {
    console.log("重新连接成功");
    updateConnectionStatus('connected');
  });

  socket.on("reconnect_failed", () => {
    console.error("重连失败");
    updateConnectionStatus('error');
  });

  socket.on("room-created", (data) => {
    if (data.success) {
      currentRoom = data.roomCode;
      isHost = data.isHost;
      hostId = socket.id; // 主持人的ID就是自己的socket.id
      isRoomConnected = true;
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
      isRoomConnected = true;
      
      // 存储主持人ID
      if (data.host) {
        hostId = data.host.id;
      }
      
      showRoomPage();
      updateRoomInfo();
      
      // 如果不是主持人，连接到主持人
      if (!isHost && hostId) {
        createPeerConnection(hostId);
      }
      
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
    console.log("用户加入:", user);
    
    // 如果新加入的是主持人（例如主持人断线重连），更新本地 hostId 并建立连接
    if (user.isHost) {
        hostId = user.id;
        if (!isHost) {
            console.log("主持人已更新，发起连接");
            createPeerConnection(hostId);
        }
    }

    addUserToList(user);
    
    // 如果我是主持人，向新用户建立 WebRTC 连接
    if (isHost && !user.isHost) {
      createPeerConnection(user.id);
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

    const transferList = document.getElementById("transferList");
    if (transferList && transferList.children.length === 0) {
      transferStatusPanel.classList.add("hidden");
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
  hostId = null; // 重置主持人ID
  const roomInfo = document.getElementById("roomInfo");
  roomInfo.classList.add("hidden");
  roomInfo.classList.remove("flex");
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
  if (isHost) {
    uploadSection.classList.remove("hidden");
  } else {
    uploadSection.classList.add("hidden");
  }
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

  // 检查连接状态
  if (!socket || !socket.connected) {
    alert("未连接到服务器，请稍候再试");
    return;
  }

  socket.emit("create-room", { hostName, userId });
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

  // 检查连接状态
  if (!socket || !socket.connected) {
    alert("未连接到服务器，请稍候再试");
    return;
  }

  socket.emit("join-room", { roomCode, participantName, userId });
}

function copyRoomCode() {
  const roomCode = document.getElementById("roomCode").textContent;
  navigator.clipboard.writeText(roomCode).then(() => {
    fileTransferManager.showNotification("房间代码已复制到剪贴板");
  });
}

function copyShareCode() {
  const roomCode = document.getElementById("roomCode").textContent;
  const shareUrl = window.location.origin + "/" + roomCode;
  navigator.clipboard.writeText(shareUrl).then(() => {
    fileTransferManager.showNotification("分享链接已复制到剪贴板");
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
  const roomInfo = document.getElementById("roomInfo");
  roomInfo.classList.remove("hidden");
  roomInfo.classList.add("flex");
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
  userItem.className = "flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 bg-slate-50 hover:bg-slate-100 active:bg-slate-200 rounded-xl transition-colors duration-200 min-h-[44px]";
  userItem.id = `user-${user.id}`;
  
  // User icon and name
  const userInfo = document.createElement("div");
  userInfo.className = "flex items-center gap-2 flex-1 min-w-0";
  
  const icon = document.createElement("div");
  icon.className = user.isHost ? "w-8 h-8 bg-gradient-to-br from-primary to-secondary rounded-lg flex items-center justify-center flex-shrink-0" : "w-8 h-8 bg-slate-200 rounded-lg flex items-center justify-center flex-shrink-0";
  icon.innerHTML = user.isHost 
    ? '<svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"></path></svg>'
    : '<svg class="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>';
  
  const nameSpan = document.createElement("span");
  nameSpan.className = "text-xs sm:text-sm font-medium text-slate-900 truncate";
  nameSpan.textContent = user.name;
  
  userInfo.appendChild(icon);
  userInfo.appendChild(nameSpan);
  userItem.appendChild(userInfo);
  
  // Connection status indicator
  if(isHost || user.isHost) {
    const statusIndicator = document.createElement("div");
    statusIndicator.className = "w-2 h-2 rounded-full bg-slate-300 connection-status disconnected flex-shrink-0";
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
  fileItem.className = "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 sm:p-4 bg-slate-50 hover:bg-slate-100 active:bg-slate-200 rounded-xl transition-colors duration-200";
  fileItem.id = `file-${fileInfo.id}`;

  const fileSize = formatFileSize(fileInfo.size);

  fileItem.innerHTML = `
        <div class="flex items-center gap-3 flex-1 min-w-0">
            <div class="w-10 h-10 sm:w-10 sm:h-10 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <svg class="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                </svg>
            </div>
            <div class="min-w-0 flex-1">
                <div class="font-medium text-slate-900 truncate text-sm sm:text-base">${fileInfo.name}</div>
                <div class="text-xs sm:text-sm text-slate-500">${fileSize}</div>
            </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0 sm:ml-auto">
            ${
              isHost
                ? `<button class="min-h-[44px] flex-1 sm:flex-none px-4 py-2 bg-red-50 hover:bg-red-100 active:bg-red-200 text-red-600 rounded-lg font-medium transition-colors duration-200 cursor-pointer text-sm sm:text-base touch-manipulation" onclick="deleteFile('${fileInfo.id}')">删除</button>`
                : ""
            }
            ${
              !isHost
                ? `<button class="btn-primary min-h-[44px] flex-1 sm:flex-none px-4 py-2 bg-gradient-to-r from-primary to-secondary hover:from-orange-600 hover:to-orange-500 active:from-orange-700 active:to-orange-600 text-white rounded-lg font-medium transition-all duration-200 cursor-pointer text-sm sm:text-base touch-manipulation" onclick="downloadFile('${fileInfo.id}')">下载</button><div class="btn-back hidden min-h-[44px] flex-1 sm:flex-none px-4 py-2 bg-slate-200 text-slate-600 rounded-lg text-xs sm:text-sm">准备中...</div>`
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

  // 参与者：使用存储的主持人ID
  if (!hostId) {
    alert("未找到主持人");
    return;
  }

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
}

function requestFileFromHost(fileId, hostId) {
  const fileElement = document.getElementById(`file-${fileId}`);
  const fileName = fileElement.querySelector(".font-medium").textContent;
  const downbtn = fileElement.querySelector(".btn-primary");
  const preparbtn = fileElement.querySelector(".btn-back");
  preparbtn.classList.remove("hidden");
  downbtn.classList.add("hidden");

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
    uploadArea.classList.add("bg-primary/20");
  });

  uploadArea.addEventListener("touchend", (e) => {
    uploadArea.classList.remove("bg-primary/20");
  });

  // 拖拽上传
  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("border-primary", "bg-primary/20");
  });

  uploadArea.addEventListener("dragleave", () => {
    uploadArea.classList.remove("border-primary", "bg-primary/20");
  });

  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("border-primary", "bg-primary/20");
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

      // 存储文件
      localFiles.set(fileId, file);
      
      const fileData = {
        roomCode: currentRoom,
        fileInfo: {
          id: fileId,
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
        },
      };

      // 检查连接状态，决定是否立即发送
      if (isRoomConnected && socket && socket.connected) {
          socket.emit("file-upload", fileData);
          console.log("文件已添加到列表并上传:", file.name);
      } else {
          console.log("连接不稳定，加入待上传队列:", file.name);
          pendingUploads.push(fileData);
          fileTransferManager.showNotification("连接恢复中，文件将自动上传...", "preparing");
          
          // 如果连接断开，尝试触发重连（以防万一）
          if (socket && !socket.connected) {
              socket.connect();
          }
      }
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
  // 初始化连接状态显示
  updateConnectionStatus('connecting');
  
  initSocket();
  setupFileUpload();

  // 监听页面可见性变化，解决移动端后台断连问题
  document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
          console.log("页面恢复可见，检查连接状态...");
          // 强制检查连接，如果 isRoomConnected 为 false 但 currentRoom 存在，也说明状态不对
          if (!socket.connected || (currentRoom && !isRoomConnected)) {
              console.log("检测到连接异常，正在尝试重连...");
              if (!socket.connected) {
                  socket.connect();
              } else {
                  // Socket 连接着但没进房间，手动触发 rejoin
                  socket.emit('rejoin-room', {
                      roomCode: currentRoom,
                      userId: userId
                  });
              }
          } else {
              // 发送一个心跳包保活
              if (currentRoom) {
                  socket.emit('ping-check');
              }
          }
      }
  });

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
  transferStatusPanel = document.getElementById("transferStatusPanel");
  if (!transferStatusPanel) {
    transferStatusPanel = document.createElement("div");
    transferStatusPanel.id = "transferStatusPanel";
    transferStatusPanel.className = "fixed bottom-6 right-6 w-96 max-w-[calc(100vw-3rem)] bg-white rounded-2xl shadow-2xl border border-slate-200 hidden max-h-96 overflow-y-auto";
    transferStatusPanel.innerHTML = `
      <div class="p-4 border-b border-slate-200 sticky top-0 bg-white rounded-t-2xl">
        <h4 class="font-semibold text-slate-900">传输进度</h4>
      </div>
      <div id="transferList" class="p-4 space-y-3"></div>
    `;
    document.body.appendChild(transferStatusPanel);
  }
}

// 添加连接状态管理相关函数

// 更新连接状态显示
function updateConnectionStatus(userId, status) {
  const userItem = document.getElementById(`user-${userId}`);
  if (userItem) {
    const statusIndicator = userItem.querySelector(".connection-status");
    if (statusIndicator) {
      statusIndicator.classList.remove("bg-slate-300", "bg-green-500", "bg-yellow-500", "bg-red-500");
      statusIndicator.classList.remove("disconnected", "connected", "connecting");
      statusIndicator.classList.add(status);
      
      if (status === "connected") {
        statusIndicator.classList.add("bg-green-500");
        statusIndicator.style.animation = "pulse 2s infinite";
      } else if (status === "connecting") {
        statusIndicator.classList.add("bg-yellow-500");
        statusIndicator.style.animation = "pulse 1s infinite";
      } else {
        statusIndicator.classList.add("bg-red-500");
        statusIndicator.style.animation = "none";
      }
    }
  }
}

function processPendingUploads() {
    if (pendingUploads.length === 0) return;
    
    console.log(`处理待上传队列: ${pendingUploads.length} 个文件`);
    fileTransferManager.showNotification("连接已恢复，正在上传等待中的文件...");
    
    // 复制队列并清空，防止处理过程中重复添加
    const uploads = [...pendingUploads];
    pendingUploads = [];
    
    uploads.forEach(data => {
        // 确保 roomCode 是最新的
        data.roomCode = currentRoom;
        socket.emit("file-upload", data);
    });
}

// 全局函数暴露
window.showHome = showHome;
window.showCreateRoom = showCreateRoom;
window.showJoinRoom = showJoinRoom;
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.copyRoomCode = copyRoomCode;
window.copyShareCode = copyShareCode;
window.deleteFile = deleteFile;
window.downloadFile = downloadFile;

// 更新 WebSocket 连接状态
function updateConnectionStatus(status) {
  const statusElement = document.getElementById('connectionStatus');
  const indicatorElement = document.getElementById('connectionIndicator');
  const textElement = document.getElementById('connectionText');
  const createRoomBtn = document.getElementById('createRoomBtn');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  
  if (!statusElement || !indicatorElement || !textElement) return;
  
  // 移除所有状态类
  indicatorElement.className = 'w-2 h-2 rounded-full';
  statusElement.className = 'mt-4 sm:mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-all duration-300';
  
  switch(status) {
    case 'connecting':
      indicatorElement.classList.add('bg-yellow-500');
      indicatorElement.style.animation = 'pulse 1.5s infinite';
      textElement.textContent = '正在连接服务器...';
      textElement.className = 'text-sm font-medium text-yellow-700';
      statusElement.classList.add('bg-yellow-50', 'border', 'border-yellow-200');
      // 禁用按钮
      if (createRoomBtn) createRoomBtn.disabled = true;
      if (joinRoomBtn) joinRoomBtn.disabled = true;
      break;
      
    case 'connected':
      indicatorElement.classList.add('bg-green-500');
      indicatorElement.style.animation = 'pulse 2s infinite';
      textElement.textContent = '已连接到服务器';
      textElement.className = 'text-sm font-medium text-green-700';
      statusElement.classList.add('bg-green-50', 'border', 'border-green-200');
      // 启用按钮
      if (createRoomBtn) createRoomBtn.disabled = false;
      if (joinRoomBtn) joinRoomBtn.disabled = false;
      break;
      
    case 'disconnected':
      indicatorElement.classList.add('bg-red-500');
      indicatorElement.style.animation = 'none';
      textElement.textContent = '与服务器断开连接';
      textElement.className = 'text-sm font-medium text-red-700';
      statusElement.classList.add('bg-red-50', 'border', 'border-red-200');
      // 禁用按钮
      if (createRoomBtn) createRoomBtn.disabled = true;
      if (joinRoomBtn) joinRoomBtn.disabled = true;
      break;
      
    case 'reconnecting':
      indicatorElement.classList.add('bg-yellow-500');
      indicatorElement.style.animation = 'pulse 1s infinite';
      textElement.textContent = '正在重新连接...';
      textElement.className = 'text-sm font-medium text-yellow-700';
      statusElement.classList.add('bg-yellow-50', 'border', 'border-yellow-200');
      // 禁用按钮
      if (createRoomBtn) createRoomBtn.disabled = true;
      if (joinRoomBtn) joinRoomBtn.disabled = true;
      break;
      
    case 'error':
      indicatorElement.classList.add('bg-red-500');
      indicatorElement.style.animation = 'none';
      textElement.textContent = '连接失败，请刷新页面';
      textElement.className = 'text-sm font-medium text-red-700';
      statusElement.classList.add('bg-red-50', 'border', 'border-red-200');
      // 禁用按钮
      if (createRoomBtn) createRoomBtn.disabled = true;
      if (joinRoomBtn) joinRoomBtn.disabled = true;
      break;
      
    default:
      indicatorElement.classList.add('bg-slate-300');
      indicatorElement.style.animation = 'none';
      textElement.textContent = '未知状态';
      textElement.className = 'text-sm font-medium text-slate-600';
      statusElement.classList.add('bg-slate-50', 'border', 'border-slate-200');
      // 禁用按钮
      if (createRoomBtn) createRoomBtn.disabled = true;
      if (joinRoomBtn) joinRoomBtn.disabled = true;
  }
}
