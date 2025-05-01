const { GoogleGenerativeAI } = require("@google/generative-ai");
const { PredictionServiceClient, helpers } = require('@google-cloud/aiplatform');
const logger = require('../utils/logger');
const config = require('../config');
const User = require('../database/models/User');
const fs = require('fs');
const path = require('path');
const util = require('util');

// Load environment variables for Gemini API Key
if (!process.env.GEMINI_API_KEY) { logger.warn('GEMINI_API_KEY not found...'); }
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
if (genAI) { logger.info("GoogleGenerativeAI client initialized."); }
else if (process.env.GEMINI_API_KEY) { logger.error("Failed to initialize GoogleGenerativeAI client."); }

// Load environment variables for Vertex AI
const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
const location = process.env.GOOGLE_CLOUD_LOCATION;

if (!projectId || !location) {
    logger.warn('GOOGLE_CLOUD_PROJECT_ID or GOOGLE_CLOUD_LOCATION missing. Vertex AI Image Generation disabled.');
}

/**
 * Formats interaction history from the database into a structure compatible with the Gemini API.
 * @param {Array<object>} dbHistory - The interaction history from the database.
 * @returns {Array<object>} The formatted history for the API.
 */
const formatHistoryForApi = (dbHistory) => {
    if (!Array.isArray(dbHistory)) return [];
    return dbHistory.map(entry => ({
        role: entry.role,
        parts: Array.isArray(entry.parts) ? entry.parts.map(part => ({ text: part.text })) : [],
    })).filter(entry => entry.role && entry.parts.length > 0 && entry.parts[0].text);
};

/**
 * Generates text response using the Gemini API.
 * @param {string} prompt - The user's prompt.
 * @param {string} discordId - The Discord user ID.
 * @returns {Promise<string>} The generated text response or an error message.
 */
const generateText = async (prompt, discordId) => {
    if (!genAI) return "My connection to the generative faculties seems to be severed.";
    try {
        // Fetch user data to get personality preference and history
        const user = await User.findOne({ discordId: discordId });
        if (!user) return "Alas, I cannot recall our prior discourse.";

        // Get personality prompt
        const personalityKey = user.aiPersonalityPreference || 'default_founding_father';
        const personalityPrompt = config.gemini.personalities[personalityKey] || config.gemini.personalities.default_founding_father;

        // Format history and prepare messages for the API
        const apiCompatibleHistory = formatHistoryForApi((user.aiInteractionHistory || []).slice(-config.gemini.maxHistoryLength));
        const currentUserPrompt = { role: "user", parts: [{ text: prompt }] };

        // Include personality prompt only in the first turn if history is empty
        const messagesToSend = apiCompatibleHistory.length === 0
            ? [{ role: "user", parts: [{ text: `${personalityPrompt}\n\nUser: ${prompt}` }] }]
            : [...apiCompatibleHistory, currentUserPrompt];

        logger.debug(`Sending prompt to Gemini for user ${discordId}. History length: ${messagesToSend.length}`);

        // Get the generative model
        const model = genAI.getGenerativeModel({
            model: config.gemini.model,
            safetySettings: config.gemini.safetySettings, // Use safety settings from config
            generationConfig: config.gemini.generationConfig // Use generation config from config
        });

        // Start a chat session with the history
        const chat = model.startChat({ history: messagesToSend.slice(0, -1) });

        // Send the current message
        const result = await chat.sendMessage(messagesToSend[messagesToSend.length - 1].parts[0].text);
        const response = result.response;

        // Process the response
        if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
            const blockReason = response?.promptFeedback?.blockReason || response?.candidates?.[0]?.finishReason;
            if (blockReason && blockReason !== 'STOP') return `My apologies, Friend. My response was hindered by content safety protocols (${blockReason}).`;
            return "A peculiar silence... I seem unable to formulate a response.";
        }

        const text = response.candidates[0].content.parts[0].text;

        // Save interaction history to the database
        const userDbEntry = { role: "user", parts: [{ text: prompt }], timestamp: new Date() };
        const modelDbEntry = { role: "model", parts: [{ text: text }], timestamp: new Date() };
        if (!user.aiInteractionHistory) user.aiInteractionHistory = [];
        user.aiInteractionHistory.push(userDbEntry);
        user.aiInteractionHistory.push(modelDbEntry);

        // Trim history to prevent it from growing indefinitely
        while (user.aiInteractionHistory.length > config.gemini.maxHistoryLength * 2) user.aiInteractionHistory.shift();

        await user.save();

        logger.info(`Successfully generated Gemini response for user ${discordId}.`);
        return text;

    } catch (error) {
        logger.error(`Error generating text with Gemini for user ${discordId}:`, error);
        return "Forgive me, Citizen, a momentary lapse in my cogitative functions prevents a response.";
    }
};

/**
 * Generates an image using the Vertex AI Imagen model.
 * @param {string} prompt - The image generation prompt.
 * @param {string} discordId - The Discord user ID.
 * @returns {Promise<Buffer|string>} The image buffer or an error message.
 */
