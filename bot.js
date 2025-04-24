// bot.js
// Samuel Jefferson - A Bot of Reason and Rhythm

require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./utils/logger');
const connectDB = require('./database/connect');
const setupSpotifyAuthServer = require('./spotify/webserver');

// Client setup (Intents, Partials) - remains the same
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel],
});

// Global Variables & Collections - remains the same
client.commands = new Collection();
client.cooldowns = new Collection();
client.config = config;
client.logger = logger;
client.queues = new Map();

// --- Database Connection ---
connectDB().then(() => {
    logger.info('Successfully connected to MongoDB.');
}).catch(err => {
    logger.error('Failed to connect to MongoDB:', err);
    process.exit(1); // Exit if DB connection fails critically
});

// --- Load Handlers ---
logger.info('Loading handlers...');
const handlersPath = path.join(__dirname, 'handlers');
const handlerFiles = fs.readdirSync(handlersPath).filter(file => file.endsWith('.js'));
for (const file of handlerFiles) {
    try {
        const filePath = path.join(handlersPath, file);
        const handler = require(filePath);
        if (typeof handler === 'function') {
            handler(client); // Execute handler setup (e.g., commandHandler(client))
            logger.info(`Executed handler setup: ${file}`);
        } else { logger.warn(`Handler file ${file} does not export a function.`); }
    } catch (error) { logger.error(`Error executing handler setup from ${file}:`, error); }
}
logger.info('Handler setup complete.');


// --- Spotify OAuth Web Server ---
logger.info('Attempting to set up Spotify OAuth server...');
let spotifyServer = null; // Variable to hold the server instance if needed
try {
    // Pass client if needed within webserver routes (e.g., for DM confirmations)
    const serverSetupResult = setupSpotifyAuthServer(client);
    if (serverSetupResult && serverSetupResult.serverInstance) {
         spotifyServer = serverSetupResult.serverInstance; // Store the instance
         logger.info(`Spotify OAuth callback server setup initiated successfully.`);
         // No need to log "listening" here, webserver.js does that
    } else if (serverSetupResult === null) {
         logger.warn('Spotify OAuth server setup skipped due to missing configuration.');
    } else {
         logger.warn('Spotify OAuth server setup function did not return expected instance.');
    }
} catch (error) {
    logger.error('Critical error during Spotify OAuth server setup function call:', error);
    // Decide if this is fatal - maybe bot can run without it?
    // process.exit(1);
}


// --- High-Level Error Handling ---
process.on('uncaughtException', (error, origin) => {
    logger.error(`Uncaught exception at: ${origin}`, error);
    process.exit(1); // Exit on uncaught exceptions
});
process.on('warning', (warning) => {
     logger.warn(`Node Process Warning: ${warning.name}`, warning.message);
     logger.debug(warning.stack);
});
// unhandledRejection is handled by events/process/unhandledRejection.js


// --- Login to Discord ---
logger.info('Logging into Discord...');
if (!process.env.DISCORD_BOT_TOKEN) {
    logger.error("Discord bot token not found in .env file.");
    process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => {
        logger.info('Discord login successful. Bot should be ready soon.');
        // The 'ready' event handler (events/discord/ready.js) will log when fully ready.
    })
    .catch(err => {
        logger.error('Failed to log in to Discord:', err);
        if (err.code === 'DisallowedIntents') {
             logger.error('Ensure all required intents are enabled in the Discord Developer Portal!');
        }
        process.exit(1); // Exit if login fails
    });

// --- Graceful Shutdown (Optional but Recommended) ---
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
signals.forEach(signal => {
    process.on(signal, async () => {
        logger.warn(`Received ${signal}. Initiating graceful shutdown...`);
        // 1. Close Spotify server if running
        if (spotifyServer) {
            logger.info('Closing Spotify OAuth server...');
            await new Promise(resolve => spotifyServer.close(err => {
                if (err) logger.error('Error closing Spotify server:', err);
                else logger.info('Spotify server closed.');
                resolve();
            }));
        }
        // 2. Destroy Discord client
        logger.info('Destroying Discord client...');
        client.destroy();
        // 3. Close DB connection (optional, depends on driver/setup)
        // mongoose.connection.close(() => { logger.info('MongoDB connection closed.'); });
        logger.info('Shutdown complete. Exiting.');
        process.exit(0); // Exit cleanly
    });
});

logger.info('Bot initialization sequence complete. Waiting for Discord login and ready event...');
// The process stays alive due to client.login() and the active Discord connection.
