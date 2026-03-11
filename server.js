import express from "express";
import http from "http";
import { Server } from "socket.io";
import os from "os";
import qrcode from "qrcode";
import fs from "fs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- LOAD CONFIG ---
let config;
try {
  const configData = fs.readFileSync("config.json", "utf8");
  config = JSON.parse(configData);
} catch (err) {
  console.error("[FATAL] Could not read config.json.", err);
  process.exit(1);
}

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Load existing files from uploads directory on startup
function loadExistingFiles() {
  try {
    const files = fs.readdirSync(uploadsDir);
    let loadedCount = 0;

    files.forEach(filename => {
      const filePath = path.join(uploadsDir, filename);

      // Skip if file doesn't exist (race condition)
      if (!fs.existsSync(filePath)) return;

      const stats = fs.statSync(filePath);

      if (stats.isFile()) {
        const ext = path.extname(filename).toLowerCase();
        const videoExts = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.3gp'];
        const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
        const pdfExts = ['.pdf'];

        let fileType = null;
        if (videoExts.includes(ext)) {
          fileType = 'local_video';
        } else if (audioExts.includes(ext)) {
          fileType = 'local_audio';
        } else if (pdfExts.includes(ext)) {
          fileType = 'pdf';
        }

        if (fileType && !uploadedFiles.has(filename)) {
          const fileInfo = {
            id: filename,
            originalName: filename,
            url: `/uploads/${filename}`,
            type: fileType,
            size: stats.size,
            uploadedAt: stats.birthtime.toISOString()
          };

          uploadedFiles.set(filename, fileInfo);
          loadedCount++;
        }
      }
    });

    if (loadedCount > 0) {
      console.log(`[STARTUP] Loaded ${loadedCount} existing file(s) from uploads directory`);
    }
  } catch (error) {
    console.error('[ERROR] Failed to load existing files:', error);
  }
}

// Watch uploads directory for changes
function watchUploadsDirectory() {
  console.log('[WATCHER] Monitoring /uploads folder for changes...');

  fs.watch(uploadsDir, (eventType, filename) => {
    if (!filename) return;

    const filePath = path.join(uploadsDir, filename);

    // File added or modified
    if (eventType === 'rename' || eventType === 'change') {
      // Use setTimeout to avoid catching incomplete file writes
      setTimeout(() => {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);

          if (stats.isFile() && !uploadedFiles.has(filename)) {
            const ext = path.extname(filename).toLowerCase();
            const videoExts = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.3gp'];
            const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
            const pdfExts = ['.pdf'];

            let fileType = null;
            if (videoExts.includes(ext)) {
              fileType = 'local_video';
            } else if (audioExts.includes(ext)) {
              fileType = 'local_audio';
            } else if (pdfExts.includes(ext)) {
              fileType = 'pdf';
            }

            if (fileType) {
              const fileInfo = {
                id: filename,
                originalName: filename,
                url: `/uploads/${filename}`,
                type: fileType,
                size: stats.size,
                uploadedAt: stats.birthtime.toISOString()
              };

              uploadedFiles.set(filename, fileInfo);
              console.log(`[WATCHER] New file detected: ${filename} (${fileType})`);

              // Notify all controllers about new file
              io.to('controllers').emit('file_added', fileInfo);
            }
          }
        } else {
          // File deleted
          if (uploadedFiles.has(filename)) {
            console.log(`[WATCHER] File removed: ${filename}`);
            uploadedFiles.delete(filename);

            // Check if deleted file is currently playing
            if (currentMediaState.fileUrl && currentMediaState.fileUrl.includes(filename)) {
              console.log(`[WATCHER] Currently playing file deleted, stopping playback`);

              currentMediaState = {
                mediaType: null,
                videoId: null,
                fileUrl: null,
                fileName: null,
                time: 0,
                isPlaying: false,
                volume: currentMediaState.volume,
                isMuted: currentMediaState.isMuted,
                lastUpdate: Date.now()
              };

              io.emit("command", { type: "stop" });
              io.emit("current_state", currentMediaState);
            }

            // Notify controllers about file removal
            io.to('controllers').emit('file_removed', { filename });
          }
        }
      }, 500); // Wait 500ms to ensure file write is complete
    }
  });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|mp3|webm|ogg|wav|m4a|mkv|avi|mov|flv|wmv|m4v|3gp|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype.startsWith('video/') ||
      file.mimetype.startsWith('audio/') ||
      file.mimetype === 'application/pdf';

    if (mimetype || extname) {
      return cb(null, true);
    }
    cb(new Error("Invalid file type. Only video, audio, and PDF files are allowed."));
  }
});

