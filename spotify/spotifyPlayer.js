const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
const config = require('../config');
// Assuming User model and spotifyAuth are correctly set up if needed elsewhere
// const User = require('../database/models/User');
// const { getUserSpotifyApi } = require('./spotifyAuth');
// const SpotifyWebApi = require('spotify-web-api-node');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Gets or creates a Lavalink player instance for a guild.
 * Attempts to join the voice channel if no player exists.
 * Handles basic connection state verification and waits for player readiness.
 * @param {import('discord.js').Client} client - The Discord client instance.
 * @param {string} guildId - The ID of the guild.
 * @param {string} voiceChannelId - The ID of the voice channel to join.
 * @param {import('discord.js').TextChannel} textChannel - The text channel for sending messages.
 * @returns {Promise<import('shoukaku').Player | null>} The Lavalink player or null if failed.
 */
async function getLavalinkPlayer(client, guildId, voiceChannelId, textChannel) {
    if (!client.shoukaku) {
        logger.error(`[${guildId}] Shoukaku client not initialized.`);
        return null;
    }
    if (!client.shoukaku.nodes.size) {
        logger.error(`[${guildId}] No Lavalink nodes available/connected.`);
        if (textChannel) await textChannel.send('⚠️ Cannot connect to the music service node. Please ensure Lavalink is running and configured.').catch(() => {});
        return null;
    }

    let player = client.shoukaku.players.get(guildId);

    // If player exists, check if its connection details are valid and if it's in the correct channel
    if (player && player.connection && player.connection.channelId) {
        if (player.connection.channelId !== voiceChannelId) {
            logger.warn(`[${guildId}] Player exists but is in channel ${player.connection.channelId}, requested ${voiceChannelId}. Attempting move...`);
            try {
                // Shoukaku v4 doesn't have a direct move function, we need to leave and rejoin
                await client.shoukaku.leaveVoiceChannel(guildId);
                logger.info(`[${guildId}] Left old voice channel. Rejoining new one...`);
                player = null; // Force recreation below
            } catch (moveError) {
                logger.error(`[${guildId}] Error leaving voice channel to move:`, moveError);
                if (textChannel) await textChannel.send(`⚠️ Error moving to your voice channel: ${moveError.message}`).catch(() => {});
                return null; // Prevent further action if leaving failed
            }
        } else {
            // Player exists, has connection info, and is in the correct channel
            logger.debug(`[${guildId}] Reusing existing player in channel ${voiceChannelId}. Player State: ${player.state}, Connection State: ${player.connection?.state}`);
            // Optional: Add a check here if player.state indicates a problem (e.g., DISCONNECTED)
            // if (player.state === Shoukaku.Constants.State.DISCONNECTED) { ... handle reconnection ... }
            return player; // Return existing, correctly placed player
        }
    } else if (player) {
         // Player object exists but connection details are missing/invalid
         logger.warn(`[${guildId}] Player object found, but connection details missing or invalid (player.connection: ${player.connection}). Forcing recreation.`);
         try {
              // Attempt to clean up the potentially broken player state
              await client.shoukaku.leaveVoiceChannel(guildId);
         } catch (cleanupError) {
              logger.error(`[${guildId}] Error trying to leave voice channel during player recreation cleanup:`, cleanupError);
              // Continue trying to create a new player anyway
         }
         player = null; // Force recreation below
    }


    // If player doesn't exist or needed recreation
    if (!player) {
        try {
            let node = client.shoukaku.options.nodeResolver(client.shoukaku.nodes);
            if (!node) {
                logger.warn(`[${guildId}] Node resolver returned null, falling back to first available node.`);
                node = Array.from(client.shoukaku.nodes.values()).find(n => n.state === 1); // Find connected node
                if (!node) node = Array.from(client.shoukaku.nodes.values())[0]; // Fallback to any node
            }

            if (!node) {
                logger.error(`[${guildId}] No suitable Lavalink node found.`);
                if (textChannel) await textChannel.send('⚠️ Could not find an available music service node.').catch(() => {});
                return null;
            }

            logger.info(`[${guildId}] Attempting to join voice channel ${voiceChannelId} using node ${node.name}...`);

            // --- Start Refined Connection Handling ---
            // Add the voiceServerUpdate listener *before* joining the voice channel
            // This event provides the necessary token and endpoint for Lavalink to connect to Discord's voice server.
            const voiceServerUpdateListener = (data) => {
                if (data.guild_id === guildId) {
                    logger.debug(`[${guildId}] Received voiceServerUpdate event for this guild. Token: ${data.token ? 'Present' : 'Missing'}, Endpoint: ${data.endpoint ? 'Present' : 'Missing'}`); // Added specific log with data check
                } else {
                     logger.debug(`[${guildId}] Received voiceServerUpdate for different guild: ${data.guild_id}.`); // Log for other guilds
                }
            };
            client.on('voiceServerUpdate', voiceServerUpdateListener);

            try {
                // Attempt to join the voice channel
                // Shoukaku sends the necessary Discord API calls (VOICE_STATE_UPDATE) which
                // triggers Discord to send the VOICE_SERVER_UPDATE event back to the bot.
                player = await client.shoukaku.joinVoiceChannel({
                    guildId: guildId,
                    channelId: voiceChannelId,
                    shardId: client.guilds.cache.get(guildId)?.shardId ?? 0, // Use nullish coalescing for safety
                    deaf: true // Deafening is generally recommended for music bots
                });

                logger.info(`[${guildId}] Successfully initiated join for VC ${voiceChannelId}. Player object obtained.`);
                logger.debug(`[${guildId}] Initial Player State after join call: ${player.state}, Connection State: ${player.connection?.state}`);


                // Wait for the player's 'ready' event with a timeout
                // The 'ready' event fires when Shoukaku/Lavalink has successfully used the
                // voiceServerUpdate data to connect to the Discord voice server endpoint.
                // If this event doesn't fire, it indicates a problem with Lavalink's
                // ability to connect to Discord's voice server (often network/firewall related).
                logger.debug(`[${guildId}] Waiting for player 'ready' event...`);
                await new Promise((resolve, reject) => {
                    const readyTimeout = setTimeout(() => {
                        logger.warn(`[${guildId}] Timeout waiting for player ready event.`);
                        // Clean up listeners if timeout occurs
                        player.removeListener('ready', resolve);
                        client.removeListener('voiceServerUpdate', voiceServerUpdateListener);
                        reject(new Error('Player ready timeout')); // This is the error you are seeing
                    }, 35000); // 35 seconds timeout (can adjust if needed, but 35s is usually sufficient)

                    player.once('ready', () => {
                        logger.debug(`[${guildId}] Player 'ready' event received.`);
                        clearTimeout(readyTimeout); // Clear timeout if ready event fires
                        client.removeListener('voiceServerUpdate', voiceServerUpdateListener); // Clean up voice update listener
                        resolve();
                    });
                });

                 // After waiting for 'ready', player.connection should be populated
                 if (!player.connection || !player.connection.token || !player.connection.endpoint || !player.connection.sessionId) {
                      logger.error(`[${guildId}] Player connection details still missing after player 'ready' event.`);
                      throw new Error('Player connection details not available after ready event');
                 }
                 logger.debug(`[${guildId}] Player connection is now ready and details are available.`);


            } catch (waitError) {
                logger.error(`[${guildId}] Error during voice channel join or waiting for readiness:`, waitError);
                // Ensure voiceServerUpdate listener is removed on error
                client.removeListener('voiceServerUpdate', voiceServerUpdateListener);
                if (textChannel) await textChannel.send(`⚠️ Failed to establish music service connection. Playback stopped. Reason: ${waitError.message}`).catch(()=>{});
                // Clean up the player state in Shoukaku if connection fails at this stage
                if (client.shoukaku.players.has(guildId)) {
                     client.shoukaku.players.delete(guildId);
                }
                return null; // Return null if player connection fails
            }
            // --- End Refined Connection Handling ---


            // Re-setup standard player listeners after successful connection
            setupPlayerListeners(player, client, guildId);

        } catch (error) {
            logger.error(`[${guildId}] Failed to join voice channel ${voiceChannelId}:`, error);
            if (textChannel) await textChannel.send(`⚠️ Error joining voice channel: ${error.message}`).catch(() => {});
            // Clean up potentially partially created player state in Shoukaku if join failed
            if (client.shoukaku.players.has(guildId)) {
                 client.shoukaku.players.delete(guildId);
            }
            return null;
        }
    }

    // Associate player with queue if queue exists
    const queue = client.queues?.get(guildId);
    if (queue) {
        queue.lavalinkPlayer = player;
        queue.voiceChannelId = voiceChannelId; // Ensure voice channel ID is up-to-date
    } else {
        // This case might happen if getLavalinkPlayer is called before createGuildQueue
        logger.warn(`[${guildId}] Lavalink player obtained/reused, but no corresponding bot queue found yet.`);
    }

    return player;
}

