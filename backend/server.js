const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ── Auto-start Niryo MJPEG stream (port 5001) ────────────────────────────────
// Streams the Niryo Ned2 robot camera to the Angular dashboard.
// Requires: pip install flask flask-cors opencv-python pyniryo
// Safe to run even when the robot is offline — serves a placeholder until connected.
let niryoProc = null;

function startNiryoStream() {
  // Prevent duplicate processes — kill the old one first if still running
  if (niryoProc && !niryoProc.killed) {
    try { niryoProc.kill(); } catch (_) {}
    niryoProc = null;
  }

  const scriptPath = path.join(__dirname, 'niryo_stream.py');

  // Try python3 first, fall back to python
  const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
  const proc = spawn(pythonCmd, [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  niryoProc = proc;

  proc.stdout.on('data', (d) => process.stdout.write(`[niryo_stream] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[niryo_stream] ${d}`));

  proc.on('error', (err) => {
    console.warn(`[niryo_stream] Could not start — Python not found or pyniryo missing: ${err.message}`);
    niryoProc = null;
  });

  proc.on('close', (code) => {
    niryoProc = null;
    if (code !== 0) {
      console.warn(`[niryo_stream] Exited (code ${code}), retrying in 8 s…`);
      setTimeout(startNiryoStream, 8000);
    }
  });
}

startNiryoStream();

const authRoutes = require('./routes/auth');
const inspectionRoutes = require('./routes/inspection');
const authMiddleware = require('./middleware/auth');
const roleMiddleware = require('./middleware/role');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Attach io to requests for controllers
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Routes
app.use('/api', authRoutes);
app.use('/api', inspectionRoutes);

// ── Robot health polling + Socket.IO relay ──────────────────────────────────
// Polls niryo_stream.py /robot-health every 3s and pushes to all clients.
// New alerts (by id) trigger a separate 'robotAlert' event.
let latestRobotHealth = null;
const NIRYO_STREAM_URL = 'http://localhost:5001';

function startHealthPolling() {
  setInterval(async () => {
    try {
      const res = await fetch(`${NIRYO_STREAM_URL}/robot-health`);
      const health = await res.json();

      // Detect NEW alerts that weren't in the previous snapshot
      const prevAlertIds = new Set((latestRobotHealth?.alerts || []).map(a => a.id));
      const newAlerts = (health.alerts || []).filter(a => !prevAlertIds.has(a.id));

      latestRobotHealth = health;
      io.emit('robotHealth', health);
      newAlerts.forEach(alert => io.emit('robotAlert', alert));
    } catch (_) {
      // niryo_stream.py not running yet — ignore
    }
  }, 3000);
}

// ── Robot API routes (auth-protected) ───────────────────────────────────────
// GET  /api/robot/health  — worker + admin (for initial page load)
// POST /api/robot/action  — worker only (they operate the robot on the floor)

app.get('/api/robot/health', authMiddleware, roleMiddleware(['worker', 'admin']), (req, res) => {
  if (latestRobotHealth) {
    res.json(latestRobotHealth);
  } else {
    res.status(503).json({ message: 'Robot health data not available yet' });
  }
});

app.post('/api/robot/action', authMiddleware, roleMiddleware(['worker', 'admin']), async (req, res) => {
  const { action } = req.body;
  if (!action) {
    return res.status(400).json({ success: false, message: 'Missing "action" field' });
  }
  try {
    const pyRes = await fetch(`${NIRYO_STREAM_URL}/robot-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const result = await pyRes.json();
    res.status(pyRes.status).json(result);
  } catch (err) {
    res.status(503).json({ success: false, message: 'niryo_stream.py not reachable' });
  }
});

// Socket.IO logic
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Send latest health data immediately on connect
  if (latestRobotHealth) {
    socket.emit('robotHealth', latestRobotHealth);
  }

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Database connection
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('FATAL ERROR: MONGO_URI is not defined in .env file');
  process.exit(1);
}

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10,
  retryWrites: true
})
  .then(async () => {
    console.log('Connected to MongoDB');

    // Seed Fixed Admin
    const User = require('./models/User');
    const fixedAdminEmail = 'nourmessaoudi54@gmail.com';
    const existingAdmin = await User.findOne({ email: fixedAdminEmail });

    if (!existingAdmin) {
      console.log(`[Seed] Creating fixed admin: ${fixedAdminEmail}`);
      const admin = new User({
        username: 'nourmessaoudi',
        email: fixedAdminEmail,
        password: 'AdminIndustry2025', // Model pre-save hashes this
        role: 'admin',
        status: 'approved'
      });
      await admin.save();
    }

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      startHealthPolling();
      console.log('[robot-health] Polling niryo_stream.py every 3s');
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
  });
