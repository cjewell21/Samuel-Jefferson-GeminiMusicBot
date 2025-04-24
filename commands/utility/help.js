// commands/utility/help.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config'); // Adjust path
const logger = require('../../utils/logger'); // Adjust path

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Displays a list of available commands or info about a specific command.')
        .addStringOption(option =>
            option.setName('command')
                .setDescription('The specific command you require assistance with.')
                .setRequired(false)
                .setAutocomplete(true)), // Enable autocomplete

    // --- Autocomplete Handler ---
    async autocomplete(interaction, client) {
        const focusedValue = interaction.options.getFocused();
        // Filter commands based on user input
        const choices = client.commands
            .map(cmd => cmd.data.name) // Get command names
            .filter(name => name.startsWith(focusedValue)) // Filter by input
            .slice(0, 25); // Limit choices for Discord API

        await interaction.respond(
            choices.map(choice => ({ name: choice, value: choice })),
        );
    },

    // --- Execute Handler ---
    async execute(interaction, client, userProfile) {
        const commandName = interaction.options.getString('command');
        const embed = new EmbedBuilder()
            .setColor(config.colors.primary)
            .setAuthor({ name: config.botName + ' - Command Compendium', iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        if (commandName) {
            // Show help for a specific command
            const command = client.commands.get(commandName);
            if (!command) {
                return interaction.reply({ content: `The command \`/${commandName}\` is unknown to me. Use \`/help\` to see all available commands.`, ephemeral: true });
            }

            embed.setTitle(`Command: /${command.data.name}`)
                 .setDescription(command.data.description || 'No description provided.');

            // Add options if they exist
            if (command.data.options && command.data.options.length > 0) {
                 const optionsString = command.data.options.map(opt => {
                     const required = opt.required ? '(Required)' : '(Optional)';
                     return `\`${opt.name}\`: ${opt.description} ${required}`;
                 }).join('\n');
                 embed.addFields({ name: 'Options', value: optionsString });
            }
            // Add cooldown info
             const cooldown = config.cooldowns[command.data.name] || config.cooldowns.default;
             embed.addFields({ name: 'Cooldown', value: `${cooldown} second(s)` });

        } else {
            // Show list of all commands, categorized
            embed.setTitle('Available Commands')
                 .setDescription(`Greetings, Citizen! I am ${config.botName}, at your service. Below lies a compendium of my capabilities. Use \`/help [command]\` for details on a specific command.`);

            const categories = {}; // { categoryName: [commandName, ...] }

            client.commands.forEach(cmd => {
                 // Infer category from command file path (e.g., commands/music/play.js -> music)
                 // This relies on the command handler structure.
                 const category = cmd.filePath?.split(require('path').sep).slice(-2, -1)[0] || 'utility'; // Default to utility
                 if (!categories[category]) {
                     categories[category] = [];
                 }
                 categories[category].push(`\`/${cmd.data.name}\``);
            });

            // Sort categories alphabetically (optional)
            const sortedCategories = Object.keys(categories).sort();

            for (const category of sortedCategories) {
                 if (categories[category].length > 0) {
                     const categoryName = category.charAt(0).toUpperCase() + category.slice(1); // Capitalize
                     embed.addFields({ name: `📜 ${categoryName}`, value: categories[category].join(', '), inline: false });
                 }
            }
             embed.setFooter({ text: `Total Commands: ${client.commands.size}` });
        }

        await interaction.reply({ embeds: [embed] });
    },
};
