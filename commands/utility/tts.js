// commands/utility/tts.js
const { SlashCommandBuilder } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path

// NOTE: @discordjs/voice related imports REMOVED as Lavalink is now used for music.
// Re-implementing TTS requires a different approach (e.g., synthesizing to file).

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tts')
        .setDescription('Speaks the provided text (Currently disabled with Lavalink).')
        .addStringOption(option =>
            option.setName('text')
                .setDescription('The text you want the bot to speak.')
                .setRequired(true)
                .setMaxLength(200)),

    async execute(interaction, client, userProfile) {
        // --- Command Disabled ---
        logger.warn(`User ${interaction.user.tag} attempted to use /tts command, which is currently disabled due to Lavalink integration.`);
        await interaction.reply({
            content: 'My apologies, Citizen. The Text-to-Speech functionality requires different mechanisms when using the Lavalink music service and is currently unavailable. This feature may be revisited in the future.',
            ephemeral: true // Use ephemeral flag directly
            // flags: 64 // Alternative way for ephemeral in newer d.js versions if needed
        });
        return;
        // --- End Disabled Section ---

        /* --- Original TTS Logic (Commented Out - Requires @discordjs/voice) ---
        // ... (previous commented out logic remains unchanged) ...
        */
    },
};
