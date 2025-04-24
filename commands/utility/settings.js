// commands/utility/settings.js
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, PermissionFlagsBits } = require('discord.js');
const User = require('../../database/models/User'); // Adjust path
const config = require('../../config'); // Adjust path
const logger = require('../../utils/logger'); // Adjust path

module.exports = {
    data: new SlashCommandBuilder()
        .setName('settings')
        .setDescription('View or modify your personal bot settings.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View your current settings.'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Modify a specific setting.')
                // Add options for each setting you want to allow modification for
                // Example: TTS toggle
                .addBooleanOption(option =>
                     option.setName('tts_enabled')
                     .setDescription('Enable or disable Text-to-Speech for music announcements.')
                     .setRequired(false)) // Make options optional for setting one at a time
                 // Example: AI Personality Preference
                 .addStringOption(option =>
                     option.setName('ai_personality')
                     .setDescription('Choose the AI personality you wish to interact with.')
                     .setRequired(false)
                     .addChoices(
                         // Dynamically generate choices from config or list them explicitly
                         ...Object.keys(config.gemini.personalities).map(key => ({ name: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), value: key }))
                         // { name: 'Default Founding Father', value: 'default_founding_father' },
                         // Add more choices if defined in config.js
                     ))
                 // Add other settings like preferred volume, etc.
        ),

    async execute(interaction, client, userProfile) {
        const subcommand = interaction.options.getSubcommand();

        if (!userProfile) {
             // Should be handled by interactionCreate, but double-check
             return interaction.reply({ content: 'Could not retrieve your user profile. Please try again.', ephemeral: true });
        }

        if (subcommand === 'view') {
            // Display current settings
            const embed = new EmbedBuilder()
                .setColor(config.colors.primary)
                .setTitle(`${interaction.user.username}'s Settings`)
                .addFields(
                    { name: '🗣️ TTS Announcements', value: userProfile.settings?.ttsEnabled ? 'Enabled' : 'Disabled', inline: true },
                    { name: '🤖 AI Personality', value: userProfile.aiPersonalityPreference?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Default', inline: true }
                    // Add more fields for other settings
                )
                .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });

        } else if (subcommand === 'set') {
            let changesMade = false;
            const updatedFields = [];

            // --- Update TTS Setting ---
            const ttsValue = interaction.options.getBoolean('tts_enabled');
            if (ttsValue !== null) { // Check if the option was provided
                 if (!userProfile.settings) userProfile.settings = {}; // Initialize settings object if it doesn't exist
                 userProfile.settings.ttsEnabled = ttsValue;
                 changesMade = true;
                 updatedFields.push(`TTS Announcements: **${ttsValue ? 'Enabled' : 'Disabled'}**`);
                 logger.info(`User ${interaction.user.tag} set tts_enabled to ${ttsValue}`);
            }

            // --- Update AI Personality Setting ---
            const personalityValue = interaction.options.getString('ai_personality');
            if (personalityValue !== null) {
                 // Validate if the chosen personality exists in config
                 if (config.gemini.personalities[personalityValue]) {
                     userProfile.aiPersonalityPreference = personalityValue;
                     changesMade = true;
                     updatedFields.push(`AI Personality: **${personalityValue.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}**`);
                     logger.info(`User ${interaction.user.tag} set ai_personality to ${personalityValue}`);
                 } else {
                     return interaction.reply({ content: `Invalid AI personality choice: "${personalityValue}". Please choose from the available options.`, ephemeral: true });
                 }
            }

            // --- Add logic for other settings here ---


            if (!changesMade) {
                return interaction.reply({ content: 'You did not specify any settings to change. Use `/settings set [option]:[value]` or view current settings with `/settings view`.', ephemeral: true });
            }

            try {
                await userProfile.save();
                const embed = new EmbedBuilder()
                    .setColor(config.colors.success)
                    .setTitle('Settings Updated')
                    .setDescription(`Your preferences have been updated:\n- ${updatedFields.join('\n- ')}`)
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
            } catch (error) {
                logger.error(`Failed to save user settings for ${interaction.user.tag}:`, error);
                await interaction.reply({ content: 'An error occurred while saving your settings. Please try again.', ephemeral: true });
            }
        }
    },
};
