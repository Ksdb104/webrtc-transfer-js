# webrtc-transfer-js
WebRTC协议传输文件的简单实现，仅使用HTML CSS JavaScript

```bash
git clone https://github.com/Ksdb104/webrtc-transfer-js
npm install
npm run start
```

若部署在服务器，需要先授予权限
```bash
chmod -R 755 *
```

然后pm2启动
```bash
pm2 start server.js
```

由于本例刚需HTTPS，可以考虑用Caddy反代
```
xxxx.com:port {
  reverse_proxy localhost:3000
}
```

# 在使用中遇到的一些问题
需要暂时关闭浏览器去广告插件的屏蔽webrtc的功能
<img width="1244" height="220" alt="image" src="https://github.com/user-attachments/assets/64f3cc44-4ff2-4285-b5c1-ec402f9935e6" />
和一些浏览器插件，例如
<img width="538" height="374" alt="image" src="https://github.com/user-attachments/assets/4056a8b2-c2a2-4da9-90b4-c83bbfef4384" />

在PC端需要关闭TUN/TAP的系统级代理，路由器挂载的代理可能也需要关闭，这会干扰udp流。
但在移动端则需要开启代理否则无法添加文件，不过这也可能是我的服务部署在海外的原因。

传统的webrtc内存传输方式因为浏览器可操作的内存限制（通常来说如果总内存<16GB，则为2GB，若>16GB，则为4-8GB）会制约传输文件的大小，超出限制在传输时页面有概率会爆内存。

因此本例使用了一个实验性API [**showSaveFilePicker()**](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)
实测46GB的大模型GGUF切片文件可以正常传输

但此API只能使用在安全上下文（HTTPS，127.0.0.1或localhost），并且兼容性堪忧
<img width="1590" height="760" alt="image" src="https://github.com/user-attachments/assets/e5abd4e8-68bd-4e5a-a2be-0d7b9a609f42" />
