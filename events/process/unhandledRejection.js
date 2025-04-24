// events/process/unhandledRejection.js
// Handles unhandled promise rejections in the Node.js process.

const logger = require('../../utils/logger'); // Adjust path as needed

// The 'event' parameter here is the error/reason for the rejection
// The 'promise' parameter is the promise that was rejected
module.exports = (client, reason, promise) => {
    logger.error('Unhandled Promise Rejection:', reason);

    // Optional: Log more details about the promise if helpful
    // console.error('Unhandled Rejection at:', promise);

    // Depending on the severity or type of rejection, you might:
    // 1. Just log it (as done above).
    // 2. Send a notification to a monitoring channel/service.
    // 3. Attempt graceful shutdown in critical cases (though often difficult).

    // Example: Sending to a specific Discord channel (if client is available and ready)
    /*
    if (client && client.isReady()) {
        const channelId = 'YOUR_LOGGING_CHANNEL_ID'; // Replace with actual channel ID
        const channel = client.channels.cache.get(channelId);
        if (channel && channel.isTextBased()) {
            const errorMessage = `**Unhandled Promise Rejection:**\n\`\`\`${reason?.stack || reason}\`\`\``;
            // Split message if too long
            const chunks = errorMessage.match(/[\s\S]{1,1990}/g) || []; // Split into chunks < 2000 chars
            for (const chunk of chunks) {
                 channel.send(chunk).catch(e => logger.error("Failed to send rejection log to Discord:", e));
            }
        } else {
             logger.warn(`Log channel ${channelId} not found or not text-based for rejection logging.`);
        }
    }
    */
};

// This event does not use 'once'
module.exports.once = false;
