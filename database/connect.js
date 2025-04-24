// database/connect.js
const mongoose = require('mongoose');
const logger = require('../utils/logger'); // Use the logger utility

const connectDB = async () => {
    if (!process.env.MONGO_URI) {
        logger.error('MONGO_URI not found in .env file. Database connection aborted.');
        // Depending on your bot's needs, you might allow it to run without a DB
        // or force exit. For features like user data, exiting is safer.
        process.exit(1);
    }

    try {
        // Mongoose connection options (adjust as needed)
        const connectionOptions = {
            // useNewUrlParser: true, // No longer needed in Mongoose 6+
            // useUnifiedTopology: true, // No longer needed in Mongoose 6+
            // useCreateIndex: true, // No longer needed
            // useFindAndModify: false, // No longer needed
            serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
            socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
            retryWrites: true,
            w: 'majority', // Write concern
        };

        await mongoose.connect(process.env.MONGO_URI, connectionOptions);

        // Optional: Listen for connection events
        mongoose.connection.on('connected', () => {
            logger.info('Mongoose connected to DB.');
        });

        mongoose.connection.on('error', (err) => {
            logger.error('Mongoose connection error:', err);
        });

        mongoose.connection.on('disconnected', () => {
            logger.warn('Mongoose disconnected from DB.');
            // Optional: Implement reconnection logic here if needed
        });

    } catch (err) {
        logger.error('Initial MongoDB connection error:', err);
        // Exit process on initial connection failure
        process.exit(1);
    }
};

module.exports = connectDB;