/**
 * Sets up standard event listeners for a Lavalink player.
 * Ensures listeners are not duplicated.
 * @param {import('shoukaku').Player} player - The Lavalink player instance.
 * @param {import('discord.js').Client} client - The Discord client instance.
 * @param {string} guildId - The ID of the guild this player belongs to.
 */
function setupPlayerListeners(player, client, guildId) {
    // Remove existing listeners to prevent duplicates if this function is called multiple times for the same player
    player.removeAllListeners('start');
    player.removeAllListeners('end');
    player.removeAllListeners('exception');
    player.removeAllListeners('closed');
    player.removeAllListeners('error'); // General error listener
    player.removeAllListeners('ready'); // Ensure 'ready' listener is also managed

    player.on('start', () => {
        logger.info(`[${guildId}] Player Event: Track started.`);
        const queue = client.queues?.get(guildId);
        if (queue) {
            queue.playing = true;
            logger.debug(`[${guildId}] Now playing: ${queue.currentTrack?.title}`);
            updateNowPlayingMessage(queue);
        } else {
             logger.warn(`[${guildId}] Player 'start' event fired, but no queue found.`);
        }
    });

    player.on('end', (data) => {
        // data might be null or undefined in some Shoukaku/Lavalink versions/scenarios
        const reason = data?.reason || 'Unknown';
        logger.info(`[${guildId}] Player Event: Track ended. Reason: ${reason}`);
        const queue = client.queues?.get(guildId);
        if (queue) {
            const endedTrack = queue.currentTrack;
            // Only advance queue if track wasn't replaced or stopped manually
            if (reason !== 'REPLACED' && reason !== 'STOPPED') {
                 queue.currentTrack = null;
                 queue.playing = false;
                 // Handle looping
                 if (queue.loop && endedTrack) {
                     logger.info(`[${guildId}] Looping track "${endedTrack.title}". Adding back to queue start.`);
                     // Add back to the beginning for single track loop
                     queue.songs.unshift(endedTrack);
                 }
                 // Try to play next only if not stopped
                 if (queue.songs.length > 0) {
                     playNextTrack(guildId, client.queues, client);
                 } else {
                     handleQueueEnd(queue, queues, client);
                 }
            } else if (reason === 'STOPPED') {
                 // If stopped manually, ensure queue state is clean
                 queue.currentTrack = null;
                 queue.playing = false;
                 handleQueueEnd(queue, queues, client); // Treat stop as queue end for cleanup
            }
             // If REPLACED, playNextTrack was likely called manually, do nothing here.
        } else {
             logger.warn(`[${guildId}] Player 'end' event fired, but no queue found.`);
        }
    });

    player.on('exception', (error) => {
        // error object structure might vary { message, severity, cause }
        const errorMsg = error?.message || 'Unknown Error';
        const severity = error?.severity || 'Unknown Severity';
        logger.error(`[${guildId}] Player Event: Exception! Severity: ${severity}, Message: ${errorMsg}`, error?.cause || error);
        const queue = client.queues?.get(guildId);
        if (queue?.textChannel) {
            queue.textChannel.send(`💥 Playback Error: ${errorMsg}. Severity: ${severity}. Skipping track.`).catch(() => {});
        }
        // Attempt to recover by playing the next track
        if (queue) {
            const failedTrack = queue.currentTrack;
            queue.currentTrack = null;
            queue.playing = false;
            if (queue.loop && failedTrack) queue.songs.push(failedTrack); // Add back to end if looping failed track
            if (queue.songs.length > 0) {
                playNextTrack(guildId, queues, client);
            } else {
                handleQueueEnd(queue, queues, client);
            }
        }
    });

    player.on('closed', (data) => {
        // data structure { code, reason, byRemote }
        const code = data?.code || 'N/A';
        const reason = data?.reason || 'N/A';
        const byRemote = data?.byRemote || false;
        logger.warn(`[${guildId}] Player Event: WebSocket closed. Code: ${code}, Reason: ${reason}, By Remote: ${byRemote}`);
        const queue = client.queues?.get(guildId);
        if (queue) {
            // Don't immediately delete queue, maybe connection can be re-established
            queue.playing = false;
            // Consider attempting reconnection or notifying user
        }
         // Shoukaku might handle reconnection automatically based on config
         // If connection is permanently lost, clean up might be needed elsewhere (e.g., node disconnect event)
    });

     player.on('error', (error) => {
         logger.error(`[${guildId}] General Player Error Event:`, error);
         // Handle general player errors if necessary
     });

     player.on('ready', () => {
         logger.info(`[${guildId}] Player Event: Player is ready (connection established).`);
         // This event indicates player.connection is populated.
         // If playNextTrack was waiting, it should now proceed.
     });
}

