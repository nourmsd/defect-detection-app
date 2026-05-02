const User = require('../models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const {
  sendPendingEmail,
  sendApprovedEmail,
  sendEmail, // optional (for rejection)
} = require("../services/emailService");


// ================= REGISTER =================
exports.register = async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    // Check if user already exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    user = new User({
      username,
      email,
      password,
      role: role || 'worker',
      status: 'pending'
    });


    await user.save();

    // 📧 SEND PENDING EMAIL (SAFE)
    try {
      await sendPendingEmail(user.email);
    } catch (e) {
      console.error("❌ Failed to send pending email:", e.message);
    }

    console.log(`[Auth] Registered new user: ${email} (Status: pending)`);

    res.status(201).json({
      message: 'Registration successful! Your account is pending admin approval.'
    });

  } catch (err) {
    console.error(`[Auth] Registration error: ${err.message}`);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};


// ================= LOGIN =================
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log(`[Auth] Login attempt for email: ${email}`);

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'Email not found' });
    }

    // Allow fixed admin bypass
    const IS_FIXED_ADMIN = email === 'bghassen239@gmail.com';

    if (!IS_FIXED_ADMIN && user.status !== 'approved') {
      const msg =
        user.status === 'pending'
          ? 'Your account is pending admin approval'
          : 'Your account has been rejected';

      return res.status(403).json({ message: msg });
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const payload = {
      id: user._id,
      role: user.role,
      email: user.email
    };

    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '1d' }
    );

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


// ================= GET PENDING USERS =================
exports.getPendingWorkers = async (req, res) => {
  try {
    const pending = await User.find({ status: 'pending' }).select('-password');
    res.json(pending);
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching pending requests',
      error: err.message
    });
  }
};


// ================= VALIDATE WORKER =================
exports.validateWorker = async (req, res) => {
  try {
    const { userId, status, phone, role } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.status = status;

    if (phone) user.phone = phone;
    if (role) user.role = role;

    await user.save();

    // 📧 SEND EMAIL BASED ON STATUS
    try {
      if (status === "approved") {
        await sendApprovedEmail(user.email);
      }

      if (status === "rejected") {
        await sendEmail(
          user.email,
          "Account Rejected",
          "Your account has been rejected by the administrator."
        );
      }

    } catch (e) {
      console.error("❌ Failed to send status email:", e.message);
    }

    console.log(`[Admin] Moderated user ${user.email} -> Status: ${status}, Role: ${role || user.role}`);

    res.json({
      message: `User ${status} successfully!`,
      user
    });

  } catch (err) {
    res.status(500).json({
      message: 'Error validating user',
      error: err.message
    });
  }
};


// ================= RESET PASSWORD =================
exports.resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res.status(400).json({ message: 'Email and new password are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'Email not found in our system' });
    }

    if (user.status !== 'approved') {
      const msg =
        user.status === 'pending'
          ? 'Your account is not yet validated by the administrator'
          : 'Your account has been rejected';

      return res.status(403).json({ message: msg });
    }

    user.password = newPassword;
    await user.save();

    console.log(`[Auth] Password reset successful for: ${email}`);

    res.json({
      message: 'Password reset successfully! You can now log in.'
    });

  } catch (err) {
    console.error(`[Auth] Reset password error: ${err.message}`);
    res.status(500).json({
      message: 'Internal Server Error',
      error: err.message
    });
  }
};


// ================= GET ACTIVE WORKERS =================
exports.getActiveWorkers = async (req, res) => {
  try {
    const workers = await User.find({
      role: 'worker',
      status: 'approved'
    })
      .select('-password')
      .sort({ isOnline: -1, username: 1 });

    res.json(workers);

  } catch (err) {
    console.error(`[Admin] Error fetching workers: ${err.message}`);
    res.status(500).json({
      message: 'Error fetching workers',
      error: err.message
    });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching users', error: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findOneAndDelete({
      _id: userId,
      email: { $ne: 'bghassen239@gmail.com' }
    });
    if (!user) return res.status(404).json({ message: 'User not found or protected' });
    res.json({ message: `User ${user.email} deleted. Email is free to re-register.` });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting user', error: err.message });
  }
};