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
      const { hostName } = data;
      const roomCode = generateRoomCode();

      const room = {
        code: roomCode,
        host: {
          id: socket.id,
          name: hostName,
          isHost: true,
        },
        participants: new Map(),
        files: new Map(),
        createdAt: new Date(),
      };

      rooms.set(roomCode, room);
      socket.join(roomCode);

      socket.emit("room-created", {
        success: true,
        roomCode,
        isHost: true,
      });

      console.log(`房间创建成功: ${roomCode}, 主持人: ${hostName}`);
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
      const { roomCode, participantName } = data;
      const upperRoomCode = roomCode.toUpperCase();

      if (!rooms.has(upperRoomCode)) {
        socket.emit("room-joined", {
          success: false,
          error: "房间不存在",
        });
        return;
      }

      const room = rooms.get(upperRoomCode);

      // 检查是否是主持人重新连接
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
        name: participantName,
        isHost: false,
      };

      room.participants.set(socket.id, participant);
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

      console.log(`用户加入房间: ${upperRoomCode}, 用户名: ${participantName}`);
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

  // 用户断开连接
  socket.on("disconnect", () => {
    console.log("用户断开连接:", socket.id);

    // 查找用户所在的房间
    for (const [roomCode, room] of rooms.entries()) {
      // 如果是主持人断开，删除整个房间
      if (room.host.id === socket.id) {
        io.to(roomCode).emit("host-disconnected");
        rooms.delete(roomCode);
        console.log(`房间删除: ${roomCode} (主持人离开)`);
        break;
      }

      // 如果是参与者断开，从房间中移除
      if (room.participants.has(socket.id)) {
        const participant = room.participants.get(socket.id);
        room.participants.delete(socket.id);
        socket.to(roomCode).emit("user-left", { userId: socket.id });
        console.log(`用户离开房间: ${roomCode}, 用户名: ${participant.name}`);
        break;
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
setInterval(() => {
  const now = new Date();
  for (const [roomCode, room] of rooms.entries()) {
    // 如果房间超过24小时，删除
    if (now - room.createdAt > 24 * 60 * 60 * 1000) {
      rooms.delete(roomCode);
      console.log(`清理过期房间: ${roomCode}`);
    }
  }
}, 60 * 60 * 1000); // 每小时检查一次