/**
 * Creates the basic queue structure for a guild.
 * @param {import('discord.js').Interaction} interaction - The interaction that triggered queue creation.
 * @param {import('discord.js').VoiceChannel} voiceChannel - The voice channel the bot is in.
 * @returns {object} The guild queue object.
 */
function createGuildQueue(interaction, voiceChannel) {
    const guildId = interaction.guild.id;
    logger.info(`Creating new queue structure for guild ${guildId}`);
    const queueConstruct = {
        guildId: guildId,
        textChannel: interaction.channel,
        voiceChannelId: voiceChannel.id,
        lavalinkPlayer: null, // Will be assigned by getLavalinkPlayer
        songs: [],
        playing: false,
        loop: false, // 'false' (no loop), 'track' (loop current), 'queue' (loop whole queue) - Simplified to boolean for now
        currentTrack: null,
        nowPlayingMessage: null,
        leaveTimeout: null,
        processingNext: false, // Flag to prevent race conditions in playNextTrack
    };
    // Ensure the global queues map exists
    interaction.client.queues = interaction.client.queues || new Map();
    interaction.client.queues.set(guildId, queueConstruct);
    return queueConstruct;
}

/**
 * Adds a song object to the guild's queue.
 * @param {import('discord.js').Interaction} interaction - The interaction context.
 * @param {Map} queues - The global queues map.
 * @param {object} songData - The song object to add.
 * @returns {{addedCount: number}} - Number of tracks actually added (0 or 1).
 */
