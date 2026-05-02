const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

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

// Make io accessible to routes
app.set('io', io);

// Routes
app.use('/api', authRoutes);
app.use('/api', inspectionRoutes);

// Health check endpoint (no auth required)
app.get('/api/health', async (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({
    server: true,
    database: dbState === 1,
    databaseStatus: dbStatus[dbState] || 'unknown',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Socket.IO logic
let connectedClients = 0;

io.on('connection', (socket) => {
  connectedClients++;
  console.log(`Client connected: ${socket.id} (total: ${connectedClients})`);

  // Send connection count to all clients
  io.emit('clientCount', connectedClients);

  socket.on('disconnect', () => {
    connectedClients--;
    console.log(`Client disconnected: ${socket.id} (total: ${connectedClients})`);
    io.emit('clientCount', connectedClients);
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
    const fixedAdminEmail = 'bghassen239@gmail.com';
    const existingAdmin = await User.findOne({ email: fixedAdminEmail });

    if (!existingAdmin) {
      console.log(`[Seed] Creating fixed admin: ${fixedAdminEmail}`);
      const admin = new User({
        username: 'bghassen',
        email: fixedAdminEmail,
        password: 'Admin2025',
        role: 'admin',
        status: 'approved'
      });
      await admin.save();
    }

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
  });
