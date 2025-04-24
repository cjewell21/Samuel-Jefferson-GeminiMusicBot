// handlers/commandHandler.js
const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');
const logger = require('../utils/logger');

module.exports = (client) => {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '..', 'commands'); // Path to the commands directory

    try {
        // Read directories within the commands folder (e.g., music, ai, utility)
        const commandFolders = fs.readdirSync(commandsPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        logger.info(`Found command categories: ${commandFolders.join(', ')}`);

        for (const folder of commandFolders) {
            const folderPath = path.join(commandsPath, folder);
            const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

            for (const file of commandFiles) {
                const filePath = path.join(folderPath, file);
                try {
                    const command = require(filePath);
                    // Set a new item in the Collection with the key as the command name and the value as the exported module
                    if (command.data && command.data.name) {
                         if (typeof command.execute === 'function') {
                            client.commands.set(command.data.name, command);
                            logger.info(`Loaded command: /${command.data.name} from ${folder}/${file}`);
                         } else {
                             logger.warn(`Command ${filePath} is missing an 'execute' function.`);
                         }
                    } else {
                        logger.warn(`Command ${filePath} is missing a 'data' property or 'data.name'.`);
                    }
                } catch (error) {
                    logger.error(`Error loading command ${filePath}:`, error);
                }
            }
        }
        logger.info(`Successfully loaded ${client.commands.size} slash commands.`);

    } catch (error) {
        logger.error("Error reading commands directory:", error);
    }

    // Optional: Script to register commands (deploy-commands.js)
    // You would typically run this separately using 'node deploy-commands.js'
    // See Discord.js guide for deploy-commands.js structure. It uses REST API to register commands globally or per-guild.
};
