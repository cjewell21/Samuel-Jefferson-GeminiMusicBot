// ai/gemini.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
// Import helpers for parameter formatting and the client
const { PredictionServiceClient, helpers } = require('@google-cloud/aiplatform');
const logger = require('../utils/logger');
const config = require('../config');
const User = require('../database/models/User');
const fs = require('fs');
const path = require('path');
const util = require('util'); // For deep inspection

// --- Gemini Setup (Text Generation) ---
if (!process.env.GEMINI_API_KEY) {
    logger.warn('GEMINI_API_KEY not found in .env file. Text AI features will be disabled.');
}
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
if (genAI) {
    logger.info("GoogleGenerativeAI client initialized successfully.");
} else if (process.env.GEMINI_API_KEY) {
    logger.error("Failed to initialize GoogleGenerativeAI client despite API key being present.");
}

// --- Vertex AI Setup (Image Generation) ---
const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
const location = process.env.GOOGLE_CLOUD_LOCATION;

// Validate environment variables
if (!projectId || !location) {
    logger.warn('GOOGLE_CLOUD_PROJECT_ID or GOOGLE_CLOUD_LOCATION missing in .env file. Vertex AI Image Generation will be disabled.');
}

// Helper function for text history formatting
const formatHistoryForApi = (dbHistory) => {
    if (!Array.isArray(dbHistory)) return [];
    return dbHistory.map(entry => ({
        role: entry.role,
        parts: Array.isArray(entry.parts) ? entry.parts.map(part => ({ text: part.text })) : [],
    })).filter(entry => entry.role && entry.parts.length > 0 && entry.parts[0].text);
};

