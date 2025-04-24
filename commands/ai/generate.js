// commands/ai/generate.js
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js'); // Ensure AttachmentBuilder is imported
const { generateImage } = require('../../ai/gemini'); // Path points to the ai module
const logger = require('../../utils/logger');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generate')
        .setDescription('Requests Samuel Jefferson to conjure an image (using Vertex AI) based on your description.')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('A description of the image you wish to see.')
                .setRequired(true)
                .setMaxLength(1000)), // Adjust max length as needed

    async execute(interaction, client, userProfile) {
        await interaction.deferReply(); // Image generation takes time

        const prompt = interaction.options.getString('prompt');
        const discordId = interaction.user.id;

        // Check if Vertex AI is configured (optional check, generateImage handles it)
        if (!process.env.GOOGLE_CLOUD_PROJECT_ID || !process.env.GOOGLE_CLOUD_LOCATION) {
             return interaction.editReply({ content: "Alas, the tools required for Vertex AI visual creation are not configured (Missing GCP Project ID/Location).", ephemeral: true });
        }

        try {
            // Call the generateImage function (now using Vertex AI)
            const imageResult = await generateImage(prompt, discordId);

            const embed = new EmbedBuilder()
                .setColor(config.colors.gemini) // Or a different color for Vertex AI
                .setTitle('Vertex AI Visual Conjuration') // Updated title
                .setDescription(`A depiction based upon your words:\n*${prompt}*`)
                .setFooter({ text: `Requested by ${interaction.user.tag} | Powered by Vertex AI`, iconURL: interaction.user.displayAvatarURL() }) // Updated footer
                .setTimestamp();

            let replyOptions = {};

            // Check if the result is a Buffer (successful image generation)
            if (Buffer.isBuffer(imageResult)) {
                // Create a Discord attachment from the buffer
                const attachment = new AttachmentBuilder(imageResult, { name: 'vertex_image.png' }); // Set filename
                embed.setImage('attachment://vertex_image.png'); // Refer to the attachment in the embed
                replyOptions = { embeds: [embed], files: [attachment] };
                logger.info(`Successfully prepared Vertex AI image attachment for prompt: "${prompt}"`);

            } else if (typeof imageResult === 'string') {
                // Assume it's an error message string returned from generateImage
                embed.setColor(config.colors.warning)
                     .setDescription(`Regarding your request for an image of "*${prompt}*":\n\n${imageResult}`)
                     .setImage(null); // Ensure no image is set on error
                replyOptions = { embeds: [embed], files: [] }; // Send only the error embed
                logger.warn(`Vertex AI Image generation failed for prompt: "${prompt}". Response: ${imageResult}`);
            } else {
                 // Handle unexpected null or other return types
                 embed.setColor(config.colors.error)
                      .setDescription(`An unexpected issue occurred during Vertex AI image generation. No result was returned.`)
                      .setImage(null);
                 replyOptions = { embeds: [embed], files: [] };
                 logger.error(`Vertex AI Image generation returned unexpected result type for prompt: "${prompt}". Result:`, imageResult);
            }

            await interaction.editReply(replyOptions);

        } catch (error) {
            logger.error(`Error in /generate command (Vertex AI) for user ${discordId}:`, error);
            await interaction.editReply({ content: 'A complication arose during the artistic endeavor (Vertex AI). Please try again later.', embeds: [], files: [] });
        }
    },
};