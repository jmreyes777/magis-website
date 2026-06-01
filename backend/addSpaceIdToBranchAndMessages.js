// Load environment variables
require('dotenv').config({ path: './backend.env' });

const mongoose = require('mongoose');
const Branch = require('./models/Branch'); // Adjusted path for Branch model
const Message = require('./models/Message'); // Adjusted path for Message model

const migrateSpaceId = async () => {
  console.log('Connecting to MongoDB...');
  try {
    // Connect to MongoDB using the URI from the environment variables
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('Connected to MongoDB');

    // Step 1: Add spaceId to branches that are missing it
    console.log('Adding spaceId to branches...');
    const branches = await Branch.find({ spaceId: { $exists: false } });
    for (const branch of branches) {
      const spaceId = `spaces/${branch._id}`; // Example logic for generating spaceId
      branch.spaceId = spaceId;
      await branch.save();
      console.log(`Added spaceId ${spaceId} to branch ${branch.email}`);
    }

    // Step 2: Add spaceId to messages using branchEmail
    console.log('Adding spaceId to messages...');
    const messages = await Message.find({ spaceId: { $exists: false } });
    for (const message of messages) {
      const branch = await Branch.findOne({ email: message.branchEmail });
      if (branch && branch.spaceId) {
        message.spaceId = branch.spaceId;
        await message.save();
        console.log(`Added spaceId ${branch.spaceId} to message ${message._id}`);
      }
    }

    console.log('Migration completed successfully.');
  } catch (error) {
    console.error('Migration failed:', error.message);
  } finally {
    mongoose.connection.close();
  }
};

// Execute the migration
migrateSpaceId();