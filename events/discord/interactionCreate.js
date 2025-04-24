// events/discord/interactionCreate.js
// Handles incoming interactions (slash commands, buttons, modals, select menus).

const { InteractionType, Collection, EmbedBuilder, ComponentType } = require('discord.js');
const logger = require('../../utils/logger');
const config = require('../../config');
const User = require('../../database/models/User');
const { replyWithError } = require('../../utils/interactionUtils'); // Use helper for errors

// Import button handler separately if needed, or assume commands handle their own components
// const { handleMusicButtons } = require('../../spotify/spotifyPlayer');

module.exports = async (client, interaction) => {
    // Log ALL interactions received for debugging
    logger.debug(`Interaction received: Type=${interaction.type}, ID=${interaction.id}, User=${interaction.user?.tag || 'Unknown'}, Guild=${interaction.guild?.id || 'DM'}, Channel=${interaction.channel?.id || 'DM'}`);
    if (interaction.isChatInputCommand()) logger.debug(`-> Command: /${interaction.commandName}`);
    if (interaction.isButton()) logger.debug(`-> Button: ${interaction.customId}`);
    if (interaction.isStringSelectMenu()) logger.debug(`-> SelectMenu: ${interaction.customId}`);
    if (interaction.isModalSubmit()) logger.debug(`-> ModalSubmit: ${interaction.customId}`);
    if (interaction.isAutocomplete()) logger.debug(`-> Autocomplete: /${interaction.commandName} (Focused: ${interaction.options.getFocused(true).name}=${interaction.options.getFocused()})`);


    // Ignore interactions from bots (optional, but good practice)
    if (interaction.user.bot) return;

    // Handle cases where interaction might not have a user or guild (e.g., certain webhook interactions?)
    if (!interaction.user) {
        logger.warn(`Interaction ${interaction.id} received without user information.`);
        return;
    }

    // Ensure user exists in DB
    let userProfile;
    try {
        userProfile = await User.findOrCreate(interaction.user.id, interaction.user.tag);
    } catch (dbError) {
        logger.error(`Database error fetching/creating user ${interaction.user.id} during interaction:`, dbError);
        // Try to reply with an error if possible
        if (interaction.isRepliable()) {
            await replyWithError(interaction, 'A database error occurred while retrieving your profile. Please try again later.', dbError);
        }
        return; // Stop processing
    }

    // --- Autocomplete Handling ---
    if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) {
            logger.error(`Autocomplete requested for unknown command: ${interaction.commandName}`);
            try { await interaction.respond([]); } catch (e) { logger.error('Failed empty autocomplete response:', e); } // Respond empty
            return;
        }
        try {
            if (typeof command.autocomplete === 'function') {
                await command.autocomplete(interaction, client);
            } else {
                logger.debug(`Command /${interaction.commandName} does not have an autocomplete handler.`);
                await interaction.respond([]); // Respond empty if no handler
            }
        } catch (error) {
            logger.error(`Error running autocomplete for /${interaction.commandName}:`, error);
            // Avoid replying directly to autocomplete errors, just log. Respond empty if possible.
            try { await interaction.respond([]); } catch (e) { /* Ignore */ }
        }
        return; // Autocomplete interactions only handle suggestions
    }


    // --- Command Handling (Chat Input) ---
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);

        if (!command) {
            logger.error(`No command matching interaction '${interaction.commandName}' was found.`);
            return replyWithError(interaction, `Alas, the command '/${interaction.commandName}' seems unfamiliar to me.`);
        }

        logger.info(`User ${interaction.user.tag} (${interaction.user.id}) initiated command: /${interaction.commandName} in #${interaction.channel?.name || 'DM'}`);

        // --- Cooldown Logic ---
        if (!client.cooldowns.has(command.data.name)) {
            client.cooldowns.set(command.data.name, new Collection());
        }
        const now = Date.now();
        const timestamps = client.cooldowns.get(command.data.name);
        const cooldownAmount = (config.cooldowns[command.data.name] || config.cooldowns.default) * 1000;

        if (timestamps.has(interaction.user.id)) {
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
            if (now < expirationTime) {
                const timeLeft = (expirationTime - now) / 1000;
                const embed = new EmbedBuilder()
                    .setColor(config.colors.warning)
                    .setTitle('A Moment, If You Please!')
                    .setDescription(`Pray, allow ${timeLeft.toFixed(1)} more second(s) before employing the \`/${command.data.name}\` command again. Haste makes waste, as they say.`);
                try {
                    // Send cooldown message ephemerally
                    if (!interaction.replied && !interaction.deferred) {
                         await interaction.reply({ embeds: [embed], ephemeral: true });
                    } else {
                        // If already deferred/replied (unlikely here, but safe), follow up
                         await interaction.followUp({ embeds: [embed], ephemeral: true });
                    }
                } catch (replyError) {
                     logger.error('Failed to send cooldown reply:', replyError);
                }
                return; // Stop execution if on cooldown
            }
        }
        // Set timestamp only if command execution proceeds
        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);


        // --- Execute Command ---
        try {
            // IMPORTANT: Defer reply if the command might take > 3 seconds
            // Commands themselves should handle deferral if needed, but we can add a safety net here
            // if (!interaction.deferred && commandMightTakeLong(command)) {
            //     await interaction.deferReply();
            // }

            if (typeof command.execute === 'function') {
                // Pass userProfile fetched earlier
                await command.execute(interaction, client, userProfile);
            } else {
                logger.error(`Command /${interaction.commandName} is missing the 'execute' function.`);
                await replyWithError(interaction, `There was an issue executing the command '/${interaction.commandName}'. Implementation is missing.`);
            }
        } catch (error) {
            logger.error(`Error executing command /${interaction.commandName}:`, error);
            // Use helper function to send error reply, handles deferred/replied state
            await replyWithError(interaction, `Apologies, Citizen. An error occurred whilst executing that command.`, error);
        }
        return; // End after handling command
    }

    // --- Component Interaction Handling (Buttons, Select Menus) ---
    // Often handled by collectors within the command that sent the component,
    // but can have global handlers here as fallbacks or for persistent components.
    if (interaction.isMessageComponent()) {
        logger.debug(`Component Interaction: ${interaction.customId} by ${interaction.user.tag}`);

        // Example: Route music buttons if not handled by collectors
        if (interaction.customId.startsWith('music_') && interaction.isButton()) {
             const { handleMusicButtons } = require('../../spotify/spotifyPlayer'); // Lazy load if needed
             if (handleMusicButtons && typeof handleMusicButtons === 'function') {
                 try {
                     await handleMusicButtons(interaction, client, userProfile);
                 } catch (buttonError) {
                      logger.error(`Error in global handler for music button ${interaction.customId}:`, buttonError);
                      // Attempt to notify user ephemerally
                      if (interaction.isRepliable()) {
                          await interaction.followUp({ content: "An error occurred processing this music control.", ephemeral: true }).catch(e => {});
                      }
                 }
             } else {
                  logger.warn(`Global handler: handleMusicButtons not found/imported for ${interaction.customId}.`);
                  // Defer silently if handler missing and interaction not handled by collector
                   if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate().catch(()=>{});
             }
             return; // Handled music button
        }

        // Add other global component handlers here if needed

        // If interaction reaches here, it might be from an older message or unhandled component
        logger.warn(`Unhandled component interaction: ${interaction.customId}. Might be handled by an inactive collector.`);
        // Defer silently or inform user it's expired/unhandled
        if (!interaction.replied && !interaction.deferred) {
             try {
                // Check if the original message still exists before replying
                if (interaction.message) {
                    await interaction.reply({ content: "This interaction may have expired.", ephemeral: true });
                } else {
                    // If no message context, just defer silently
                    await interaction.deferUpdate();
                }
             } catch (e) {
                 // Ignore errors trying to reply to potentially deleted messages/interactions
                 if (e.code !== 10062 && e.code !== 10008 && e.code !== 40060) { // Ignore Unknown Interaction, Unknown Message, Interaction Expired
                     logger.error("Error replying/deferring unhandled component:", e);
                 }
             }
        }
        return; // End after handling component
    }


    // --- Modal Submit Handling ---
    if (interaction.isModalSubmit()) {
        const modalId = interaction.customId;
        logger.info(`User ${interaction.user.tag} submitted modal '${modalId}'`);
        // Route modals based on customId
        // Example: if (modalId === 'my_settings_modal') { ... }
        try {
             // Find handler logic for this modal
             logger.warn(`Unhandled modal submission: ${modalId}. Handler logic needed.`);
             await interaction.reply({ content: 'Modal received, but no handler is configured for it yet.', ephemeral: true });
        } catch (error) {
            logger.error(`Error handling modal submit ${modalId}:`, error);
            await replyWithError(interaction, 'An error occurred processing the modal submission.', error);
        }
        return; // End after handling modal
    }

    // If interaction type is unhandled
    logger.warn(`Unhandled interaction type received: ${interaction.type}`);

};
