// events/discord/ready.js
// Executes once the client is ready and logged in.

const { ActivityType } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path as needed
const config = require('../../config'); // Adjust path as needed

module.exports = async (client) => {
    // Indicate the bot is ready in the console
    logger.ready(`${client.user.tag}, servant to the principles of liberty and ready for discourse!`);
    logger.info(`Operating in ${client.guilds.cache.size} server(s).`);

    // Set bot presence (activity and status)
    try {
        const presenceOptions = {
             activities: config.botPresence.activities.map(activity => ({
                name: activity.name,
                type: ActivityType[activity.type] || ActivityType.Playing, // Ensure type is valid enum
                // url: activity.url // Add if type is Streaming
             })),
             status: config.botPresence.status || 'online',
        };
        client.user.setPresence(presenceOptions);
        logger.info(`Presence set to: ${presenceOptions.status} | ${presenceOptions.activities.map(a => `${ActivityType[a.type]} ${a.name}`).join(', ')}`);
    } catch (error) {
        logger.error('Failed to set bot presence:', error);
    }

    // Optional: Any other setup tasks to run on ready
    // - Cache specific channels or roles?
    // - Check database integrity?
    // - Initialize music queues if persisting them? (Generally not recommended, better to start fresh)
};

// Add 'once' property so the event handler only runs once
module.exports.once = true;