// Helper: Get local IPv4 address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

const SERVER_IP = config.HOTSPOT_IP || getLocalIP();
const PORT = process.env.PORT || 8000;

// Initialize Express + HTTP + Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8 // 100MB for large file transfers
});

// Serve static files
app.use(express.static("public"));
app.use(express.json());

// MIME type mapping
const mimeTypes = {
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.3gp': 'video/3gpp',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  // Documents
  '.pdf': 'application/pdf'
};

// Custom range request handler for video/audio streaming (critical for mobile)
app.use("/uploads", (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  const mimeType = mimeTypes[ext];
  const isMedia = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.3gp', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext);

  // Set CORS headers for all media requests
  if (isMedia) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Accept-Ranges', 'bytes');

    // Set proper content type
    if (mimeType) {
      res.setHeader('Content-Type', mimeType);
    }
  }

  // Handle OPTIONS request for CORS preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  // Handle Range requests for video/audio streaming (critical for mobile)
  if (isMedia && req.headers.range) {
    const filePath = path.join(uploadsDir, decodeURIComponent(req.path));

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Parse Range header
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Validate range
    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    const chunkSize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);
    if (mimeType) {
      res.setHeader('Content-Type', mimeType);
    }

    file.pipe(res);
    return;
  }

  next();
}, express.static(uploadsDir, {
  setHeaders: (res, filePath) => {
    // Additional headers for better mobile compatibility
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Ensure proper content type is set
    const ext = path.extname(filePath).toLowerCase();
    if (mimeTypes[ext]) {
      res.setHeader('Content-Type', mimeTypes[ext]);
    }
  }
}));

// Track connected clients and controllers
const clients = new Map();
const controllers = new Map();
const uploadedFiles = new Map(); // Track uploaded files
// Track one controlling "host" controller per IP
const hostControllersByIP = new Map(); // ip -> socket.id
// Track blocked/kicked clients by IP (blocked for this session)
const blockedClients = new Set(); // Set of blocked IPs
// Track pending clients awaiting controller approval
const pendingClients = new Map(); // socket.id -> { name, ip, socket, requestedAt }
// Track chat users
const chatUsers = new Map(); // socket.id -> { name, role, joinedAt }

// Session logging
const sessionStartTime = new Date();
const sessionLogs = [];

function logSession(message) {
  const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const logEntry = `[${timestamp}] ${message}`;
  sessionLogs.push(logEntry);
  console.log(logEntry);
}

// Save session log to file on shutdown (saves to root folder)
function saveSessionLog() {
  const endTime = new Date();
  const dateStr = endTime.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, '-');
  const timeStr = endTime.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }).replace(/:/g, '-');
  const filename = `Media_Sync_${dateStr}_${timeStr}.txt`;
  const filepath = path.join(__dirname, filename); // Save to root folder

  const header = [
    "═".repeat(60),
    "MEDIA SYNC SESSION LOG",
    "═".repeat(60),
    `Session Start: ${sessionStartTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    `Session End: ${endTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    `Duration: ${Math.round((endTime - sessionStartTime) / 1000 / 60)} minutes`,
    `Total Clients Connected: ${clients.size}`,
    `Total Controllers Connected: ${controllers.size}`,
    `Blocked IPs: ${blockedClients.size}`,
    "═".repeat(60),
    "",
    "SESSION ACTIVITY:",
    "-".repeat(40),
    ""
  ].join("\n");

  const content = header + sessionLogs.join("\n");

  try {
    fs.writeFileSync(filepath, content, "utf8");
    console.log(`\n[SESSION] Log saved to: ${filepath}`);
  } catch (err) {
    console.error("[ERROR] Failed to save session log:", err);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logSession("Server shutting down (SIGINT)");
  saveSessionLog();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logSession("Server shutting down (SIGTERM)");
  saveSessionLog();
  process.exit(0);
});

process.on('exit', () => {
  // Final save attempt
});

