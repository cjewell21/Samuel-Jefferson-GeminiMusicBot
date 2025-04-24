// utils/interactionUtils.js
const { EmbedBuilder } = require('discord.js');
const logger = require('./logger'); // Assuming logger is in the same directory or adjust path
const config = require('../config'); // Assuming config is in root or adjust path

/**
 * Sends a standardized error reply to an interaction.
 * Attempts to handle replied/deferred states.
 * @param {Interaction} interaction - The Discord interaction object.
 * @param {string} message - The error message to display to the user.
 * @param {Error} [error] - Optional: The actual error object for logging.
 */
async function replyWithError(interaction, message, error = null) {
    if (error) {
        logger.error(`Interaction Error [User: ${interaction.user.tag}, Command: ${interaction.commandName || interaction.customId || 'N/A'}]:`, error);
    } else {
         logger.warn(`Interaction Warning [User: ${interaction.user.tag}, Command: ${interaction.commandName || interaction.customId || 'N/A'}]: ${message}`);
    }

    const errorEmbed = new EmbedBuilder()
        .setColor(config.colors.error)
        .setTitle('An Error Occurred')
        .setDescription(message || 'An unexpected error occurred while processing your request.')
        .setTimestamp();

    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    } catch (replyError) {
        logger.error(`Failed to send error reply via interaction:`, replyError);
        // As a fallback, try sending to the channel if possible (less ideal)
        // try {
        //     await interaction.channel?.send({ content: `${interaction.user.toString()}, ${message}`});
        // } catch (channelSendError) {
        //     logger.error('Failed fallback channel send for error:', channelSendError);
        // }
    }
}

/**
 * Sends a standardized success reply.
 * @param {Interaction} interaction - The Discord interaction object.
 * @param {string} title - The title for the success embed.
 * @param {string} description - The description/body of the success message.
 * @param {boolean} [ephemeral=false] - Whether the reply should be ephemeral.
 */
async function replyWithSuccess(interaction, title, description, ephemeral = false) {
     const successEmbed = new EmbedBuilder()
        .setColor(config.colors.success)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();

     try {
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ embeds: [successEmbed], ephemeral: ephemeral });
        } else {
            await interaction.reply({ embeds: [successEmbed], ephemeral: ephemeral });
        }
    } catch (replyError) {
        logger.error(`Failed to send success reply via interaction:`, replyError);
    }
}


module.exports = {
    replyWithError,
    replyWithSuccess,
    // Add other interaction helpers here, e.g., for pagination, confirmation prompts etc.
};
