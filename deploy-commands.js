// deploy-commands.js
// This script registers your slash commands globally with Discord's API.
// Run this using 'node deploy-commands.js' whenever you add or change command definitions.

require('dotenv').config(); // Load environment variables (needs DISCORD_BOT_TOKEN, CLIENT_ID)
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger'); // Assuming logger is in utils
const config = require('./config'); // Assuming config is in root

const commands = [];
// Grab all the command files from the commands directory
const commandsPath = path.join(__dirname, 'commands');

logger.info('Reading command files for global deployment...');

try {
    // Read directories within the commands folder (e.g., music, ai, utility)
    const commandFolders = fs.readdirSync(commandsPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    for (const folder of commandFolders) {
        const folderPath = path.join(commandsPath, folder);
        const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            const filePath = path.join(folderPath, file);
            try {
                const command = require(filePath);
                // Add filePath property for category detection in help command
                command.filePath = filePath;
                if (command.data && command.data.name) {
                    // Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
                    commands.push(command.data.toJSON());
                    logger.info(`Prepared command for deployment: /${command.data.name}`);
                } else {
                    logger.warn(`Command ${filePath} is missing a 'data' property or 'data.name'. Skipping deployment.`);
                }
            } catch (error) {
                 logger.error(`Error loading command ${filePath} for deployment:`, error);
            }
        }
    }
} catch (error) {
    logger.error("Error reading commands directory during deployment:", error);
    process.exit(1); // Exit if we can't read commands
}


// --- Environment Variable Checks ---
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
// Removed guildId check as we are deploying globally now
// const guildId = process.env.DISCORD_GUILD_ID;

if (!token) {
    logger.error("DISCORD_BOT_TOKEN missing in .env file. Cannot deploy commands.");
    process.exit(1);
}
if (!clientId) {
    logger.error("DISCORD_CLIENT_ID missing in .env file. Cannot deploy commands.");
    process.exit(1);
}

// Construct and prepare an instance of the REST module
const rest = new REST({ version: '10' }).setToken(token);

// Deploy the commands globally
(async () => {
    try {
        logger.info(`Started refreshing ${commands.length} application (/) commands globally.`);

        // Deploy commands globally using applicationCommands route
        const data = await rest.put(
            Routes.applicationCommands(clientId), // Use global route
            { body: commands },
        );

        logger.info(`Successfully reloaded ${data.length} application (/) commands globally.`);
        logger.warn('Note: Global command updates can take up to an hour to propagate to all servers.');


    } catch (error) {
        // Catch and log any errors during deployment
        logger.error('Error during global command deployment:', error);
        // Log specific Discord API errors if available
        if (error.rawError) {
             logger.error('Discord API Error Details:', error.rawError);
        }
    }
})();
