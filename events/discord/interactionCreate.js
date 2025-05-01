const logger = require('../../utils/logger');

module.exports = async (client, interaction) => {
    try {
        // Ignore interactions that are not commands or autocomplete
        if (!interaction.isCommand() && !interaction.isAutocomplete()) {
            return;
        }

        logger.info(`Interaction received from ${interaction.user.tag} (${interaction.user.id}) in #${interaction.channel.name} - Type: ${interaction.type}`);

        // Get the command from the client's commands collection
        const command = client.commands.get(interaction.commandName);
        if (!command) {
            logger.warn(`Command ${interaction.commandName} not found.`);
            // Reply to the interaction if it's a command and no command was found
            if (interaction.isCommand()) {
                return interaction.reply({ content: 'Command not found.', ephemeral: true }).catch(() => {});
            }
            return; // Exit if it's not a command or command not found
        }

        // Handle autocomplete interactions
        if (interaction.isAutocomplete()) {
            if (typeof command.autocomplete === 'function') {
                logger.info(`Autocomplete interaction for command: ${interaction.commandName}`);
                // Set a timeout for autocomplete responses to avoid Discord API errors
                const timeout = setTimeout(() => {
                    logger.warn(`[${interaction.guildId}] Autocomplete timeout for ${interaction.commandName}`);
                    // Respond with an empty array if timeout occurs
                    interaction.respond([]).catch(() => {}); // Catch potential errors if interaction already responded
                }, 2500); // Discord requires autocomplete responses within 3 seconds

                try {
                    // Execute the command's autocomplete function
                    await command.autocomplete(interaction, client);
                } finally {
                    // Clear the timeout regardless of whether the autocomplete succeeded or failed
                    clearTimeout(timeout);
                }
            }
            return; // Exit after handling autocomplete
        }

        // Handle slash command interactions
        if (interaction.isCommand()) {
            logger.info(`Executing command: /${interaction.commandName}`);
            // Execute the command's main execute function
            await command.execute(interaction, client);
        }
    } catch (error) {
        logger.error(`Error handling interaction:`, error);
        // Reply to the interaction with an error message if an unhandled error occurs
        // Only reply if the interaction hasn't been replied to or deferred already
        if (interaction.isCommand() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An error occurred while executing the command.', ephemeral: true }).catch(() => {});
        }
    }
};