const generateImage = async (prompt, discordId) => {
    // Check for Vertex AI configuration
    if (!projectId || !location) {
        logger.error(`Vertex AI config missing for image generation by ${discordId}.`);
        return `Configuration Error: Missing Google Cloud Project ID or Location.`;
    }

    logger.info(`Received Vertex AI image generation request from ${discordId}: "${prompt}"`);
    logger.debug(`GOOGLE_APPLICATION_CREDENTIALS: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);

    let predictionClient;
    let request = {};

    try {
        // Ensure PredictionServiceClient is correctly imported and available
        if (typeof PredictionServiceClient !== 'function') {
            logger.error("PredictionServiceClient class not found/imported correctly. Attempting re-import.");
            try {
                const aiplatform = require('@google-cloud/aiplatform');
                if (aiplatform && typeof aiplatform.PredictionServiceClient === 'function') {
                    PredictionServiceClient = aiplatform.PredictionServiceClient;
                    logger.warn("Re-imported PredictionServiceClient successfully.");
                } else {
                    throw new Error("PredictionServiceClient still not found after re-import attempt.");
                }
            } catch (importError) {
                logger.error("Failed to import PredictionServiceClient:", importError);
                return "Internal Error: Failed to load required AI library component.";
            }
        }

        // Initialize PredictionServiceClient with project and credentials
        predictionClient = new PredictionServiceClient({
            project: projectId,
            // Load credentials from file if GOOGLE_APPLICATION_CREDENTIALS env var is set
            credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS
                ? JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS))
                : undefined,
             apiEndpoint: `${location}-aiplatform.googleapis.com` // Specify the correct regional endpoint
        });
        logger.debug("PredictionServiceClient initialized.");

        // Define the model and endpoint for Imagen
        const publisher = 'google';
        const model = 'imagegeneration@006'; // Or the specific Imagen model version you are using
        const endpoint = `projects/${projectId}/locations/${location}/publishers/${publisher}/models/${model}`;
        logger.debug(`Using Vertex AI endpoint: ${endpoint}`);

        // Prepare the request instances and parameters
        const instances = [helpers.toValue({ prompt: prompt })];

        // --- Adjusted Safety Settings ---
        const parameters = helpers.toValue({
            sampleCount: 1,
            // Adjust safety settings to be less strict.
            // Note: Complete disabling of safety filters for harmful content is generally not possible.
            // We set thresholds to BLOCK_NONE for categories that support it,
            // or the least strict available option according to API documentation.
            safetySettings: [
                {
                    category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                    threshold: 'BLOCK_NONE', // Set to the least strict level
                },
                {
                    category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                    threshold: 'BLOCK_NONE', // Set to the least strict level
                },
                {
                    category: 'HARM_CATEGORY_HARASSMENT',
                    threshold: 'BLOCK_NONE', // Set to the least strict level
                },
                {
                    category: 'HARM_CATEGORY_HATE_SPEECH',
                    threshold: 'BLOCK_NONE', // Set to the least strict level
                },
                {
                    category: 'HARM_CATEGORY_CIVIC_INTEGRITY',
                    threshold: 'BLOCK_NONE', // Set to the least strict level
                },
                {
                    category: 'HARM_CATEGORY_UNSPECIFIED',
                    threshold: 'BLOCK_NONE',
                },
                // Add other categories if needed based on documentation
            ],
             // Optional: You might also explore other parameters like `seed` for reproducibility
             // and `imageSize` if the model supports it.
        });
        // --- End Adjusted Safety Settings ---

        request = {
            endpoint,
            instances,
            parameters
        };

        logger.debug("Sending request to Vertex AI Imagen predict endpoint with payload:", JSON.stringify(request, null, 2));

        // Send the prediction request
        const [response] = await predictionClient.predict(request);
        logger.debug("Received response from Vertex AI Imagen.");

        // Process the response
        if (!response || !response.predictions || response.predictions.length === 0) {
            logger.error(`Vertex AI Imagen response missing predictions. Response: ${JSON.stringify(response)}`);
            return 'Vision unclear: The response from the artistic ether was empty.';
        }

        // Extract the base64 encoded image data
        const predictionValue = helpers.fromValue(response.predictions[0]);
        const imageBase64 = predictionValue?.bytesBase64Encoded;

        if (!imageBase64 || typeof imageBase64 !== 'string') {
            logger.error(`Vertex AI Imagen prediction missing 'bytesBase64Encoded' string. Prediction Value:`, predictionValue);
            return 'Vision captured, but essence lost (invalid image data format).';
        }

        logger.info(`Successfully generated image via Vertex AI for user ${discordId}.`);
        // Return the image data as a Buffer
        return Buffer.from(imageBase64, 'base64');

    } catch (error) {
        logger.error(`Error generating image with Vertex AI Imagen for user ${discordId}. Request Payload: ${JSON.stringify(request, null, 2)}`, error);
        // Provide more informative error messages to the user
        let userErrorMessage = "Alas, a disruption occurred whilst attempting to craft your requested image.";
        if (error.code === 3 || error.message?.includes('INVALID_ARGUMENT')) {
            userErrorMessage = "Request malformed (Invalid Argument). Check prompt/parameters and model compatibility.";
        } else if (error.code === 8 || error.message?.includes('RESOURCE_EXHAUSTED')) {
            userErrorMessage = "Vertex AI service overwhelmed (quota exceeded). Try again later.";
        } else if (error.code === 7 || error.message?.includes('permission denied') || error.code === 16 || error.message?.includes('UNAUTHENTICATED')) {
            userErrorMessage = "Authentication failed for Vertex AI service. Check service account credentials and permissions.";
        } else if (error.details) {
            userErrorMessage += ` Details: ${error.details}`;
        } else {
            userErrorMessage += ` Error: ${error.message || 'Unknown error'}`;
        }
        return userErrorMessage;
    }
};

module.exports = {
    generateText,
    generateImage
};
