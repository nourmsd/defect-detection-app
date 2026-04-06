const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const userSchema = new mongoose.Schema({
  username: String,
  password: { type: String, required: true }
});

const User = mongoose.model('User', userSchema);
const MONGO_URI = process.env.MONGO_URI;

async function hashAllPasswords() {
  try {
    console.log('Connecting to MongoDB Atlas...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected!');

    const users = await User.find({});
    console.log(`Found ${users.length} users. Checking for plain text passwords...`);

    let updatedCount = 0;
    for (const user of users) {
      // Check if it's already a bcrypt hash
      const isHash = user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
      
      if (!isHash) {
        console.log(`Hashing password for user: ${user.username}`);
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(user.password, salt);
        await user.save();
        updatedCount++;
      } else {
        console.log(`User ${user.username} already has a hashed password. Skipping.`);
      }
    }

    console.log(`\nSuccess! ${updatedCount} passwords were hashed.`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error during hashing script:', err);
    process.exit(1);
  }
}

hashAllPasswords();