async function addToQueue(interaction, queues, songData) {
    const guildId = interaction.guild.id;
    const queue = queues.get(guildId);
    if (!queue) {
        logger.error(`[${guildId}] Cannot add song: No queue exists for this guild.`);
        // Optionally send a message back to the user
        // await interaction.followUp({ content: 'Could not find the music queue. Please try playing a song first.', ephemeral: true });
        return { addedCount: 0 };
    }

    // Basic duplicate check based on Lavalink track ID if available
    const duplicate = queue.songs.some(s => s.lavalinkTrack && songData.lavalinkTrack && s.lavalinkTrack === songData.lavalinkTrack);
    if (duplicate) {
        logger.debug(`[${guildId}] Skipping duplicate track: "${songData.title}".`);
        // Optionally inform user about duplicate
        // await interaction.followUp({ content: `"${songData.title}" is already in the queue.`, ephemeral: true });
        return { addedCount: 0 };
    }

    // Check queue size limit
    const maxSize = config.music.maxQueueSize || 100;
    if (queue.songs.length >= maxSize) {
        logger.warn(`[${guildId}] Queue is full (limit: ${maxSize}). Cannot add "${songData.title}".`);
        await interaction.followUp({ content: `The queue is full (max ${maxSize} songs). Please wait or clear some tracks.`, ephemeral: true }).catch(()=>{});
        return { addedCount: 0 };
    }

    queue.songs.push(songData);
    logger.debug(`[${guildId}] Added "${songData.title}" to queue. New queue size: ${queue.songs.length}`);

    // Clear leave timeout if adding to an empty queue that was about to disconnect
    if (queue.leaveTimeout) {
        logger.debug(`[${guildId}] Clearing leave timeout due to new track added.`);
        clearTimeout(queue.leaveTimeout);
        queue.leaveTimeout = null;
    }

    return { addedCount: 1 };
}

/**
 * Plays the next track in the queue. Handles getting the player and playing via Lavalink.
 * Uses node.rest.updatePlayer directly for more control over payload.
 * Waits for player connection to be ready if necessary.
 * @param {string} guildId - The guild ID.
 * @param {Map} queues - The global queues map.
 * @param {import('discord.js').Client} client - The Discord client.
 */
