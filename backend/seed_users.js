const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['worker', 'admin'], default: 'worker' }
});

const User = mongoose.model('User', userSchema);
const MONGO_URI = process.env.MONGO_URI;

async function seedUsers() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Clear existing users to avoid conflicts (Optional, but safer for this debugging task)
    // await User.deleteMany({});

    const usersToSeed = [
      {
        username: 'admin',
        email: 'admin@industry.com',
        password: 'AdminIndustry2025',
        role: 'admin'
      },
      {
        username: 'worker',
        email: 'worker@industry.com',
        password: 'worker2025',
        role: 'worker'
      }
    ];

    for (const u of usersToSeed) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(u.password, salt);
      
      await User.findOneAndUpdate(
        { username: u.username },
        { ...u, password: hashedPassword },
        { upsert: true, new: true }
      );
      console.log(`Seeded/Updated user: ${u.username}`);
    }

    console.log('Seeding completed successfully!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error seeding users:', err);
    process.exit(1);
  }
}

seedUsers();
