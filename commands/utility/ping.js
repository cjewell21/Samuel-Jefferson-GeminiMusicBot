// commands/utility/ping.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config'); // Adjust path

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Checks the bot\'s responsiveness and latency.'),

    async execute(interaction, client, userProfile) {
        const sent = await interaction.deferReply({ fetchReply: true }); // Defer and fetch the reply message

        const websocketHeartbeat = client.ws.ping;
        const roundtripLatency = sent.createdTimestamp - interaction.createdTimestamp;

        const embed = new EmbedBuilder()
            .setColor(config.colors.primary)
            .setTitle('Pong! A Measure of Responsiveness')
            .addFields(
                { name: '🌐 Roundtrip Latency', value: `\`${roundtripLatency}ms\``, inline: true },
                { name: '💓 Websocket Heartbeat', value: `\`${websocketHeartbeat}ms\``, inline: true }
            )
            .setFooter({ text: 'A swift response signifies a healthy connection.' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    },
};