async function playNextTrack(guildId, queues, client) {
    const queue = queues.get(guildId);
    if (!queue) {
        logger.info(`[${guildId}] playNextTrack called but no queue found.`);
        return;
    }
    if (queue.processingNext) {
        logger.debug(`[${guildId}] Already processing next track. Aborting duplicate call.`);
        return;
    }
    if (queue.songs.length === 0) {
        logger.info(`[${guildId}] Queue is empty. Stopping playback.`);
        handleQueueEnd(queue, queues, client);
        return;
    }

    // Get player from queue
    const player = queue.lavalinkPlayer;

    // --- Start Wait for Connection Logic (Simplified as it's handled in getLavalinkPlayer now) ---
    // Ensure player and connection details are available. getLavalinkPlayer now guarantees this
    // or returns null if it fails to connect/get details after waiting.
    if (!player || !player.connection || !player.connection.token || !player.connection.endpoint || !player.connection.sessionId) {
         logger.error(`[${guildId}] Player or connection details are not available before attempting to play.`);
         // This state indicates a failure in getLavalinkPlayer, which should have already
         // handled cleanup and user notification. Just return here.
         return;
    }
    // --- End Wait for Connection Logic ---


    // Set flag to prevent race conditions
    queue.processingNext = true;
    queue.currentTrack = queue.songs.shift(); // Get the next song

    logger.info(`[${guildId}] Attempting to play track: "${queue.currentTrack.title}"`);
    logger.debug(`[${guildId}] Track Data: URI=${queue.currentTrack.url}, Lavalink ID=${queue.currentTrack.lavalinkTrack ? 'Present' : 'Missing!'}`);
    logger.debug(`[${guildId}] Player State Before Play: State=${player.state}, Playing=${player.playing}, Paused=${player.paused}, Position=${player.position}, Volume=${player.volume}`);
    logger.debug(`[${guildId}] Player Connection State Before Play: State=${player.connection?.state}, Token=${player.connection?.token ? 'Present' : 'Missing'}, Endpoint=${player.connection?.endpoint}, SessionId=${player.connection?.sessionId}`);


    if (!queue.currentTrack.lavalinkTrack) {
        logger.error(`[${guildId}] Cannot play track "${queue.currentTrack.title}": Missing Lavalink track identifier!`);
        if (queue.textChannel) await queue.textChannel.send(`⚠️ Error: Could not find playable data for "${queue.currentTrack.title}". Skipping.`).catch(()=>{});
        queue.currentTrack = null; // Clear problematic track
        queue.processingNext = false; // Reset flag
        playNextTrack(guildId, queues, client); // Try next one
        return;
    }

    // --- Corrected playTrack call using node.rest.updatePlayer ---
    try {
        // Ensure player.connection details are available before sending - This check is now also done before the wait
        if (!player.connection || !player.connection.token || !player.connection.endpoint || !player.connection.sessionId) {
             logger.error(`[${guildId}] Missing player connection details required for updatePlayer.`);
             // This should not happen if getLavalinkPlayer succeeded, but as a safeguard:
             throw new Error('Missing player connection details before updatePlayer');
        }

        await player.node.rest.updatePlayer({
            guildId: guildId,
            data: {
                encodedTrack: queue.currentTrack.lavalinkTrack,
                position: 0, // Start from the beginning
                volume: player.volume, // Keep current volume
                filters: player.filters, // Keep current filters (if any)
                voice: { // Include voice state in the data payload for Lavalink v4 update
                    token: player.connection.token,
                    endpoint: player.connection.endpoint,
                    sessionId: player.connection.sessionId,
                },
            },
            noReplace: false // Set noReplace as a top-level boolean parameter
        });

        logger.info(`[${guildId}] Lavalink updatePlayer command issued successfully for: "${queue.currentTrack.title}"`);
        // Note: The actual 'start' event confirms playback has begun.
        queue.processingNext = false; // Reset flag after successful play call
    } catch (error) {
        logger.error(`[${guildId}] Error calling node.rest.updatePlayer for "${queue.currentTrack?.title || 'unknown track'}":`, error);

        // --- Error Handling: Attempt to refresh player on play failure ---
        // Check if the error is recoverable (e.g., connection issue vs. invalid track)
        // A "Bad Request" might indicate an issue with the track itself or session state,
        // which refreshing might not fix, but we'll try anyway for now.
        logger.warn(`[${guildId}] Playback failed. Attempting to refresh player connection...`);
        // Attempt to get/recreate the player, which includes the waiting logic for connection readiness
        const refreshedPlayer = await getLavalinkPlayer(client, guildId, queue.voiceChannelId, queue.textChannel);
        if (refreshedPlayer) {
            logger.info(`[${guildId}] Player connection refreshed. Retrying playback...`);
            queue.lavalinkPlayer = refreshedPlayer; // Update queue with the refreshed player
            // Put the failed track back at the start of the queue to retry it
            queue.songs.unshift(queue.currentTrack);
            queue.currentTrack = null;
            queue.processingNext = false; // Reset flag before retrying
            playNextTrack(guildId, queues, client); // Retry playing the track
            return; // Exit this attempt, the retry will handle it
        } else {
            logger.error(`[${guildId}] Failed to refresh player connection after playback error.`);
            if (queue.textChannel) {
                await queue.textChannel.send(`⚠️ Failed to start playback for "${queue.currentTrack?.title || 'track'}" and couldn't reconnect. Skipping. Reason: ${error.message}`).catch(() => {});
            }
        }
        // --- End Error Handling ---

        // If refresh failed or wasn't attempted, proceed to skip
        const failedTrack = queue.currentTrack;
        queue.currentTrack = null;
        if (queue.loop && failedTrack) queue.songs.push(failedTrack); // Add back to end if looping

        // Reset flag and try next track
        queue.processingNext = false;
        playNextTrack(guildId, queues, client);
    }
}