// WiFi Configuration
const WIFI_CONFIG = {
  ssid: process.env.WIFI_SSID || config.WIFI_SSID,
  password: process.env.WIFI_PASSWORD || config.WIFI_PASSWORD,
  security: "WPA"
};

// Unified Media State
let currentMediaState = {
  mediaType: null, // "youtube", "local_video", "local_audio"
  videoId: null, // For YouTube
  fileUrl: null, // For local files
  fileName: null, // Original file name
  time: 0,
  isPlaying: false,
  volume: 100,
  isMuted: false,
  lastUpdate: Date.now()
};

// Compute the effective media state at "now", including elapsed play time
function getEffectiveMediaState() {
  const state = { ...currentMediaState };

  if (state.mediaType && state.isPlaying) {
    const elapsedSeconds = (Date.now() - state.lastUpdate) / 1000;
    if (!Number.isNaN(elapsedSeconds) && elapsedSeconds > 0) {
      state.time = (state.time || 0) + elapsedSeconds;
    }
  }

  return state;
}

// Banner
function printBanner(ip, port) {
  console.clear();
  console.log("\n");
  console.log("═".repeat(70));
  console.log("   MULTI-MEDIA SYNC SERVER");
  console.log("═".repeat(70));
  console.log(`   Status:       Running`);
  console.log(`   Local Time:   ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
  console.log(`   Server IP:    ${ip} (Manual: ${!!config.HOTSPOT_IP})`);
  console.log(`   Port:         ${port}`);
  console.log("");
  console.log(`   WiFi Network: ${WIFI_CONFIG.ssid}`);
  console.log(`   Password:     ${WIFI_CONFIG.password}`);
  console.log("");
  console.log(`   Controller URL:`);
  console.log(`   http://${ip}:${port}/controller.html`);
  console.log("");
  console.log(`   Client URL:`);
  console.log(`   http://${ip}:${port}/client.html`);
  console.log("");
  console.log("   Supports: YouTube | Local Video | Local Audio");
  console.log("═".repeat(70));
  console.log("   Waiting for connections...\n");
}

// Generate WiFi QR code
function generateWiFiQR(ssid, password, security = "WPA") {
  return `WIFI:T:${security};S:${ssid};P:${password};;`;
}

// API Endpoints
app.get("/api/wifi-qr", async (req, res) => {
  try {
    const wifiString = generateWiFiQR(WIFI_CONFIG.ssid, WIFI_CONFIG.password, WIFI_CONFIG.security);
    const qrDataURL = await qrcode.toDataURL(wifiString, {
      errorCorrectionLevel: "H",
      type: "image/png",
      quality: 0.95,
      margin: 1,
      color: { dark: "#000000", light: "#FFFFFF" },
      width: 300
    });
    res.json({ qrCode: qrDataURL, ssid: WIFI_CONFIG.ssid });
  } catch (error) {
    console.error("[ERROR] QR generation failed:", error);
    res.status(500).json({ error: "QR code generation failed" });
  }
});

app.get("/api/connection-qr", async (req, res) => {
  try {
    const ip = SERVER_IP;
    const port = PORT;
    const urls = {
      controller: `http://${ip}:${port}/controller.html`,
      client: `http://${ip}:${port}/client.html`
    };

    const controllerQR = await qrcode.toDataURL(urls.controller, { width: 250 });
    const clientQR = await qrcode.toDataURL(urls.client, { width: 250 });

    res.json({ controllerQR, clientQR, urls });
  } catch (error) {
    res.status(500).json({ error: "QR code generation failed" });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    clients: clients.size,
    controllers: controllers.size,
    currentMedia: currentMediaState,
    uploadedFiles: uploadedFiles.size,
    uptime: process.uptime(),
    serverTime: new Date().toISOString()
  });
});

app.get("/api/clients", (req, res) => {
  const clientList = Array.from(clients.values()).map(c => ({
    id: c.id,
    ip: c.ip,
    connectedAt: c.connectedAt,
    lastSeen: c.lastSeen
  }));
  res.json({ clients: clientList, count: clients.size });
});

