const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const userSchema = new mongoose.Schema({
  username: String,
  email: String,
  role: String
});

const User = mongoose.model('User', userSchema);
const MONGO_URI = process.env.MONGO_URI;

async function checkUsers() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected!');

    const users = await User.find({});
    console.log('\n--- Current Users in MongoDB ---');
    if (users.length === 0) {
      console.log('No users found in the database.');
    } else {
      users.forEach(u => {
        console.log(`- Username: ${u.username}, Email: ${u.email}, Role: ${u.role}`);
      });
    }
    console.log('-------------------------------\n');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkUsers();
