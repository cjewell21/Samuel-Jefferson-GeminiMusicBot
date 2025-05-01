// config.js
// Central configuration for the Samuel Jefferson bot

module.exports = {
    // Bot settings
    botName: "Samuel Jefferson",
    botPresence: { // Example presence
        activities: [{ name: 'the debates | /help', type: 3 }], // Type 3 is WATCHING
        status: 'online', // online, idle, dnd, invisible
    },
    prefix: process.env.BOT_PREFIX || "!", // Fallback prefix if needed
    controlChannelId: process.env.CONTROL_CHANNEL_ID || null, // ID of the dedicated music control channel

    // Embed colors
    // **FIX:** Ensure colors are valid ColorResolvable types (number, hex string, name string, RGB array)
    colors: {
        primary: 0x5865F2,    // Discord Blurple (as number)
        success: 0x57F287,    // Discord Green (as number)
        warning: 0xFEE75C,    // Discord Yellow (as number)
        error: 0xED4245,      // Discord Red (as number)
        spotify: 0x1DB954,    // Spotify Green (as number)
        gemini: 0x4285F4,     // Google Blue (approx, as number)
        music: 0xFF007F,      // Music Pink/Magenta (as number) - Ensure this is a valid number
        info: 0x0099FF,
        // Alternatively use hex strings:
        // primary: '#5865F2',
        // success: '#57F287',
        // warning: '#FEE75C',
        // error: '#ED4245',
        // spotify: '#1DB954',
        // gemini: '#4285F4',
        // music: '#FF007F',
    },

    // Cooldowns (in seconds)
    cooldowns: {
        default: 3,
        music: 2,
        ai: 5, // Cooldown for AI commands might be longer
        generate: 15, // Image generation cooldown
    },

    // Spotify settings
    spotify: {
        scopes: [
            'ugc-image-upload', 'user-read-playback-state', 'user-modify-playback-state',
            'user-read-currently-playing', 'streaming', 'playlist-read-private',
            'playlist-read-collaborative', 'playlist-modify-private', 'playlist-modify-public',
            'user-follow-modify', 'user-follow-read', 'user-read-playback-position',
            'user-top-read', 'user-read-recently-played', 'user-library-modify',
            'user-library-read', 'user-read-email', 'user-read-private'
        ],
        callbackBaseUrl: process.env.SPOTIFY_REDIRECT_URI ? process.env.SPOTIFY_REDIRECT_URI.replace('/callback', '') : 'http://localhost:' + (process.env.PORT || 8888),
        callbackPath: '/callback',
        stateKey: 'spotify_auth_state',
    },

    // Gemini AI settings
    gemini: {
        model: 'gemini-1.5-flash',
        // imageModel: 'gemini-pro-vision', // Not used for generation currently
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        ],
        generationConfig: {
            maxOutputTokens: 2048,
        },
        personalities: {
            default_founding_father: `You are Samuel Jefferson, an AI embodiment of the American Founding Fathers... (rest of prompt)`,
        },
        maxHistoryLength: 20,
    },

    // Music settings
    music: {
        maxQueueSize: 100,
        defaultVolume: 50,
        stayInChannel: false,
        leaveTimeout: 300,
        maxTrackLengthMinutes: 180,
        searchResultLimit: 10, // Max results for /search command
        allowPlaylistDuplicates: false,
    },

    // Other constants
    embedLimits: {
        title: 256, description: 4096, fieldName: 256,
        fieldValue: 1024, footerText: 2048, authorName: 256, fields: 25,
    },

    // Permissions required by the bot
    requiredPermissions: [
        'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks',
        'AttachFiles', 'ReadMessageHistory', 'Connect', 'Speak',
        'UseApplicationCommands',
    ],
};