// File upload endpoint
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileUrl = `/uploads/${req.file.filename}`;

    let fileType;
    if (req.file.mimetype.startsWith("video")) {
      fileType = "local_video";
    } else if (req.file.mimetype.startsWith("audio")) {
      fileType = "local_audio";
    } else if (req.file.mimetype === "application/pdf") {
      fileType = "pdf";
    } else {
      fileType = "local_audio"; // fallback
    }

    const fileInfo = {
      id: req.file.filename,
      originalName: req.file.originalname,
      url: fileUrl,
      type: fileType,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    uploadedFiles.set(req.file.filename, fileInfo);

    console.log(`[UPLOAD] ${fileType.toUpperCase()}: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

    res.json({
      success: true,
      file: fileInfo
    });
  } catch (error) {
    console.error("[ERROR] Upload failed:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Get list of uploaded files
app.get("/api/files", (req, res) => {
  const fileList = Array.from(uploadedFiles.values());
  res.json({ files: fileList, count: fileList.length });
});

// Force re-scan uploads directory
app.post("/api/files/rescan", (req, res) => {
  try {
    console.log('[RESCAN] Manually rescanning uploads directory...');
    const beforeCount = uploadedFiles.size;

    loadExistingFiles(); // Re-run the scan

    const afterCount = uploadedFiles.size;
    const newFiles = afterCount - beforeCount;

    console.log(`[RESCAN] Complete. Total files: ${afterCount} (${newFiles >= 0 ? '+' : ''}${newFiles} change)`);

    const fileList = Array.from(uploadedFiles.values());
    res.json({
      success: true,
      files: fileList,
      count: afterCount,
      newFiles: newFiles
    });
  } catch (error) {
    console.error('[ERROR] Rescan failed:', error);
    res.status(500).json({ error: 'Rescan failed' });
  }
});

// Delete uploaded file
app.delete("/api/files/:filename", (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      const deletedFile = uploadedFiles.get(filename);
      uploadedFiles.delete(filename);
      console.log(`[DELETE] File removed: ${filename}`);

      // Notify all clients if this file is currently playing
      if (currentMediaState.fileUrl && currentMediaState.fileUrl.includes(filename)) {
        console.log(`[DELETE] Currently playing file deleted, stopping playback on all clients`);

        // Reset media state
        currentMediaState = {
          mediaType: null,
          videoId: null,
          fileUrl: null,
          fileName: null,
          time: 0,
          isPlaying: false,
          volume: currentMediaState.volume,
          isMuted: currentMediaState.isMuted,
          lastUpdate: Date.now()
        };

        // Broadcast stop command to all clients
        io.emit("command", { type: "stop" });
        io.emit("current_state", currentMediaState);
      }

      res.json({ success: true, message: "File deleted" });
    } else {
      res.status(404).json({ error: "File not found" });
    }
  } catch (error) {
    console.error("[ERROR] Delete failed:", error);
    res.status(500).json({ error: "Delete failed" });
  }
});

// Socket.IO Connection Handling
io.on("connection", (socket) => {
  const clientIP = socket.handshake.headers["x-forwarded-for"]?.split(',')[0] || socket.conn.remoteAddress;
  const userAgent = socket.handshake.headers["user-agent"] || "Unknown";

  logSession(`[CONNECTION] New socket: ${socket.id} | IP: ${clientIP}`);

  socket.on("identify", (data) => {
    const role = data?.role === "controller" ? "controller" : "client";

    // Check if this client IP is blocked (only for clients, not controllers)
    if (role === "client" && blockedClients.has(clientIP)) {
      logSession(`[BLOCKED] Rejected connection from blocked IP: ${clientIP}`);
      socket.emit("kicked", { message: "You have been blocked from this session" });
      socket.disconnect(true);
      return;
    }

    const name = data?.name || `${role}_${socket.id.substring(0, 6)}`;
    const metadata = {
      id: socket.id,
      name: name,
      ip: clientIP,
      userAgent,
      connectedAt: new Date().toISOString(),
      lastSeen: Date.now()
    };

    if (role === "controller") {
      // Enforce exactly one controlling "host" per IP.
      // First controller from an IP becomes host; others from same IP are view-only.
      let isHost = false;
      if (!hostControllersByIP.has(clientIP)) {
        hostControllersByIP.set(clientIP, socket.id);
        isHost = true;
        logSession(`[CONTROLLER] Registered HOST: ${name} | IP: ${clientIP}`);
      } else {
        logSession(`[CONTROLLER] Registered NON-HOST: ${name} | IP: ${clientIP}`);
      }

      controllers.set(socket.id, { ...metadata, isHost });
      socket.join("controllers"); // Join controllers room for targeted broadcasts

      // Inform this controller of effective current state and host status
      socket.emit("current_state", getEffectiveMediaState());
      socket.emit("host_status", { isHost, ip: clientIP });
    } else {
      // Client needs controller permission to join
      // Add to pending clients and notify controllers
      pendingClients.set(socket.id, {
        ...metadata,
        socket: socket
      });

      logSession(`[PENDING] Client requesting permission: ${name} | IP: ${clientIP}`);

      // Notify client they're waiting for permission
      socket.emit("waiting_for_permission", {
        message: "Waiting for controller permission to join..."
      });

      // Notify all controllers about the join request
      io.to("controllers").emit("join_request", {
        socketId: socket.id,
        name: name,
        ip: clientIP,
        requestedAt: new Date().toISOString()
      });

      // Broadcast updated pending count to controllers
      io.to("controllers").emit("pending_count", { count: pendingClients.size });
    }
  });

  // Approve client join request (only host controllers)
  socket.on("approve_client", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) {
      console.log(`[WARNING] Approve ignored from non-host: ${socket.id}`);
      return;
    }

    const clientSocketId = data?.socketId;
    if (!clientSocketId || !pendingClients.has(clientSocketId)) {
      console.log(`[WARNING] Client not found in pending list: ${clientSocketId}`);
      return;
    }

    const pendingClient = pendingClients.get(clientSocketId);
    pendingClients.delete(clientSocketId);

    // Add to active clients
    const { socket: clientSocket, ...metadata } = pendingClient;
    clients.set(clientSocketId, metadata);

    logSession(`[APPROVED] Client joined: ${metadata.name} | IP: ${metadata.ip} | Approved by: ${controllerMeta.name}`);

    // Notify the client they're approved
    clientSocket.emit("permission_granted", { message: "Permission granted! Joining session..." });
    clientSocket.emit("current_state", getEffectiveMediaState());

    // Notify controllers to remove from pending list
    io.to("controllers").emit("join_request_resolved", { socketId: clientSocketId, approved: true });
    io.to("controllers").emit("pending_count", { count: pendingClients.size });

    // Broadcast updated device list
    broadcastDeviceList();
  });

  // Reject client join request (only host controllers)
  socket.on("reject_client", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) {
      console.log(`[WARNING] Reject ignored from non-host: ${socket.id}`);
      return;
    }

    const clientSocketId = data?.socketId;
    if (!clientSocketId || !pendingClients.has(clientSocketId)) {
      console.log(`[WARNING] Client not found in pending list: ${clientSocketId}`);
      return;
    }

    const pendingClient = pendingClients.get(clientSocketId);
    pendingClients.delete(clientSocketId);

    logSession(`[REJECTED] Client denied: ${pendingClient.name} | IP: ${pendingClient.ip} | Rejected by: ${controllerMeta.name}`);

    // Notify the client they're rejected
    pendingClient.socket.emit("permission_denied", {
      message: "Please take permission of Controller"
    });

    // Notify controllers to remove from pending list
    io.to("controllers").emit("join_request_resolved", { socketId: clientSocketId, approved: false });
    io.to("controllers").emit("pending_count", { count: pendingClients.size });
  });

  // Kick client functionality (only host controllers can kick)
  socket.on("kick_client", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) {
      console.log(`[WARNING] Kick ignored from non-host: ${socket.id}`);
      return;
    }

    const clientId = data?.clientId;
    if (!clientId) return;

    const clientSocket = io.sockets.sockets.get(clientId);
    if (clientSocket && clients.has(clientId)) {
      const clientInfo = clients.get(clientId);

      // Add client IP to blocklist to prevent reconnection
      blockedClients.add(clientInfo.ip);
      logSession(`[KICK] Client kicked and blocked: ${clientInfo.name} | IP: ${clientInfo.ip}`);

      clientSocket.emit("kicked", { message: "You have been removed and blocked from this session" });
      clientSocket.disconnect(true);
    }
  });

  // ============================================
  // CHAT FUNCTIONALITY
  // ============================================

  // Chat user identification
  socket.on("identify_chat", (data) => {
    const name = data?.name || `User_${socket.id.substring(0, 6)}`;
    const role = data?.role || 'client';

    chatUsers.set(socket.id, {
      id: socket.id,
      name: name,
      role: role,
      joinedAt: new Date().toISOString()
    });

    socket.join("chat_room");

    // Broadcast updated count
    io.to("chat_room").emit("chat_online_count", chatUsers.size);

    // Notify others of new user
    socket.to("chat_room").emit("chat_user_joined", { name: name, role: role });

    logSession(`[CHAT] User joined: ${name} (${role})`);
  });

  // Chat message sending
  socket.on("chat_send", (data) => {
    const user = chatUsers.get(socket.id);
    if (!user) return;

    const message = data.message?.substring(0, 500) || '';
    if (!message.trim()) return;

    const messageData = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      senderId: socket.id,
      senderName: user.name,
      senderRole: user.role,
      message: message,
      timestamp: new Date().toISOString()
    };

    // Broadcast to all chat users
    io.to("chat_room").emit("chat_broadcast", messageData);

    logSession(`[CHAT] ${user.name}: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
  });

  // Function to broadcast device list to all controllers
  function broadcastDeviceList() {
    const clientList = Array.from(clients.values()).map(c => ({
      id: c.id,
      name: c.name,
      ip: c.ip,
      connectedAt: c.connectedAt
    }));

    const controllerList = Array.from(controllers.values()).map(c => ({
      id: c.id,
      name: c.name,
      ip: c.ip,
      isHost: c.isHost,
      connectedAt: c.connectedAt
    }));

    io.to("controllers").emit("device_list", {
      clients: clientList,
      controllers: controllerList,
      clientCount: clients.size,
      controllerCount: controllers.size
    });

    io.emit("clients_count", { clients: clients.size, controllers: controllers.size });
  }

  socket.on("command", (data) => {
    const controllerMeta = controllers.get(socket.id);
    // Only host controllers are allowed to issue commands
    if (!controllerMeta || !controllerMeta.isHost) {
      console.log(`[WARNING] Command ignored from non-host controller: ${socket.id}`);
      return;
    }

    // Special handling for "sync" – broadcast authoritative state to all clients
    if (data.type === "sync") {
      const effectiveState = getEffectiveMediaState();
      console.log("[COMMAND] SYNC | Broadcasting current state to all clients");
      io.emit("current_state", effectiveState);
      return;
    }

    logSession(`[COMMAND] ${data.type.toUpperCase()} | Type: ${data.mediaType || 'N/A'}`);

    // Handle load
    if (data.type === "load") {
      if (data.mediaType === "youtube") {
        let videoId = null;

        if (data.url) {
          const ytMatch = data.url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
          videoId = ytMatch ? ytMatch[1] : null;
          if (!videoId) {
            socket.emit("error", { message: "Invalid YouTube URL" });
            return;
          }
        } else if (data.videoId) {
          videoId = data.videoId;
        }

        if (!videoId) {
          socket.emit("error", { message: "Invalid YouTube URL or ID" });
          return;
        }

        currentMediaState = {
          mediaType: "youtube",
          videoId,
          fileUrl: null,
          fileName: null,
          time: 0,
          isPlaying: true,
          volume: currentMediaState.volume,
          isMuted: currentMediaState.isMuted,
          lastUpdate: Date.now()
        };

        const broadcastData = {
          type: "load",
          mediaType: "youtube",
          videoId,
          time: 0
        };
        // Send load command to all (including the issuing controller)
        io.emit("command", broadcastData);
        io.emit("current_state", getEffectiveMediaState());
        return;
      }
      else if (data.mediaType === "local_video" || data.mediaType === "local_audio") {
        if (!data.fileUrl) {
          socket.emit("error", { message: "File URL is required" });
          return;
        }

        currentMediaState = {
          mediaType: data.mediaType,
          videoId: null,
          fileUrl: data.fileUrl,
          fileName: data.fileName || "Unknown",
          time: 0,
          isPlaying: true,
          volume: currentMediaState.volume,
          isMuted: currentMediaState.isMuted,
          lastUpdate: Date.now()
        };

        const broadcastData = {
          type: "load",
          mediaType: data.mediaType,
          fileUrl: data.fileUrl,
          fileName: data.fileName,
          time: 0
        };
        // Send load command to all (including the issuing controller)
        io.emit("command", broadcastData);
        io.emit("current_state", getEffectiveMediaState());
        return;
      }
      else if (data.mediaType === "pdf") {
        if (!data.fileUrl) {
          socket.emit("error", { message: "PDF URL is required" });
          return;
        }

        currentMediaState = {
          mediaType: "pdf",
          videoId: null,
          fileUrl: data.fileUrl,
          fileName: data.fileName || "PDF Document",
          pdfPage: 1,
          pdfZoom: 1,
          time: 0,
          isPlaying: false,
          volume: currentMediaState.volume,
          isMuted: currentMediaState.isMuted,
          lastUpdate: Date.now()
        };

        const broadcastData = {
          type: "load",
          mediaType: "pdf",
          fileUrl: data.fileUrl,
          fileName: data.fileName,
          pdfPage: 1,
          pdfZoom: 1
        };
        // Send load command to all (including the issuing controller)
        io.emit("command", broadcastData);
        io.emit("current_state", getEffectiveMediaState());
        logSession(`[PDF] Loaded: ${data.fileName}`);
        return;
      }
    }

    // Handle other commands
    updateMediaState(data);
    // Broadcast control commands to everyone (controller + all clients)
    io.emit("command", data);
  });

  // ============================================
  // PDF SYNC FUNCTIONALITY
  // ============================================

  // PDF page navigation
  socket.on("pdf_page", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) return;

    if (currentMediaState.mediaType === "pdf") {
      currentMediaState.pdfPage = data.page || 1;
      currentMediaState.lastUpdate = Date.now();
    }

    // Broadcast to all clients
    io.emit("pdf_page", data);
    logSession(`[PDF] Page: ${data.page}`);
  });

  // PDF zoom change
  socket.on("pdf_zoom", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) return;

    if (currentMediaState.mediaType === "pdf") {
      currentMediaState.pdfZoom = data.zoom || 1;
      currentMediaState.lastUpdate = Date.now();
    }

    io.emit("pdf_zoom", data);
    logSession(`[PDF] Zoom: ${data.zoom}`);
  });

  // PDF drawing/annotation sync
  socket.on("pdf_draw", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) return;

    // Broadcast drawing data to all clients
    socket.broadcast.emit("pdf_draw", data);
  });

  // PDF laser pointer sync
  socket.on("pdf_laser", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) return;

    // Broadcast laser pointer position to all clients
    socket.broadcast.emit("pdf_laser", data);
  });

  // PDF clear annotations
  socket.on("pdf_clear", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) return;

    io.emit("pdf_clear", data);
    logSession(`[PDF] Cleared annotations`);
  });

  // PDF scroll sync
  socket.on("pdf_scroll", (data) => {
    const controllerMeta = controllers.get(socket.id);
    if (!controllerMeta || !controllerMeta.isHost) return;

    socket.broadcast.emit("pdf_scroll", data);
  });

  socket.on("heartbeat", () => {
    const update = (map) => {
      if (map.has(socket.id)) {
        const item = map.get(socket.id);
        item.lastSeen = Date.now();
        map.set(socket.id, item);
      }
    };
    update(clients);
    update(controllers);
  });

  socket.on("request_sync", () => {
    if (clients.has(socket.id)) {
      socket.emit("current_state", getEffectiveMediaState());
    }
  });

  socket.on("disconnect", (reason) => {
    const clientMeta = clients.get(socket.id);
    const controllerMeta = controllers.get(socket.id);
    const chatUserMeta = chatUsers.get(socket.id);
    const pendingMeta = pendingClients.get(socket.id);

    const wasClient = clients.delete(socket.id);
    const wasController = controllers.delete(socket.id);
    const wasChatUser = chatUsers.delete(socket.id);
    const wasPending = pendingClients.delete(socket.id);

    // Handle pending client disconnect
    if (wasPending) {
      logSession(`[PENDING] Client disconnected before approval: ${pendingMeta?.name || socket.id}`);
      io.to("controllers").emit("join_request_resolved", { socketId: socket.id, approved: false, disconnected: true });
      io.to("controllers").emit("pending_count", { count: pendingClients.size });
    }

    if (wasClient) {
      logSession(`[CLIENT] Disconnected: ${clientMeta?.name || socket.id} | IP: ${clientMeta?.ip || 'unknown'} | Remaining: ${clients.size}`);
    }

    if (wasController) {
      logSession(`[CONTROLLER] Disconnected: ${controllerMeta?.name || socket.id} | IP: ${controllerMeta?.ip || 'unknown'}`);

      // If this controller was host for its IP, clear and optionally promote another controller from same IP
      if (controllerMeta?.isHost && controllerMeta.ip) {
        const existingHostId = hostControllersByIP.get(controllerMeta.ip);
        if (existingHostId === socket.id) {
          hostControllersByIP.delete(controllerMeta.ip);

          // Promote another controller from same IP, if any
          for (const [id, meta] of controllers.entries()) {
            if (meta.ip === controllerMeta.ip && !meta.isHost) {
              meta.isHost = true;
              controllers.set(id, meta);
              hostControllersByIP.set(meta.ip, id);
              io.to(id).emit("host_status", { isHost: true, ip: meta.ip });
              console.log(
                `[CONTROLLER] Promoted new HOST for IP ${meta.ip}: ${id}`
              );
              break;
            }
          }
        }
      }
    }

    // Handle chat user disconnect
    if (wasChatUser) {
      logSession(`[CHAT] User left: ${chatUserMeta?.name || socket.id}`);
      io.to("chat_room").emit("chat_user_left", { name: chatUserMeta?.name || 'Unknown' });
      io.to("chat_room").emit("chat_online_count", chatUsers.size);
    }

    broadcastDeviceList();
  });

  socket.on("error", (err) => {
    console.error(`[SOCKET ERROR] ${socket.id}:`, err.message);
  });
});