/**
 * Updates the "Now Playing" message for a guild's queue.
 * Deletes the message if playback finished.
 * @param {object} queue - The guild queue object.
 * @param {boolean} [isFinished=false] - Whether playback has completely finished.
 */
async function updateNowPlayingMessage(queue, isFinished = false) {
    if (!queue || !queue.textChannel?.send) {
         logger.warn(`[${queue?.guildId || 'Unknown Guild'}] updateNowPlayingMessage called with invalid queue or textChannel.`);
         return;
    }

    // If playback is finished, delete the existing message if it exists
    if (isFinished) {
        if (queue.nowPlayingMessage) {
            logger.debug(`[${queue.guildId}] Playback finished. Deleting Now Playing message.`);
            await queue.nowPlayingMessage.delete().catch(err => {
                 // Ignore errors if message already deleted
                 if (err.code !== 10008) logger.warn(`[${queue.guildId}] Error deleting old NP message:`, err);
            });
            queue.nowPlayingMessage = null;
        }
        return;
    }

    const currentTrack = queue.currentTrack;
    const player = queue.lavalinkPlayer;

    // If no track is current or player missing, treat as finished for message update
    if (!currentTrack || !player) {
        logger.debug(`[${queue.guildId}] No current track or player for NP update. Treating as finished.`);
        await updateNowPlayingMessage(queue, true); // Call recursively to delete message
        return;
    }

    const musicColor = config?.colors?.music || 0xCCCCCC; // Default color
    // Get current position safely, default to 0 if not playing/paused
    // Add extra check for player state before accessing position
    let currentPositionMs = 0;
    try {
         // Check if player exists and has a valid state before accessing position
         if (player && player.state !== 'DESTROYED' && (player.playing || player.paused)) {
              currentPositionMs = player.position;
         }
    } catch (posError) {
         logger.warn(`[${queue.guildId}] Error accessing player position: ${posError.message}. Defaulting to 0.`);
    }

    const currentPosition = formatDuration(currentPositionMs);
    const fullDuration = formatDuration(currentTrack.rawDurationMs);

    const embed = new EmbedBuilder()
        .setColor(musicColor)
        .setTitle(player.paused ? '⏸️ Paused' : '▶️ Now Playing')
        .setDescription(`**[${currentTrack.title}](${currentTrack.url})**`)
        .addFields(
            { name: 'Duration', value: `\`${currentPosition} / ${fullDuration}\``, inline: true },
            { name: 'Requested By', value: String(currentTrack.requestedBy || 'Unknown'), inline: true },
            // Add Volume field only if player volume is accessible and meaningful
             { name: 'Volume', value: `${player.volume * 100}%`, inline: true },
            { name: 'Looping', value: queue.loop ? '✅ Track' : '❌ Off', inline: true }, // Indicate track loop for now
            { name: 'Queue', value: `\`${queue.songs.length}\``, inline: true }
        )
        .setTimestamp();

     // Add thumbnail only if available
     if (currentTrack.thumbnail) {
         embed.setThumbnail(currentTrack.thumbnail);
     }

     // Add footer indicating source if available
     if (currentTrack.source) {
         embed.setFooter({ text: `Source: ${currentTrack.source}` });
     }

    try {
        // Try editing existing message first
        if (queue.nowPlayingMessage?.editable) {
            await queue.nowPlayingMessage.edit({ embeds: [embed] });
            logger.debug(`[${queue.guildId}] Edited existing NP message.`);
        } else {
            // If no editable message, delete any potentially stale reference and send a new one
            if (queue.nowPlayingMessage) {
                 await queue.nowPlayingMessage.delete().catch(err => { if (err.code !== 10008) logger.warn(`[${queue.guildId}] Error deleting stale NP message ref:`, err); });
            }
            logger.debug(`[${queue.guildId}] Sending new NP message.`);
            const sentMessage = await queue.textChannel.send({ embeds: [embed] });
            // Fetch the message again to ensure we have a valid reference
            queue.nowPlayingMessage = await queue.textChannel.messages.fetch(sentMessage.id).catch(() => null);
             if (!queue.nowPlayingMessage) logger.warn(`[${queue.guildId}] Failed to fetch newly sent NP message.`);
        }
    } catch (error) {
        logger.error(`[${queue.guildId}] Error updating/sending NP message:`, error);
        // Handle specific errors like unknown message or missing permissions
        if (error.code === 10008 || error.code === 50001 || error.code === 50013) {
             logger.warn(`[${queue.guildId}] Resetting NP message reference due to error.`);
             queue.nowPlayingMessage = null; // Reset reference if message is gone or permissions lost
        }
    }
}

