const User = require('../models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// Register a new user
exports.register = async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // Check if user already exists by email
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    user = new User({ 
      username, 
      email, 
      password, 
      role: 'worker', 
      status: 'pending' // Default to pending
    });
    await user.save();

    console.log(`[Auth] Registered new user: ${email} (Status: pending)`);
    res.status(201).json({ message: 'Registration successful! Your account is pending admin approval.' });
  } catch (err) {
    console.error(`[Auth] Registration error: ${err.message}`);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Login user
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(`[Auth] Login attempt for email: ${email}`);

    const user = await User.findOne({ email });
    if (!user) {
      console.warn(`[Auth] User not found: ${email}`);
      return res.status(404).json({ message: 'Email not found' });
    }

    // CHECK STATUS (EXCEPT FOR FIXED ADMIN)
    const IS_FIXED_ADMIN = email === 'nourmessaoudi54@gmail.com';
    if (!IS_FIXED_ADMIN && user.status !== 'approved') {
      const msg = user.status === 'pending' ? 'Your account is pending admin approval' : 'Your account has been rejected';
      console.warn(`[Auth] Prevented login for ${email}: Status is ${user.status}`);
      return res.status(403).json({ message: msg });
    }

    // STRICT SECURE PASSWORD CHECK
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      console.warn(`[Auth] Password mismatch for: ${email}`);
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const payload = { id: user._id, role: user.role, email: user.email };
    const token = jwt.sign(payload, process.env.JWT_SECRET || 'your_jwt_secret', { expiresIn: '1d' });

    // Set user online
    user.isOnline = true;
    await user.save();

    console.log(`[Auth] Login successful: ${email} (${user.role})`);
    res.json({ 
      token, 
      id: user._id, 
      username: user.username, 
      email: user.email, 
      role: user.role,
      status: user.status
    });
  } catch (err) {
    console.error(`[Auth] Server error: ${err.message}`);
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
  }
};

// GET PENDING USERS (ADMIN ONLY)
exports.getPendingWorkers = async (req, res) => {
  try {
    const pending = await User.find({ status: 'pending' }).select('-password');
    res.json(pending);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching pending requests', error: err.message });
  }
};

// VALIDATE WORKER (ADMIN ONLY)
exports.validateWorker = async (req, res) => {
  try {
    const { userId, status, phone, role } = req.body; // status = approved or rejected
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.status = status;
    if (phone) user.phone = phone;
    if (role) user.role = role;
    
    await user.save();
    console.log(`[Admin] Moderated user ${user.email} -> Status: ${status}, Role: ${role || user.role}`);
    
    res.json({ message: `User ${status} successfully!`, user });
  } catch (err) {
    res.status(500).json({ message: 'Error validating user', error: err.message });
  }
};

// Reset password (Secure Flow)
exports.resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    console.log(`[Auth] Password reset attempt for: ${email}`);

    if (!email || !newPassword) {
      return res.status(400).json({ message: 'Email and new password are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      console.warn(`[Auth] Reset failed: User not found for email ${email}`);
      return res.status(404).json({ message: 'Email not found in our system' });
    }

    // CHECK STATUS: Only approved users can reset passwords
    if (user.status !== 'approved') {
      const msg = user.status === 'pending' ? 'Your account is not yet validated by the administrator' : 'Your account has been rejected and cannot reset password';
      console.warn(`[Auth] Reset denied for ${email}: Status is ${user.status}`);
      return res.status(403).json({ message: msg });
    }

    // Update password (bcrypt hashing is handled by User.js pre-save hook)
    user.password = newPassword;
    await user.save();

    console.log(`[Auth] Password reset successful for: ${email}`);
    res.json({ message: 'Password reset successfully! You can now log in with your new password.' });
  } catch (err) {
    console.error(`[Auth] Reset password error: ${err.message}`);
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
  }
};

// GET ALL WORKERS (ADMIN ONLY) — includes online/offline status
exports.getActiveWorkers = async (req, res) => {
  try {
    const workers = await User.find({ role: 'worker', status: 'approved' })
      .select('-password')
      .sort({ isOnline: -1, username: 1 });
    res.json(workers);
  } catch (err) {
    console.error(`[Admin] Error fetching workers: ${err.message}`);
    res.status(500).json({ message: 'Error fetching workers', error: err.message });
  }
};

