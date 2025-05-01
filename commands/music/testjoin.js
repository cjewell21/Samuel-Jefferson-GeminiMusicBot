// testJoin.js
const { SlashCommandBuilder } = require('discord.js');
const { getLavalinkPlayer } = require('../../spotify/spotifyPlayer');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('testjoin')
        .setDescription('Test joining a voice channel.'),
    async execute(interaction, client) {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: 'Join a voice channel first!', ephemeral: true });
        }
        await interaction.deferReply();
        const player = await getLavalinkPlayer(client, interaction.guild.id, voiceChannel.id, interaction.channel);
        if (player) {
            await interaction.editReply({ content: 'Successfully joined the voice channel!' });
        } else {
            await interaction.editReply({ content: 'Failed to join the voice channel.' });
        }
    }
};