/**
 * Handles interactions from music control buttons.
 * @param {import('discord.js').ButtonInteraction} interaction - The button interaction.
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} userProfile - The user's profile data (if needed for permissions).
 */
async function handleMusicButtons(interaction, client, userProfile) {
    const { customId, guildId, member } = interaction;
    const queue = client.queues?.get(guildId);
    const player = queue?.lavalinkPlayer;

    // Defer update immediately to prevent interaction timeout
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }
    } catch (e) {
        logger.warn(`[${guildId}] Failed to defer update for button ${customId}: ${e.message}`);
        return; // Don't proceed if defer fails
    }

    if (!queue || !player) {
        logger.debug(`[${guildId}] Button ${customId} pressed, but no active queue/player.`);
        await interaction.followUp({ content: 'There is nothing playing right now.', ephemeral: true }).catch(() => {});
        return;
    }

    // Check if user is in the same voice channel as the bot
    // Add extra check for player.connection
    if (!member.voice.channel || !player.connection || member.voice.channel.id !== player.connection.channelId) {
        logger.debug(`[${guildId}] Button ${customId} pressed by user not in the correct VC.`);
        await interaction.followUp({ content: 'You must be in the same voice channel as the bot to use controls.', ephemeral: true }).catch(() => {});
        return;
    }

    logger.debug(`[${guildId}] Processing music button: ${customId}`);
    let feedbackMessage = null; // Message to send as ephemeral feedback

    try {
        switch (customId) {
            case 'music_pause':
                if (!player.paused) {
                    await player.setPaused(true); // Use setPaused for clarity
                    feedbackMessage = '⏸️ Playback paused.';
                    logger.info(`[${guildId}] Playback paused via button.`);
                } else {
                    feedbackMessage = 'Playback is already paused.';
                }
                break;
            case 'music_resume':
                if (player.paused) {
                    await player.setPaused(false);
                    feedbackMessage = '▶️ Playback resumed.';
                    logger.info(`[${guildId}] Playback resumed via button.`);
                } else {
                    feedbackMessage = 'Playback is not paused.';
                }
                break;
            case 'music_skip':
                if (queue.songs.length > 0 || queue.loop) { // Can skip if looping current track or items in queue
                    await player.stop(); // Stop current track, 'end' listener will handle playing next
                    feedbackMessage = '⏭️ Skipping to the next track...';
                    logger.info(`[${guildId}] Track skipped via button.`);
                    // No need to call playNextTrack here, the 'end' event handles it
                } else {
                    feedbackMessage = '❌ There are no more tracks in the queue to skip to.';
                }
                break;
            case 'music_stop':
                logger.info(`[${guildId}] Stopping playback and leaving VC via button.`);
                queue.songs = []; // Clear queue
                queue.loop = false; // Disable loop
                queue.currentTrack = null; // Clear current track immediately
                queue.playing = false;
                await player.stop(); // Stop playback
                await client.shoukaku.leaveVoiceChannel(guildId); // Leave VC
                feedbackMessage = '⏹️ Playback stopped and disconnected.';
                handleQueueEnd(queue, client.queues, client); // Trigger immediate cleanup
                break;
            case 'music_loop':
                queue.loop = !queue.loop; // Toggle boolean loop state
                logger.info(`[${guildId}] Loop toggled via button to: ${queue.loop}`);
                feedbackMessage = `🔁 Loop current track: ${queue.loop ? 'Enabled' : 'Disabled'}`;
                break;
            default:
                logger.warn(`[${guildId}] Unhandled music button ID: ${customId}`);
                feedbackMessage = 'Unknown music control action.';
        }

        // Send ephemeral feedback to the user who clicked the button
        if (feedbackMessage) {
            await interaction.followUp({ content: feedbackMessage, ephemeral: true }).catch(e => logger.warn(`[${guildId}] Failed to send button feedback: ${e.message}`));
        }

        // Update the main Now Playing message if state changed (pause/resume/loop)
        if (['music_pause', 'music_resume', 'music_loop'].includes(customId)) {
            await updateNowPlayingMessage(queue);
        }
        // Skip/Stop already trigger updates via 'end' or handleQueueEnd

    } catch (error) {
        logger.error(`[${guildId}] Error processing music button ${customId}:`, error);
        await interaction.followUp({ content: 'An error occurred while processing this action.', ephemeral: true }).catch(() => {});
    }
}


