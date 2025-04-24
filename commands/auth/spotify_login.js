// commands/auth/spotify_login.js
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getAuthorizationUrl } = require('../../spotify/spotifyAuth'); // Adjust path
const config = require('../../config'); // Adjust path
const logger = require('../../utils/logger'); // Adjust path
const User = require('../../database/models/User'); // Adjust path
const { replyWithError } = require('../../utils/interactionUtils'); // Use helper for errors

// Helper to generate random string for state
const generateRandomString = (length) => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('spotify_login')
        .setDescription('Links your Spotify account to enable personalized music features.'),

    async execute(interaction, client, userProfile) {
        // Defer the reply ephemerally as generating URL and checking DB might take a moment
        // This also prevents the "InteractionNotReplied" error if URL generation fails later.
        await interaction.deferReply({ ephemeral: true });

        if (!userProfile) {
             logger.error(`User profile missing for ${interaction.user.tag} in spotify_login command.`);
             // Use editReply since we deferred
             return interaction.editReply({ content: 'An error occurred retrieving your profile. Please try again.' });
        }

        // Check if user is already linked and token is likely valid
        if (userProfile.spotify && userProfile.spotify.accessToken && !userProfile.isSpotifyTokenExpired()) {
             const embed = new EmbedBuilder()
                .setColor(config.colors.success)
                .setTitle('Spotify Account Already Linked')
                .setDescription('Your Spotify account appears to be already linked and active. You can use music commands that require authentication.')
                .setTimestamp();
             // Use editReply since we deferred
             return interaction.editReply({ embeds: [embed] });
        }

        // Generate state and authorization URL
        const stateRandomString = generateRandomString(16);
        let authUrl;
        try {
            authUrl = getAuthorizationUrl(interaction.user.id, stateRandomString);
        } catch (error) {
             logger.error('Failed to generate Spotify authorization URL:', error);
             // Use editReply since we deferred
             return interaction.editReply({ content: 'An internal error occurred while preparing the Spotify login link. Please try again later.' });
        }

        // --- URL Length Check (Optional but recommended) ---
        if (authUrl.length > 512) { // Discord's typical limit for button URLs
            logger.warn(`Generated Spotify Auth URL for ${interaction.user.tag} exceeds 512 characters (${authUrl.length}). Sending as text.`);
            // Send URL as text because it's too long for a button
            const embed = new EmbedBuilder()
                .setColor(config.colors.spotify)
                .setTitle('Link Your Spotify Account (Manual Step)')
                .setDescription(`To unlock the full suite of musical features, please authorize me by logging into Spotify.\n\n**The authorization link is too long for a button. Please copy the link below and paste it into your browser:**`)
                .addFields({ name: 'Authorization Link', value: `\`\`\`${authUrl}\`\`\`` }) // Display URL in code block
                .setFooter({ text: 'You will be redirected to Spotify to grant permissions.' })
                .setTimestamp();
            // Use editReply since we deferred
            await interaction.editReply({ embeds: [embed] }); // No button needed here
        } else {
            // URL is likely short enough, use the button method
            const embed = new EmbedBuilder()
                .setColor(config.colors.spotify)
                .setTitle('Link Your Spotify Account')
                .setDescription(`To unlock the full suite of musical features, including access to your private playlists and personalized playback, please authorize me by logging into Spotify.\n\nClick the button below to proceed to the Spotify authorization page.\n\n*This link is unique to you and should not be shared.*`)
                .setFooter({ text: 'You will be redirected to Spotify to grant permissions.' })
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel('Login with Spotify')
                        .setStyle(ButtonStyle.Link)
                        .setURL(authUrl) // The generated URL
                        .setEmoji('🔗')
                );
            // Use editReply since we deferred
            await interaction.editReply({ embeds: [embed], components: [row] });
        }
        logger.info(`Sent Spotify login instructions to ${interaction.user.tag} (${interaction.user.id})`);

        // No catch block needed here specifically for the reply, as deferral handles the initial state.
        // Errors in URL generation or DB checks are handled above.

    },
};
