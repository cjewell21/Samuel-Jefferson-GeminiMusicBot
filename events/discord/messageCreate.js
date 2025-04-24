// events/discord/messageCreate.js
// Handles regular text messages, looking for bot mentions followed by commands.

const { Collection, EmbedBuilder } = require('discord.js');
const logger = require('../../utils/logger'); // Adjust path
const config = require('../../config'); // Adjust path
const User = require('../../database/models/User'); // Adjust path
const { replyWithError } = require('../../utils/interactionUtils'); // Can use helpers, but need message context

module.exports = async (client, message) => {
    // 1. Ignore messages from bots and potentially DMs if not supported
    if (message.author.bot) return;
    if (!message.guild) return; // Ignore DMs for now

    // 2. Check if the message mentions the bot
    // Mentions can be <@BOT_ID> or <@!BOT_ID> (with nickname)
    const mentionPrefix = `<@${client.user.id}>`;
    const nicknameMentionPrefix = `<@!${client.user.id}>`;
    let prefixUsed = null;

    if (message.content.startsWith(mentionPrefix)) {
        prefixUsed = mentionPrefix;
    } else if (message.content.startsWith(nicknameMentionPrefix)) {
        prefixUsed = nicknameMentionPrefix;
    }

    // If the bot wasn't mentioned at the start, ignore the message for command processing
    if (!prefixUsed) return;

    logger.debug(`Bot mentioned by ${message.author.tag} in #${message.channel.name}`);

    // 3. Parse the command and arguments
    const args = message.content.slice(prefixUsed.length).trim().split(/ +/); // Remove mention, trim, split by space
    const commandName = args.shift()?.toLowerCase(); // Get the first word as command name, remove from args

    if (!commandName) {
        // Bot was mentioned but no command followed
        logger.debug(`Bot mentioned by ${message.author.tag} with no command.`);
        // Optionally reply with help or a greeting
        // message.reply("Greetings! How may I be of service? Use `@Samuel Jefferson help` to see my commands.").catch(e => logger.error("Failed mention reply:", e));
        return;
    }

    // 4. Find the command in the client.commands collection (same as slash commands)
    const command = client.commands.get(commandName);

    if (!command) {
        logger.warn(`User ${message.author.tag} mentioned bot with unknown command: ${commandName}`);
        message.reply(`I confess, the term "${commandName}" is not within my known lexicon of commands. Perhaps consult the \`/help\` command?`).catch(e => logger.error("Failed unknown command reply:", e));
        return;
    }

    logger.info(`User ${message.author.tag} mentioned command: ${commandName} with args: [${args.join(', ')}]`);

    // 5. Cooldown Check (similar to interactionCreate)
    if (!client.cooldowns.has(command.data.name)) {
        client.cooldowns.set(command.data.name, new Collection());
    }
    const now = Date.now();
    const timestamps = client.cooldowns.get(command.data.name);
    const cooldownAmount = (config.cooldowns[command.data.name] || config.cooldowns.default) * 1000;

    if (timestamps.has(message.author.id)) {
        const expirationTime = timestamps.get(message.author.id) + cooldownAmount;
        if (now < expirationTime) {
            const timeLeft = (expirationTime - now) / 1000;
            message.reply(`Pray, allow ${timeLeft.toFixed(1)} more second(s) before employing the \`${command.data.name}\` command again.`)
                   .then(msg => setTimeout(() => msg.delete().catch(e=>logger.warn("Failed to delete cooldown msg:", e)), 5000)) // Delete msg after 5s
                   .catch(e => logger.error("Failed cooldown reply:", e));
            return;
        }
    }
    timestamps.set(message.author.id, now);
    setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);

    // 6. Execute the command (ADAPTATION NEEDED)
    // The current `command.execute` expects an Interaction object.
    // We cannot directly pass the `message` object as it lacks methods like `deferReply`, `editReply`, `options`, etc.
    try {
        logger.warn(`Executing mentioned command "${commandName}" - REQUIRES ADAPTATION in command file or separate logic.`);

        // --- Option A: Create Mock Interaction (Complex & Potentially Brittle) ---
        // const mockInteraction = { ...message, options: { /* parse args into options */ }, reply: message.reply, editReply: ..., deferReply: ..., followUp: ..., isChatInputCommand: () => true, commandName: commandName };
        // await command.execute(mockInteraction, client, userProfile); // Might fail if command uses interaction-specific methods

        // --- Option B: Refactor Commands ---
        // Move core logic to a separate function callable by both interactionCreate and messageCreate.
        // Example: await command.runLogic(message, args, client, userProfile); // Needs command files to export runLogic

        // --- Option C: Simple Message-Based Handling (Requires separate logic per command) ---
        // This requires adding specific `if/else if` blocks here or a new handler system for message commands.
        // Example:
        if (commandName === 'ping') {
             const msg = await message.reply('Pondering...');
             const latency = msg.createdTimestamp - message.createdTimestamp;
             const wsLatency = client.ws.ping;
             msg.edit(`Response Latency: \`${latency}ms\`. Websocket Ping: \`${wsLatency}ms\`.`).catch(e => logger.error("Ping edit failed:", e));
        } else if (commandName === 'help') {
             // Implement help logic using message.reply based on args
             message.reply("Mention-based help is not fully implemented yet. Please use `/help`.").catch(e => logger.error("Help reply failed:", e));
        } else if (commandName === 'chat') {
             const prompt = args.join(' ');
             if (!prompt) return message.reply("Pray tell, what is the subject of your discourse?").catch(e => logger.error("Chat reply failed:", e));
             // Need userProfile for chat history
             let userProfile;
             try { userProfile = await User.findOrCreate(message.author.id, message.author.tag); } catch(e) { logger.error("DB error in msgCreate:", e); return message.reply("Database error fetching profile."); }

             const { generateText } = require('../../ai/gemini'); // Load AI function
             const responseText = await generateText(prompt, message.author.id);
             if (responseText) {
                 // Split long messages for Discord limit
                 const chunks = responseText.match(/[\s\S]{1,1990}/g) || [];
                 for (const chunk of chunks) {
                     await message.reply(chunk).catch(e => logger.error("Chat reply failed:", e));
                 }
             } else {
                  message.reply("I seem unable to formulate a response at this moment.").catch(e => logger.error("Chat reply failed:", e));
             }
        }
        // Add more `else if` blocks for other commands ('play', 'generate', etc.)
        // These will need to parse `args` and call appropriate functions (e.g., from spotifyPlayer, gemini)
        // and use `message.reply` or `message.channel.send` for output.
        else {
            message.reply(`The command \`${commandName}\` is recognized, but responding to mentions for it is not yet fully implemented. Please try using the slash command: \`/${commandName}\`.`).catch(e => logger.error("Not implemented reply failed:", e));
        }

        // --- End Option C ---

    } catch (error) {
        logger.error(`Error executing mentioned command ${commandName}:`, error);
        message.reply('An unforeseen complication arose while processing your command.').catch(e => logger.error("Error reply failed:", e));
    }
};
