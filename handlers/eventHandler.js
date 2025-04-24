// handlers/eventHandler.js
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

module.exports = (client) => {
    const eventsPath = path.join(__dirname, '..', 'events'); // Path to the events directory

    try {
        // Read directories within the events folder (e.g., discord, process)
        const eventFolders = fs.readdirSync(eventsPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        logger.info(`Loading events from categories: ${eventFolders.join(', ')}`);

        for (const folder of eventFolders) {
            const folderPath = path.join(eventsPath, folder);
            const eventFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

            for (const file of eventFiles) {
                const filePath = path.join(folderPath, file);
                try {
                    const event = require(filePath);
                    const eventName = path.basename(file, '.js'); // Extract event name from filename

                    if (typeof event === 'function') {
                        // Use 'once' for events that should only run once (like 'ready')
                        if (event.once) {
                            client.once(eventName, (...args) => event(client, ...args));
                        } else {
                        // Use 'on' for events that can run multiple times
                            client.on(eventName, (...args) => event(client, ...args));
                        }
                        logger.info(`Loaded event listener: ${eventName} from ${folder}/${file}`);
                    } else {
                         logger.warn(`Event file ${filePath} does not export a function.`);
                    }
                } catch (error) {
                    logger.error(`Error loading event ${filePath}:`, error);
                }
            }
        }
         logger.info('Successfully loaded event listeners.');

    } catch (error) {
        logger.error("Error reading events directory:", error);
    }
};