// Update media state
function updateMediaState(data) {
  switch (data.type) {
    case "play":
      // Resume playback from the last known time
      if (!currentMediaState.isPlaying) {
        currentMediaState.isPlaying = true;
        currentMediaState.lastUpdate = Date.now();
      }
      break;
    case "pause":
      // Freeze time at the point of pause
      if (currentMediaState.isPlaying) {
        const elapsedSeconds = (Date.now() - currentMediaState.lastUpdate) / 1000;
        if (!Number.isNaN(elapsedSeconds) && elapsedSeconds > 0) {
          currentMediaState.time = (currentMediaState.time || 0) + elapsedSeconds;
        }
      }
      currentMediaState.isPlaying = false;
      break;
    case "seek":
      currentMediaState.time = data.time || 0;
      currentMediaState.lastUpdate = Date.now();
      break;
    case "restart":
      currentMediaState.time = 0;
      currentMediaState.isPlaying = true;
      currentMediaState.lastUpdate = Date.now();
      break;
    case "volume":
      currentMediaState.volume = data.volume;
      break;
    case "mute":
      currentMediaState.isMuted = data.muted;
      break;
  }
}

// Cleanup stale connections
setInterval(() => {
  const now = Date.now();
  const timeout = 120000;

  for (const [id, client] of clients.entries()) {
    if (now - client.lastSeen > timeout) {
      console.log(`[CLEANUP] Stale client removed: ${id}`);
      clients.delete(id);
    }
  }
  io.emit("clients_count", { clients: clients.size, controllers: controllers.size });
}, 60000);

// 404 Fallback
app.use((req, res) => {
  res.status(404).send(`
    <pre style="font-family: monospace; color: white; background: #000; padding: 40px; text-align: center; font-size: 14px;">
╔══════════════════════════════════════════════════════════════╗
  MULTI-MEDIA SYNC SERVER ACTIVE
  Controller: http://${SERVER_IP}:${PORT}/controller.html
  Client:     http://${SERVER_IP}:${PORT}/client.html
  WiFi: ${WIFI_CONFIG.ssid} | Pass: ${WIFI_CONFIG.password}
  Supports: YouTube | Local Video | Local Audio
╚══════════════════════════════════════════════════════════════╝
    </pre>
  `);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[SHUTDOWN] Stopping server...");
  io.emit("server_shutdown", { message: "Server shutting down" });
  server.close(() => process.exit(0));
});

process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled Rejection:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught Exception:", err);
  process.exit(1);
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    clients: clients.size,
    controllers: controllers.size,
    media: currentMediaState.mediaType || "none",
    uploadedFiles: uploadedFiles.size
  });
});

// Start Server
server.listen(PORT, SERVER_IP, () => {
  printBanner(SERVER_IP, PORT);
  loadExistingFiles();
  watchUploadsDirectory();
});