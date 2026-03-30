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

// Routes
app.use('/api', authRoutes);
app.use('/api', inspectionRoutes);

// Socket.IO logic
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });

  // Real robot/AI alerts will be emitted here when integrated
  // socket.emit('alert', ...) - triggered by actual detection events only
});

// Database connection
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('FATAL ERROR: MONGO_URI is not defined in .env file');
  process.exit(1);
}

mongoose.connect(MONGO_URI)
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
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
  });
