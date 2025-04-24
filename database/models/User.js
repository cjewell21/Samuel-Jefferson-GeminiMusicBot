// database/models/User.js
const mongoose = require('mongoose');
const logger = require('../../utils/logger'); // Adjust path as needed

const userSchema = new mongoose.Schema({
    discordId: {
        type: String,
        required: true,
        unique: true, // Each Discord user should have only one entry
        index: true, // Index for faster lookups
    },
    discordTag: { // Store for reference, might change
        type: String,
        required: true,
    },
    // --- Spotify Data ---
    spotify: {
        userId: { type: String, index: true }, // Spotify User ID (e.g., '1188868611')
        accessToken: String,
        refreshToken: String,
        tokenExpiry: Date, // Store expiry time to know when to refresh
        scopes: [String], // Store granted permissions
        linkedAt: { type: Date, default: Date.now },
    },
    // --- AI Interaction History & Preferences ---
    aiInteractionHistory: [
        {
            role: { type: String, enum: ['user', 'model'], required: true }, // 'user' or 'model'
            parts: [{ text: String }], // Structure matching Gemini API
            timestamp: { type: Date, default: Date.now },
        }
    ],
    aiPersonalityPreference: { // User can potentially choose a variation
        type: String,
        default: 'default_founding_father', // Default personality
        // You could define specific personalities here or in config
    },
    // --- Bot Settings ---
    settings: {
        ttsEnabled: { type: Boolean, default: true },
        // Add other user-specific settings here
        // e.g., preferredVolume: { type: Number, default: 50, min: 0, max: 100 }
    },
    // --- Timestamps ---
    createdAt: {
        type: Date,
        default: Date.now,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
}, {
    // Automatically update `updatedAt` timestamp on modification
    timestamps: true,
});

// --- Schema Methods & Statics (Optional) ---

// Example: Method to check if Spotify token is expired
userSchema.methods.isSpotifyTokenExpired = function() {
    if (!this.spotify || !this.spotify.tokenExpiry) {
        return true; // No token or expiry date means it's effectively expired/invalid
    }
    // Add a buffer (e.g., 5 minutes) to refresh before actual expiry
    const bufferSeconds = 300;
    return Date.now() >= (this.spotify.tokenExpiry.getTime() - bufferSeconds * 1000);
};

// Example: Static method to find or create a user
userSchema.statics.findOrCreate = async function(discordId, discordTag) {
    try {
        let user = await this.findOne({ discordId: discordId });
        if (!user) {
            user = new this({ discordId: discordId, discordTag: discordTag });
            await user.save();
            logger.info(`Created new user entry for ${discordTag} (${discordId})`);
        } else if (user.discordTag !== discordTag) {
            // Update tag if it has changed
            user.discordTag = discordTag;
            await user.save();
        }
        return user;
    } catch (error) {
        logger.error(`Error finding or creating user ${discordId}:`, error);
        // Attempt to handle potential schema read errors / inconsistencies
        if (error.name === 'ValidationError' || error.name === 'CastError') {
             logger.warn(`Potential schema mismatch for user ${discordId}. Check DB structure against model.`);
             // You might try fetching with lean() or specific fields to bypass schema issues temporarily
             // Or implement more robust error recovery/migration logic
             return this.findOne({ discordId: discordId }).lean(); // Example: Fetch raw data
        }
        throw error; // Re-throw other errors
    }
};


// --- Error Handling Middleware (Example) ---
// Handle errors during save operations, e.g., unique constraint violation
userSchema.post('save', function(error, doc, next) {
  if (error.name === 'MongoServerError' && error.code === 11000) {
    // Duplicate key error (e.g., trying to insert user with existing discordId)
    logger.warn(`Attempted to save duplicate user entry: ${doc.discordId}`);
    // You might want to just log this and continue, or handle it differently
    next(); // Call next() without an error to prevent crashing the save operation
  } else if (error) {
     logger.error(`Error saving user ${doc.discordId}:`, error);
     next(error); // Pass other errors along
  } else {
    next(); // Continue if no error
  }
});


const User = mongoose.model('User', userSchema);

module.exports = User;