// --- generateText function ---
const generateText = async (prompt, discordId) => {
    if (!genAI) return "My connection to the generative faculties seems to be severed.";
    try {
        const user = await User.findOne({ discordId: discordId });
        if (!user) return "Alas, I cannot recall our prior discourse.";
        const personalityKey = user.aiPersonalityPreference || 'default_founding_father';
        const personalityPrompt = config.gemini.personalities[personalityKey] || config.gemini.personalities.default_founding_father;
        const apiCompatibleHistory = formatHistoryForApi((user.aiInteractionHistory || []).slice(-config.gemini.maxHistoryLength));
        const currentUserPrompt = { role: "user", parts: [{ text: prompt }] };
        const messagesToSend = apiCompatibleHistory.length === 0
            ? [ { role: "user", parts: [{ text: `${personalityPrompt}\n\nUser: ${prompt}` }] } ]
            : [ ...apiCompatibleHistory, currentUserPrompt ];

        logger.debug(`Sending prompt to Gemini for user ${discordId}. History length: ${messagesToSend.length}`);
        const model = genAI.getGenerativeModel({ model: config.gemini.model, safetySettings: config.gemini.safetySettings, generationConfig: config.gemini.generationConfig });
        const chat = model.startChat({ history: messagesToSend.slice(0, -1) });
        const result = await chat.sendMessage(messagesToSend[messagesToSend.length - 1].parts[0].text);
        const response = result.response;
        if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
            const blockReason = response?.promptFeedback?.blockReason || response?.candidates?.[0]?.finishReason;
            if (blockReason && blockReason !== 'STOP') return `My apologies, Friend. My response was hindered by content safety protocols (${blockReason}).`;
            return "A peculiar silence... I seem unable to formulate a response.";
        }
        const text = response.candidates[0].content.parts[0].text;
        const userDbEntry = { role: "user", parts: [{ text: prompt }], timestamp: new Date() };
        const modelDbEntry = { role: "model", parts: [{ text: text }], timestamp: new Date() };
        if (!user.aiInteractionHistory) user.aiInteractionHistory = [];
        user.aiInteractionHistory.push(userDbEntry);
        user.aiInteractionHistory.push(modelDbEntry);
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
 * Generates an image using Google Cloud Vertex AI Imagen.
 * @param {string} prompt - The text prompt describing the image.
 * @param {string} discordId - The Discord ID of the user requesting.
 * @returns {Promise<Buffer|string|null>} A Buffer containing the image data (if successful), an error message string, or null.
 */
const generateImage = async (prompt, discordId) => {
    if (!projectId || !location) {
        logger.error(`Vertex AI configuration incomplete for image generation requested by ${discordId}.`);
        return `My apologies, the faculties required for visual creation are unavailable due to missing configuration (Project ID or Location).`;
    }

    // Validate prompt
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
        logger.error(`Invalid prompt provided by ${discordId}: "${prompt}"`);
        return `Please provide a valid prompt with at least 3 characters to conjure an image.`;
    }

    logger.info(`Received Vertex AI image generation request from ${discordId}: "${prompt}"`);

    let client; // Declare client outside try block
    let request = {}; // Declare request outside for logging in catch block
    const model = 'imagegeneration@006'; // Define model at function scope
    const publisher = 'google'; // Define publisher at function scope

    try {
        // --- Initialize Client ---
        logger.debug("Initializing PredictionServiceClient...");
        client = new PredictionServiceClient({
            project: projectId,
            location: location,
            apiEndpoint: `${location}-aiplatform.googleapis.com`,
        });
        logger.debug("PredictionServiceClient initialized.");

        // --- Construct Endpoint ---
        const endpoint = `projects/${projectId}/locations/${location}/publishers/${publisher}/models/${model}`;
        logger.debug(`Using Vertex AI endpoint: ${endpoint}`);

        // --- Construct Request Payload ---
        const instances = [{ prompt: prompt.trim() }]; // Use 'prompt' instead of 'text'
        const parameters = helpers.toValue({
            sampleCount: 1, // Number of images to generate
            imageSize: '2560x1440',
            negativePrompt: '', // Optional, empty string for no negative prompt
        });

        // Prepare the final request object
        request = {
            endpoint,
            instances: instances.map(instance => helpers.toValue(instance)), // Convert instances to Value format
            parameters,
        };

        logger.debug("Sending request to Vertex AI Imagen predict endpoint with payload:", JSON.stringify(request, null, 2));
        // --- Make API Call ---
        const [response] = await client.predict(request);
        logger.debug("Received response from Vertex AI Imagen:", JSON.stringify(response, null, 2));

        // --- Process Response ---
        if (!response || !response.predictions || response.predictions.length === 0) {
            logger.error(`Vertex AI Imagen response missing predictions field or predictions array is empty. Response: ${JSON.stringify(response)}`);
            return 'I attempted to conjure a vision, but the response structure was unexpected or empty.';
        }

        const prediction = response.predictions[0];
        // Extract base64 string from nested structure
        const imageBase64 = prediction?.bytesBase64Encoded?.value || prediction?.structValue?.fields?.bytesBase64Encoded?.stringValue;

        if (!imageBase64) {
            logger.error(`Vertex AI Imagen prediction missing base64-encoded image data. Prediction: ${JSON.stringify(prediction, null, 2)}`);
            return 'The vision formed, but its essence (image data) could not be found in the response.';
        }

        logger.info(`Successfully generated image via Vertex AI for user ${discordId}.`);
        return Buffer.from(imageBase64, 'base64');

    } catch (error) {
        logger.error(`Error generating image with Vertex AI Imagen for user ${discordId}. Request Payload: ${JSON.stringify(request, null, 2)}`, error);
        let userErrorMessage = "Alas, a disruption occurred whilst attempting to craft your requested image.";

        if (error.code === 3 || (error.message && error.message.includes('INVALID_ARGUMENT'))) {
            userErrorMessage = `The request to conjure your image was malformed (Invalid Argument). Please ensure the prompt is descriptive and try again. Details: ${error.details || error.message || 'No additional details provided'}`;
            // Fallback to imagegeneration@005 if model-specific issue
            if (model === 'imagegeneration@006') {
                logger.warn(`Retrying with imagegeneration@005 due to persistent INVALID_ARGUMENT error.`);
                const fallbackEndpoint = `projects/${projectId}/locations/${location}/publishers/${publisher}/models/imagegeneration@005`;
                request.endpoint = fallbackEndpoint;
                try {
                    const [fallbackResponse] = await client.predict(request);
                    if (fallbackResponse?.predictions?.[0]?.bytesBase64Encoded?.value) {
                        logger.info(`Fallback to imagegeneration@005 succeeded for user ${discordId}.`);
                        return Buffer.from(fallbackResponse.predictions[0].bytesBase64Encoded.value, 'base64');
                    }
                } catch (fallbackError) {
                    logger.error(`Fallback to imagegeneration@005 failed:`, fallbackError);
                }
            }
        } else if (error.code === 8 || (error.message && error.message.includes('RESOURCE_EXHAUSTED'))) {
            userErrorMessage = "The Vertex AI service is currently overwhelmed (quota exceeded). Please try again later.";
        } else if (error.code === 7 || (error.message && error.message.includes('permission denied'))) {
            userErrorMessage = "I lack the necessary permissions to use the Vertex AI service. Please verify the bot's service account roles.";
        } else {
            userErrorMessage += ` Error: ${error.message || 'Unknown error'}`;
            if (error.details) userErrorMessage += ` Details: ${error.details}`;
        }
        return userErrorMessage;
    }
};

module.exports = {
    generateText,
    generateImage,
};
