const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const cors = require("cors");
const compression = require("compression");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// 配置
const PORT = process.env.PORT || 3000;
const ROOM_CODE_LENGTH = 6;

// 存储房间信息
const rooms = new Map();
// 存储断线重连计时器: userId -> { timeout, roomCode, oldSocketId, isHost, userData }
const disconnectTimers = new Map();
// 辅助映射: socketId -> userId
const socketToUser = new Map();

// 生成房间代码
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXY0123456789";
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 中间件
app.use(compression());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// 路由
app.get("/:roomCode", (req, res) => {
  const roomCode = req.params.roomCode.toUpperCase();
  if (rooms.has(roomCode)) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  } else {
    res.status(404).send("房间不存在");
  }
});

// Socket.IO 事件处理
io.on("connection", (socket) => {
  console.log("用户连接:", socket.id);

  // 创建房间
  socket.on("create-room", (data) => {
    try {
      const { hostName, userId } = data; // 接收 userId
      const roomCode = generateRoomCode();

      const room = {
        code: roomCode,
        host: {
          id: socket.id,
          userId: userId, // 存储 userId
          name: hostName,
          isHost: true,
        },
        participants: new Map(),
        files: new Map(),
        createdAt: new Date(),
      };

      rooms.set(roomCode, room);
      if (userId) socketToUser.set(socket.id, userId);
      
      socket.join(roomCode);

      socket.emit("room-created", {
        success: true,
        roomCode,
        isHost: true,
      });

      console.log(`房间创建成功: ${roomCode}, 主持人: ${hostName}, UserID: ${userId}`);
    } catch (error) {
      socket.emit("room-created", {
        success: false,
        error: error.message,
      });
    }
  });

  // 加入房间
  socket.on("join-room", (data) => {
    try {
      const { roomCode, participantName, userId } = data;
      const upperRoomCode = roomCode.toUpperCase();

      if (!rooms.has(upperRoomCode)) {
        socket.emit("room-joined", {
          success: false,
          error: "房间不存在",
        });
        return;
      }

      const room = rooms.get(upperRoomCode);

      // 检查是否是主持人重新连接 (基于 socket.id)
      if (room.host.id === socket.id) {
        socket.emit("room-joined", {
          success: true,
          roomCode: upperRoomCode,
          isHost: true,
          users: Array.from(room.participants.values()),
          files: Array.from(room.files.values()),
        });
        return;
      }

      // 添加参与者
      const participant = {
        id: socket.id,
        userId: userId, // 存储 userId
        name: participantName,
        isHost: false,
      };

      room.participants.set(socket.id, participant);
      if (userId) socketToUser.set(socket.id, userId);

      socket.join(upperRoomCode);

      // 通知房间内的其他用户
      socket.to(upperRoomCode).emit("user-joined", participant);

      // 发送房间信息给新加入的用户
      socket.emit("room-joined", {
        success: true,
        roomCode: upperRoomCode,
        isHost: false,
        host: room.host, // 单独发送主持人信息
        users: Array.from(room.participants.values()),
        files: Array.from(room.files.values()),
      });

      console.log(`用户加入房间: ${upperRoomCode}, 用户名: ${participantName}, UserID: ${userId}`);
    } catch (error) {
      socket.emit("room-joined", {
        success: false,
        error: error.message,
      });
    }
  });

  // 文件上传
  socket.on("file-upload", (data) => {
    try {
      const { roomCode, fileInfo } = data;
      const room = rooms.get(roomCode);

      if (!room || room.host.id !== socket.id) {
        socket.emit("file-upload-result", {
          success: false,
          error: "无权上传文件",
        });
        return;
      }

      const fileId = fileInfo.id;
      const fileData = {
        id: fileId,
        ...fileInfo,
        uploadedBy: socket.id,
        uploadedAt: new Date(),
      };

      room.files.set(fileId, fileData);

      // 通知房间内的所有用户
      io.to(roomCode).emit("file-added", fileData);

      socket.emit("file-upload-result", {
        success: true,
        fileId,
      });

      console.log(`文件上传: ${fileInfo.name} (${fileInfo.size} bytes)`);
    } catch (error) {
      socket.emit("file-upload-result", {
        success: false,
        error: error.message,
      });
    }
  });

  // 删除文件
  socket.on("file-delete", (data) => {
    try {
      const { roomCode, fileId } = data;
      const room = rooms.get(roomCode);

      if (!room || room.host.id !== socket.id) {
        socket.emit("file-delete-result", {
          success: false,
          error: "无权删除文件",
        });
        return;
      }

      if (room.files.has(fileId)) {
        room.files.delete(fileId);
        io.to(roomCode).emit("file-removed", { fileId });

        socket.emit("file-delete-result", {
          success: true,
        });
      } else {
        socket.emit("file-delete-result", {
          success: false,
          error: "文件不存在",
        });
      }
    } catch (error) {
      socket.emit("file-delete-result", {
        success: false,
        error: error.message,
      });
    }
  });

  // WebRTC 信令
  socket.on("webrtc-signal", (data) => {
    try {
      const { target, signal, roomCode } = data;
      io.to(target).emit("webrtc-signal", {
        sender: socket.id,
        signal,
        roomCode,
      });
    } catch (error) {
      console.error("WebRTC 信令错误:", error);
    }
  });

  // 请求文件传输
  socket.on("request-file", (data) => {
    try {
      const { roomCode, fileId, target } = data;
      const room = rooms.get(roomCode);
      if (!room || !room.files.has(fileId)) {
        socket.emit("file-request-result", {
          success: false,
          error: "文件不存在",
        });
        return;
      }

      const file = room.files.get(fileId);
      io.to(target).emit("file-request", {
        requester: socket.id,
        fileId,
        fileName: file.name,
      });
    } catch (error) {
      console.error("请求文件错误:", error);
    }
  });

  // 处理重新加入房间 (Rejoin)
  socket.on("rejoin-room", (data) => {
    const { roomCode, userId } = data;
    const upperRoomCode = roomCode.toUpperCase();
    console.log(`收到重连请求: User ${userId} -> Room ${upperRoomCode}`);

    if (disconnectTimers.has(userId)) {
      const timerInfo = disconnectTimers.get(userId);
      
      // 验证房间号是否匹配
      if (timerInfo.roomCode !== upperRoomCode) {
         socket.emit("rejoin-result", { success: false, error: "房间信息不匹配" });
         return;
      }

      // 清除定时器
      clearTimeout(timerInfo.timeout);
      disconnectTimers.delete(userId);

      const room = rooms.get(upperRoomCode);
      if (!room) {
        socket.emit("rejoin-result", { success: false, error: "房间已过期" });
        return;
      }

      // 更新 Socket 映射
      socketToUser.set(socket.id, userId);
      socket.join(upperRoomCode);

      // 恢复身份
      if (timerInfo.isHost) {
        // 更新主持人 socket ID
        room.host.id = socket.id;
        console.log(`主持人恢复连接: ${upperRoomCode}`);
        
        socket.to(upperRoomCode).emit("user-joined", room.host);
      } else {
        // 更新参与者 socket ID
        const oldParticipant = timerInfo.userData;
        const newParticipant = { ...oldParticipant, id: socket.id };
        
        // 删除旧的记录
        if (room.participants.has(timerInfo.oldSocketId)) {
            room.participants.delete(timerInfo.oldSocketId);
        }
        room.participants.set(socket.id, newParticipant);
        
        console.log(`参与者恢复连接: ${upperRoomCode}`);
        socket.to(upperRoomCode).emit("user-joined", newParticipant);
      }

      // 返回成功
      socket.emit("rejoin-result", {
        success: true,
        roomCode: upperRoomCode,
        isHost: timerInfo.isHost,
        hostId: room.host.id,
        users: Array.from(room.participants.values()),
        files: Array.from(room.files.values()),
      });
      
      // 广播旧用户离开 (清理旧的 PeerConnection)
      socket.to(upperRoomCode).emit("user-left", { userId: timerInfo.oldSocketId });

    } else {
      // 尝试查找是否存在活跃连接（Session Takeover）
      // 当移动端切换网络或长时间后台后，旧连接可能在服务器端尚未断开
      // 此时需要强制接管旧会话
      const room = rooms.get(upperRoomCode);
      if (room) {
          let targetUser = null;
          let isHost = false;
          let oldSocketId = null;

          if (room.host.userId === userId) {
              targetUser = room.host;
              isHost = true;
              oldSocketId = room.host.id;
          } else {
              for (const [pid, p] of room.participants) {
                  if (p.userId === userId) {
                      targetUser = p;
                      oldSocketId = pid;
                      break;
                  }
              }
          }

          if (targetUser) {
              console.log(`用户 ${userId} 抢占活跃会话 (Old Socket: ${oldSocketId})`);
              
              // 1. 更新映射 (这会防止旧 socket disconnect 时删除用户)
              socketToUser.delete(oldSocketId);
              socketToUser.set(socket.id, userId);
              
              // 2. 更新房间信息
              targetUser.id = socket.id;
              if (!isHost) {
                  room.participants.delete(oldSocketId);
                  room.participants.set(socket.id, targetUser);
              }

              // 3. 加入房间
              socket.join(upperRoomCode);
              
              // 4. 尝试断开旧连接
              const oldSocket = io.sockets.sockets.get(oldSocketId);
              if (oldSocket) {
                  oldSocket.disconnect(true);
              }

              // 5. 广播更新
              socket.to(upperRoomCode).emit("user-joined", targetUser);
              socket.to(upperRoomCode).emit("user-left", { userId: oldSocketId });

              // 6. 返回结果
              socket.emit("rejoin-result", {
                  success: true,
                  roomCode: upperRoomCode,
                  isHost: isHost,
                  hostId: room.host.id,
                  users: Array.from(room.participants.values()),
                  files: Array.from(room.files.values()),
              });
              return;
          }
      }

      socket.emit("rejoin-result", { success: false, error: "会话已过期或无效" });
    }
  });
  
  // 心跳检测
  socket.on("ping-check", () => {
      socket.emit("pong-check");
  });

  // 用户断开连接
  socket.on("disconnect", () => {
    console.log("用户断开连接:", socket.id);
    const userId = socketToUser.get(socket.id);
    
    // 查找用户所在的房间
    for (const [roomCode, room] of rooms.entries()) {
      let isHost = false;
      let userData = null;

      // 检查是否是主持人
      if (room.host.id === socket.id) {
        isHost = true;
        userData = room.host;
      }
      // 检查是否是参与者
      else if (room.participants.has(socket.id)) {
        userData = room.participants.get(socket.id);
      }

      if (userData) {
        console.log(`用户 ${userData.name} (Host: ${isHost}) 断开连接，进入保留期...`);
        
        // 如果有 userId，设置保留期定时器
        if (userId) {
            const timeout = setTimeout(() => {
                console.log(`用户 ${userId} 保留期结束，执行清理`);
                disconnectTimers.delete(userId);
                socketToUser.delete(socket.id); // 清理 map

                // 执行真正的断开逻辑
                if (isHost) {
                    if (rooms.has(roomCode)) { // 再次检查房间是否存在
                        io.to(roomCode).emit("host-disconnected");
                        rooms.delete(roomCode);
                        console.log(`房间删除: ${roomCode} (主持人超时未归)`);
                    }
                } else {
                    if (rooms.has(roomCode) && room.participants.has(socket.id)) {
                        room.participants.delete(socket.id);
                        socket.to(roomCode).emit("user-left", { userId: socket.id });
                        console.log(`用户彻底离开房间: ${roomCode}`);
                    }
                }
            }, 60000); // 60秒宽限期

            disconnectTimers.set(userId, {
                timeout,
                roomCode,
                isHost,
                oldSocketId: socket.id,
                userData
            });
        } else {
            // 没有 userId (旧客户端?)，直接执行断开
            if (isHost) {
                io.to(roomCode).emit("host-disconnected");
                rooms.delete(roomCode);
            } else {
                room.participants.delete(socket.id);
                socket.to(roomCode).emit("user-left", { userId: socket.id });
            }
            socketToUser.delete(socket.id);
        }
        break; // 找到房间后退出循环
      }
    }
  });

  // 错误处理
  socket.on("error", (error) => {
    console.error("Socket 错误:", error);
  });
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`环境: ${process.env.NODE_ENV || "development"}`);
});

// 清理不活跃的房间（可选）
// setInterval(() => {
//   const now = new Date();
//   for (const [roomCode, room] of rooms.entries()) {
//     // 如果房间超过24小时，删除
//     if (now - room.createdAt > 24 * 60 * 60 * 1000) {
//       rooms.delete(roomCode);
//       console.log(`清理过期房间: ${roomCode}`);
//     }
//   }
// }, 60 * 60 * 1000); // 每小时检查一次
