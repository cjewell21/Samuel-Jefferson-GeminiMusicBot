// commands/ai/chat.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { generateText } = require('../../ai/gemini'); // Adjust path
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path

module.exports = {
    data: new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Engage in discourse with Samuel Jefferson.')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('Your message or question for the esteemed gentleman.')
                .setRequired(true)),

    async execute(interaction, client, userProfile) {
        await interaction.deferReply(); // AI generation can take time

        const prompt = interaction.options.getString('prompt');
        const discordId = interaction.user.id;

        if (!process.env.GEMINI_API_KEY) {
             return interaction.editReply({ content: "My apologies, my generative faculties are currently unavailable. The necessary configurations seem absent.", ephemeral: true });
        }

        try {
            const responseText = await generateText(prompt, discordId);

            if (!responseText) {
                return interaction.editReply({ content: 'I seem to be at a loss for words at this moment. Pray, try again later.', ephemeral: true });
            }

            // Ensure response isn't too long for a single embed description
            const maxLength = config.embedLimits.description - (prompt.length + 50); // Reserve space for prompt formatting
            let truncatedResponse = responseText;
            if (responseText.length > maxLength) {
                logger.warn(`Gemini response truncated for length. Original: ${responseText.length}, Max: ${maxLength}`);
                truncatedResponse = responseText.substring(0, maxLength - 3) + "...";
            }

            const embed = new EmbedBuilder()
                .setColor(config.colors.gemini)
                // .setTitle(`A Response from Samuel Jefferson`)
                .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
                .setDescription(`**You inquired:**\n*${prompt}*\n\n**Samuel Jefferson replies:**\n${truncatedResponse}`)
                // .addFields({ name: "Your Inquiry", value: prompt })
                // .addFields({ name: "My Response", value: truncatedResponse })
                .setTimestamp()
                .setFooter({ text: config.botName, iconURL: client.user.displayAvatarURL() });


            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error(`Error in /chat command for user ${discordId}:`, error);
            await interaction.editReply({ content: 'Forgive my momentary lapse, an error prevented me from formulating a proper response.', ephemeral: true });
        }
    },
};
