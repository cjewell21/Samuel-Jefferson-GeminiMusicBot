require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./utils/logger');
const connectDB = require('./database/connect');
const setupSpotifyAuthServer = require('./spotify/webserver');

const lavalinkNodes = [{
    name: process.env.LAVALINK_NAME || 'local-node',
    url: `${process.env.LAVALINK_HOST || '127.0.0.1'}:${process.env.LAVALINK_PORT || 4848}`,
    auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
    secure: process.env.LAVALINK_SECURE === 'true'
}];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel],
});

client.commands = new Collection();
client.cooldowns = new Collection();
client.config = config;
client.logger = logger;
client.queues = new Map();

logger.info("Initializing Shoukaku...");
const shoukakuOptions = {
    moveOnDisconnect: false,
    resumable: false,
    resumableTimeout: 30,
    reconnectTries: 10,
    restTimeout: 30000, // Increased for Spotify searches
    userAgent: 'Discord Bot/1.0 (https://github.com/your-repo)',
    nodeResolver: nodes => {
        const nodeArray = Array.from(nodes.values());
        logger.debug(`Node states: ${JSON.stringify(nodeArray.map(n => ({ name: n.name, state: n.state, stats: n.stats })), null, 2)}`);
        const sortedNodes = nodeArray
            .filter(node => node.state === 1 || node.state === 0)
            .sort((a, b) => {
                if (a.state === 1 && b.state !== 1) return -1;
                if (b.state === 1 && a.state !== 1) return 1;
                return (a.stats?.cpu?.systemLoad || 0) - (b.stats?.cpu?.systemLoad || 0);
            });
        const selectedNode = sortedNodes[0] || nodeArray[0] || null;
        if (!selectedNode) {
            logger.warn('No Lavalink nodes available. Nodes: ' + JSON.stringify(nodeArray.map(n => ({ name: n.name, state: n.state }))));
        } else {
            logger.debug(`Selected node: ${selectedNode.name}, state: ${selectedNode.state}`);
        }
        return selectedNode;
    }
};
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), lavalinkNodes, shoukakuOptions);
client.shoukaku = shoukaku;
logger.info("Shoukaku instance created for v4.1.1 with Connectors.DiscordJS.");

// Add retry logic for REST requests
shoukaku.on('ready', (name, resumed) => {
    logger.info(`Lavalink Node "${name}" is now connected. Resumed: ${resumed}`);
});
shoukaku.on('error', (name, error) => {
    logger.error(`Lavalink Node "${name}" encountered an error:`, error);
});
shoukaku.on('close', (name, code, reason) => {
    logger.warn(`Lavalink Node "${name}" closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
});
shoukaku.on('disconnect', (name, players, moved) => {
    logger.warn(`Lavalink Node "${name}" disconnected. Moved ${players.size} players: ${moved}`);
});
shoukaku.on('debug', (name, info) => {
    logger.debug(`Lavalink Node "${name}" debug: ${info}`);
});

client.on('voiceServerUpdate', (data) => {
    logger.debug(`Voice server update received for guild ${data.guild_id}: Token=${data.token ? 'Present' : 'Missing'}, Endpoint=${data.endpoint || 'Missing'}, SessionId=${data.session_id || 'Missing'}`);
    const player = client.shoukaku.players.get(data.guild_id);
    if (player) {
        player.emit('voiceUpdate', data);
        logger.debug(`[${data.guild_id}] Emitted voiceUpdate event for player.`);
    } else {
        logger.warn(`[${data.guild_id}] No player found for voiceServerUpdate event.`);
    }
});
client.on('voiceStateUpdate', (oldState, newState) => {
    logger.debug(`Voice state update for guild ${newState.guild.id}: User=${newState.id}, Channel=${newState.channelId || 'none'}`);
    // Shoukaku listens to voice state updates internally via Connectors.DiscordJS
    // You might add custom logic here if needed, but Shoukaku handles the core updates.
});
client.on('ready', () => {
    logger.info(`Websocket ping: ${client.ws.ping}ms`);
});

connectDB().then(() => {
    logger.info('Successfully connected to MongoDB.');
}).catch(err => {
    logger.error('Failed to connect to MongoDB:', err);
    process.exit(1);
});

logger.info('Loading handlers...');
const handlersPath = path.join(__dirname, 'handlers');
const handlerFiles = fs.readdirSync(handlersPath).filter(file => file.endsWith('.js'));
for (const file of handlerFiles) {
    try {
        const filePath = path.join(handlersPath, file);
        const handler = require(filePath);
        if (typeof handler === 'function') {
            handler(client);
            logger.info(`Executed handler setup: ${file}`);
        } else {
            logger.warn(`Handler file ${file} does not export a function.`);
        }
    } catch (error) {
        logger.error(`Error executing handler setup from ${file}:`, error);
    }
}
logger.info('Handler setup complete.');

logger.info('Attempting to set up Spotify OAuth server...');
let spotifyServer = null;
try {
    const serverSetupResult = setupSpotifyAuthServer(client);
    if (serverSetupResult && serverSetupResult.serverInstance) {
        spotifyServer = serverSetupResult.serverInstance;
        logger.info(`Spotify OAuth callback server setup initiated successfully.`);
    } else if (serverSetupResult === null) {
        logger.warn('Spotify OAuth server setup skipped (missing config).');
    } else {
        logger.warn('Spotify OAuth server setup function did not return expected instance.');
    }
} catch (error) {
    logger.error('Critical error during Spotify OAuth server setup:', error);
}

process.on('uncaughtException', (error, origin) => {
    logger.error(`Uncaught exception at: ${origin}`, error);
    process.exit(1);
});
process.on('warning', (warning) => {
    logger.warn(`Node Process Warning: ${warning.name}`, warning.message);
    logger.debug(warning.stack);
});

logger.info('Logging into Discord...');
if (!process.env.DISCORD_BOT_TOKEN) {
    logger.error("Discord bot token not found.");
    process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => {
        logger.info('Discord login successful. Bot should be ready soon.');
    })
    .catch(err => {
        logger.error('Failed to log in to Discord:', err);
        if (err.code === 'DisallowedIntents') logger.error('Ensure all required intents are enabled!');
        process.exit(1);
    });

const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
signals.forEach(signal => {
    process.on(signal, async () => {
        logger.warn(`Received ${signal}. Initiating graceful shutdown...`);
        if (spotifyServer) {
            logger.info('Closing Spotify OAuth server...');
            spotifyServer.close();
        }
        logger.info('Disconnecting Lavalink nodes...');
        // Destroying the client should handle disconnecting Shoukaku nodes
        // await shoukaku.close(); // Removed this line in a previous fix as it's not a Shoukaku method
        client.destroy();
        logger.info('Shutdown complete. Exiting.');
        process.exit(0);
    });
});

logger.info('Bot initialization sequence complete. Waiting for Discord ready event...');