/**
 * Handles the end of the queue (no more songs).
 * Cleans up resources and sets leave timeout if configured.
 * @param {object} queue - The guild queue object.
 * @param {Map} queues - The global queues map.
 * @param {import('discord.js').Client} client - The Discord client.
 */
async function handleQueueEnd(queue, queues, client) {
    const guildId = queue.guildId;
    logger.info(`[${guildId}] Queue ended or manually stopped.`);

    // Ensure state reflects finished playback
    queue.playing = false;
    queue.currentTrack = null;

    // Update or delete the Now Playing message
    await updateNowPlayingMessage(queue, true); // Pass true to indicate finished

    // Clear any existing leave timeout to prevent duplicates
    if (queue.leaveTimeout) {
        clearTimeout(queue.leaveTimeout);
        queue.leaveTimeout = null;
    }

    // Set timeout to leave VC if configured and bot is still in VC
    const player = client.shoukaku?.players.get(guildId);
    const shouldStay = config.music.stayInChannel;
    const leaveDelayMs = (config.music.leaveTimeout || 60) * 1000; // Default to 60s

    if (!shouldStay && player) { // Only set timeout if player exists (i.e., bot is in VC)
        logger.info(`[${guildId}] Setting ${leaveDelayMs / 1000}s inactivity timeout.`);
        queue.leaveTimeout = setTimeout(async () => {
            // Re-fetch queue and player state inside timeout to ensure it's still relevant
            const currentQueue = queues.get(guildId);
            const currentPlayer = client.shoukaku?.players.get(guildId);

            // Leave only if the queue still exists and the player is not playing/paused
            if (currentQueue && currentPlayer && !currentPlayer.playing && !currentPlayer.paused) {
                logger.info(`[${guildId}] Leaving VC ${currentPlayer.connection.channelId} due to inactivity timeout.`);
                if (currentQueue.textChannel) {
                     await currentQueue.textChannel.send(`👋 Leaving voice channel due to inactivity.`).catch(()=>{});
                }
                try {
                    await client.shoukaku.leaveVoiceChannel(guildId);
                } catch (leaveError) {
                    logger.error(`[${guildId}] Error leaving voice channel during timeout:`, leaveError);
                }
                queues.delete(guildId); // Delete the queue after leaving
            } else if (currentQueue) {
                 // If something started playing again before timeout, clear the timeout reference
                 logger.debug(`[${guildId}] Inactivity timeout reached, but player is active or queue gone. Timeout cleared.`);
                 currentQueue.leaveTimeout = null;
            }
        }, leaveDelayMs);
    } else if (shouldStay) {
         logger.info(`[${guildId}] Configured to stay in channel. Not setting leave timeout.`);
    } else if (!player) {
         logger.info(`[${guildId}] Queue ended, and player already gone. Deleting queue reference.`);
         queues.delete(guildId); // Clean up queue if player is already gone
    }
}


// Utility function (keep local or move to utils)
function formatDuration(ms) {
    if (ms === Infinity) return 'Live'; // Handle livestreams
    if (!ms || typeof ms !== 'number' || ms < 0) return 'N/A';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    let parts = [];
    if (hours > 0) parts.push(hours.toString());
    parts.push(minutes.toString().padStart(hours > 0 ? 2 : 1, '0')); // Pad minutes if hours exist
    parts.push(seconds.toString().padStart(2, '0'));

    return parts.join(':');
}

module.exports = {
    getLavalinkPlayer,
    createGuildQueue,
    addToQueue,
    updateNowPlayingMessage,
    playNextTrack,
    handleMusicButtons,
    handleQueueEnd,
};
